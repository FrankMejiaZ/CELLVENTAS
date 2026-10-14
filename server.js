const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 8092;
const JWT_SECRET = process.env.JWT_SECRET || 'cellventas_dev_local_secret_2026';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Inicializar DB al arrancar
db.initDb();

// Sistema de logs estructurado conforme a la Constitución de VT VALETEC
function logSystemError(context, req, err) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: 'ERROR',
    context,
    route: req ? `${req.method} ${req.originalUrl}` : 'INTERNAL',
    user: req?.user?.username || 'mostrador',
    message: err?.message || String(err)
  };
  console.error('[CELLVENTAS_LOG]', JSON.stringify(logEntry));
}

// Respuesta de error estandarizada sin exponer estructura interna de la base de datos
function sendSafeError(res, req, context, err, userMessage = 'Ocurrió un error al procesar la solicitud en el servidor.') {
  logSystemError(context, req, err);
  const isUniqueViolation = String(err?.message || '').toLowerCase().includes('unique') || String(err?.message || '').toLowerCase().includes('duplicate');
  if (isUniqueViolation) {
    return res.status(400).json({ error: '⚠️ Ya existe un registro con ese código, documento o nombre único.' });
  }
  return res.status(500).json({ error: userMessage });
}

// Parsea JSON de detalles de pago de forma segura sin bloques catch vacíos
function parsePaymentDetails(rawDetails, contextLabel = 'parsePaymentDetails') {
  if (!rawDetails) return null;
  if (typeof rawDetails === 'object') return rawDetails;
  try {
    return JSON.parse(rawDetails);
  } catch (err) {
    console.warn(`⚠️ Aviso en ${contextLabel}: formato JSON inválido en payment_details:`, err.message);
    return null;
  }
}

// WebSockets para sincronización en tiempo real
io.on('connection', (socket) => {
  console.log('⚡ Cliente Socket.io conectado a CELLVENTAS:', socket.id);
});

// Middleware JWT para identificar sesión activa
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader ? authHeader.split(' ')[1] : null;
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
  } catch (err) {
    console.warn('⚠️ Token JWT inválido o expirado en solicitud:', req.originalUrl, err.message);
  }
  next();
}
app.use(verifyToken);

// Middleware para restringir operaciones críticas a Administrador
function requireAdmin(req, res, next) {
  if (!req.user || String(req.user.role || '').toLowerCase() !== 'administrador') {
    return res.status(403).json({ error: 'Acceso denegado. Esta acción requiere permisos de Administrador.' });
  }
  next();
}

// ==========================================
// 0. AUTENTICACIÓN Y GESTIÓN DE USUARIOS
// ==========================================

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos.' });
    }

    const cleanUser = String(username).trim();
    const userRes = await db.query(`SELECT * FROM users WHERE username = ?`, [cleanUser]);
    const user = userRes.rows[0];

    if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
      return res.status(401).json({ error: 'Credenciales incorrectas. Verifique su usuario y contraseña.' });
    }

    const payload = {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
    res.json({
      success: true,
      token,
      user: payload
    });
  } catch (err) {
    sendSafeError(res, req, 'AUTH_LOGIN', err, 'No se pudo procesar el inicio de sesión.');
  }
});

app.get('/api/auth/me', (req, res) => {
  if (req.user) {
    return res.json({ authenticated: true, user: req.user });
  }
  return res.status(401).json({ authenticated: false, user: null, error: 'Sesión no iniciada o token expirado.' });
});

app.get('/api/users', async (req, res) => {
  try {
    const result = await db.query(`SELECT id, username, name, role, created_at FROM users ORDER BY id ASC`);
    res.json(result.rows);
  } catch (err) {
    sendSafeError(res, req, 'GET_USERS', err, 'Error al consultar usuarios.');
  }
});

app.put('/api/auth/change-password', async (req, res) => {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'Debe iniciar sesión para cambiar su contraseña.' });
    }

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Debe ingresar su contraseña actual y la nueva contraseña.' });
    }

    if (String(newPassword).length < 4) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 4 caracteres.' });
    }

    const userRes = await db.query(`SELECT id, password_hash FROM users WHERE id = ?`, [req.user.id]);
    const user = userRes.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    const isValid = bcrypt.compareSync(String(currentPassword), user.password_hash);
    if (!isValid) {
      return res.status(400).json({ error: 'La contraseña actual no es correcta.' });
    }

    const newHash = bcrypt.hashSync(String(newPassword), 10);
    await db.query(`UPDATE users SET password_hash = ? WHERE id = ?`, [newHash, req.user.id]);

    res.json({ success: true, message: 'Contraseña actualizada correctamente.' });
  } catch (err) {
    sendSafeError(res, req, 'CHANGE_PASSWORD', err, 'No se pudo actualizar la contraseña.');
  }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  try {
    const { username, name, role, password } = req.body;
    const cleanUser = String(username || '').trim().toLowerCase();
    const cleanName = String(name || '').trim();
    const cleanRole = String(role || 'Vendedor').trim();
    const cleanPass = String(password || '').trim();

    if (!cleanUser || !cleanName || !cleanPass) {
      return res.status(400).json({ error: 'Nombre, usuario y contraseña son obligatorios.' });
    }

    if (cleanPass.length < 4) {
      return res.status(400).json({ error: 'La contraseña debe tener mínimo 4 caracteres.' });
    }

    const existingRes = await db.query(`SELECT id FROM users WHERE LOWER(username) = ?`, [cleanUser]);
    if (existingRes.rows.length > 0) {
      return res.status(400).json({ error: 'Ya existe un usuario con ese nombre de usuario.' });
    }

    const passHash = bcrypt.hashSync(cleanPass, 10);
    const insertRes = await db.query(`
      INSERT INTO users (username, name, role, password_hash)
      VALUES (?, ?, ?, ?)
      RETURNING id
    `, [cleanUser, cleanName, cleanRole, passHash]);

    const newId = insertRes.lastID || (insertRes.rows && insertRes.rows[0] ? insertRes.rows[0].id : null);

    res.json({
      success: true,
      message: `Usuario "${cleanUser}" creado con éxito.`,
      user: { id: newId, username: cleanUser, name: cleanName, role: cleanRole }
    });
  } catch (err) {
    sendSafeError(res, req, 'CREATE_USER', err, 'No se pudo registrar el usuario.');
  }
});

app.put('/api/users/:id/password', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;
    const cleanPass = String(newPassword || '').trim();

    if (!cleanPass || cleanPass.length < 4) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 4 caracteres.' });
    }

    const userRes = await db.query(`SELECT id, username FROM users WHERE id = ?`, [id]);
    const user = userRes.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    const newHash = bcrypt.hashSync(cleanPass, 10);
    await db.query(`UPDATE users SET password_hash = ? WHERE id = ?`, [newHash, id]);

    res.json({ success: true, message: `Contraseña de "${user.username}" restablecida con éxito.` });
  } catch (err) {
    sendSafeError(res, req, 'RESET_PASSWORD', err, 'No se pudo restablecer la contraseña.');
  }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const userRes = await db.query(`SELECT id, username FROM users WHERE id = ?`, [id]);
    const user = userRes.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    if (user.username === 'admin') {
      return res.status(400).json({ error: 'No se puede eliminar el usuario administrador principal del sistema.' });
    }

    if (req.user && parseInt(req.user.id, 10) === parseInt(id, 10)) {
      return res.status(400).json({ error: 'No puede eliminar su propio usuario en sesión activa.' });
    }

    await db.query(`DELETE FROM users WHERE id = ?`, [id]);
    res.json({ success: true, message: `Usuario "${user.username}" eliminado del sistema.` });
  } catch (err) {
    sendSafeError(res, req, 'DELETE_USER', err, 'No se pudo eliminar el usuario.');
  }
});

// ==========================================
// 0.1 CONFIGURACIÓN DE TIENDA Y COMPROBANTES
// ==========================================

app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM store_settings WHERE id = 1`);
    if (result.rows.length === 0) {
      return res.json({
        store_name: 'CELLVENTAS',
        store_subheading: 'ACCESORIOS Y CELULARES',
        store_legal_name: 'VT VALETEC',
        store_ruc: '20601234567',
        store_address: 'Av. Comercial 450 - Tienda 12',
        store_phone: '987 654 321',
        ticket_footer: '¡Gracias por su preferencia! Revise su producto antes de retirarse. Garantía válida con su ticket.',
        ticket_width: '80mm'
      });
    }
    res.json(result.rows[0]);
  } catch (err) {
    sendSafeError(res, req, 'GET_SETTINGS', err, 'Error al obtener la configuración de la tienda.');
  }
});

app.put('/api/settings', requireAdmin, async (req, res) => {
  try {
    const {
      store_name,
      store_subheading,
      store_legal_name,
      store_ruc,
      store_address,
      store_phone,
      ticket_footer,
      ticket_width
    } = req.body;

    await db.query(`
      UPDATE store_settings
      SET store_name = ?,
          store_subheading = ?,
          store_legal_name = ?,
          store_ruc = ?,
          store_address = ?,
          store_phone = ?,
          ticket_footer = ?,
          ticket_width = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `, [
      String(store_name || 'CELLVENTAS').trim(),
      String(store_subheading || '').trim(),
      String(store_legal_name || '').trim(),
      String(store_ruc || '').trim(),
      String(store_address || '').trim(),
      String(store_phone || '').trim(),
      String(ticket_footer || '').trim(),
      ticket_width === '58mm' ? '58mm' : '80mm'
    ]);

    const updated = await db.query(`SELECT * FROM store_settings WHERE id = 1`);
    const settings = updated.rows[0];
    io.emit('settings_updated', settings);

    res.json({
      success: true,
      message: 'Configuración de tienda y comprobantes guardada exitosamente.',
      settings
    });
  } catch (err) {
    sendSafeError(res, req, 'UPDATE_SETTINGS', err, 'No se pudo guardar la configuración de la tienda.');
  }
});

// ==========================================
// 1. MARCAS, MODELOS Y ASISTENTE 360°
// ==========================================

app.get('/api/brands', async (req, res) => {
  try {
    const brandsRes = await db.query(`SELECT * FROM brands ORDER BY name ASC`);
    const modelsRes = await db.query(`SELECT * FROM phone_models ORDER BY model_name ASC`);

    const brandsMap = brandsRes.rows.map(b => ({
      ...b,
      models: modelsRes.rows.filter(m => m.brand_id === b.id)
    }));

    res.json(brandsMap);
  } catch (err) {
    sendSafeError(res, req, 'GET_BRANDS', err, 'Error al cargar el catálogo de marcas y modelos.');
  }
});

app.post('/api/brands', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Nombre de marca es requerido.' });
    await db.query(`INSERT INTO brands (name) VALUES (?)`, [name]);
    io.emit('compatibility_updated');
    res.json({ success: true, message: 'Marca registrada exitosamente' });
  } catch (err) {
    sendSafeError(res, req, 'CREATE_BRAND', err, 'No se pudo registrar la marca.');
  }
});

app.post('/api/models', async (req, res) => {
  try {
    const { brand_id, model_name, release_year } = req.body;
    const cleanModelName = String(model_name || '').trim();
    if (!brand_id || !cleanModelName) {
      return res.status(400).json({ error: 'Marca y Nombre de Modelo son requeridos.' });
    }
    await db.query(
      `INSERT INTO phone_models (brand_id, model_name, release_year) VALUES (?, ?, ?)`,
      [parseInt(brand_id, 10), cleanModelName, parseInt(release_year, 10) || 2024]
    );
    io.emit('compatibility_updated');
    res.json({ success: true, message: 'Modelo de celular registrado.' });
  } catch (err) {
    sendSafeError(res, req, 'CREATE_MODEL', err, 'No se pudo registrar el modelo de celular.');
  }
});

app.delete('/api/models/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.query(`DELETE FROM phone_models WHERE id = ?`, [id]);
    io.emit('compatibility_updated');
    res.json({ success: true, message: 'Modelo eliminado.' });
  } catch (err) {
    sendSafeError(res, req, 'DELETE_MODEL', err, 'No se pudo eliminar el modelo.');
  }
});

// ASISTENTE DE MOSTRADOR: FICHA 360° DE COMPATIBILIDADES
app.get('/api/compatibilities/assistant/:modelId', async (req, res) => {
  try {
    const { modelId } = req.params;

    const modelRes = await db.query(`
      SELECT pm.*, b.name as brand_name 
      FROM phone_models pm 
      INNER JOIN brands b ON pm.brand_id = b.id 
      WHERE pm.id = ?
    `, [modelId]);

    if (modelRes.rows.length === 0) {
      return res.status(404).json({ error: 'Modelo no encontrado' });
    }

    const modelInfo = modelRes.rows[0];

    const prodsRes = await db.query(`
      SELECT p.*
      FROM products p
      INNER JOIN product_compatibilities pc ON p.id = pc.product_id
      WHERE pc.phone_model_id = ?
      ORDER BY p.category ASC, p.name ASC
    `, [modelId]);

    const allCompatsRes = await db.query(`
      SELECT pc.product_id, pm.id as model_id, pm.model_name, b.name as brand_name
      FROM product_compatibilities pc
      INNER JOIN phone_models pm ON pc.phone_model_id = pm.id
      INNER JOIN brands b ON pm.brand_id = b.id
    `);

    const products = prodsRes.rows.map(p => {
      const otherModels = allCompatsRes.rows
        .filter(c => c.product_id === p.id && String(c.model_id) !== String(modelId))
        .map(c => `${c.brand_name} ${c.model_name}`);

      return {
        ...p,
        shared_with: otherModels
      };
    });

    res.json({
      model: modelInfo,
      products: products
    });
  } catch (err) {
    sendSafeError(res, req, 'ASSISTANT_360', err, 'Error al consultar la ficha de compatibilidades.');
  }
});

// REPORTE DE COBERTURA Y AUDITORÍA DE MODELOS DESABASTECIDOS
app.get('/api/compatibilities/coverage', async (req, res) => {
  try {
    const modelsRes = await db.query(`
      SELECT pm.id, pm.model_name, pm.release_year, b.name as brand_name, b.id as brand_id
      FROM phone_models pm
      INNER JOIN brands b ON pm.brand_id = b.id
      ORDER BY b.name ASC, pm.model_name ASC
    `);

    const compatsRes = await db.query(`
      SELECT pc.phone_model_id, p.id as product_id, p.name, p.category, p.stock
      FROM product_compatibilities pc
      INNER JOIN products p ON pc.product_id = p.id
    `);

    const coverage = modelsRes.rows.map(m => {
      const items = compatsRes.rows.filter(c => c.phone_model_id === m.id);
      const cases = items.filter(i => (i.category || '').toLowerCase().includes('case') || (i.category || '').toLowerCase().includes('funda'));
      const micas = items.filter(i => (i.category || '').toLowerCase().includes('mica') || (i.category || '').toLowerCase().includes('protector'));
      
      const casesStock = cases.reduce((acc, curr) => acc + (curr.stock || 0), 0);
      const micasStock = micas.reduce((acc, curr) => acc + (curr.stock || 0), 0);
      const totalStock = items.reduce((acc, curr) => acc + (curr.stock || 0), 0);

      return {
        ...m,
        totalItems: items.length,
        casesCount: cases.length,
        casesStock: casesStock,
        micasCount: micas.length,
        micasStock: micasStock,
        totalStock: totalStock,
        needsCases: casesStock === 0,
        needsMicas: micasStock === 0
      };
    });

    res.json(coverage);
  } catch (err) {
    sendSafeError(res, req, 'COMPATIBILITY_COVERAGE', err, 'Error al obtener la auditoría de cobertura.');
  }
});

// ASIGNADOR RÁPIDO MASIVO
app.post('/api/compatibilities/bulk', async (req, res) => {
  try {
    const { product_id, model_ids } = req.body;
    if (!product_id || !Array.isArray(model_ids)) {
      return res.status(400).json({ error: 'Producto y lista de modelos requeridos.' });
    }

    await db.withTransaction(async (tx) => {
      await tx(`DELETE FROM product_compatibilities WHERE product_id = ?`, [product_id]);
      for (const mId of model_ids) {
        await tx(`INSERT INTO product_compatibilities (product_id, phone_model_id) VALUES (?, ?)`, [product_id, mId]);
      }
    });

    io.emit('compatibility_updated');
    res.json({ success: true, message: `Compatibilidad actualizada (${model_ids.length} modelos asignados).` });
  } catch (err) {
    sendSafeError(res, req, 'BULK_COMPATIBILITY', err, 'No se pudo actualizar la matriz de compatibilidad.');
  }
});

// ==========================================
// 2. PRODUCTOS E INVENTARIO
// ==========================================

app.get('/api/products', async (req, res) => {
  try {
    const prods = await db.query(`SELECT * FROM products ORDER BY id DESC`);
    const compats = await db.query(`
      SELECT pc.product_id, pm.id as model_id, pm.model_name, b.name as brand_name
      FROM product_compatibilities pc
      INNER JOIN phone_models pm ON pc.phone_model_id = pm.id
      INNER JOIN brands b ON pm.brand_id = b.id
    `);

    const productsWithModels = prods.rows.map(p => ({
      ...p,
      compatible_models: compats.rows.filter(c => c.product_id === p.id)
    }));

    res.json(productsWithModels);
  } catch (err) {
    sendSafeError(res, req, 'GET_PRODUCTS', err, 'Error al consultar el inventario de productos.');
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const { code, name, category, purchase_price, price, stock, min_stock, is_serialized, model_ids } = req.body;
    const cleanCode = String(code || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanCode || !cleanName || price === undefined || price === null) {
      return res.status(400).json({ error: 'Código, Nombre y Precio son requeridos.' });
    }

    const serializedFlag = is_serialized ? 1 : 0;
    // Si el equipo requiere IMEI, su stock inicial es 0 hasta que se registren sus IMEIs
    const initialStock = serializedFlag === 1 ? 0 : (parseInt(stock, 10) || 0);

    const productId = await db.withTransaction(async (tx) => {
      const insertRes = await tx(`
        INSERT INTO products (code, name, category, purchase_price, price, stock, min_stock, is_serialized)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `, [
        cleanCode,
        cleanName,
        category || 'Accesorios',
        parseFloat(purchase_price) || 0,
        parseFloat(price) || 0,
        initialStock,
        parseInt(min_stock, 10) || 5,
        serializedFlag
      ]);

      const newId = insertRes.lastID || (insertRes.rows && insertRes.rows[0] ? insertRes.rows[0].id : null);

      if (newId && model_ids && Array.isArray(model_ids)) {
        for (const mId of model_ids) {
          await tx(`INSERT INTO product_compatibilities (product_id, phone_model_id) VALUES (?, ?)`, [newId, mId]);
        }
      }

      if (newId && initialStock > 0) {
        await tx(`
          INSERT INTO inventory_movements (product_id, type, quantity, previous_stock, new_stock, reason, reference_code, user_name)
          VALUES (?, 'STOCK_INICIAL', ?, 0, ?, 'Stock inicial al registrar producto', 'REGISTRO', ?)
        `, [newId, initialStock, initialStock, req.user?.name || 'Administrador']);
      }
      return newId;
    });

    io.emit('product_updated', { action: 'created', productId });
    res.json({ success: true, id: productId, productId, message: 'Producto guardado con éxito con su matriz de compatibilidad.' });
  } catch (err) {
    sendSafeError(res, req, 'CREATE_PRODUCT', err, 'No se pudo registrar el producto.');
  }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { code, name, category, purchase_price, price, stock, min_stock, is_serialized, model_ids } = req.body;
    const serializedFlag = is_serialized ? 1 : 0;

    await db.withTransaction(async (tx) => {
      await tx(`
        UPDATE products 
        SET code = ?, name = ?, category = ?, purchase_price = ?, price = ?, stock = ?, min_stock = ?, is_serialized = ?
        WHERE id = ?
      `, [
        String(code || '').trim(),
        String(name || '').trim(),
        category || 'Accesorios',
        parseFloat(purchase_price) || 0,
        parseFloat(price) || 0,
        parseInt(stock, 10) || 0,
        parseInt(min_stock, 10) || 5,
        serializedFlag,
        id
      ]);

      if (model_ids && Array.isArray(model_ids)) {
        await tx(`DELETE FROM product_compatibilities WHERE product_id = ?`, [id]);
        for (const mId of model_ids) {
          await tx(`INSERT INTO product_compatibilities (product_id, phone_model_id) VALUES (?, ?)`, [id, mId]);
        }
      }

      if (serializedFlag === 1) {
        await db.syncSerializedProductStock(id, tx);
      }
    });

    io.emit('product_updated', { action: 'updated', productId: id });
    res.json({ success: true, message: 'Producto actualizado correctamente.' });
  } catch (err) {
    sendSafeError(res, req, 'UPDATE_PRODUCT', err, 'No se pudo actualizar el producto.');
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.query(`DELETE FROM products WHERE id = ?`, [id]);
    io.emit('product_updated', { action: 'deleted', productId: id });
    res.json({ success: true, message: 'Producto eliminado.' });
  } catch (err) {
    sendSafeError(res, req, 'DELETE_PRODUCT', err, 'No se pudo eliminar el producto.');
  }
});

// ==========================================
// 2.5 KARDEX Y MOVIMIENTOS DE INVENTARIO
// ==========================================

app.get('/api/inventory/kardex', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT im.*, p.name as product_name, p.code as product_code
      FROM inventory_movements im
      INNER JOIN products p ON im.product_id = p.id
      ORDER BY im.id DESC
      LIMIT 200
    `);
    res.json(result.rows);
  } catch (err) {
    sendSafeError(res, req, 'GET_INVENTORY_KARDEX_ALL', err, 'Error al consultar movimientos del Kardex.');
  }
});

app.get('/api/inventory/kardex/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const result = await db.query(`
      SELECT im.*, p.name as product_name, p.code as product_code
      FROM inventory_movements im
      INNER JOIN products p ON im.product_id = p.id
      WHERE im.product_id = ?
      ORDER BY im.id DESC
    `, [productId]);
    res.json(result.rows);
  } catch (err) {
    sendSafeError(res, req, 'GET_INVENTORY_KARDEX_PRODUCT', err, 'Error al consultar el Kardex del producto.');
  }
});

app.post('/api/inventory/adjustment', async (req, res) => {
  try {
    const { product_id, type, quantity, reason, reference_code, new_stock_target } = req.body;
    const pid = parseInt(product_id, 10);
    const qty = parseInt(quantity, 10);
    const cleanReason = String(reason || '').trim();
    const cleanType = String(type || '').trim().toUpperCase();

    if (!pid || isNaN(pid)) {
      return res.status(400).json({ error: 'Debe especificar un producto válido.' });
    }
    if (!cleanReason) {
      return res.status(400).json({ error: 'El motivo del ajuste o movimiento es obligatorio (ej. Factura compra #123, merma por rotura, inventario físico).' });
    }

    const prodRes = await db.query(`SELECT id, name, stock, is_serialized FROM products WHERE id = ?`, [pid]);
    const product = prodRes.rows[0];
    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado.' });
    }

    const prevStock = parseInt(product.stock, 10) || 0;
    let newStock = prevStock;
    let movementType = cleanType;
    let movementQty = qty;

    if (cleanType === 'ENTRADA' || cleanType === 'ENTRADA_COMPRA') {
      if (isNaN(qty) || qty <= 0) {
        return res.status(400).json({ error: 'La cantidad a ingresar debe ser mayor a 0.' });
      }
      movementType = 'ENTRADA';
      movementQty = qty;
      newStock = prevStock + qty;
    } else if (cleanType === 'SALIDA' || cleanType === 'SALIDA_MERMA') {
      if (isNaN(qty) || qty <= 0) {
        return res.status(400).json({ error: 'La cantidad a retirar debe ser mayor a 0.' });
      }
      movementType = 'SALIDA';
      movementQty = qty;
      if (prevStock < qty) {
        return res.status(400).json({ 
          error: `Stock insuficiente. Stock actual: ${prevStock}, cantidad a retirar: ${qty}.` 
        });
      }
      newStock = prevStock - qty;
    } else if (cleanType === 'AJUSTE') {
      movementType = 'AJUSTE';
      if (new_stock_target !== undefined && new_stock_target !== null && new_stock_target !== '') {
        const target = Math.max(0, parseInt(new_stock_target, 10) || 0);
        movementQty = Math.abs(target - prevStock);
        newStock = target;
      } else if (!isNaN(qty) && qty > 0) {
        movementQty = qty;
        newStock = qty;
      } else {
        return res.status(400).json({ error: 'Debe especificar la nueva cantidad real del inventario.' });
      }
    } else {
      return res.status(400).json({ error: 'Tipo de movimiento inválido. Use ENTRADA, SALIDA o AJUSTE.' });
    }

    const movement = await db.withTransaction(async (tx) => {
      await tx(`UPDATE products SET stock = ? WHERE id = ?`, [newStock, pid]);

      const insertRes = await tx(`
        INSERT INTO inventory_movements (product_id, type, quantity, previous_stock, new_stock, reason, reference_code, user_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `, [
        pid,
        movementType,
        movementQty,
        prevStock,
        newStock,
        cleanReason,
        reference_code || 'AJUSTE-MANUAL',
        req.user?.name || 'Administrador'
      ]);

      const movId = insertRes.lastID || (insertRes.rows && insertRes.rows[0] ? insertRes.rows[0].id : null);
      return {
        id: movId,
        product_id: pid,
        product_name: product.name,
        type: movementType,
        quantity: movementQty,
        previous_stock: prevStock,
        new_stock: newStock,
        reason: cleanReason,
        reference_code: reference_code || 'AJUSTE-MANUAL',
        user_name: req.user?.name || 'Administrador',
        created_at: new Date().toISOString()
      };
    });

    io.emit('product_updated', { action: 'stock_adjusted', productId: pid, newStock });
    io.emit('inventory_movement_added', movement);

    res.json({
      success: true,
      message: `Stock de "${product.name}" actualizado con éxito de ${prevStock} a ${newStock}.`,
      movement
    });
  } catch (err) {
    sendSafeError(res, req, 'STOCK_ADJUSTMENT', err, 'No se pudo registrar el movimiento de inventario.');
  }
});

// ==========================================
// 3. GESTIÓN Y TRAZABILIDAD DE IMEIS
// ==========================================

app.get('/api/imeis/available/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const result = await db.query(`
      SELECT * FROM device_imeis 
      WHERE product_id = ? AND status = 'disponible' 
      ORDER BY id ASC
    `, [productId]);
    res.json(result.rows);
  } catch (err) {
    sendSafeError(res, req, 'GET_AVAILABLE_IMEIS', err, 'Error al consultar los IMEIs disponibles.');
  }
});

app.post('/api/imeis', async (req, res) => {
  try {
    const { product_id, imeis, notes } = req.body;
    if (!product_id || !imeis || !Array.isArray(imeis) || imeis.length === 0) {
      return res.status(400).json({ error: 'Producto y al menos un código IMEI son requeridos.' });
    }

    let insertedCount = 0;
    for (const imei of imeis) {
      const cleanImei = String(imei).trim();
      if (cleanImei) {
        try {
          await db.query(`
            INSERT INTO device_imeis (product_id, imei_code, status, notes)
            VALUES (?, ?, 'disponible', ?)
          `, [product_id, cleanImei, notes || '']);
          insertedCount++;
        } catch (dupErr) {
          console.warn(`⚠️ IMEI ${cleanImei} omitido (duplicado o inválido):`, dupErr.message);
        }
      }
    }

    // Sincronizar stock con la cantidad real de IMEIs disponibles
    await db.syncSerializedProductStock(product_id);

    io.emit('product_updated', { action: 'imei_added', productId: product_id });
    res.json({ success: true, message: `${insertedCount} IMEIs registrados exitosamente.`, insertedCount });
  } catch (err) {
    sendSafeError(res, req, 'CREATE_IMEIS', err, 'Error al registrar el lote de IMEIs.');
  }
});

app.get('/api/imeis/search/:query', async (req, res) => {
  try {
    const { query } = req.params;
    const result = await db.query(`
      SELECT di.*, p.name as product_name, p.code as product_code, s.receipt_code, s.customer_name, s.payment_method, s.created_at as sale_date
      FROM device_imeis di
      INNER JOIN products p ON di.product_id = p.id
      LEFT JOIN sales s ON di.sale_id = s.id
      WHERE di.imei_code LIKE ?
      ORDER BY di.id DESC
    `, [`%${String(query).trim()}%`]);
    res.json(result.rows);
  } catch (err) {
    sendSafeError(res, req, 'SEARCH_IMEIS', err, 'Error al buscar trazabilidad del IMEI.');
  }
});

// ==========================================
// 4. VENTAS, PAGOS MIXTOS Y TICKETS
// ==========================================

app.get('/api/sales', async (req, res) => {
  try {
    const { from, to, limit } = req.query;
    let queryStr = `SELECT * FROM sales`;
    const params = [];
    const conditions = [];

    if (from) {
      conditions.push(`created_at >= ?`);
      params.push(`${from} 00:00:00`);
    }
    if (to) {
      conditions.push(`created_at <= ?`);
      params.push(`${to} 23:59:59`);
    }

    if (conditions.length > 0) {
      queryStr += ` WHERE ` + conditions.join(' AND ');
    }

    queryStr += ` ORDER BY id DESC`;

    if (!from && !to) {
      const lim = parseInt(limit, 10) || 200;
      queryStr += ` LIMIT ${lim}`;
    }

    const salesRes = await db.query(queryStr, params);
    const itemsRes = await db.query(`SELECT * FROM sale_items ORDER BY id ASC`);

    const salesWithItems = salesRes.rows.map(s => ({
      ...s,
      payment_details: parsePaymentDetails(s.payment_details, `sale_${s.id}`),
      items: itemsRes.rows.filter(i => i.sale_id === s.id)
    }));

    res.json(salesWithItems);
  } catch (err) {
    sendSafeError(res, req, 'GET_SALES', err, 'Error al consultar el historial de ventas.');
  }
});

app.get('/api/sales/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const saleRes = await db.query(`SELECT * FROM sales WHERE id = ?`, [id]);
    if (saleRes.rows.length === 0) return res.status(404).json({ error: 'Venta no encontrada' });

    const itemsRes = await db.query(`SELECT * FROM sale_items WHERE sale_id = ?`, [id]);
    const saleRow = saleRes.rows[0];

    res.json({
      ...saleRow,
      payment_details: parsePaymentDetails(saleRow.payment_details, `sale_${id}`),
      items: itemsRes.rows
    });
  } catch (err) {
    sendSafeError(res, req, 'GET_SALE_BY_ID', err, 'Error al obtener el comprobante de venta.');
  }
});

// Procesar Venta con transacción atómica, validación de caja abierta, descuentos y pagos mixtos
app.post('/api/sales', async (req, res) => {
  try {
    const { doc_type, customer_id, customer_name, payment_method, payment_details, items, paid_amount, change_amount, discount } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'El carrito no puede estar vacío.' });
    }

    // Verificar si la caja está abierta
    const checkCash = await db.query(`SELECT id FROM cash_registers WHERE status = 'abierta' ORDER BY id DESC LIMIT 1`);
    if (checkCash.rows.length === 0) {
      return res.status(400).json({ 
        error: '⚠️ La caja está cerrada. Debe abrir el turno de caja antes de realizar ventas.',
        cash_closed: true 
      });
    }
    const activeCashId = checkCash.rows[0].id;

    let grossTotal = 0;
    items.forEach(i => { grossTotal += Number(i.quantity) * Number(i.unit_price); });
    const discountAmount = Math.max(0, Math.min(grossTotal, parseFloat(discount) || 0));
    const total = Math.max(0, grossTotal - discountAmount);
    const subtotal = total / 1.18;
    const tax = total - subtotal;

    // Validar Stock antes de iniciar escritura
    for (const item of items) {
      if (item.product_id) {
        const prodCheck = await db.query(`SELECT name, stock FROM products WHERE id = ?`, [item.product_id]);
        const prod = prodCheck.rows[0];
        if (!prod || prod.stock < item.quantity) {
          return res.status(400).json({ error: `Stock insuficiente para ${item.product_name}. Stock disponible: ${prod ? prod.stock : 0}` });
        }
      }
    }

    const result = await db.withTransaction(async (tx) => {
      // Correlativo
      const cleanDocType = doc_type || 'Ticket';
      const prefijo = cleanDocType === 'Factura' ? 'F' : (cleanDocType === 'Boleta' ? 'B' : 'T');
      const counterRes = await tx(`SELECT last_number FROM counters WHERE doc_type = ?`, [cleanDocType]);
      const lastNum = counterRes.rows[0] ? parseInt(counterRes.rows[0].last_number, 10) : 0;
      const nextNum = lastNum + 1;
      const receipt_code = `${prefijo}001-${String(nextNum).padStart(6, '0')}`;

      await tx(`UPDATE counters SET last_number = ? WHERE doc_type = ?`, [nextNum, cleanDocType]);

      const paymentDetailsStr = payment_details ? JSON.stringify(payment_details) : '';

      // Registrar Cabecera de Venta con vínculo al turno de caja y descuento
      const saleInsert = await tx(`
        INSERT INTO sales (receipt_code, doc_type, customer_id, customer_name, payment_method, payment_details, subtotal, tax, discount, total, paid_amount, change_amount, cash_register_id, user_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `, [
        receipt_code,
        cleanDocType,
        customer_id || null,
        customer_name || 'Público General',
        payment_method,
        paymentDetailsStr,
        subtotal,
        tax,
        discountAmount,
        total,
        paid_amount !== undefined ? parseFloat(paid_amount) : total,
        parseFloat(change_amount) || 0,
        activeCashId,
        req.user?.name || 'Administrador'
      ]);

      const saleId = saleInsert.lastID || (saleInsert.rows && saleInsert.rows[0] ? saleInsert.rows[0].id : null);

      // Registrar Items, actualizar Stock e IMEIs
      for (const item of items) {
        const itemSubtotal = Number(item.quantity) * Number(item.unit_price);
        const imeiCode = item.imei || item.imei_code || '';
        let prodName = item.product_name || item.name || '';
        if (!prodName && item.product_id) {
          const pLookup = await tx(`SELECT name FROM products WHERE id = ?`, [item.product_id]);
          prodName = pLookup.rows[0]?.name || 'Producto';
        }
        if (!prodName) prodName = 'Producto Mostrador';

        await tx(`
          INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, subtotal, imei_code)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [saleId, item.product_id || null, prodName, item.quantity, item.unit_price, itemSubtotal, imeiCode]);

        if (imeiCode) {
          await tx(`
            UPDATE device_imeis 
            SET status = 'vendido', sale_id = ?, sold_at = CURRENT_TIMESTAMP 
            WHERE imei_code = ?
          `, [saleId, imeiCode]);
        }

        if (item.product_id) {
          const prodCheck = await tx(`SELECT stock FROM products WHERE id = ?`, [item.product_id]);
          const prevStock = prodCheck.rows[0] ? parseInt(prodCheck.rows[0].stock, 10) : 0;
          let newStock = prevStock;

          if (imeiCode) {
            await db.syncSerializedProductStock(item.product_id, tx);
            const updatedProd = await tx(`SELECT stock FROM products WHERE id = ?`, [item.product_id]);
            newStock = updatedProd.rows[0] ? parseInt(updatedProd.rows[0].stock, 10) : prevStock;
          } else {
            newStock = Math.max(0, prevStock - parseInt(item.quantity, 10));
            await tx(`UPDATE products SET stock = ? WHERE id = ?`, [newStock, item.product_id]);
          }

          await tx(`
            INSERT INTO inventory_movements (product_id, type, quantity, previous_stock, new_stock, reason, reference_code, user_name)
            VALUES (?, 'VENTA', ?, ?, ?, ?, ?, ?)
          `, [
            item.product_id,
            parseInt(item.quantity, 10),
            prevStock,
            newStock,
            `Venta en mostrador #${receipt_code}`,
            receipt_code,
            req.user?.name || 'Administrador'
          ]);
        }
      }

      // Registrar Crédito si aplica
      if ((payment_method === 'Crédito' || payment_method === 'Fiado') && customer_id) {
        const custRes = await tx(`SELECT debt FROM customers WHERE id = ?`, [customer_id]);
        const currentDebt = parseFloat(custRes.rows[0]?.debt || 0);
        const newDebt = currentDebt + total;
        const details = items.map(i => `${i.quantity}x ${i.product_name} ${i.imei ? '(IMEI: ' + i.imei + ')' : ''}`).join(', ');

        await tx(`UPDATE customers SET debt = ? WHERE id = ?`, [newDebt, customer_id]);
        await tx(`
          INSERT INTO fiado_records (customer_id, type, amount, details, balance_after, receipt_code, payment_method)
          VALUES (?, 'COMPRA_CREDITO', ?, ?, ?, ?, 'Crédito')
        `, [customer_id, total, details, newDebt, receipt_code]);
      }

      return { saleId, receipt_code, cleanDocType };
    });

    const completedSale = {
      id: result.saleId,
      receipt_code: result.receipt_code,
      doc_type: result.cleanDocType,
      customer_name: customer_name || 'Público General',
      payment_method,
      payment_details: payment_details || null,
      subtotal,
      tax,
      discount: discountAmount,
      total,
      paid_amount: paid_amount !== undefined ? parseFloat(paid_amount) : total,
      change_amount: parseFloat(change_amount) || 0,
      cash_register_id: activeCashId,
      created_at: new Date().toISOString(),
      items: items.map(i => ({ ...i, imei_code: i.imei || '' }))
    };

    io.emit('sale_completed', completedSale);
    io.emit('cash_updated');
    res.json({ success: true, sale: completedSale, receipt_code: result.receipt_code, saleId: result.saleId, total });
  } catch (err) {
    sendSafeError(res, req, 'CREATE_SALE', err, 'No se pudo procesar la venta.');
  }
});

// Anular Venta y restituir Stock + IMEIs + Deuda de forma transaccional (Solo Administrador)
app.put('/api/sales/:id/anular', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const saleRes = await db.query(`SELECT * FROM sales WHERE id = ?`, [id]);
    const sale = saleRes.rows[0];

    if (!sale) return res.status(404).json({ error: 'Venta no encontrada.' });
    if (sale.status === 'anulada') return res.status(400).json({ error: 'La venta ya está anulada.' });

    await db.withTransaction(async (tx) => {
      await tx(`UPDATE sales SET status = 'anulada' WHERE id = ?`, [id]);

      const itemsRes = await tx(`SELECT product_id, quantity, product_name, imei_code FROM sale_items WHERE sale_id = ?`, [id]);
      for (const item of itemsRes.rows) {
        if (item.imei_code) {
          await tx(`
            UPDATE device_imeis 
            SET status = 'disponible', sale_id = NULL, sold_at = NULL 
            WHERE imei_code = ?
          `, [item.imei_code]);
        }
        if (item.product_id) {
          const prodCheck = await tx(`SELECT stock FROM products WHERE id = ?`, [item.product_id]);
          const prevStock = prodCheck.rows[0] ? parseInt(prodCheck.rows[0].stock, 10) : 0;
          let newStock = prevStock;

          if (item.imei_code) {
            await db.syncSerializedProductStock(item.product_id, tx);
            const updatedProd = await tx(`SELECT stock FROM products WHERE id = ?`, [item.product_id]);
            newStock = updatedProd.rows[0] ? parseInt(updatedProd.rows[0].stock, 10) : prevStock;
          } else {
            newStock = prevStock + parseInt(item.quantity, 10);
            await tx(`UPDATE products SET stock = ? WHERE id = ?`, [newStock, item.product_id]);
          }

          await tx(`
            INSERT INTO inventory_movements (product_id, type, quantity, previous_stock, new_stock, reason, reference_code, user_name)
            VALUES (?, 'ANULACION', ?, ?, ?, ?, ?, ?)
          `, [
            item.product_id,
            parseInt(item.quantity, 10),
            prevStock,
            newStock,
            `Anulación de venta #${sale.receipt_code}`,
            sale.receipt_code,
            req.user?.name || 'Administrador'
          ]);
        }
      }

      if ((sale.payment_method === 'Crédito' || sale.payment_method === 'Fiado') && sale.customer_id) {
        const custRes = await tx(`SELECT debt FROM customers WHERE id = ?`, [sale.customer_id]);
        const currentDebt = parseFloat(custRes.rows[0]?.debt || 0);
        const newDebt = Math.max(0, currentDebt - parseFloat(sale.total));

        await tx(`UPDATE customers SET debt = ? WHERE id = ?`, [newDebt, sale.customer_id]);
        await tx(`
          INSERT INTO fiado_records (customer_id, type, amount, details, balance_after, receipt_code)
          VALUES (?, 'ANULACION', ?, ?, ?, ?)
        `, [sale.customer_id, parseFloat(sale.total), `Anulación venta #${sale.receipt_code}`, newDebt, sale.receipt_code]);
      }
    });

    io.emit('sale_annulled', { saleId: id });
    io.emit('cash_updated');
    res.json({ success: true, message: `Venta #${sale.receipt_code} anulada. Stock e IMEIs restituidos con éxito.` });
  } catch (err) {
    sendSafeError(res, req, 'ANNUL_SALE', err, 'No se pudo anular la venta.');
  }
});

// ==========================================
// 5. CONTROL DE CAJA Y ARQUEO Z (CON PAGOS MIXTOS, ABONOS E HISTORIAL)
// ==========================================

// Función auxiliar para calcular totales de un turno de caja
function calculateRegisterTotals(register, salesRows, movementsRows) {
  let efectivoSales = 0;
  let tarjetaSales = 0;
  let yapeSales = 0;
  let plinSales = 0;
  let creditoSales = 0;

  salesRows.forEach(r => {
    const tot = parseFloat(r.total || 0);
    if (r.payment_method === 'Mixto' && r.payment_details) {
      const det = parsePaymentDetails(r.payment_details, 'cash_register_calc');
      if (det) {
        efectivoSales += parseFloat(det.efectivo || 0);
        yapeSales += parseFloat(det.yape || 0);
        plinSales += parseFloat(det.plin || 0);
        tarjetaSales += parseFloat(det.tarjeta || 0);
      } else {
        efectivoSales += tot;
      }
    } else if (r.payment_method === 'Efectivo') {
      efectivoSales += tot;
    } else if (r.payment_method === 'Tarjeta') {
      tarjetaSales += tot;
    } else if (r.payment_method === 'Yape') {
      yapeSales += tot;
    } else if (r.payment_method === 'Plin') {
      plinSales += tot;
    } else if (r.payment_method === 'Yape/Plin') {
      yapeSales += tot;
    } else if (r.payment_method === 'Crédito' || r.payment_method === 'Fiado') {
      creditoSales += tot;
    }
  });

  let ingresos = 0;
  let retiros = 0;
  let abonosEfectivo = 0;
  let abonosDigital = 0;

  movementsRows.forEach(m => {
    const a = parseFloat(m.amount || 0);
    if (m.type === 'INGRESO') {
      if (!m.payment_method || m.payment_method === 'Efectivo') {
        ingresos += a;
      } else {
        abonosDigital += a;
      }
    } else if (m.type === 'RETIRO') {
      retiros += a;
    } else if (m.type === 'ABONO') {
      if (m.payment_method === 'Efectivo') {
        abonosEfectivo += a;
      } else {
        abonosDigital += a;
      }
    }
  });

  const initial = parseFloat(register.initial_amount || 0);
  const expectedCash = initial + efectivoSales + abonosEfectivo + ingresos - retiros;
  const expectedDigital = yapeSales + plinSales + tarjetaSales + abonosDigital;

  return {
    initialAmount: initial,
    efectivoSales,
    tarjetaSales,
    yapeSales: yapeSales + plinSales,
    creditoSales,
    abonosEfectivo,
    abonosDigital,
    totalSales: efectivoSales + tarjetaSales + yapeSales + plinSales + creditoSales,
    ingresos,
    retiros,
    expectedCash,
    expectedDigital
  };
}

app.get('/api/cash/status', async (req, res) => {
  try {
    const regRes = await db.query(`SELECT * FROM cash_registers WHERE status = 'abierta' ORDER BY id DESC LIMIT 1`);
    const activeRegister = regRes.rows[0] || null;

    if (!activeRegister) {
      return res.json({ isOpen: false, register: null });
    }

    // Obtener ventas completadas del turno actual por cash_register_id (o por fecha de apertura como respaldo)
    const salesRes = await db.query(`
      SELECT payment_method, payment_details, total 
      FROM sales 
      WHERE status = 'completada' AND (cash_register_id = ? OR (cash_register_id IS NULL AND created_at >= ?))
    `, [activeRegister.id, activeRegister.opened_at]);

    // Movimientos manuales y abonos del turno
    const movsRes = await db.query(`
      SELECT * FROM cash_movements 
      WHERE cash_register_id = ?
      ORDER BY id DESC
    `, [activeRegister.id]);

    const totals = calculateRegisterTotals(activeRegister, salesRes.rows, movsRes.rows);

    res.json({
      isOpen: true,
      register: activeRegister,
      ...totals,
      movements: movsRes.rows
    });
  } catch (err) {
    sendSafeError(res, req, 'GET_CASH_STATUS', err, 'Error al consultar el estado de caja.');
  }
});

app.get('/api/cash/history', async (req, res) => {
  try {
    const historyRes = await db.query(`
      SELECT * FROM cash_registers 
      WHERE status = 'cerrada' 
      ORDER BY id DESC LIMIT 50
    `);
    res.json(historyRes.rows);
  } catch (err) {
    sendSafeError(res, req, 'GET_CASH_HISTORY', err, 'Error al consultar el historial de cierres de caja.');
  }
});

app.post('/api/cash/open', async (req, res) => {
  try {
    const { initial_amount, user_name } = req.body;
    const checkOpen = await db.query(`SELECT id FROM cash_registers WHERE status = 'abierta'`);
    if (checkOpen.rows.length > 0) {
      return res.status(400).json({ error: 'Ya existe una caja abierta actualmente.' });
    }

    await db.query(`
      INSERT INTO cash_registers (user_name, initial_amount, status)
      VALUES (?, ?, 'abierta')
    `, [user_name || req.user?.name || 'Administrador', parseFloat(initial_amount) || 0]);

    io.emit('cash_updated');
    res.json({ success: true, message: 'Caja abierta exitosamente.' });
  } catch (err) {
    sendSafeError(res, req, 'OPEN_CASH', err, 'No se pudo abrir la caja.');
  }
});

app.post('/api/cash/movement', async (req, res) => {
  try {
    const { type, amount, reason, payment_method } = req.body;
    const checkOpen = await db.query(`SELECT id FROM cash_registers WHERE status = 'abierta' ORDER BY id DESC LIMIT 1`);
    if (checkOpen.rows.length === 0) {
      return res.status(400).json({ error: 'No hay ninguna caja abierta.' });
    }

    const regId = checkOpen.rows[0].id;
    await db.query(`
      INSERT INTO cash_movements (cash_register_id, type, amount, reason, payment_method, user_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [regId, type, parseFloat(amount), String(reason || '').trim(), payment_method || 'Efectivo', req.user?.name || 'Administrador']);

    io.emit('cash_updated');
    res.json({ success: true, message: `Movimiento de ${type} registrado con éxito.` });
  } catch (err) {
    sendSafeError(res, req, 'CASH_MOVEMENT', err, 'No se pudo registrar el movimiento de caja.');
  }
});

app.post('/api/cash/close', async (req, res) => {
  try {
    const { final_amount, notes } = req.body;
    const checkOpen = await db.query(`SELECT * FROM cash_registers WHERE status = 'abierta' ORDER BY id DESC LIMIT 1`);
    if (checkOpen.rows.length === 0) {
      return res.status(400).json({ error: 'No hay ninguna caja abierta.' });
    }

    const reg = checkOpen.rows[0];

    const salesRes = await db.query(`
      SELECT payment_method, payment_details, total 
      FROM sales 
      WHERE status = 'completada' AND (cash_register_id = ? OR (cash_register_id IS NULL AND created_at >= ?))
    `, [reg.id, reg.opened_at]);

    const movsRes = await db.query(`SELECT type, amount, payment_method FROM cash_movements WHERE cash_register_id = ?`, [reg.id]);

    const totals = calculateRegisterTotals(reg, salesRes.rows, movsRes.rows);
    const expected = totals.expectedCash;
    const finalAmt = parseFloat(final_amount) || 0;
    const difference = finalAmt - expected;
    const closedAtIso = new Date().toISOString();

    await db.query(`
      UPDATE cash_registers 
      SET status = 'cerrada', final_amount = ?, expected_amount = ?, difference = ?, notes = ?, closed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [finalAmt, expected, difference, notes || '', reg.id]);

    io.emit('cash_updated');
    res.json({
      success: true,
      message: 'Caja cerrada y Arqueo Z generado.',
      summary: {
        registerId: reg.id,
        userName: reg.user_name || 'Administrador',
        openedAt: reg.opened_at,
        closedAt: closedAtIso,
        initialAmount: totals.initialAmount,
        efectivoSales: totals.efectivoSales,
        yapeSales: totals.yapeSales,
        tarjetaSales: totals.tarjetaSales,
        creditoSales: totals.creditoSales,
        abonosEfectivo: totals.abonosEfectivo,
        abonosDigital: totals.abonosDigital,
        totalSales: totals.totalSales,
        ingresos: totals.ingresos,
        retiros: totals.retiros,
        expectedAmount: expected,
        finalAmount: finalAmt,
        difference,
        notes: notes || ''
      }
    });
  } catch (err) {
    sendSafeError(res, req, 'CLOSE_CASH', err, 'No se pudo cerrar la caja.');
  }
});

// ==========================================
// 6. CRM, CRÉDITOS Y ABONOS CON RECIBO TÉRMICO
// ==========================================

app.get('/api/customers', async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM customers ORDER BY name ASC`);
    res.json(result.rows);
  } catch (err) {
    sendSafeError(res, req, 'GET_CUSTOMERS', err, 'Error al consultar la cartera de clientes.');
  }
});

app.post('/api/customers', async (req, res) => {
  try {
    const { doc, name, phone, address } = req.body;
    const cleanDoc = String(doc || '').trim();
    const cleanName = String(name || '').trim();
    if (!cleanDoc || !cleanName) return res.status(400).json({ error: 'DNI/RUC y Nombre son requeridos.' });

    const insertRes = await db.query(
      `INSERT INTO customers (doc, name, phone, address, debt) VALUES (?, ?, ?, ?, 0) RETURNING id`,
      [cleanDoc, cleanName, String(phone || '').trim(), String(address || '').trim()]
    );
    const customerId = insertRes.lastID || (insertRes.rows && insertRes.rows[0] ? insertRes.rows[0].id : null);

    res.json({
      success: true,
      customerId,
      customer: { id: customerId, doc: cleanDoc, name: cleanName, phone: phone || '', address: address || '', debt: 0 },
      message: 'Cliente registrado con éxito.'
    });
  } catch (err) {
    sendSafeError(res, req, 'CREATE_CUSTOMER', err, 'No se pudo registrar el cliente.');
  }
});

app.put('/api/customers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { doc, name, phone, address } = req.body;
    const cleanDoc = String(doc || '').trim();
    const cleanName = String(name || '').trim();
    if (!cleanDoc || !cleanName) return res.status(400).json({ error: 'DNI/RUC y Nombre son requeridos.' });

    await db.query(
      `UPDATE customers SET doc = ?, name = ?, phone = ?, address = ? WHERE id = ?`,
      [cleanDoc, cleanName, String(phone || '').trim(), String(address || '').trim(), id]
    );
    res.json({ success: true, message: 'Datos del cliente actualizados correctamente.' });
  } catch (err) {
    sendSafeError(res, req, 'UPDATE_CUSTOMER', err, 'No se pudo actualizar el cliente.');
  }
});

// Registrar Abono a Crédito con generación de Recibo Térmico
app.post('/api/credits/abono', async (req, res) => {
  try {
    const { customer_id, amount, payment_method } = req.body;
    const abonoAmt = parseFloat(amount);
    const method = payment_method || 'Efectivo';

    if (!customer_id || isNaN(abonoAmt) || abonoAmt <= 0) {
      return res.status(400).json({ error: 'Monto de abono válido es requerido.' });
    }

    const custRes = await db.query(`SELECT id, debt, name, doc FROM customers WHERE id = ?`, [customer_id]);
    const customer = custRes.rows[0];
    if (!customer) return res.status(404).json({ error: 'Cliente no encontrado.' });

    const currentDebt = parseFloat(customer.debt || 0);
    if (currentDebt <= 0) {
      return res.status(400).json({ error: '⚠️ El cliente no registra deudas pendientes.' });
    }

    if (abonoAmt > currentDebt) {
      return res.status(400).json({ error: `⚠️ El monto a abonar (S/ ${abonoAmt.toFixed(2)}) no puede ser mayor a la deuda pendiente (S/ ${currentDebt.toFixed(2)}).` });
    }

    const newDebt = Math.max(0, currentDebt - abonoAmt);

    const receipt_code = await db.withTransaction(async (tx) => {
      // Correlativo para Recibo de Abono
      const counterRes = await tx(`SELECT last_number FROM counters WHERE doc_type = 'ReciboAbono'`);
      const lastNum = counterRes.rows[0] ? parseInt(counterRes.rows[0].last_number, 10) : 0;
      const nextNum = lastNum + 1;
      const code = `REC-001-${String(nextNum).padStart(6, '0')}`;
      await tx(`UPDATE counters SET last_number = ? WHERE doc_type = 'ReciboAbono'`, [nextNum]);

      // Actualizar deuda del cliente
      await tx(`UPDATE customers SET debt = ? WHERE id = ?`, [newDebt, customer_id]);

      // Registrar en historial de créditos
      await tx(`
        INSERT INTO fiado_records (customer_id, type, amount, details, balance_after, receipt_code, payment_method)
        VALUES (?, 'ABONO', ?, ?, ?, ?, ?)
      `, [customer_id, abonoAmt, `Abono a cuenta (${method})`, newDebt, code, method]);

      // Si hay caja abierta, registrar en movimientos de caja
      const activeCash = await tx(`SELECT id FROM cash_registers WHERE status = 'abierta' ORDER BY id DESC LIMIT 1`);
      if (activeCash.rows.length > 0) {
        await tx(`
          INSERT INTO cash_movements (cash_register_id, type, amount, reason, payment_method, user_name)
          VALUES (?, 'ABONO', ?, ?, ?, ?)
        `, [activeCash.rows[0].id, abonoAmt, `ABONO CRÉDITO: ${customer.name} (#${code})`, method, req.user?.name || 'Administrador']);
      }

      return code;
    });

    const abonoReceipt = {
      receipt_code,
      customer_id: customer.id,
      customer_name: customer.name,
      customer_doc: customer.doc,
      amount: abonoAmt,
      previous_debt: currentDebt,
      new_debt: newDebt,
      payment_method: method,
      created_at: new Date().toISOString()
    };

    io.emit('abono_registered', { customerId: customer_id, newDebt });
    io.emit('cash_updated');

    res.json({
      success: true,
      message: `Abono de S/ ${abonoAmt.toFixed(2)} registrado correctamente.`,
      abonoReceipt
    });
  } catch (err) {
    sendSafeError(res, req, 'REGISTER_ABONO', err, 'No se pudo procesar el abono.');
  }
});

// Alias para compatibilidad
app.post('/api/fiados/abono', (req, res, next) => {
  req.url = '/api/credits/abono';
  app.handle(req, res, next);
});

app.get('/api/credits/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const result = await db.query(`SELECT * FROM fiado_records WHERE customer_id = ? ORDER BY id DESC`, [customerId]);
    res.json(result.rows);
  } catch (err) {
    sendSafeError(res, req, 'GET_CUSTOMER_CREDITS', err, 'Error al consultar el estado de cuenta del cliente.');
  }
});

app.get('/api/fiados/:customerId', (req, res, next) => {
  req.url = `/api/credits/${req.params.customerId}`;
  app.handle(req, res, next);
});

// ==========================================
// 7. SERVICIO TÉCNICO / TALLER DE REPARACIONES
// ==========================================

app.get('/api/repairs', async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM repair_orders ORDER BY id DESC LIMIT 200`);
    res.json(result.rows);
  } catch (err) {
    sendSafeError(res, req, 'GET_REPAIRS', err, 'Error al consultar las órdenes de servicio técnico.');
  }
});

app.post('/api/repairs', async (req, res) => {
  try {
    const {
      customer_id,
      customer_name,
      customer_phone,
      device_brand,
      device_model,
      imei_or_serial,
      unlock_pattern,
      issue_description,
      diagnosis,
      estimated_cost,
      advance_payment,
      payment_method,
      notes
    } = req.body;

    const cleanCustomerName = String(customer_name || '').trim();
    const cleanBrand = String(device_brand || '').trim();
    const cleanModel = String(device_model || '').trim();
    const cleanIssue = String(issue_description || '').trim();

    if (!cleanCustomerName || !cleanBrand || !cleanModel || !cleanIssue) {
      return res.status(400).json({ error: 'Cliente, Marca, Modelo y Falla reportada son obligatorios.' });
    }

    const estCost = Math.max(0, parseFloat(estimated_cost) || 0);
    const advPay = Math.max(0, parseFloat(advance_payment) || 0);
    const method = payment_method || 'Efectivo';

    const createdOrder = await db.withTransaction(async (tx) => {
      const counterRes = await tx(`SELECT last_number FROM counters WHERE doc_type = 'OrdenServicio'`);
      const lastNum = counterRes.rows[0] ? parseInt(counterRes.rows[0].last_number, 10) : 0;
      const nextNum = lastNum + 1;
      const order_code = `OS-001-${String(nextNum).padStart(6, '0')}`;
      await tx(`UPDATE counters SET last_number = ? WHERE doc_type = 'OrdenServicio'`, [nextNum]);

      const insRes = await tx(`
        INSERT INTO repair_orders (
          order_code, customer_id, customer_name, customer_phone,
          device_brand, device_model, imei_or_serial, unlock_pattern,
          issue_description, diagnosis, estimated_cost, advance_payment,
          payment_method, status, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Recibido', ?)
        RETURNING id
      `, [
        order_code,
        customer_id || null,
        cleanCustomerName,
        String(customer_phone || '').trim(),
        cleanBrand,
        cleanModel,
        String(imei_or_serial || '').trim(),
        String(unlock_pattern || '').trim(),
        cleanIssue,
        String(diagnosis || '').trim(),
        estCost,
        advPay,
        method,
        String(notes || '').trim()
      ]);

      const orderId = insRes.lastID || (insRes.rows && insRes.rows[0] ? insRes.rows[0].id : null);

      // Si el cliente deja adelanto y hay caja abierta, registrar ingreso en caja
      if (advPay > 0) {
        const activeCash = await tx(`SELECT id FROM cash_registers WHERE status = 'abierta' ORDER BY id DESC LIMIT 1`);
        if (activeCash.rows.length > 0) {
          await tx(`
            INSERT INTO cash_movements (cash_register_id, type, amount, reason, payment_method, user_name)
            VALUES (?, 'INGRESO', ?, ?, ?, ?)
          `, [
            activeCash.rows[0].id,
            advPay,
            `ADELANTO SERVICIO TÉCNICO #${order_code} (${cleanBrand} ${cleanModel} - ${cleanCustomerName})`,
            method,
            req.user?.name || 'Administrador'
          ]);
        }
      }

      return {
        id: orderId,
        order_code,
        customer_id: customer_id || null,
        customer_name: cleanCustomerName,
        customer_phone: String(customer_phone || '').trim(),
        device_brand: cleanBrand,
        device_model: cleanModel,
        imei_or_serial: String(imei_or_serial || '').trim(),
        unlock_pattern: String(unlock_pattern || '').trim(),
        issue_description: cleanIssue,
        diagnosis: String(diagnosis || '').trim(),
        estimated_cost: estCost,
        advance_payment: advPay,
        payment_method: method,
        status: 'Recibido',
        notes: String(notes || '').trim(),
        created_at: new Date().toISOString()
      };
    });

    io.emit('repair_updated', createdOrder);
    if (advPay > 0) io.emit('cash_updated');

    res.json({
      success: true,
      message: `Orden de Servicio #${createdOrder.order_code} registrada exitosamente.`,
      order: createdOrder
    });
  } catch (err) {
    sendSafeError(res, req, 'CREATE_REPAIR_ORDER', err, 'No se pudo registrar la orden de servicio técnico.');
  }
});

app.put('/api/repairs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, diagnosis, estimated_cost, notes, collect_balance, payment_method } = req.body;

    const currentRes = await db.query(`SELECT * FROM repair_orders WHERE id = ?`, [id]);
    const order = currentRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Orden de servicio no encontrada.' });

    const newStatus = status || order.status;
    const newDiagnosis = diagnosis !== undefined ? String(diagnosis).trim() : order.diagnosis;
    const newCost = estimated_cost !== undefined ? Math.max(0, parseFloat(estimated_cost) || 0) : parseFloat(order.estimated_cost || 0);
    const newNotes = notes !== undefined ? String(notes).trim() : order.notes;
    const currentAdvance = parseFloat(order.advance_payment || 0);
    const pendingBalance = Math.max(0, newCost - currentAdvance);
    const method = payment_method || 'Efectivo';

    let finalAdvance = currentAdvance;

    await db.withTransaction(async (tx) => {
      if (collect_balance && pendingBalance > 0) {
        finalAdvance = newCost;
        const activeCash = await tx(`SELECT id FROM cash_registers WHERE status = 'abierta' ORDER BY id DESC LIMIT 1`);
        if (activeCash.rows.length > 0) {
          await tx(`
            INSERT INTO cash_movements (cash_register_id, type, amount, reason, payment_method, user_name)
            VALUES (?, 'INGRESO', ?, ?, ?, ?)
          `, [
            activeCash.rows[0].id,
            pendingBalance,
            `SALDO SERVICIO TÉCNICO #${order.order_code} (${order.device_brand} ${order.device_model} - ${order.customer_name})`,
            method,
            req.user?.name || 'Administrador'
          ]);
        }
      }

      if (newStatus === 'Entregado') {
        await tx(`
          UPDATE repair_orders 
          SET status = ?, diagnosis = ?, estimated_cost = ?, advance_payment = ?, notes = ?, delivered_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [newStatus, newDiagnosis, newCost, finalAdvance, newNotes, id]);
      } else {
        await tx(`
          UPDATE repair_orders 
          SET status = ?, diagnosis = ?, estimated_cost = ?, advance_payment = ?, notes = ?
          WHERE id = ?
        `, [newStatus, newDiagnosis, newCost, finalAdvance, newNotes, id]);
      }
    });

    io.emit('repair_updated', { id, status: newStatus });
    if (collect_balance && pendingBalance > 0) io.emit('cash_updated');

    res.json({
      success: true,
      message: `Orden #${order.order_code} actualizada a estado "${newStatus}".`
    });
  } catch (err) {
    sendSafeError(res, req, 'UPDATE_REPAIR_ORDER', err, 'No se pudo actualizar la orden de servicio técnico.');
  }
});

// ==========================================
// 8. DASHBOARD (VENTAS, UTILIDAD NETA Y STOCK CRÍTICO)
// ==========================================
app.get('/api/dashboard', async (req, res) => {
  try {
    // Calcular el inicio del día en hora local de Perú (UTC-5) para evitar reinicio prematuro a las 7:00 PM
    const now = new Date();
    const peruOffsetMs = -5 * 60 * 60 * 1000;
    const peruDate = new Date(now.getTime() + peruOffsetMs);
    const yyyyMmDd = peruDate.toISOString().slice(0, 10);
    // Medianoche de Perú expresada en UTC (05:00:00Z del día en curso)
    const startOfPeruDayUtc = `${yyyyMmDd} 05:00:00`;

    const salesRes = await db.query(`
      SELECT COALESCE(SUM(total), 0) AS totalSales, COALESCE(SUM(discount), 0) AS totalDiscount, COUNT(id) AS ticketsCount
      FROM sales 
      WHERE created_at >= ? AND status = 'completada'
    `, [startOfPeruDayUtc]);

    // Calcular ganancia bruta de los ítems vendidos hoy
    const profitRes = await db.query(`
      SELECT COALESCE(SUM((si.unit_price - COALESCE(p.purchase_price, 0)) * si.quantity), 0) AS grossProfit
      FROM sale_items si
      INNER JOIN sales s ON si.sale_id = s.id
      LEFT JOIN products p ON si.product_id = p.id
      WHERE s.created_at >= ? AND s.status = 'completada'
    `, [startOfPeruDayUtc]);

    const fiadosRes = await db.query(`SELECT COALESCE(SUM(debt), 0) AS totalDebt FROM customers`);
    const topRes = await db.query(`
      SELECT si.product_name, SUM(si.quantity) as totalQty 
      FROM sale_items si
      INNER JOIN sales s ON si.sale_id = s.id
      WHERE s.status = 'completada'
      GROUP BY si.product_name 
      ORDER BY totalQty DESC LIMIT 1
    `);

    const lowStockListRes = await db.query(`
      SELECT id, code, name, category, stock, min_stock, price 
      FROM products 
      WHERE stock <= min_stock 
      ORDER BY stock ASC, name ASC
    `);

    const activeRepairsRes = await db.query(`
      SELECT COUNT(id) as activeCount 
      FROM repair_orders 
      WHERE status IN ('Recibido', 'En Reparación', 'Listo')
    `);

    const todaySales = parseFloat(salesRes.rows[0]?.totalsales || salesRes.rows[0]?.totalSales || 0);
    const todayDiscount = parseFloat(salesRes.rows[0]?.totaldiscount || salesRes.rows[0]?.totalDiscount || 0);
    const grossProfit = parseFloat(profitRes.rows[0]?.grossprofit || profitRes.rows[0]?.grossProfit || 0);
    const isVendor = req.user && String(req.user.role || '').toLowerCase() === 'vendedor';
    const todayProfit = isVendor ? null : Math.max(0, grossProfit - todayDiscount);

    res.json({
      todaySales,
      todayTickets: parseInt(salesRes.rows[0]?.ticketscount || salesRes.rows[0]?.ticketsCount || 0, 10),
      todayProfit,
      isVendor,
      totalFiadosDebt: parseFloat(fiadosRes.rows[0]?.totaldebt || fiadosRes.rows[0]?.totalDebt || 0),
      topProduct: topRes.rows[0]?.product_name || 'N/A',
      lowStockCount: lowStockListRes.rows.length,
      lowStockProducts: lowStockListRes.rows,
      activeRepairsCount: parseInt(activeRepairsRes.rows[0]?.activecount || activeRepairsRes.rows[0]?.activeCount || 0, 10)
    });
  } catch (err) {
    sendSafeError(res, req, 'GET_DASHBOARD', err, 'Error al cargar métricas del Dashboard.');
  }
});

// Fallback SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor CELLVENTAS activo en http://localhost:${PORT}`);
});

