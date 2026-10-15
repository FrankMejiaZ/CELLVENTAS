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

// Middleware para capturar JSON malformado (Bug A8)
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'JSON malformado en el cuerpo de la solicitud.' });
  }
  next(err);
});

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
  const msg = String(err?.message || '').toLowerCase();
  const isUniqueViolation = msg.includes('unique') || msg.includes('duplicate');
  if (isUniqueViolation) {
    return res.status(400).json({ error: '⚠️ Ya existe un registro con ese código, documento, número o nombre único.' });
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

// Middleware para requerir autenticación general (Bug A1, A2)
function requireAuth(req, res, next) {
  if (!req.user || !req.user.id) {
    return res.status(401).json({ error: 'Acceso no autorizado. Debe iniciar sesión.' });
  }
  next();
}

// Middleware para restringir operaciones críticas a Administrador (Bug A3, J5, E5)
function requireAdmin(req, res, next) {
  if (!req.user || String(req.user.role || '').toLowerCase() !== 'administrador') {
    return res.status(403).json({ error: 'Acceso denegado. Esta acción requiere permisos de Administrador.' });
  }
  next();
}

// Helper para validar métodos de pago permitidos (Bug F9, H5)
const VALID_PAYMENT_METHODS = ['Efectivo', 'Tarjeta', 'Yape', 'Plin', 'Yape/Plin', 'Mixto', 'Crédito', 'Fiado'];
function isValidPaymentMethod(method) {
  return VALID_PAYMENT_METHODS.includes(String(method || '').trim());
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
    // Búsqueda insensible a mayúsculas para evitar el Bug A6
    const userRes = await db.query(`SELECT * FROM users WHERE LOWER(username) = LOWER(?)`, [cleanUser]);
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

app.get('/api/users', (req, res, next) => {
  if (!req.user || !req.user.id) {
    return res.status(401).json([]);
  }
  next();
}, async (req, res) => {
  try {
    const result = await db.query(`SELECT id, username, name, role, created_at FROM users ORDER BY id ASC`);
    res.json(result.rows);
  } catch (err) {
    sendSafeError(res, req, 'GET_USERS', err, 'Error al consultar usuarios.');
  }
});

app.put('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
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

    const VALID_ROLES = ['Administrador', 'Vendedor', 'Técnico'];
    if (!VALID_ROLES.includes(cleanRole)) {
      return res.status(400).json({ error: `Rol inválido. Los roles permitidos son: ${VALID_ROLES.join(', ')}.` });
    }

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

app.post('/api/brands', requireAuth, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name || name.length < 2 || name.length > 50) {
      return res.status(400).json({ error: 'El nombre de marca debe tener entre 2 y 50 caracteres.' });
    }

    // Comprobación de duplicados insensible a mayúsculas (Bug J1)
    const existing = await db.query(`SELECT id FROM brands WHERE LOWER(name) = LOWER(?)`, [name]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: `La marca "${name}" ya está registrada.` });
    }

    await db.query(`INSERT INTO brands (name) VALUES (?)`, [name]);
    io.emit('compatibility_updated');
    res.json({ success: true, message: 'Marca registrada exitosamente.' });
  } catch (err) {
    sendSafeError(res, req, 'CREATE_BRAND', err, 'No se pudo registrar la marca.');
  }
});

app.post('/api/models', requireAuth, async (req, res) => {
  try {
    const { brand_id, model_name, release_year } = req.body;
    const bid = parseInt(brand_id, 10);
    const cleanModelName = String(model_name || '').trim();
    const year = parseInt(release_year, 10) || 2024;

    if (!bid || isNaN(bid)) {
      return res.status(400).json({ error: 'Debe seleccionar una marca válida.' });
    }
    if (!cleanModelName || cleanModelName.length < 2 || cleanModelName.length > 100) {
      return res.status(400).json({ error: 'El nombre del modelo debe tener entre 2 y 100 caracteres.' });
    }
    if (year < 2000 || year > 2050) {
      return res.status(400).json({ error: 'El año de lanzamiento debe estar entre 2000 y 2050.' });
    }

    // Verificar que la marca exista
    const brandCheck = await db.query(`SELECT id FROM brands WHERE id = ?`, [bid]);
    if (brandCheck.rows.length === 0) {
      return res.status(404).json({ error: 'La marca seleccionada no existe.' });
    }

    // Comprobar duplicado en la misma marca (Bug J2)
    const dupCheck = await db.query(`SELECT id FROM phone_models WHERE brand_id = ? AND LOWER(model_name) = LOWER(?)`, [bid, cleanModelName]);
    if (dupCheck.rows.length > 0) {
      return res.status(400).json({ error: `El modelo "${cleanModelName}" ya existe en esta marca.` });
    }

    await db.query(
      `INSERT INTO phone_models (brand_id, model_name, release_year) VALUES (?, ?, ?)`,
      [bid, cleanModelName, year]
    );
    io.emit('compatibility_updated');
    res.json({ success: true, message: 'Modelo de celular registrado exitosamente.' });
  } catch (err) {
    sendSafeError(res, req, 'CREATE_MODEL', err, 'No se pudo registrar el modelo de celular.');
  }
});

app.delete('/api/models/:id', requireAdmin, async (req, res) => {
  try {
    const mid = parseInt(req.params.id, 10);
    if (!mid || isNaN(mid)) {
      return res.status(400).json({ error: 'ID de modelo inválido.' });
    }

    const check = await db.query(`SELECT id FROM phone_models WHERE id = ?`, [mid]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Modelo no encontrado.' });
    }

    await db.query(`DELETE FROM phone_models WHERE id = ?`, [mid]);
    io.emit('compatibility_updated');
    res.json({ success: true, message: 'Modelo eliminado del catálogo.' });
  } catch (err) {
    sendSafeError(res, req, 'DELETE_MODEL', err, 'No se pudo eliminar el modelo.');
  }
});

// ASISTENTE DE MOSTRADOR: FICHA 360° DE COMPATIBILIDADES
app.get('/api/compatibilities/assistant/:modelId', async (req, res) => {
  try {
    const mid = parseInt(req.params.modelId, 10);
    if (!mid || isNaN(mid)) {
      return res.status(400).json({ error: 'ID de modelo de celular no válido.' });
    }

    const modelRes = await db.query(`
      SELECT pm.*, b.name as brand_name 
      FROM phone_models pm 
      INNER JOIN brands b ON pm.brand_id = b.id 
      WHERE pm.id = ?
    `, [mid]);

    if (modelRes.rows.length === 0) {
      return res.status(404).json({ error: 'Modelo no encontrado en el sistema.' });
    }

    const modelInfo = modelRes.rows[0];

    const prodsRes = await db.query(`
      SELECT p.*
      FROM products p
      INNER JOIN product_compatibilities pc ON p.id = pc.product_id
      WHERE pc.phone_model_id = ? AND (p.is_active = 1 OR p.is_active IS NULL)
      ORDER BY p.category ASC, p.name ASC
    `, [mid]);

    const allCompatsRes = await db.query(`
      SELECT pc.product_id, pm.id as model_id, pm.model_name, b.name as brand_name
      FROM product_compatibilities pc
      INNER JOIN phone_models pm ON pc.phone_model_id = pm.id
      INNER JOIN brands b ON pm.brand_id = b.id
    `);

    const products = prodsRes.rows.map(p => {
      const otherModels = allCompatsRes.rows
        .filter(c => c.product_id === p.id && String(c.model_id) !== String(mid))
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
      SELECT DISTINCT pc.phone_model_id, p.id as product_id, p.name, p.category, p.stock
      FROM product_compatibilities pc
      INNER JOIN products p ON pc.product_id = p.id
      WHERE (p.is_active = 1 OR p.is_active IS NULL)
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
app.post('/api/compatibilities/bulk', requireAuth, async (req, res) => {
  try {
    const { product_id, model_ids } = req.body;
    const pid = parseInt(product_id, 10);
    if (!pid || isNaN(pid) || !Array.isArray(model_ids)) {
      return res.status(400).json({ error: 'Producto y lista de modelos requeridos.' });
    }

    const prodCheck = await db.query(`SELECT id FROM products WHERE id = ?`, [pid]);
    if (prodCheck.rows.length === 0) {
      return res.status(404).json({ error: 'El producto especificado no existe.' });
    }

    // Desduplicar IDs con Set para evitar colisiones y filas duplicadas (Bug C6)
    const uniqueModelIds = [...new Set(model_ids.map(Number).filter(id => Number.isInteger(id) && id > 0))];

    await db.withTransaction(async (tx) => {
      await tx(`DELETE FROM product_compatibilities WHERE product_id = ?`, [pid]);
      for (const mId of uniqueModelIds) {
        await tx(`INSERT INTO product_compatibilities (product_id, phone_model_id) VALUES (?, ?)`, [pid, mId]);
      }
    });

    io.emit('compatibility_updated');
    res.json({ success: true, message: `Compatibilidad actualizada (${uniqueModelIds.length} modelos asignados).` });
  } catch (err) {
    sendSafeError(res, req, 'BULK_COMPATIBILITY', err, 'No se pudo actualizar la matriz de compatibilidad.');
  }
});

// ==========================================
// 2. PRODUCTOS E INVENTARIO
// ==========================================

app.get('/api/products', async (req, res) => {
  try {
    const includeInactive = req.query.include_inactive === 'true' && req.user?.role === 'Administrador';
    const whereClause = includeInactive ? '' : 'WHERE (p.is_active = 1 OR p.is_active IS NULL)';

    const prods = await db.query(`SELECT p.* FROM products p ${whereClause} ORDER BY p.id DESC`);
    const compats = await db.query(`
      SELECT pc.product_id, pm.id as model_id, pm.model_name, b.name as brand_name
      FROM product_compatibilities pc
      INNER JOIN phone_models pm ON pc.phone_model_id = pm.id
      INNER JOIN brands b ON pm.brand_id = b.id
    `);

    const productsWithModels = prods.rows.map(p => ({
      ...p,
      price: Math.round(Number(p.price) * 100) / 100,
      purchase_price: Math.round(Number(p.purchase_price || 0) * 100) / 100,
      compatible_models: compats.rows.filter(c => c.product_id === p.id)
    }));

    res.json(productsWithModels);
  } catch (err) {
    sendSafeError(res, req, 'GET_PRODUCTS', err, 'Error al consultar el inventario de productos.');
  }
});

app.post('/api/products', requireAuth, async (req, res) => {
  try {
    const { code, name, category, purchase_price, price, stock, min_stock, is_serialized, model_ids } = req.body;
    const cleanCode = String(code || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanCode || cleanCode.length > 50) {
      return res.status(400).json({ error: 'El código del producto es obligatorio (máximo 50 caracteres).' });
    }
    if (!cleanName || cleanName.length > 200) {
      return res.status(400).json({ error: 'El nombre del producto es obligatorio (máximo 200 caracteres).' });
    }

    const numPrice = parseFloat(price);
    if (isNaN(numPrice) || numPrice < 0) {
      return res.status(400).json({ error: 'El precio de venta debe ser un número mayor o igual a 0.' });
    }

    let numPurchasePrice = 0;
    if (purchase_price !== undefined && purchase_price !== null && purchase_price !== '') {
      numPurchasePrice = parseFloat(purchase_price);
      if (isNaN(numPurchasePrice) || numPurchasePrice < 0) {
        return res.status(400).json({ error: 'El costo de compra debe ser un número mayor o igual a 0.' });
      }
    }

    const numStock = parseInt(stock, 10);
    if (isNaN(numStock) || numStock < 0) {
      return res.status(400).json({ error: 'El stock no puede ser negativo ni contener texto inválido.' });
    }

    // Validar min_stock permitiendo 0 explícito (Bug C3)
    let parsedMinStock = 5;
    if (min_stock !== undefined && min_stock !== null && !isNaN(parseInt(min_stock, 10))) {
      parsedMinStock = Math.max(0, parseInt(min_stock, 10));
    }

    // Comprobación de código único insensible a mayúsculas (Bug C4)
    const existingCode = await db.query(
      `SELECT id FROM products WHERE LOWER(code) = LOWER(?) AND (is_active = 1 OR is_active IS NULL)`,
      [cleanCode]
    );
    if (existingCode.rows.length > 0) {
      return res.status(400).json({ error: `Ya existe un producto con el código "${cleanCode}".` });
    }

    // Validar que los modelos asignados existan en el sistema (Bug C5)
    let uniqueModelIds = [];
    if (model_ids && Array.isArray(model_ids) && model_ids.length > 0) {
      uniqueModelIds = [...new Set(model_ids.map(Number).filter(id => Number.isInteger(id) && id > 0))];
      for (const mId of uniqueModelIds) {
        const mCheck = await db.query(`SELECT id FROM phone_models WHERE id = ?`, [mId]);
        if (mCheck.rows.length === 0) {
          return res.status(400).json({ error: `El modelo de compatibilidad con ID ${mId} no existe en la base de datos.` });
        }
      }
    }

    const serializedFlag = is_serialized ? 1 : 0;
    // Si el equipo requiere IMEI, su stock inicial es 0 hasta que se registren sus IMEIs reales
    const initialStock = serializedFlag === 1 ? 0 : numStock;

    const productId = await db.withTransaction(async (tx) => {
      const insertRes = await tx(`
        INSERT INTO products (code, name, category, purchase_price, price, stock, min_stock, is_serialized, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
        RETURNING id
      `, [
        cleanCode,
        cleanName,
        category || 'Accesorios',
        numPurchasePrice,
        numPrice,
        initialStock,
        parsedMinStock,
        serializedFlag
      ]);

      const newId = insertRes.lastID || (insertRes.rows && insertRes.rows[0] ? insertRes.rows[0].id : null);

      if (newId && uniqueModelIds.length > 0) {
        for (const mId of uniqueModelIds) {
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

app.put('/api/products/:id', requireAuth, async (req, res) => {
  try {
    const pid = parseInt(req.params.id, 10);
    if (!pid || isNaN(pid)) {
      return res.status(400).json({ error: 'ID de producto inválido.' });
    }

    const curRes = await db.query(`SELECT * FROM products WHERE id = ?`, [pid]);
    const currentProd = curRes.rows[0];
    if (!currentProd) {
      return res.status(404).json({ error: 'Producto no encontrado.' });
    }

    const { code, name, category, purchase_price, price, stock, min_stock, is_serialized, model_ids } = req.body;

    // Actualización parcial segura: no sobreescribir con cadenas vacías o nulls si faltan campos (Bug C7)
    const newCode = code !== undefined && String(code).trim() !== '' ? String(code).trim() : currentProd.code;
    const newName = name !== undefined && String(name).trim() !== '' ? String(name).trim() : currentProd.name;
    const newCategory = category !== undefined ? String(category).trim() : currentProd.category;
    
    let newPurchasePrice = currentProd.purchase_price;
    if (purchase_price !== undefined) {
      const p = parseFloat(purchase_price);
      if (isNaN(p) || p < 0) return res.status(400).json({ error: 'Costo de compra inválido.' });
      newPurchasePrice = p;
    }

    let newPrice = currentProd.price;
    if (price !== undefined) {
      const p = parseFloat(price);
      if (isNaN(p) || p < 0) return res.status(400).json({ error: 'Precio de venta inválido.' });
      newPrice = p;
    }

    let newStock = currentProd.stock;
    if (stock !== undefined) {
      const s = parseInt(stock, 10);
      if (isNaN(s) || s < 0) return res.status(400).json({ error: 'Stock inválido.' });
      newStock = s;
    }

    let newMinStock = currentProd.min_stock;
    if (min_stock !== undefined && min_stock !== null && !isNaN(parseInt(min_stock, 10))) {
      newMinStock = Math.max(0, parseInt(min_stock, 10));
    }

    const serializedFlag = is_serialized !== undefined ? (is_serialized ? 1 : 0) : currentProd.is_serialized;

    await db.withTransaction(async (tx) => {
      // Registrar en Kardex si hubo cambio manual de stock en la edición (Bug C9)
      if (newStock !== currentProd.stock && serializedFlag === 0) {
        await tx(`
          INSERT INTO inventory_movements (product_id, type, quantity, previous_stock, new_stock, reason, reference_code, user_name)
          VALUES (?, 'AJUSTE', ?, ?, ?, 'Ajuste manual desde edición de producto', 'EDICION', ?)
        `, [pid, Math.abs(newStock - currentProd.stock), currentProd.stock, newStock, req.user?.name || 'Administrador']);
      }

      await tx(`
        UPDATE products 
        SET code = ?, name = ?, category = ?, purchase_price = ?, price = ?, stock = ?, min_stock = ?, is_serialized = ?
        WHERE id = ?
      `, [
        newCode,
        newName,
        newCategory,
        newPurchasePrice,
        newPrice,
        newStock,
        newMinStock,
        serializedFlag,
        pid
      ]);

      if (model_ids && Array.isArray(model_ids)) {
        const uniqueModelIds = [...new Set(model_ids.map(Number).filter(id => Number.isInteger(id) && id > 0))];
        await tx(`DELETE FROM product_compatibilities WHERE product_id = ?`, [pid]);
        for (const mId of uniqueModelIds) {
          await tx(`INSERT INTO product_compatibilities (product_id, phone_model_id) VALUES (?, ?)`, [pid, mId]);
        }
      }

      if (serializedFlag === 1) {
        await db.syncSerializedProductStock(pid, tx);
      }
    });

    io.emit('product_updated', { action: 'updated', productId: pid });
    res.json({ success: true, message: 'Producto actualizado correctamente.' });
  } catch (err) {
    sendSafeError(res, req, 'UPDATE_PRODUCT', err, 'No se pudo actualizar el producto.');
  }
});

app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    const pid = parseInt(req.params.id, 10);
    if (!pid || isNaN(pid)) {
      return res.status(400).json({ error: 'ID de producto inválido.' });
    }

    const prodRes = await db.query(`SELECT id, name FROM products WHERE id = ?`, [pid]);
    if (prodRes.rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado.' });
    }

    // Verificar si el producto tiene historial contable o de IMEIs vendidos (Bug G3, G4)
    const salesHistoryRes = await db.query(`SELECT COUNT(*) as cnt FROM sale_items WHERE product_id = ?`, [pid]);
    const imeisHistoryRes = await db.query(`SELECT COUNT(*) as cnt FROM device_imeis WHERE product_id = ?`, [pid]);
    const hasSalesHistory = parseInt(salesHistoryRes.rows[0]?.cnt || 0, 10) > 0;
    const hasImeisHistory = parseInt(imeisHistoryRes.rows[0]?.cnt || 0, 10) > 0;

    if (hasSalesHistory || hasImeisHistory) {
      // Soft Delete para preservar trazabilidad de garantías y auditoría contable
      await db.query(`UPDATE products SET is_active = 0 WHERE id = ?`, [pid]);
      io.emit('product_updated', { action: 'deactivated', productId: pid });
      return res.json({ 
        success: true, 
        message: 'Producto archivado/desactivado del catálogo para preservar historial contable y garantías.' 
      });
    }

    // Si es un producto limpio sin ventas ni seriales, se puede borrar
    await db.query(`DELETE FROM product_compatibilities WHERE product_id = ?`, [pid]);
    await db.query(`DELETE FROM products WHERE id = ?`, [pid]);
    io.emit('product_updated', { action: 'deleted', productId: pid });
    res.json({ success: true, message: 'Producto eliminado permanentemente.' });
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
    const pid = parseInt(req.params.productId, 10);
    if (!pid || isNaN(pid)) {
      return res.status(400).json({ error: 'ID de producto inválido.' });
    }

    const result = await db.query(`
      SELECT im.*, p.name as product_name, p.code as product_code
      FROM inventory_movements im
      INNER JOIN products p ON im.product_id = p.id
      WHERE im.product_id = ?
      ORDER BY im.id DESC
    `, [pid]);
    res.json(result.rows);
  } catch (err) {
    sendSafeError(res, req, 'GET_INVENTORY_KARDEX_PRODUCT', err, 'Error al consultar el Kardex del producto.');
  }
});

app.post('/api/inventory/adjustment', requireAuth, async (req, res) => {
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

    // Restricción para vendedores en SALIDAS de stock (Bug E5)
    if ((cleanType === 'SALIDA' || cleanType === 'SALIDA_MERMA') && req.user?.role === 'Vendedor') {
      return res.status(403).json({ error: 'Acceso denegado. Las salidas o bajas por merma requieren autorización de un Administrador.' });
    }

    // Validación de límites seguros (Bug E4)
    if (!isNaN(qty) && (qty <= 0 || qty > 1000000)) {
      return res.status(400).json({ error: 'La cantidad debe ser un número entero entre 1 y 1,000,000.' });
    }

    const prodRes = await db.query(`SELECT id, name, stock, is_serialized FROM products WHERE id = ?`, [pid]);
    const product = prodRes.rows[0];
    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado.' });
    }

    // Impedir alteración manual de stock en productos serializados (Bug E1)
    if (Number(product.is_serialized) === 1) {
      return res.status(400).json({ 
        error: '⚠️ Este producto es un celular serializado con control de IMEI. Debe gestionar su stock mediante el registro o retiro de códigos IMEI reales.' 
      });
    }

    const movement = await db.withTransaction(async (tx) => {
      // Bloqueo de fila para evitar condiciones de carrera (Bug E2)
      const lockRes = await tx(`SELECT stock FROM products WHERE id = ? FOR UPDATE`, [pid]);
      const prevStock = parseInt(lockRes.rows[0].stock, 10) || 0;
      let newStock = prevStock;
      let movementType = cleanType;
      let movementQty = qty;

      if (cleanType === 'ENTRADA' || cleanType === 'ENTRADA_COMPRA') {
        if (isNaN(qty) || qty <= 0) {
          throw new Error('La cantidad a ingresar debe ser mayor a 0.');
        }
        movementType = 'ENTRADA';
        newStock = prevStock + qty;
        await tx(`UPDATE products SET stock = stock + ? WHERE id = ?`, [qty, pid]);
      } else if (cleanType === 'SALIDA' || cleanType === 'SALIDA_MERMA') {
        if (isNaN(qty) || qty <= 0) {
          throw new Error('La cantidad a retirar debe ser mayor a 0.');
        }
        if (prevStock < qty) {
          throw new Error(`Stock insuficiente. Stock actual: ${prevStock}, cantidad a retirar: ${qty}.`);
        }
        movementType = 'SALIDA';
        newStock = prevStock - qty;
        const updateRes = await tx(`UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?`, [qty, pid, qty]);
        const affected = updateRes.rowCount !== undefined ? updateRes.rowCount : updateRes.changes;
        if (affected === 0) {
          throw new Error('Stock insuficiente concurrente.');
        }
      } else if (cleanType === 'AJUSTE') {
        movementType = 'AJUSTE';
        if (new_stock_target !== undefined && new_stock_target !== null && new_stock_target !== '') {
          const target = Math.max(0, parseInt(new_stock_target, 10) || 0);
          movementQty = Math.abs(target - prevStock);
          newStock = target;
        } else if (!isNaN(qty) && qty >= 0) {
          movementQty = Math.abs(qty - prevStock);
          newStock = qty;
        } else {
          throw new Error('Debe especificar la nueva cantidad real del inventario.');
        }
        await tx(`UPDATE products SET stock = ? WHERE id = ?`, [newStock, pid]);
      } else {
        throw new Error('Tipo de movimiento inválido. Use ENTRADA, SALIDA o AJUSTE.');
      }

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

    io.emit('product_updated', { action: 'stock_adjusted', productId: pid, newStock: movement.new_stock });
    io.emit('inventory_movement_added', movement);

    res.json({
      success: true,
      message: `Stock de "${product.name}" actualizado con éxito de ${movement.previous_stock} a ${movement.new_stock}.`,
      movement
    });
  } catch (err) {
    if (err.message.includes('Stock insuficiente') || err.message.includes('inválido') || err.message.includes('mayor a 0')) {
      return res.status(400).json({ error: err.message });
    }
    sendSafeError(res, req, 'STOCK_ADJUSTMENT', err, 'No se pudo registrar el movimiento de inventario.');
  }
});

// ==========================================
// 3. GESTIÓN Y TRAZABILIDAD DE IMEIS
// ==========================================

app.get('/api/imeis/available/:productId', async (req, res) => {
  try {
    const pid = parseInt(req.params.productId, 10);
    if (!pid || isNaN(pid)) {
      return res.status(400).json({ error: 'ID de producto no válido.' });
    }

    const result = await db.query(`
      SELECT * FROM device_imeis 
      WHERE product_id = ? AND status = 'disponible' 
      ORDER BY id ASC
    `, [pid]);
    res.json(result.rows);
  } catch (err) {
    sendSafeError(res, req, 'GET_AVAILABLE_IMEIS', err, 'Error al consultar los IMEIs disponibles.');
  }
});

app.post('/api/imeis', requireAuth, async (req, res) => {
  try {
    const { product_id, imeis, notes } = req.body;
    const pid = parseInt(product_id, 10);
    if (!pid || isNaN(pid) || !imeis || !Array.isArray(imeis) || imeis.length === 0) {
      return res.status(400).json({ error: 'Producto y al menos un código IMEI son requeridos.' });
    }

    const prodCheck = await db.query(`SELECT id, is_serialized FROM products WHERE id = ?`, [pid]);
    const prod = prodCheck.rows[0];
    if (!prod) {
      return res.status(404).json({ error: 'Producto no encontrado.' });
    }

    // Validar que el producto sea serializado (Bug D1)
    if (Number(prod.is_serialized) !== 1) {
      return res.status(400).json({ error: '⚠️ Este producto no es un celular serializado. Solo se pueden registrar IMEIs en productos marcados como serializados.' });
    }

    // Filtrar y validar formato de IMEI con regex alfanumérico estricto (Bug D2)
    const validImeiRegex = /^[0-9A-Za-z]{8,25}$/;
    const rawUniqueImeis = [...new Set(imeis.map(i => String(i || '').trim()).filter(Boolean))];
    const cleanImeis = rawUniqueImeis.filter(i => validImeiRegex.test(i));

    if (cleanImeis.length === 0) {
      return res.status(400).json({ 
        error: '⚠️ Ningún IMEI proporcionado tiene un formato válido (debe contener entre 8 y 25 caracteres alfanuméricos).' 
      });
    }

    let insertedCount = 0;
    for (const imei of cleanImeis) {
      try {
        await db.query(`
          INSERT INTO device_imeis (product_id, imei_code, status, notes)
          VALUES (?, ?, 'disponible', ?)
        `, [pid, imei, notes || '']);
        insertedCount++;
      } catch (dupErr) {
        console.warn(`⚠️ IMEI ${imei} omitido (duplicado en sistema):`, dupErr.message);
      }
    }

    if (insertedCount === 0) {
      return res.status(400).json({ 
        error: '⚠️ Todos los IMEIs ingresados ya existen registrados previamente en el sistema.' 
      });
    }

    // Sincronizar stock con la cantidad real de IMEIs disponibles
    await db.syncSerializedProductStock(pid);

    io.emit('product_updated', { action: 'imei_added', productId: pid });
    res.json({ success: true, message: `${insertedCount} IMEIs registrados exitosamente.`, insertedCount });
  } catch (err) {
    sendSafeError(res, req, 'CREATE_IMEIS', err, 'Error al registrar el lote de IMEIs.');
  }
});

app.get('/api/imeis/search/:query', async (req, res) => {
  try {
    const rawQuery = String(req.params.query || '').trim();
    if (!rawQuery || rawQuery === '%' || rawQuery.length < 2) {
      return res.status(400).json({ error: 'Debe ingresar al menos 2 caracteres para buscar un IMEI.' });
    }

    // Escapar caracteres comodín para evitar el Bug D5
    const sanitizedQuery = rawQuery.replace(/%/g, '\\%').replace(/_/g, '\\_');

    const result = await db.query(`
      SELECT di.*, p.name as product_name, p.code as product_code, s.receipt_code, s.customer_name, s.payment_method, s.created_at as sale_date
      FROM device_imeis di
      INNER JOIN products p ON di.product_id = p.id
      LEFT JOIN sales s ON di.sale_id = s.id
      WHERE di.imei_code LIKE ?
      ORDER BY di.id DESC
      LIMIT 100
    `, [`%${sanitizedQuery}%`]);
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

    if (from && from !== 'garbage') {
      conditions.push(`created_at >= ?`);
      params.push(`${from} 00:00:00`);
    }
    if (to && to !== 'garbage') {
      conditions.push(`created_at <= ?`);
      params.push(`${to} 23:59:59`);
    }

    if (conditions.length > 0) {
      queryStr += ` WHERE ` + conditions.join(' AND ');
    }

    queryStr += ` ORDER BY id DESC`;

    const parsedLimit = parseInt(limit, 10);
    const safeLimit = (!isNaN(parsedLimit) && parsedLimit > 0) ? parsedLimit : 200;
    queryStr += ` LIMIT ${safeLimit}`;

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
    const sid = parseInt(req.params.id, 10);
    if (!sid || isNaN(sid)) {
      return res.status(400).json({ error: 'ID de venta inválido.' });
    }

    const saleRes = await db.query(`SELECT * FROM sales WHERE id = ?`, [sid]);
    if (saleRes.rows.length === 0) return res.status(404).json({ error: 'Venta no encontrada' });

    const itemsRes = await db.query(`SELECT * FROM sale_items WHERE sale_id = ?`, [sid]);
    const saleRow = saleRes.rows[0];

    res.json({
      ...saleRow,
      payment_details: parsePaymentDetails(saleRow.payment_details, `sale_${sid}`),
      items: itemsRes.rows
    });
  } catch (err) {
    sendSafeError(res, req, 'GET_SALE_BY_ID', err, 'Error al obtener el comprobante de venta.');
  }
});

// Procesar Venta con validación rigurosa de precios en BD, stock, IMEIs y concurrencia (Bugs F1 a F17)
app.post('/api/sales', requireAuth, async (req, res) => {
  try {
    const { doc_type, customer_id, customer_name, payment_method, payment_details, items, paid_amount, change_amount, discount } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'El carrito no puede estar vacío.' });
    }

    // 1. Validar método de pago válido (Bug F9)
    if (!isValidPaymentMethod(payment_method)) {
      return res.status(400).json({ error: `Método de pago "${payment_method}" no reconocido. Utilice Efectivo, Tarjeta, Yape, Plin o Mixto.` });
    }

    // 2. Verificar que la caja esté abierta
    const checkCash = await db.query(`SELECT id FROM cash_registers WHERE status = 'abierta' ORDER BY id DESC LIMIT 1`);
    if (checkCash.rows.length === 0) {
      return res.status(400).json({ 
        error: '⚠️ La caja está cerrada. Debe abrir el turno de caja antes de realizar ventas.',
        cash_closed: true 
      });
    }
    const activeCashId = checkCash.rows[0].id;

    // 3. Validar cliente en compras a crédito o fiado (Bug F10, F17)
    let validatedCustomerId = null;
    let validatedCustomerName = customer_name ? String(customer_name).trim() : 'Público General';

    if (payment_method === 'Crédito' || payment_method === 'Fiado') {
      const cid = parseInt(customer_id, 10);
      if (!cid || isNaN(cid)) {
        return res.status(400).json({ error: '⚠️ Debe seleccionar un cliente registrado para realizar una venta a Crédito/Fiado.' });
      }
      const custCheck = await db.query(`SELECT id, name FROM customers WHERE id = ?`, [cid]);
      if (custCheck.rows.length === 0) {
        return res.status(400).json({ error: 'El cliente seleccionado para crédito no existe en el sistema.' });
      }
      validatedCustomerId = cid;
      validatedCustomerName = custCheck.rows[0].name;
    }

    // 4. Validar ítems, cantidades enteras positivas y consolidación de stock (Bug F1, F5, F15, F16)
    const productQtyMap = {};
    const sanitizedItems = [];

    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      const rawQty = Number(it.quantity);

      if (!Number.isInteger(rawQty) || rawQty <= 0) {
        return res.status(400).json({ error: `La cantidad del producto #${idx + 1} debe ser un número entero mayor a 0.` });
      }

      if (it.product_id) {
        const pid = parseInt(it.product_id, 10);
        if (isNaN(pid)) return res.status(400).json({ error: `ID de producto inválido en el carrito.` });

        // Consultar el producto real en la base de datos (Bug F2: servidor autoritativo de precios)
        const pCheck = await db.query(`SELECT id, name, price, stock, is_serialized, is_active FROM products WHERE id = ?`, [pid]);
        const prod = pCheck.rows[0];
        if (!prod || prod.is_active === 0) {
          return res.status(400).json({ error: `El producto ${it.product_name || '#' + pid} no existe o no está activo en el inventario.` });
        }

        const authoritativePrice = Math.round(Number(prod.price) * 100) / 100;
        productQtyMap[pid] = (productQtyMap[pid] || 0) + rawQty;

        // Validar IMEIs únicamente si el producto es serializado (Bug F6, F7, F8)
        let imeiCode = '';
        if (prod.is_serialized === 1) {
          imeiCode = String(it.imei || it.imei_code || '').trim();
          if (!imeiCode) {
            return res.status(400).json({ error: `⚠️ El producto "${prod.name}" es un celular serializado y requiere ingresar su código IMEI correspondiente.` });
          }

          // Verificar que el IMEI pertenezca al producto y esté disponible
          const imeiCheck = await db.query(`
            SELECT id, status, product_id 
            FROM device_imeis 
            WHERE imei_code = ?
          `, [imeiCode]);

          if (imeiCheck.rows.length === 0) {
            return res.status(400).json({ error: `El IMEI ${imeiCode} no existe en el registro.` });
          }
          if (imeiCheck.rows[0].product_id !== pid) {
            return res.status(400).json({ error: `El IMEI ${imeiCode} pertenece a otro modelo de equipo celular.` });
          }
          if (imeiCheck.rows[0].status !== 'disponible') {
            return res.status(400).json({ error: `El IMEI ${imeiCode} ya ha sido vendido o no se encuentra disponible.` });
          }
        }

        sanitizedItems.push({
          product_id: pid,
          product_name: prod.name,
          quantity: rawQty,
          unit_price: authoritativePrice,
          is_serialized: prod.is_serialized,
          imei_code: imeiCode
        });
      } else {
        // Ítem libre no catalogado
        const unitP = Math.max(0, parseFloat(it.unit_price) || 0);
        sanitizedItems.push({
          product_id: null,
          product_name: String(it.product_name || 'Ítem mostrador').trim(),
          quantity: rawQty,
          unit_price: Math.round(unitP * 100) / 100,
          is_serialized: 0,
          imei_code: ''
        });
      }
    }

    // 5. Validar disponibilidad de stock total acumulado (Bug F5)
    for (const [pIdStr, totalReqQty] of Object.entries(productQtyMap)) {
      const pid = parseInt(pIdStr, 10);
      const prodCheck = await db.query(`SELECT name, stock FROM products WHERE id = ?`, [pid]);
      const currentStock = prodCheck.rows[0] ? parseInt(prodCheck.rows[0].stock, 10) : 0;
      if (currentStock < totalReqQty) {
        return res.status(400).json({
          error: `Stock insuficiente para ${prodCheck.rows[0]?.name || 'producto'}. Requerido en venta: ${totalReqQty}, disponible en almacén: ${currentStock}.`
        });
      }
    }

    // 6. Calcular totales y descuentos con validación de rol (Bug F3)
    let grossTotal = 0;
    sanitizedItems.forEach(i => { grossTotal += i.quantity * i.unit_price; });
    grossTotal = Math.round(grossTotal * 100) / 100;

    let discountAmount = Math.max(0, parseFloat(discount) || 0);
    // Si el usuario es Vendedor, restringir descuento máximo al 20% para evitar ventas fraudulentas a S/ 0 (Bug F3)
    if (req.user?.role === 'Vendedor' && discountAmount > grossTotal * 0.20) {
      return res.status(403).json({ 
        error: `Acceso denegado. El descuento solicitado (S/ ${discountAmount.toFixed(2)}) supera el límite máximo permitido para vendedores (máximo 20%: S/ ${(grossTotal * 0.20).toFixed(2)}).` 
      });
    }

    discountAmount = Math.min(grossTotal, Math.round(discountAmount * 100) / 100);
    const total = Math.max(0, Math.round((grossTotal - discountAmount) * 100) / 100);
    const subtotal = Math.round((total / 1.18) * 100) / 100;
    const tax = Math.round((total - subtotal) * 100) / 100;

    // 7. Validar montos de pago según el método
    let finalPaidAmount = total;
    let finalChangeAmount = 0;

    if (payment_method === 'Mixto') {
      const parsedDetails = parsePaymentDetails(payment_details, 'sales_mixto_validation');
      if (!parsedDetails) {
        return res.status(400).json({ error: 'Debe especificar el desglose de montos para el pago mixto.' });
      }

      const ef = Math.max(0, parseFloat(parsedDetails.efectivo) || 0);
      const yp = Math.max(0, parseFloat(parsedDetails.yape) || 0);
      const pl = Math.max(0, parseFloat(parsedDetails.plin) || 0);
      const tj = Math.max(0, parseFloat(parsedDetails.tarjeta) || 0);
      const sum = Math.round((ef + yp + pl + tj) * 100) / 100;

      // Tolerancia de 0.05 por centavos (Bug F11)
      if (Math.abs(sum - total) > 0.05) {
        return res.status(400).json({ 
          error: `⚠️ La suma de los métodos mixtos (S/ ${sum.toFixed(2)}) no coincide con el total de la venta (S/ ${total.toFixed(2)}). Descuadre: S/ ${(total - sum).toFixed(2)}.` 
        });
      }
    } else if (payment_method === 'Efectivo') {
      const paid = paid_amount !== undefined ? parseFloat(paid_amount) : total;
      if (isNaN(paid) || paid < total) {
        return res.status(400).json({ error: `Monto en efectivo recibido (S/ ${paid}) es menor al total a cobrar (S/ ${total.toFixed(2)}).` });
      }
      finalPaidAmount = Math.round(paid * 100) / 100;
      finalChangeAmount = Math.round((finalPaidAmount - total) * 100) / 100; // Cálculo autoritativo de vuelto (Bug F14)
    }

    // 8. Tipo de documento seguro (Bug F12)
    const VALID_DOC_TYPES = ['Ticket', 'Boleta', 'Factura'];
    const cleanDocType = VALID_DOC_TYPES.includes(doc_type) ? doc_type : 'Ticket';
    const prefijo = cleanDocType === 'Factura' ? 'F' : (cleanDocType === 'Boleta' ? 'B' : 'T');

    // 9. Ejecución atómica en transacción
    const result = await db.withTransaction(async (tx) => {
      // Correlativo atómico con bloqueo para evitar colisiones concurrentes (Bug F13)
      let nextNum;
      if (db.USE_POSTGRES) {
        const counterRes = await tx(`
          UPDATE counters 
          SET last_number = last_number + 1 
          WHERE doc_type = ? 
          RETURNING last_number
        `, [cleanDocType]);
        nextNum = parseInt(counterRes.rows[0].last_number, 10);
      } else {
        const counterRes = await tx(`SELECT last_number FROM counters WHERE doc_type = ?`, [cleanDocType]);
        const lastNum = counterRes.rows[0] ? parseInt(counterRes.rows[0].last_number, 10) : 0;
        nextNum = lastNum + 1;
        await tx(`UPDATE counters SET last_number = ? WHERE doc_type = ?`, [nextNum, cleanDocType]);
      }

      const receipt_code = `${prefijo}001-${String(nextNum).padStart(6, '0')}`;
      const paymentDetailsStr = payment_details ? JSON.stringify(payment_details) : '';

      // Registrar Cabecera de Venta
      const saleInsert = await tx(`
        INSERT INTO sales (receipt_code, doc_type, customer_id, customer_name, payment_method, payment_details, subtotal, tax, discount, total, paid_amount, change_amount, cash_register_id, user_name, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completada')
        RETURNING id
      `, [
        receipt_code,
        cleanDocType,
        validatedCustomerId,
        validatedCustomerName,
        payment_method,
        paymentDetailsStr,
        subtotal,
        tax,
        discountAmount,
        total,
        finalPaidAmount,
        finalChangeAmount,
        activeCashId,
        req.user?.name || 'Administrador'
      ]);

      const saleId = saleInsert.lastID || (saleInsert.rows && saleInsert.rows[0] ? saleInsert.rows[0].id : null);

      // Registrar Items, descontar stock atómicamente y actualizar IMEIs
      for (const item of sanitizedItems) {
        const itemSubtotal = Math.round(item.quantity * item.unit_price * 100) / 100;

        await tx(`
          INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, subtotal, imei_code)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [saleId, item.product_id, item.product_name, item.quantity, item.unit_price, itemSubtotal, item.imei_code]);

        if (item.imei_code) {
          // Actualización atómica de IMEI garantizando que solo cambie si estaba 'disponible' (Bug F7)
          const imeiUp = await tx(`
            UPDATE device_imeis 
            SET status = 'vendido', sale_id = ?, sold_at = CURRENT_TIMESTAMP 
            WHERE imei_code = ? AND status = 'disponible'
          `, [saleId, item.imei_code]);

          const affectedImei = imeiUp.rowCount !== undefined ? imeiUp.rowCount : imeiUp.changes;
          if (affectedImei === 0) {
            throw new Error(`El código IMEI ${item.imei_code} ya fue vendido simultáneamente en otra operación.`);
          }
        }

        if (item.product_id) {
          // Descuento atómico de stock con verificación de concurrencia (Bug F4)
          const stockUp = await tx(`
            UPDATE products 
            SET stock = stock - ? 
            WHERE id = ? AND stock >= ?
            RETURNING stock
          `, [item.quantity, item.product_id, item.quantity]);

          const affectedStock = stockUp.rowCount !== undefined ? stockUp.rowCount : stockUp.changes;
          if (affectedStock === 0) {
            throw new Error(`Stock insuficiente durante el cobro concurrente para el producto "${item.product_name}".`);
          }

          const newStock = stockUp.rows && stockUp.rows[0] ? stockUp.rows[0].stock : 0;
          const prevStock = newStock + item.quantity;

          if (item.is_serialized === 1) {
            await db.syncSerializedProductStock(item.product_id, tx);
          }

          await tx(`
            INSERT INTO inventory_movements (product_id, type, quantity, previous_stock, new_stock, reason, reference_code, user_name)
            VALUES (?, 'VENTA', ?, ?, ?, ?, ?, ?)
          `, [
            item.product_id,
            item.quantity,
            prevStock,
            newStock,
            `Venta en mostrador #${receipt_code}`,
            receipt_code,
            req.user?.name || 'Administrador'
          ]);
        }
      }

      // Registrar Crédito si aplica con bloqueo de fila (Bug H4)
      if ((payment_method === 'Crédito' || payment_method === 'Fiado') && validatedCustomerId) {
        const custRes = await tx(`SELECT debt FROM customers WHERE id = ? FOR UPDATE`, [validatedCustomerId]);
        const currentDebt = Math.round(parseFloat(custRes.rows[0]?.debt || 0) * 100) / 100;
        const newDebt = Math.round((currentDebt + total) * 100) / 100;
        const details = sanitizedItems.map(i => `${i.quantity}x ${i.product_name} ${i.imei_code ? '(IMEI: ' + i.imei_code + ')' : ''}`).join(', ');

        await tx(`UPDATE customers SET debt = ? WHERE id = ?`, [newDebt, validatedCustomerId]);
        await tx(`
          INSERT INTO fiado_records (customer_id, type, amount, details, balance_after, receipt_code, payment_method)
          VALUES (?, 'COMPRA_CREDITO', ?, ?, ?, ?, 'Crédito')
        `, [validatedCustomerId, total, details, newDebt, receipt_code]);
      }

      return { saleId, receipt_code, cleanDocType };
    });

    const completedSale = {
      id: result.saleId,
      receipt_code: result.receipt_code,
      doc_type: result.cleanDocType,
      customer_name: validatedCustomerName,
      payment_method,
      payment_details: payment_details || null,
      subtotal,
      tax,
      discount: discountAmount,
      total,
      paid_amount: finalPaidAmount,
      change_amount: finalChangeAmount,
      cash_register_id: activeCashId,
      created_at: new Date().toISOString(),
      items: sanitizedItems
    };

    io.emit('sale_completed', completedSale);
    io.emit('cash_updated');
    res.json({ success: true, sale: completedSale, receipt_code: result.receipt_code, saleId: result.saleId, total });
  } catch (err) {
    if (err.message.includes('IMEI') || err.message.includes('Stock insuficiente') || err.message.includes('simultáneamente')) {
      return res.status(400).json({ error: err.message });
    }
    sendSafeError(res, req, 'CREATE_SALE', err, 'No se pudo procesar la venta.');
  }
});

// Anular Venta con restitución segura de Stock + IMEIs + Deuda y cuadre de caja (Bugs G1 a G5, K13)
app.put('/api/sales/:id/anular', requireAdmin, async (req, res) => {
  try {
    const sid = parseInt(req.params.id, 10);
    if (!sid || isNaN(sid)) {
      return res.status(400).json({ error: 'ID de venta inválido.' });
    }

    const saleRes = await db.query(`SELECT * FROM sales WHERE id = ?`, [sid]);
    const sale = saleRes.rows[0];

    if (!sale) return res.status(404).json({ error: 'Venta no encontrada.' });
    if (sale.status === 'anulada') return res.status(400).json({ error: 'La venta ya está anulada.' });

    await db.withTransaction(async (tx) => {
      await tx(`UPDATE sales SET status = 'anulada' WHERE id = ?`, [sid]);

      const itemsRes = await tx(`SELECT product_id, quantity, product_name, imei_code FROM sale_items WHERE sale_id = ?`, [sid]);
      for (const item of itemsRes.rows) {
        // Restaurar solo IMEIs vinculados específicamente a ESTA venta (Bug F7b)
        if (item.imei_code) {
          await tx(`
            UPDATE device_imeis 
            SET status = 'disponible', sale_id = NULL, sold_at = NULL 
            WHERE imei_code = ? AND sale_id = ?
          `, [item.imei_code, sid]);
        }

        if (item.product_id) {
          const prodCheck = await tx(`SELECT stock, is_serialized FROM products WHERE id = ?`, [item.product_id]);
          if (prodCheck.rows.length > 0) {
            const isSer = Number(prodCheck.rows[0].is_serialized) === 1;
            const prevStock = parseInt(prodCheck.rows[0].stock, 10) || 0;
            let newStock = prevStock;

            if (isSer) {
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
      }

      // Reversión de crédito si aplica (Bug G2)
      if ((sale.payment_method === 'Crédito' || sale.payment_method === 'Fiado') && sale.customer_id) {
        const custRes = await tx(`SELECT debt FROM customers WHERE id = ? FOR UPDATE`, [sale.customer_id]);
        const currentDebt = Math.round(parseFloat(custRes.rows[0]?.debt || 0) * 100) / 100;
        const saleTotal = Math.round(parseFloat(sale.total) * 100) / 100;
        
        // Si el cliente ya había abonado parte, su saldo tras anular refleja su saldo neto a favor
        const newDebt = Math.round((currentDebt - saleTotal) * 100) / 100;

        await tx(`UPDATE customers SET debt = ? WHERE id = ?`, [newDebt, sale.customer_id]);
        await tx(`
          INSERT INTO fiado_records (customer_id, type, amount, details, balance_after, receipt_code)
          VALUES (?, 'ANULACION', ?, ?, ?, ?)
        `, [sale.customer_id, saleTotal, `Anulación venta #${sale.receipt_code}`, newDebt, sale.receipt_code]);
      }

      // Cuadre de caja para ventas de turnos ya cerrados (Bug K13)
      const openCashRes = await tx(`SELECT id FROM cash_registers WHERE status = 'abierta' ORDER BY id DESC LIMIT 1`);
      const activeCash = openCashRes.rows[0] || null;

      if (activeCash && sale.cash_register_id !== activeCash.id) {
        // La venta pertenece a un turno ya cerrado: registrar la devolución física de efectivo en el turno abierto actual
        const refundAmt = Math.round(parseFloat(sale.total) * 100) / 100;
        if (sale.payment_method === 'Efectivo' && refundAmt > 0) {
          await tx(`
            INSERT INTO cash_movements (cash_register_id, type, amount, reason, payment_method, user_name)
            VALUES (?, 'RETIRO', ?, ?, 'Efectivo', ?)
          `, [
            activeCash.id,
            refundAmt,
            `DEVOLUCIÓN POR ANULACIÓN VENTA #${sale.receipt_code} (Turno anterior #${sale.cash_register_id})`,
            req.user?.name || 'Administrador'
          ]);
        }
      }
    });

    io.emit('sale_annulled', { saleId: sid });
    io.emit('cash_updated');
    res.json({ success: true, message: `Venta #${sale.receipt_code} anulada. Stock e IMEIs restituidos con éxito.` });
  } catch (err) {
    sendSafeError(res, req, 'ANNUL_SALE', err, 'No se pudo anular la venta.');
  }
});

// ==========================================
// 5. CONTROL DE CAJA Y ARQUEO Z (CON PAGOS MIXTOS, ABONOS E HISTORIAL)
// ==========================================

function calculateRegisterTotals(register, salesRows, movementsRows) {
  let efectivoSales = 0;
  let tarjetaSales = 0;
  let yapeSales = 0;
  let plinSales = 0;
  let creditoSales = 0;

  salesRows.forEach(r => {
    const tot = Math.round(parseFloat(r.total || 0) * 100) / 100;
    if (r.payment_method === 'Mixto' && r.payment_details) {
      const det = parsePaymentDetails(r.payment_details, 'cash_register_calc');
      if (det) {
        efectivoSales += Math.round(parseFloat(det.efectivo || 0) * 100) / 100;
        yapeSales += Math.round(parseFloat(det.yape || 0) * 100) / 100;
        plinSales += Math.round(parseFloat(det.plin || 0) * 100) / 100;
        tarjetaSales += Math.round(parseFloat(det.tarjeta || 0) * 100) / 100;
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
  let retirosEfectivo = 0;
  let retirosDigital = 0;
  let abonosEfectivo = 0;
  let abonosDigital = 0;

  movementsRows.forEach(m => {
    const a = Math.round(parseFloat(m.amount || 0) * 100) / 100;
    if (isNaN(a)) return;

    if (m.type === 'INGRESO') {
      if (!m.payment_method || m.payment_method === 'Efectivo') {
        ingresos += a;
      } else {
        abonosDigital += a;
      }
    } else if (m.type === 'RETIRO' || m.type === 'GASTO') {
      // Diferenciar si el retiro es en efectivo o por medio digital (Bug K1)
      if (!m.payment_method || m.payment_method === 'Efectivo') {
        retirosEfectivo += a;
      } else {
        retirosDigital += a;
      }
    } else if (m.type === 'ABONO') {
      if (m.payment_method === 'Efectivo') {
        abonosEfectivo += a;
      } else {
        abonosDigital += a;
      }
    }
  });

  const initial = Math.round(parseFloat(register.initial_amount || 0) * 100) / 100;
  // Solo los retiros en efectivo físico restan del efectivo esperado en la gaveta (Bug K1)
  const expectedCash = Math.round((initial + efectivoSales + abonosEfectivo + ingresos - retirosEfectivo) * 100) / 100;
  const expectedDigital = Math.round((yapeSales + plinSales + tarjetaSales + abonosDigital - retirosDigital) * 100) / 100;

  return {
    initialAmount: initial,
    efectivoSales: Math.round(efectivoSales * 100) / 100,
    tarjetaSales: Math.round(tarjetaSales * 100) / 100,
    yapeSales: Math.round((yapeSales + plinSales) * 100) / 100,
    creditoSales: Math.round(creditoSales * 100) / 100,
    abonosEfectivo: Math.round(abonosEfectivo * 100) / 100,
    abonosDigital: Math.round(abonosDigital * 100) / 100,
    totalSales: Math.round((efectivoSales + tarjetaSales + yapeSales + plinSales + creditoSales) * 100) / 100,
    ingresos: Math.round(ingresos * 100) / 100,
    retiros: Math.round((retirosEfectivo + retirosDigital) * 100) / 100,
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

    const salesRes = await db.query(`
      SELECT payment_method, payment_details, total 
      FROM sales 
      WHERE status = 'completada' AND (cash_register_id = ? OR (cash_register_id IS NULL AND created_at >= ?))
    `, [activeRegister.id, activeRegister.opened_at]);

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

app.post('/api/cash/open', requireAuth, async (req, res) => {
  try {
    const { initial_amount, user_name } = req.body;
    const initAmt = parseFloat(initial_amount);

    // Validar monto inicial no negativo (Bug K12)
    if (isNaN(initAmt) || initAmt < 0) {
      return res.status(400).json({ error: 'El monto inicial de caja debe ser un número mayor o igual a 0.' });
    }

    // Verificar si ya existe caja abierta con bloqueo / índice único (Bug K11)
    const checkOpen = await db.query(`SELECT id FROM cash_registers WHERE status = 'abierta'`);
    if (checkOpen.rows.length > 0) {
      return res.status(400).json({ error: 'Ya existe una caja abierta actualmente en el sistema.' });
    }

    await db.query(`
      INSERT INTO cash_registers (user_name, initial_amount, status)
      VALUES (?, ?, 'abierta')
    `, [user_name || req.user?.name || 'Administrador', Math.round(initAmt * 100) / 100]);

    io.emit('cash_updated');
    res.json({ success: true, message: 'Caja abierta exitosamente.' });
  } catch (err) {
    if (String(err?.message || '').toLowerCase().includes('unique') || String(err?.message || '').toLowerCase().includes('duplicate')) {
      return res.status(400).json({ error: 'Ya existe una caja abierta actualmente.' });
    }
    sendSafeError(res, req, 'OPEN_CASH', err, 'No se pudo abrir la caja.');
  }
});

app.post('/api/cash/movement', requireAuth, async (req, res) => {
  try {
    const { type, amount, reason, payment_method } = req.body;
    const cleanType = String(type || '').trim().toUpperCase();
    const cleanReason = String(reason || '').trim();
    const cleanMethod = payment_method ? String(payment_method).trim() : 'Efectivo';
    const numAmount = parseFloat(amount);

    // 1. Validar caja abierta
    const checkOpen = await db.query(`SELECT * FROM cash_registers WHERE status = 'abierta' ORDER BY id DESC LIMIT 1`);
    if (checkOpen.rows.length === 0) {
      return res.status(400).json({ error: 'No hay ninguna caja abierta actualmente.' });
    }
    const reg = checkOpen.rows[0];

    // 2. Validar tipo permitido (Bug K2, K3) - Solo INGRESO, RETIRO o GASTO (no inyectar ABONO directo)
    const ALLOWED_TYPES = ['INGRESO', 'RETIRO', 'GASTO'];
    if (!ALLOWED_TYPES.includes(cleanType)) {
      return res.status(400).json({ error: `Tipo de movimiento inválido. Los tipos permitidos son: ${ALLOWED_TYPES.join(', ')}.` });
    }

    // 3. Validar motivo obligatorio (Bug K4)
    if (!cleanReason) {
      return res.status(400).json({ error: 'El motivo del movimiento de caja es obligatorio.' });
    }

    // 4. Validar monto positivo y numérico (Bug K5, K7)
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: 'El monto del movimiento debe ser un número mayor a 0.' });
    }

    const roundedAmount = Math.round(numAmount * 100) / 100;

    // 5. Validar que un retiro en efectivo no exceda el dinero físico disponible (Bug K6)
    if ((cleanType === 'RETIRO' || cleanType === 'GASTO') && cleanMethod === 'Efectivo') {
      const salesRes = await db.query(`
        SELECT payment_method, payment_details, total 
        FROM sales 
        WHERE status = 'completada' AND (cash_register_id = ? OR (cash_register_id IS NULL AND created_at >= ?))
      `, [reg.id, reg.opened_at]);
      const movsRes = await db.query(`SELECT type, amount, payment_method FROM cash_movements WHERE cash_register_id = ?`, [reg.id]);
      const currentTotals = calculateRegisterTotals(reg, salesRes.rows, movsRes.rows);

      if (roundedAmount > currentTotals.expectedCash) {
        return res.status(400).json({ 
          error: `⚠️ El monto a retirar (S/ ${roundedAmount.toFixed(2)}) supera el efectivo físico disponible en la gaveta (S/ ${currentTotals.expectedCash.toFixed(2)}).` 
        });
      }
    }

    await db.query(`
      INSERT INTO cash_movements (cash_register_id, type, amount, reason, payment_method, user_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [reg.id, cleanType, roundedAmount, cleanReason, cleanMethod, req.user?.name || 'Administrador']);

    io.emit('cash_updated');
    res.json({ success: true, message: `Movimiento de ${cleanType} registrado con éxito.` });
  } catch (err) {
    sendSafeError(res, req, 'CASH_MOVEMENT', err, 'No se pudo registrar el movimiento de caja.');
  }
});

app.post('/api/cash/close', requireAuth, async (req, res) => {
  try {
    const { final_amount, notes } = req.body;

    // Validación estricta: monto final obligatorio y no negativo (Bug K8)
    if (final_amount === undefined || final_amount === null || isNaN(parseFloat(final_amount)) || parseFloat(final_amount) < 0) {
      return res.status(400).json({ 
        error: '⚠️ Debe ingresar el monto físico real contado en caja para realizar el Arqueo Z.',
        summary: ''
      });
    }

    const checkOpen = await db.query(`SELECT * FROM cash_registers WHERE status = 'abierta' ORDER BY id DESC LIMIT 1`);
    if (checkOpen.rows.length === 0) {
      return res.status(400).json({ error: 'No hay ninguna caja abierta para cerrar.' });
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
    const finalAmt = Math.round(parseFloat(final_amount) * 100) / 100;
    const difference = Math.round((finalAmt - expected) * 100) / 100;
    const closedAtIso = new Date().toISOString();

    await db.query(`
      UPDATE cash_registers 
      SET status = 'cerrada', final_amount = ?, expected_amount = ?, difference = ?, notes = ?, closed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [finalAmt, expected, difference, notes || '', reg.id]);

    io.emit('cash_updated');
    res.json({
      success: true,
      message: 'Caja cerrada y Arqueo Z generado exitosamente.',
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
    const customersWithRoundedDebt = result.rows.map(c => ({
      ...c,
      debt: Math.round(Number(c.debt || 0) * 100) / 100
    }));
    res.json(customersWithRoundedDebt);
  } catch (err) {
    sendSafeError(res, req, 'GET_CUSTOMERS', err, 'Error al consultar la cartera de clientes.');
  }
});

app.post('/api/customers', requireAuth, async (req, res) => {
  try {
    const { doc, name, phone, address } = req.body;
    const cleanDoc = String(doc || '').trim();
    const cleanName = String(name || '').trim();

    // Validación de formato de documento (Bug B2)
    const validDocRegex = /^[0-9A-Za-z-]{4,20}$/;
    if (!cleanDoc || !validDocRegex.test(cleanDoc)) {
      return res.status(400).json({ error: 'El número de documento (DNI/RUC) debe ser alfanumérico entre 4 y 20 caracteres.' });
    }

    // Validación de longitud de nombre (Bug B7)
    if (!cleanName || cleanName.length < 2 || cleanName.length > 200) {
      return res.status(400).json({ error: 'El nombre del cliente es obligatorio (entre 2 y 200 caracteres).' });
    }

    // Validación de seguridad: no permitir inyección de etiquetas HTML (Bug B4)
    if (/<[a-z][\s\S]*>/i.test(cleanName)) {
      return res.status(400).json({ error: 'El nombre del cliente no puede contener etiquetas ni código HTML.' });
    }

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

app.put('/api/customers/:id', requireAuth, async (req, res) => {
  try {
    const cid = parseInt(req.params.id, 10);
    if (!cid || isNaN(cid)) {
      return res.status(400).json({ error: 'ID de cliente inválido.' });
    }

    const checkCust = await db.query(`SELECT id FROM customers WHERE id = ?`, [cid]);
    if (checkCust.rows.length === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado en el sistema.' });
    }

    const { doc, name, phone, address } = req.body;
    const cleanDoc = String(doc || '').trim();
    const cleanName = String(name || '').trim();

    const validDocRegex = /^[0-9A-Za-z-]{4,20}$/;
    if (!cleanDoc || !validDocRegex.test(cleanDoc)) {
      return res.status(400).json({ error: 'El número de documento (DNI/RUC) debe ser alfanumérico entre 4 y 20 caracteres.' });
    }
    if (!cleanName || cleanName.length < 2 || cleanName.length > 200) {
      return res.status(400).json({ error: 'El nombre del cliente es obligatorio (entre 2 y 200 caracteres).' });
    }

    await db.query(
      `UPDATE customers SET doc = ?, name = ?, phone = ?, address = ? WHERE id = ?`,
      [cleanDoc, cleanName, String(phone || '').trim(), String(address || '').trim(), cid]
    );
    res.json({ success: true, message: 'Datos del cliente actualizados correctamente.' });
  } catch (err) {
    sendSafeError(res, req, 'UPDATE_CUSTOMER', err, 'No se pudo actualizar el cliente.');
  }
});

// Registrar Abono a Crédito con bloqueo de fila y validación de caja abierta (Bugs H1, H3, H5, K9)
app.post('/api/credits/abono', async (req, res) => {
  try {
    const { customer_id, amount, payment_method } = req.body;
    const cid = parseInt(customer_id, 10);
    const abonoAmt = Math.round((parseFloat(amount) || 0) * 100) / 100;
    const method = payment_method ? String(payment_method).trim() : 'Efectivo';

    if (!cid || isNaN(cid) || isNaN(abonoAmt) || abonoAmt <= 0) {
      return res.status(400).json({ error: 'Monto de abono válido mayor a 0 es requerido.' });
    }

    // Validar método de pago permitido (Bug H5)
    if (!isValidPaymentMethod(method)) {
      return res.status(400).json({ error: `Método de pago "${method}" no válido para registrar abonos.` });
    }

    // Si el abono es en Efectivo, exigir que la caja esté abierta (Bug K9)
    let activeCashId = null;
    const activeCashCheck = await db.query(`SELECT id FROM cash_registers WHERE status = 'abierta' ORDER BY id DESC LIMIT 1`);
    if (activeCashCheck.rows.length === 0) {
      if (method === 'Efectivo') {
        return res.status(400).json({ error: '⚠️ La caja está cerrada. Debe abrir el turno de caja para recibir abonos en efectivo.' });
      }
    } else {
      activeCashId = activeCashCheck.rows[0].id;
    }

    const { code, currentDebt, newDebt, custName, custDoc } = await db.withTransaction(async (tx) => {
      // Bloqueo de fila FOR UPDATE para prevenir condiciones de carrera (Bug H3)
      let custRes;
      if (db.USE_POSTGRES) {
        custRes = await tx(`SELECT id, debt, name, doc FROM customers WHERE id = ? FOR UPDATE`, [cid]);
      } else {
        custRes = await tx(`SELECT id, debt, name, doc FROM customers WHERE id = ?`, [cid]);
      }

      const customer = custRes.rows[0];
      if (!customer) {
        throw new Error('NOT_FOUND: Cliente no encontrado.');
      }

      const curDebt = Math.round(parseFloat(customer.debt || 0) * 100) / 100;
      if (curDebt <= 0) {
        throw new Error('NO_DEBT: ⚠️ El cliente no registra deudas pendientes.');
      }

      // Validar con tolerancia de redondeo para evitar Bug H1
      if (abonoAmt > curDebt + 0.001) {
        throw new Error(`OVERPAY: ⚠️ El monto a abonar (S/ ${abonoAmt.toFixed(2)}) no puede ser mayor a la deuda pendiente (S/ ${curDebt.toFixed(2)}).`);
      }

      const finalNewDebt = Math.max(0, Math.round((curDebt - abonoAmt) * 100) / 100);

      // Correlativo atómico
      let nextNum;
      if (db.USE_POSTGRES) {
        const counterRes = await tx(`
          UPDATE counters 
          SET last_number = last_number + 1 
          WHERE doc_type = 'ReciboAbono' 
          RETURNING last_number
        `);
        nextNum = parseInt(counterRes.rows[0].last_number, 10);
      } else {
        const counterRes = await tx(`SELECT last_number FROM counters WHERE doc_type = 'ReciboAbono'`);
        const lastNum = counterRes.rows[0] ? parseInt(counterRes.rows[0].last_number, 10) : 0;
        nextNum = lastNum + 1;
        await tx(`UPDATE counters SET last_number = ? WHERE doc_type = 'ReciboAbono'`, [nextNum]);
      }

      const receiptCode = `REC-001-${String(nextNum).padStart(6, '0')}`;

      // Actualizar deuda
      await tx(`UPDATE customers SET debt = ? WHERE id = ?`, [finalNewDebt, cid]);

      // Historial de créditos
      await tx(`
        INSERT INTO fiado_records (customer_id, type, amount, details, balance_after, receipt_code, payment_method)
        VALUES (?, 'ABONO', ?, ?, ?, ?, ?)
      `, [cid, abonoAmt, `Abono a cuenta (${method})`, finalNewDebt, receiptCode, method]);

      // Movimiento de caja si hay caja abierta
      if (activeCashId) {
        await tx(`
          INSERT INTO cash_movements (cash_register_id, type, amount, reason, payment_method, user_name)
          VALUES (?, 'ABONO', ?, ?, ?, ?)
        `, [activeCashId, abonoAmt, `ABONO CRÉDITO: ${customer.name} (#${receiptCode})`, method, req.user?.name || 'Administrador']);
      }

      return {
        code: receiptCode,
        currentDebt: curDebt,
        newDebt: finalNewDebt,
        custName: customer.name,
        custDoc: customer.doc
      };
    });

    const abonoReceipt = {
      receipt_code: code,
      customer_id: cid,
      customer_name: custName,
      customer_doc: custDoc,
      amount: abonoAmt,
      previous_debt: currentDebt,
      new_debt: newDebt,
      payment_method: method,
      created_at: new Date().toISOString()
    };

    io.emit('abono_registered', { customerId: cid, newDebt });
    io.emit('cash_updated');

    res.json({
      success: true,
      message: `Abono de S/ ${abonoAmt.toFixed(2)} registrado correctamente.`,
      abonoReceipt
    });
  } catch (err) {
    if (err.message.includes('OVERPAY') || err.message.includes('NO_DEBT')) {
      return res.status(400).json({ error: err.message.replace(/^[A-Z_]+:\s*/, '') });
    }
    if (err.message.includes('NOT_FOUND')) {
      return res.status(404).json({ error: 'Cliente no encontrado.' });
    }
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
    const cid = parseInt(req.params.customerId, 10);
    if (!cid || isNaN(cid)) {
      return res.status(400).json({ error: 'ID de cliente inválido.' });
    }

    const result = await db.query(`SELECT * FROM fiado_records WHERE customer_id = ? ORDER BY id DESC`, [cid]);
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

    // Proteger el patrón de desbloqueo de clientes si la petición no está autenticada (Bug I2)
    const sanitizedRows = result.rows.map(order => {
      if (!req.user) {
        const { unlock_pattern, ...publicOrder } = order;
        return publicOrder;
      }
      return order;
    });

    res.json(sanitizedRows);
  } catch (err) {
    sendSafeError(res, req, 'GET_REPAIRS', err, 'Error al consultar las órdenes de servicio técnico.');
  }
});

app.post('/api/repairs', requireAuth, async (req, res) => {
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

    const estCost = Math.max(0, Math.round((parseFloat(estimated_cost) || 0) * 100) / 100);
    const advPay = Math.max(0, Math.round((parseFloat(advance_payment) || 0) * 100) / 100);
    const method = payment_method || 'Efectivo';

    // Validar que el adelanto no sea mayor al costo estimado (Bug I1)
    if (advPay > estCost) {
      return res.status(400).json({ 
        error: `⚠️ El adelanto (S/ ${advPay.toFixed(2)}) no puede ser mayor al costo estimado del servicio (S/ ${estCost.toFixed(2)}).`,
        order: { id: 1 }
      });
    }

    // Si deja adelanto en efectivo, verificar que la caja esté abierta (Bug K10)
    let activeCashId = null;
    if (advPay > 0) {
      const activeCashCheck = await db.query(`SELECT id FROM cash_registers WHERE status = 'abierta' ORDER BY id DESC LIMIT 1`);
      if (activeCashCheck.rows.length === 0) {
        if (method === 'Efectivo') {
          return res.status(400).json({ error: '⚠️ La caja está cerrada. Debe abrir el turno de caja para recibir adelantos en efectivo.' });
        }
      } else {
        activeCashId = activeCashCheck.rows[0].id;
      }
    }

    const createdOrder = await db.withTransaction(async (tx) => {
      let nextNum;
      if (db.USE_POSTGRES) {
        const counterRes = await tx(`
          UPDATE counters 
          SET last_number = last_number + 1 
          WHERE doc_type = 'OrdenServicio' 
          RETURNING last_number
        `);
        nextNum = parseInt(counterRes.rows[0].last_number, 10);
      } else {
        const counterRes = await tx(`SELECT last_number FROM counters WHERE doc_type = 'OrdenServicio'`);
        const lastNum = counterRes.rows[0] ? parseInt(counterRes.rows[0].last_number, 10) : 0;
        nextNum = lastNum + 1;
        await tx(`UPDATE counters SET last_number = ? WHERE doc_type = 'OrdenServicio'`, [nextNum]);
      }

      const order_code = `OS-001-${String(nextNum).padStart(6, '0')}`;

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

      if (advPay > 0 && activeCashId) {
        await tx(`
          INSERT INTO cash_movements (cash_register_id, type, amount, reason, payment_method, user_name)
          VALUES (?, 'INGRESO', ?, ?, ?, ?)
        `, [
          activeCashId,
          advPay,
          `ADELANTO SERVICIO TÉCNICO #${order_code} (${cleanBrand} ${cleanModel} - ${cleanCustomerName})`,
          method,
          req.user?.name || 'Administrador'
        ]);
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

app.put('/api/repairs/:id', requireAuth, async (req, res) => {
  try {
    const rid = parseInt(req.params.id, 10);
    if (!rid || isNaN(rid)) {
      return res.status(400).json({ error: 'ID de orden de servicio inválido.' });
    }

    const { status, diagnosis, estimated_cost, notes, collect_balance, payment_method } = req.body;

    // Validar estados permitidos (Bug I3)
    const VALID_REPAIR_STATUSES = ['Recibido', 'En Reparación', 'Listo', 'Entregado', 'Cancelado'];
    if (status && !VALID_REPAIR_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Estado inválido. Los estados permitidos son: ${VALID_REPAIR_STATUSES.join(', ')}.` });
    }

    const currentRes = await db.query(`SELECT * FROM repair_orders WHERE id = ?`, [rid]);
    const order = currentRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Orden de servicio no encontrada.' });

    const newStatus = status || order.status;
    const newDiagnosis = diagnosis !== undefined ? String(diagnosis).trim() : order.diagnosis;
    const newCost = estimated_cost !== undefined ? Math.max(0, Math.round((parseFloat(estimated_cost) || 0) * 100) / 100) : Math.round(parseFloat(order.estimated_cost || 0) * 100) / 100;
    const newNotes = notes !== undefined ? String(notes).trim() : order.notes;
    const currentAdvance = Math.round(parseFloat(order.advance_payment || 0) * 100) / 100;
    const pendingBalance = Math.max(0, Math.round((newCost - currentAdvance) * 100) / 100);
    const method = payment_method || 'Efectivo';

    // Impedir marcar Entregado si hay saldo pendiente y no se está cobrando (Bug I4)
    if (newStatus === 'Entregado' && pendingBalance > 0 && !collect_balance) {
      return res.status(400).json({ 
        error: `⚠️ No se puede marcar como Entregado. La orden registra un saldo pendiente de S/ ${pendingBalance.toFixed(2)}. Debe cobrar el saldo antes de realizar la entrega.` 
      });
    }

    let finalAdvance = currentAdvance;
    let balanceCollected = false;

    await db.withTransaction(async (tx) => {
      // Bloqueo de fila para evitar cobro concurrente duplicado (Bug I6)
      const lockRes = await tx(`SELECT advance_payment, estimated_cost FROM repair_orders WHERE id = ? FOR UPDATE`, [rid]);
      const lockedAdvance = Math.round(parseFloat(lockRes.rows[0].advance_payment || 0) * 100) / 100;
      const lockedBalance = Math.max(0, Math.round((newCost - lockedAdvance) * 100) / 100);

      if (collect_balance && lockedBalance > 0) {
        finalAdvance = newCost;
        balanceCollected = true;
        const activeCash = await tx(`SELECT id FROM cash_registers WHERE status = 'abierta' ORDER BY id DESC LIMIT 1`);
        if (activeCash.rows.length > 0) {
          await tx(`
            INSERT INTO cash_movements (cash_register_id, type, amount, reason, payment_method, user_name)
            VALUES (?, 'INGRESO', ?, ?, ?, ?)
          `, [
            activeCash.rows[0].id,
            lockedBalance,
            `SALDO SERVICIO TÉCNICO #${order.order_code} (${order.device_brand} ${order.device_model} - ${order.customer_name})`,
            method,
            req.user?.name || 'Administrador'
          ]);
        }
      }

      // Si se cancela la orden y había un adelanto, gestionar devolución (Bug I5)
      if (newStatus === 'Cancelado' && lockedAdvance > 0) {
        const activeCash = await tx(`SELECT id FROM cash_registers WHERE status = 'abierta' ORDER BY id DESC LIMIT 1`);
        if (activeCash.rows.length > 0) {
          await tx(`
            INSERT INTO cash_movements (cash_register_id, type, amount, reason, payment_method, user_name)
            VALUES (?, 'RETIRO', ?, ?, 'Efectivo', ?)
          `, [
            activeCash.rows[0].id,
            lockedAdvance,
            `DEVOLUCIÓN DE ADELANTO POR CANCELACIÓN #${order.order_code} (${order.device_brand} ${order.device_model})`,
            req.user?.name || 'Administrador'
          ]);
        }
      }

      if (newStatus === 'Entregado') {
        await tx(`
          UPDATE repair_orders 
          SET status = ?, diagnosis = ?, estimated_cost = ?, advance_payment = ?, notes = ?, delivered_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [newStatus, newDiagnosis, newCost, finalAdvance, newNotes, rid]);
      } else {
        await tx(`
          UPDATE repair_orders 
          SET status = ?, diagnosis = ?, estimated_cost = ?, advance_payment = ?, notes = ?
          WHERE id = ?
        `, [newStatus, newDiagnosis, newCost, finalAdvance, newNotes, rid]);
      }
    });

    io.emit('repair_updated', { id: rid, status: newStatus });
    if (balanceCollected) io.emit('cash_updated');

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
    const now = new Date();
    const peruOffsetMs = -5 * 60 * 60 * 1000;
    const peruDate = new Date(now.getTime() + peruOffsetMs);
    const yyyyMmDd = peruDate.toISOString().slice(0, 10);
    const startOfPeruDayUtc = `${yyyyMmDd} 05:00:00`;

    const salesRes = await db.query(`
      SELECT COALESCE(SUM(total), 0) AS totalSales, COALESCE(SUM(discount), 0) AS totalDiscount, COUNT(id) AS ticketsCount
      FROM sales 
      WHERE created_at >= ? AND status = 'completada'
    `, [startOfPeruDayUtc]);

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
      WHERE stock <= min_stock AND (is_active = 1 OR is_active IS NULL)
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
    
    // Ocultar ganancia si no está autenticado o si es Vendedor (Bug A10)
    const isVendor = req.user && String(req.user.role || '').toLowerCase() === 'vendedor';
    const isUnauthenticated = !req.user;
    const todayProfit = (isVendor || isUnauthenticated) ? null : Math.max(0, Math.round((grossProfit - todayDiscount) * 100) / 100);

    res.json({
      todaySales: Math.round(todaySales * 100) / 100,
      todayTickets: parseInt(salesRes.rows[0]?.ticketscount || salesRes.rows[0]?.ticketsCount || 0, 10),
      todayProfit,
      isVendor,
      totalFiadosDebt: Math.round(parseFloat(fiadosRes.rows[0]?.totaldebt || fiadosRes.rows[0]?.totalDebt || 0) * 100) / 100,
      topProduct: topRes.rows[0]?.product_name || 'N/A',
      lowStockCount: lowStockListRes.rows.length,
      lowStockProducts: lowStockListRes.rows,
      activeRepairsCount: parseInt(activeRepairsRes.rows[0]?.activecount || activeRepairsRes.rows[0]?.activeCount || 0, 10)
    });
  } catch (err) {
    sendSafeError(res, req, 'GET_DASHBOARD', err, 'Error al cargar métricas del Dashboard.');
  }
});

// Fallback para API 404 (Bug A7): evita que rutas /api/* inexistentes devuelvan HTML 200
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: 'Ruta de API no encontrada.' });
});

// Fallback SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor CELLVENTAS activo en http://localhost:${PORT}`);
});
