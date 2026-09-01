// =========================================================================
// SERVIDOR BACKEND API - CELLVENTAS
// Sistema POS, Almacén y Matriz de Compatibilidad para Celulares y Accesorios
// Express + WebSockets (Socket.io) + PostgreSQL + JWT + Rate Limiter
// =========================================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

const PORT = process.env.PORT || 8092;
const JWT_SECRET = process.env.JWT_SECRET || 'cellventas_jwt_super_secret_key_2026';

// Configuración de Rate Limiting para Login (Protección Anti-Fuerza Bruta)
const loginLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 10, // Máximo 10 intentos por IP
  message: { error: '⚠️ Demasiados intentos fallidos. Por seguridad, espere 1 minuto antes de reintentar.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Manejo de conexiones WebSocket
io.on('connection', (socket) => {
  console.log(`🔌 Cliente WebSocket conectado (ID: ${socket.id})`);
  socket.on('disconnect', () => {
    console.log(`🔌 Cliente WebSocket desconectado (ID: ${socket.id})`);
  });
});

// Middleware de Autenticación JWT
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Acceso no autorizado. Token JWT requerido.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Sesión expirada o token no válido.' });
  }
}

// Middleware para verificar rol de Administrador
function adminOnly(req, res, next) {
  if (req.user && (req.user.role === 'Administrador' || req.user.role === 'Admin')) {
    next();
  } else {
    res.status(403).json({ error: 'Acceso denegado. Se requieren permisos de Administrador.' });
  }
}

// =========================================================================
// 0. AUTENTICACIÓN (LOGIN Y VERIFICACIÓN)
// =========================================================================
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña son requeridos.' });
  }

  try {
    const result = await db.query('SELECT * FROM users WHERE username = $1', [username.trim()]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }

    const match = bcrypt.compareSync(password, user.password);
    if (!match) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      message: 'Inicio de sesión exitoso',
      token,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ error: 'Error interno en el servidor.' });
  }
});

app.get('/api/auth/verify', authMiddleware, (req, res) => {
  res.json({ valid: true, user: req.user });
});

// =========================================================================
// 1. MARCAS DE CELULARES (/api/brands)
// =========================================================================
app.get('/api/brands', authMiddleware, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM brands ORDER BY order_index ASC, name ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/brands', authMiddleware, adminOnly, async (req, res) => {
  const { name, logo, order_index } = req.body;
  if (!name) return res.status(400).json({ error: 'El nombre de la marca es obligatorio.' });

  try {
    const result = await db.query(`
      INSERT INTO brands (name, logo, order_index)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [name.trim(), logo || '', order_index || 0]);
    io.emit('brands_updated');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: 'Marca ya existente o datos inválidos.' });
  }
});

app.put('/api/brands/:id', authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { name, logo, order_index } = req.body;
  try {
    const result = await db.query(`
      UPDATE brands
      SET name = COALESCE($1, name), logo = COALESCE($2, logo), order_index = COALESCE($3, order_index)
      WHERE id = $4
      RETURNING *
    `, [name ? name.trim() : null, logo, order_index, id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Marca no encontrada.' });
    io.emit('brands_updated');
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/brands/:id', authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('DELETE FROM brands WHERE id = $1', [id]);
    io.emit('brands_updated');
    res.json({ message: 'Marca eliminada correctamente.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// 2. MODELOS DE CELULARES (/api/models)
// =========================================================================
app.get('/api/models', authMiddleware, async (req, res) => {
  const { brand_id } = req.query;
  try {
    let query = `
      SELECT m.*, b.name AS brand_name 
      FROM phone_models m
      JOIN brands b ON m.brand_id = b.id
    `;
    const params = [];
    if (brand_id) {
      query += ' WHERE m.brand_id = $1';
      params.push(brand_id);
    }
    query += ' ORDER BY b.name ASC, m.release_year DESC NULLS LAST, m.name ASC';
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/models', authMiddleware, adminOnly, async (req, res) => {
  const { brand_id, name, release_year, screen_size, notes } = req.body;
  if (!brand_id || !name) return res.status(400).json({ error: 'Marca y Nombre del modelo son obligatorios.' });

  try {
    const result = await db.query(`
      INSERT INTO phone_models (brand_id, name, release_year, screen_size, notes)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [brand_id, name.trim(), release_year || null, screen_size || '', notes || '']);
    io.emit('models_updated');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: 'Modelo ya registrado para esta marca.' });
  }
});

app.put('/api/models/:id', authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { brand_id, name, release_year, screen_size, notes } = req.body;
  try {
    const result = await db.query(`
      UPDATE phone_models
      SET brand_id = COALESCE($1, brand_id),
          name = COALESCE($2, name),
          release_year = $3,
          screen_size = COALESCE($4, screen_size),
          notes = COALESCE($5, notes)
      WHERE id = $6
      RETURNING *
    `, [brand_id, name ? name.trim() : null, release_year, screen_size, notes, id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Modelo no encontrado.' });
    io.emit('models_updated');
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/models/:id', authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('DELETE FROM phone_models WHERE id = $1', [id]);
    io.emit('models_updated');
    res.json({ message: 'Modelo eliminado correctamente.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// 3. MATRIZ DE COMPATIBILIDAD CRUZADA (/api/compatibilities)
// =========================================================================

// Obtener todos los accesorios/productos compatibles con un Modelo de celular
app.get('/api/compatibilities/by-model/:modelId', authMiddleware, async (req, res) => {
  const { modelId } = req.params;
  try {
    const result = await db.query(`
      SELECT 
        p.*,
        pc.notes AS compatibility_notes,
        b.name AS brand_name,
        pm.name AS phone_model_name,
        (SELECT COUNT(*) FROM device_imeis di WHERE di.product_id = p.id AND di.status = 'disponible') AS available_imeis_count
      FROM products p
      JOIN product_compatibilities pc ON p.id = pc.product_id
      LEFT JOIN brands b ON p.brand_id = b.id
      LEFT JOIN phone_models pm ON p.phone_model_id = pm.id
      WHERE pc.phone_model_id = $1
      ORDER BY p.category ASC, p.name ASC
    `, [modelId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obtener todos los modelos de celular compatibles con un Producto específico
app.get('/api/compatibilities/by-product/:productId', authMiddleware, async (req, res) => {
  const { productId } = req.params;
  try {
    const result = await db.query(`
      SELECT 
        pc.id AS compatibility_id,
        pc.notes AS compatibility_notes,
        pm.id AS model_id,
        pm.name AS model_name,
        pm.release_year,
        pm.screen_size,
        b.id AS brand_id,
        b.name AS brand_name
      FROM product_compatibilities pc
      JOIN phone_models pm ON pc.phone_model_id = pm.id
      JOIN brands b ON pm.brand_id = b.id
      WHERE pc.product_id = $1
      ORDER BY b.name ASC, pm.name ASC
    `, [productId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Asignación Masiva de Modelos a un Producto (Guarda la lista completa de compatibilidades)
app.post('/api/compatibilities/assign', authMiddleware, adminOnly, async (req, res) => {
  const { productId, modelIds, notes } = req.body;
  if (!productId || !Array.isArray(modelIds)) {
    return res.status(400).json({ error: 'productId y array de modelIds son requeridos.' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    
    // Eliminar compatibilidades anteriores del producto
    await client.query('DELETE FROM product_compatibilities WHERE product_id = $1', [productId]);

    // Insertar nuevas compatibilidades
    for (const modelId of modelIds) {
      await client.query(`
        INSERT INTO product_compatibilities (product_id, phone_model_id, notes)
        VALUES ($1, $2, $3)
        ON CONFLICT (product_id, phone_model_id) DO UPDATE SET notes = EXCLUDED.notes
      `, [productId, modelId, notes || '']);
    }

    await client.query('COMMIT');
    io.emit('compatibilities_updated', { productId });
    res.json({ message: 'Compatibilidades actualizadas con éxito.', totalAssigned: modelIds.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Resumen y Auditoría de la Matriz para el Dueño (Modelos con stock de accesorios)
app.get('/api/compatibilities/matrix-overview', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        b.id AS brand_id,
        b.name AS brand_name,
        pm.id AS model_id,
        pm.name AS model_name,
        pm.release_year,
        COUNT(pc.id) AS total_compatible_products,
        COALESCE(SUM(CASE WHEN p.category = 'Micas y Vidrios' THEN p.stock ELSE 0 END), 0) AS glass_stock,
        COALESCE(SUM(CASE WHEN p.category = 'Fundas y Cases' THEN p.stock ELSE 0 END), 0) AS cases_stock,
        COALESCE(SUM(CASE WHEN p.category = 'Protectores de Cámara' THEN p.stock ELSE 0 END), 0) AS camera_stock,
        COALESCE(SUM(p.stock), 0) AS total_stock
      FROM phone_models pm
      JOIN brands b ON pm.brand_id = b.id
      LEFT JOIN product_compatibilities pc ON pm.id = pc.phone_model_id
      LEFT JOIN products p ON pc.product_id = p.id
      GROUP BY b.id, b.name, pm.id, pm.name, pm.release_year
      ORDER BY b.order_index ASC, b.name ASC, pm.name ASC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// 4. PRODUCTOS E INVENTARIO (/api/products)
// =========================================================================
app.get('/api/products', authMiddleware, async (req, res) => {
  const { search, category, brand_id, phone_model_id, has_imei, low_stock } = req.query;
  try {
    let query = `
      SELECT 
        p.*,
        b.name AS brand_name,
        pm.name AS phone_model_name,
        (SELECT COUNT(*) FROM device_imeis di WHERE di.product_id = p.id AND di.status = 'disponible') AS available_imeis_count,
        (SELECT COUNT(*) FROM product_compatibilities pc WHERE pc.product_id = p.id) AS total_compatibilities_count
      FROM products p
      LEFT JOIN brands b ON p.brand_id = b.id
      LEFT JOIN phone_models pm ON p.phone_model_id = pm.id
      WHERE 1=1
    `;
    const params = [];

    if (search) {
      params.push(`%${search.trim()}%`);
      query += ` AND (p.name ILIKE $${params.length} OR p.code ILIKE $${params.length} OR p.description ILIKE $${params.length})`;
    }
    if (category && category !== 'Todos') {
      params.push(category);
      query += ` AND p.category = $${params.length}`;
    }
    if (brand_id) {
      params.push(brand_id);
      query += ` AND p.brand_id = $${params.length}`;
    }
    if (phone_model_id) {
      params.push(phone_model_id);
      query += ` AND (p.phone_model_id = $${params.length} OR p.id IN (SELECT product_id FROM product_compatibilities WHERE phone_model_id = $${params.length}))`;
    }
    if (has_imei !== undefined) {
      params.push(has_imei === 'true');
      query += ` AND p.has_imei = $${params.length}`;
    }
    if (low_stock === 'true') {
      query += ` AND p.stock <= p.min_stock`;
    }

    query += ' ORDER BY p.name ASC';
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const prodRes = await db.query(`
      SELECT p.*, b.name AS brand_name, pm.name AS phone_model_name
      FROM products p
      LEFT JOIN brands b ON p.brand_id = b.id
      LEFT JOIN phone_models pm ON p.phone_model_id = pm.id
      WHERE p.id = $1
    `, [id]);
    if (prodRes.rows.length === 0) return res.status(404).json({ error: 'Producto no encontrado.' });

    const product = prodRes.rows[0];

    // Cargar compatibilidades
    const compRes = await db.query(`
      SELECT pc.phone_model_id, pm.name AS model_name, b.name AS brand_name, pc.notes
      FROM product_compatibilities pc
      JOIN phone_models pm ON pc.phone_model_id = pm.id
      JOIN brands b ON pm.brand_id = b.id
      WHERE pc.product_id = $1
    `, [id]);
    product.compatibilities = compRes.rows;

    // Cargar IMEIs si aplica
    if (product.has_imei) {
      const imeiRes = await db.query(`
        SELECT * FROM device_imeis WHERE product_id = $1 ORDER BY status ASC, id ASC
      `, [id]);
      product.imeis = imeiRes.rows;
    }

    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products', authMiddleware, adminOnly, async (req, res) => {
  const { code, name, category, purchase_price, price, stock, min_stock, has_imei, brand_id, phone_model_id, description, initial_imeis } = req.body;
  if (!code || !name || price === undefined) {
    return res.status(400).json({ error: 'Código, Nombre y Precio son requeridos.' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const calculatedStock = (has_imei && Array.isArray(initial_imeis)) ? initial_imeis.length : (stock || 0);

    const result = await client.query(`
      INSERT INTO products (code, name, category, purchase_price, price, stock, min_stock, has_imei, brand_id, phone_model_id, description)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [
      code.trim(),
      name.trim(),
      category || 'Accesorios',
      purchase_price || 0,
      price,
      calculatedStock,
      min_stock || 5,
      has_imei || false,
      brand_id || null,
      phone_model_id || null,
      description || ''
    ]);

    const newProduct = result.rows[0];

    // Si tiene IMEIs iniciales, registrarlos
    if (has_imei && Array.isArray(initial_imeis) && initial_imeis.length > 0) {
      for (const imeiStr of initial_imeis) {
        const cleanImei = String(imeiStr).trim();
        if (cleanImei) {
          await client.query(`
            INSERT INTO device_imeis (product_id, imei, serial_number, status)
            VALUES ($1, $2, $3, 'disponible')
          `, [newProduct.id, cleanImei, 'SN-' + cleanImei.slice(-6)]);
        }
      }
    }

    await client.query('COMMIT');
    io.emit('stock_updated');
    res.status(201).json(newProduct);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: 'Código duplicado o error al registrar producto: ' + err.message });
  } finally {
    client.release();
  }
});

app.put('/api/products/:id', authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { code, name, category, purchase_price, price, stock, min_stock, has_imei, brand_id, phone_model_id, description } = req.body;
  try {
    const result = await db.query(`
      UPDATE products
      SET code = COALESCE($1, code),
          name = COALESCE($2, name),
          category = COALESCE($3, category),
          purchase_price = COALESCE($4, purchase_price),
          price = COALESCE($5, price),
          stock = COALESCE($6, stock),
          min_stock = COALESCE($7, min_stock),
          has_imei = COALESCE($8, has_imei),
          brand_id = $9,
          phone_model_id = $10,
          description = COALESCE($11, description)
      WHERE id = $12
      RETURNING *
    `, [code ? code.trim() : null, name ? name.trim() : null, category, purchase_price, price, stock, min_stock, has_imei, brand_id, phone_model_id, description, id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Producto no encontrado.' });
    io.emit('stock_updated');
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('DELETE FROM products WHERE id = $1', [id]);
    io.emit('stock_updated');
    res.json({ message: 'Producto eliminado correctamente.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ajuste rápido de Stock y Abastecimiento
app.post('/api/products/:id/stock-entry', authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { quantity, imeis, notes } = req.body;
  
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const prodRes = await client.query('SELECT * FROM products WHERE id = $1', [id]);
    if (prodRes.rows.length === 0) throw new Error('Producto no encontrado');
    const prod = prodRes.rows[0];

    let addedQty = parseInt(quantity || 0);

    if (prod.has_imei && Array.isArray(imeis) && imeis.length > 0) {
      addedQty = imeis.length;
      for (const imei of imeis) {
        const clean = String(imei).trim();
        if (clean) {
          await client.query(`
            INSERT INTO device_imeis (product_id, imei, serial_number, status)
            VALUES ($1, $2, $3, 'disponible')
          `, [id, clean, 'SN-' + clean.slice(-6)]);
        }
      }
    }

    const updated = await client.query(`
      UPDATE products
      SET stock = stock + $1
      WHERE id = $2
      RETURNING *
    `, [addedQty, id]);

    await client.query('COMMIT');
    io.emit('stock_updated');
    res.json({ message: 'Stock actualizado con éxito.', product: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// =========================================================================
// 5. GESTIÓN Y RASTREO DE IMEIS (/api/imeis)
// =========================================================================

// Listar IMEIs de un producto
app.get('/api/imeis/product/:productId', authMiddleware, async (req, res) => {
  const { productId } = req.params;
  const { status } = req.query;
  try {
    let query = 'SELECT * FROM device_imeis WHERE product_id = $1';
    const params = [productId];
    if (status) {
      query += ' AND status = $2';
      params.push(status);
    }
    query += ' ORDER BY status ASC, id ASC';
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rastrear un IMEI específico (Búsqueda en todo el sistema)
app.get('/api/imeis/track/:imei', authMiddleware, async (req, res) => {
  const { imei } = req.params;
  try {
    const result = await db.query(`
      SELECT 
        di.*,
        p.name AS product_name,
        p.code AS product_code,
        s.receipt_code,
        s.doc_type,
        s.customer_name,
        s.payment_method,
        s.user_name AS cashier_name,
        s.created_at AS sale_date
      FROM device_imeis di
      JOIN products p ON di.product_id = p.id
      LEFT JOIN sales s ON di.sale_id = s.id
      WHERE di.imei = $1 OR di.serial_number = $1
    `, [imei.trim()]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'IMEI / Serie no encontrado en el sistema.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cambiar estado de un IMEI (ej. reportar defectuoso)
app.put('/api/imeis/:id/status', authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    const result = await db.query(`
      UPDATE device_imeis
      SET status = $1
      WHERE id = $2
      RETURNING *
    `, [status, id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// 6. CLIENTES (/api/customers)
// =========================================================================
app.get('/api/customers', authMiddleware, async (req, res) => {
  const { search } = req.query;
  try {
    let query = 'SELECT * FROM customers WHERE 1=1';
    const params = [];
    if (search) {
      params.push(`%${search.trim()}%`);
      query += ` AND (name ILIKE $${params.length} OR doc ILIKE $${params.length} OR phone ILIKE $${params.length})`;
    }
    query += ' ORDER BY name ASC LIMIT 50';
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/customers', authMiddleware, async (req, res) => {
  const { doc, name, phone, address } = req.body;
  if (!doc || !name) return res.status(400).json({ error: 'Documento (DNI/RUC) y Nombre son obligatorios.' });

  try {
    const result = await db.query(`
      INSERT INTO customers (doc, name, phone, address)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (doc) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, address = EXCLUDED.address
      RETURNING *
    `, [doc.trim(), name.trim(), phone || '', address || '']);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// 7. ARQUEO Y CONTROL DE CAJA (/api/cash)
// =========================================================================
app.get('/api/cash/status', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM cash_registers 
      WHERE status = 'abierta' 
      ORDER BY id DESC LIMIT 1
    `);
    res.json({ activeRegister: result.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cash/open', authMiddleware, async (req, res) => {
  const { opening_amount, notes } = req.body;
  try {
    // Verificar si ya hay una caja abierta
    const active = await db.query("SELECT id FROM cash_registers WHERE status = 'abierta'");
    if (active.rows.length > 0) {
      return res.status(400).json({ error: 'Ya existe una caja abierta actualmente.' });
    }

    const result = await db.query(`
      INSERT INTO cash_registers (user_id, user_name, opening_amount, notes)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [req.user.id, req.user.name, opening_amount || 0, notes || '']);

    io.emit('cash_updated');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cash/movement', authMiddleware, async (req, res) => {
  const { cash_register_id, type, amount, reason } = req.body;
  if (!cash_register_id || !amount || !reason) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios.' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const mov = await client.query(`
      INSERT INTO cash_movements (cash_register_id, user_id, user_name, type, amount, reason)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [cash_register_id, req.user.id, req.user.name, type || 'RETIRO', amount, reason]);

    if (type === 'RETIRO') {
      await client.query(`
        UPDATE cash_registers
        SET total_withdrawals = total_withdrawals + $1
        WHERE id = $2
      `, [amount, cash_register_id]);
    }

    await client.query('COMMIT');
    io.emit('cash_updated');
    res.status(201).json(mov.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/cash/movements/:registerId', authMiddleware, async (req, res) => {
  const { registerId } = req.params;
  try {
    const result = await db.query(`
      SELECT * FROM cash_movements WHERE cash_register_id = $1 ORDER BY created_at DESC
    `, [registerId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cash/close', authMiddleware, async (req, res) => {
  const { cash_register_id, actual_cash, notes } = req.body;
  if (!cash_register_id || actual_cash === undefined) {
    return res.status(400).json({ error: 'ID de caja y efectivo real contado son requeridos.' });
  }

  try {
    const regRes = await db.query('SELECT * FROM cash_registers WHERE id = $1', [cash_register_id]);
    if (regRes.rows.length === 0) return res.status(404).json({ error: 'Caja no encontrada.' });

    const reg = regRes.rows[0];
    const expectedCash = (parseFloat(reg.opening_amount) + parseFloat(reg.cash_sales)) - parseFloat(reg.total_withdrawals);
    const difference = parseFloat(actual_cash) - expectedCash;

    const result = await db.query(`
      UPDATE cash_registers
      SET status = 'cerrada',
          expected_cash = $1,
          actual_cash = $2,
          difference = $3,
          notes = COALESCE($4, notes),
          closed_at = CURRENT_TIMESTAMP
      WHERE id = $5
      RETURNING *
    `, [expectedCash, actual_cash, difference, notes, cash_register_id]);

    io.emit('cash_updated');
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// 8. PUNTO DE VENTA (POS) Y VENTAS (/api/sales)
// =========================================================================

// Generar código correlativo de comprobante
async function generateReceiptCode(docType, client) {
  const prefix = docType === 'Factura' ? 'FAC' : (docType === 'Boleta' ? 'BOL' : 'TICK');
  const counterId = `sales_${prefix.toLowerCase()}`;
  
  await client.query(`
    INSERT INTO counters (id, value) VALUES ($1, 1)
    ON CONFLICT (id) DO UPDATE SET value = counters.value + 1
  `, [counterId]);

  const res = await client.query('SELECT value FROM counters WHERE id = $1', [counterId]);
  const num = String(res.rows[0].value).padStart(6, '0');
  return `${prefix}-${num}`;
}

// Registrar nueva venta (Transacción ACID)
app.post('/api/sales', authMiddleware, async (req, res) => {
  const { doc_type, customer_id, customer_name, payment_method, items, paid_amount, notes } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'El carrito de venta no puede estar vacío.' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // 1. Obtener caja activa si existe
    const activeCash = await client.query("SELECT id FROM cash_registers WHERE status = 'abierta' ORDER BY id DESC LIMIT 1");
    const cashRegisterId = activeCash.rows.length > 0 ? activeCash.rows[0].id : null;

    // 2. Validar stock e IMEIs de cada item
    let subtotal = 0;
    const validatedItems = [];

    for (const item of items) {
      const prodRes = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [item.product_id]);
      if (prodRes.rows.length === 0) {
        throw new Error(`Producto con ID ${item.product_id} no encontrado.`);
      }
      const prod = prodRes.rows[0];

      if (prod.stock < item.quantity) {
        throw new Error(`Stock insuficiente para "${prod.name}". Disponible: ${prod.stock}, Solicitado: ${item.quantity}`);
      }

      // Validar IMEIs si el producto los requiere
      if (prod.has_imei) {
        if (!item.imeis || !Array.isArray(item.imeis) || item.imeis.length !== item.quantity) {
          throw new Error(`Debe seleccionar exactamente ${item.quantity} IMEI(s) para "${prod.name}".`);
        }

        // Verificar que los IMEIs existan y estén disponibles
        for (const imeiCode of item.imeis) {
          const imeiCheck = await client.query(`
            SELECT * FROM device_imeis 
            WHERE product_id = $1 AND imei = $2 AND status = 'disponible' 
            FOR UPDATE
          `, [prod.id, imeiCode]);
          if (imeiCheck.rows.length === 0) {
            throw new Error(`El IMEI "${imeiCode}" para "${prod.name}" no está disponible.`);
          }
        }
      }

      const unitPrice = parseFloat(item.price || prod.price);
      const itemTotal = unitPrice * item.quantity;
      subtotal += itemTotal;

      validatedItems.push({
        product_id: prod.id,
        product_name: prod.name,
        quantity: item.quantity,
        unit_price: unitPrice,
        total_price: itemTotal,
        has_imei: prod.has_imei,
        imeis: item.imeis || []
      });
    }

    const total = subtotal; // Podría calcularse impuesto si aplica
    const receiptCode = await generateReceiptCode(doc_type || 'Ticket', client);
    const paid = parseFloat(paid_amount || total);
    const change = paid > total ? paid - total : 0;

    // 3. Insertar Venta
    const saleResult = await client.query(`
      INSERT INTO sales (
        receipt_code, doc_type, customer_id, customer_name, payment_method,
        subtotal, tax, total, paid_amount, change_amount,
        user_id, user_name, cash_register_id, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *
    `, [
      receiptCode,
      doc_type || 'Ticket',
      customer_id || null,
      customer_name || 'Público General',
      payment_method || 'Efectivo',
      subtotal,
      0,
      total,
      paid,
      change,
      req.user.id,
      req.user.name,
      cashRegisterId,
      notes || ''
    ]);

    const newSale = saleResult.rows[0];

    // 4. Insertar Detalle, descontar stock y marcar IMEIs vendidos
    for (const vItem of validatedItems) {
      await client.query(`
        INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, total_price, imeis)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [newSale.id, vItem.product_id, vItem.product_name, vItem.quantity, vItem.unit_price, vItem.total_price, JSON.stringify(vItem.imeis)]);

      // Descontar Stock
      await client.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [vItem.quantity, vItem.product_id]);

      // Marcar IMEIs
      if (vItem.has_imei && vItem.imeis.length > 0) {
        for (const imeiCode of vItem.imeis) {
          await client.query(`
            UPDATE device_imeis 
            SET status = 'vendido', sale_id = $1, sold_at = CURRENT_TIMESTAMP
            WHERE product_id = $2 AND imei = $3
          `, [newSale.id, vItem.product_id, imeiCode]);
        }
      }
    }

    // 5. Acumular en Caja si está abierta
    if (cashRegisterId) {
      if (payment_method === 'Efectivo') {
        await client.query('UPDATE cash_registers SET cash_sales = cash_sales + $1 WHERE id = $2', [total, cashRegisterId]);
      } else if (payment_method === 'Tarjeta') {
        await client.query('UPDATE cash_registers SET card_sales = card_sales + $1 WHERE id = $2', [total, cashRegisterId]);
      } else if (payment_method === 'Yape / Plin' || payment_method === 'Transferencia') {
        await client.query('UPDATE cash_registers SET transfer_sales = transfer_sales + $1 WHERE id = $2', [total, cashRegisterId]);
      }
    }

    await client.query('COMMIT');

    newSale.items = validatedItems;
    io.emit('sale_completed', newSale);
    io.emit('stock_updated');

    res.status(201).json(newSale);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Listar ventas
app.get('/api/sales', authMiddleware, async (req, res) => {
  const { date, status, search } = req.query;
  try {
    let query = `
      SELECT s.*,
        (SELECT json_agg(si.*) FROM sale_items si WHERE si.sale_id = s.id) AS items
      FROM sales s
      WHERE 1=1
    `;
    const params = [];

    if (date) {
      params.push(date);
      query += ` AND DATE(s.created_at) = $${params.length}`;
    }
    if (status) {
      params.push(status);
      query += ` AND s.status = $${params.length}`;
    }
    if (search) {
      params.push(`%${search.trim()}%`);
      query += ` AND (s.receipt_code ILIKE $${params.length} OR s.customer_name ILIKE $${params.length})`;
    }

    query += ' ORDER BY s.created_at DESC LIMIT 100';
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Anular Venta (Devuelve stock y libera IMEIs)
app.post('/api/sales/:id/cancel', authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const saleRes = await client.query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [id]);
    if (saleRes.rows.length === 0) throw new Error('Venta no encontrada.');

    const sale = saleRes.rows[0];
    if (sale.status === 'anulada') throw new Error('Esta venta ya se encuentra anulada.');

    // 1. Obtener items de la venta
    const itemsRes = await client.query('SELECT * FROM sale_items WHERE sale_id = $1', [id]);

    for (const item of itemsRes.rows) {
      // Revertir Stock
      if (item.product_id) {
        await client.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [item.quantity, item.product_id]);
      }

      // Revertir IMEIs
      const imeis = item.imeis || [];
      if (Array.isArray(imeis) && imeis.length > 0) {
        for (const imeiCode of imeis) {
          await client.query(`
            UPDATE device_imeis 
            SET status = 'disponible', sale_id = NULL, sold_at = NULL
            WHERE product_id = $1 AND imei = $2
          `, [item.product_id, imeiCode]);
        }
      }
    }

    // 2. Revertir saldo de caja si la caja correspondiente sigue abierta
    if (sale.cash_register_id) {
      const regCheck = await client.query('SELECT status FROM cash_registers WHERE id = $1', [sale.cash_register_id]);
      if (regCheck.rows.length > 0 && regCheck.rows[0].status === 'abierta') {
        if (sale.payment_method === 'Efectivo') {
          await client.query('UPDATE cash_registers SET cash_sales = GREATEST(0, cash_sales - $1) WHERE id = $2', [sale.total, sale.cash_register_id]);
        } else if (sale.payment_method === 'Tarjeta') {
          await client.query('UPDATE cash_registers SET card_sales = GREATEST(0, card_sales - $1) WHERE id = $2', [sale.total, sale.cash_register_id]);
        } else if (sale.payment_method === 'Yape / Plin' || sale.payment_method === 'Transferencia') {
          await client.query('UPDATE cash_registers SET transfer_sales = GREATEST(0, transfer_sales - $1) WHERE id = $2', [sale.total, sale.cash_register_id]);
        }
      }
    }

    // 3. Marcar Venta como Anulada
    const updatedSale = await client.query(`
      UPDATE sales 
      SET status = 'anulada', notes = notes || ' | [ANULADA: ' || $1 || ' por ' || $2 || ']'
      WHERE id = $3
      RETURNING *
    `, [reason || 'Anulación solicitada', req.user.name, id]);

    await client.query('COMMIT');
    io.emit('sale_cancelled', { saleId: id });
    io.emit('stock_updated');
    res.json({ message: 'Venta anulada exitosamente y stock restituido.', sale: updatedSale.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// =========================================================================
// 9. USUARIOS Y ROLES (/api/users)
// =========================================================================
app.get('/api/users', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await db.query('SELECT id, username, name, role, created_at FROM users ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', authMiddleware, adminOnly, async (req, res) => {
  const { username, password, name, role } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: 'Todos los campos son requeridos.' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(`
      INSERT INTO users (username, password, name, role)
      VALUES ($1, $2, $3, $4)
      RETURNING id, username, name, role, created_at
    `, [username.trim(), hash, name.trim(), role || 'Vendedor']);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: 'Usuario ya existente.' });
  }
});

app.put('/api/users/:id', authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { name, role, password } = req.body;
  try {
    let query = 'UPDATE users SET name = COALESCE($1, name), role = COALESCE($2, role)';
    const params = [name ? name.trim() : null, role];

    if (password) {
      const hash = await bcrypt.hash(password, 10);
      params.push(hash);
      query += `, password = $${params.length}`;
    }

    params.push(id);
    query += ` WHERE id = $${params.length} RETURNING id, username, name, role, created_at`;

    const result = await db.query(query, params);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:id', authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  if (parseInt(id) === req.user.id) {
    return res.status(400).json({ error: 'No puede eliminar su propio usuario activo.' });
  }
  try {
    await db.query('DELETE FROM users WHERE id = $1', [id]);
    res.json({ message: 'Usuario eliminado correctamente.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// 10. DASHBOARD Y REPORTES (/api/dashboard)
// =========================================================================
app.get('/api/dashboard/summary', authMiddleware, adminOnly, async (req, res) => {
  try {
    // Ventas de hoy
    const todayRes = await db.query(`
      SELECT 
        COALESCE(SUM(total), 0) AS today_sales,
        COUNT(id) AS today_transactions
      FROM sales 
      WHERE DATE(created_at) = CURRENT_DATE AND status = 'completada'
    `);

    // Ventas del mes
    const monthRes = await db.query(`
      SELECT 
        COALESCE(SUM(total), 0) AS month_sales,
        COUNT(id) AS month_transactions
      FROM sales 
      WHERE DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE) AND status = 'completada'
    `);

    // Productos con stock bajo
    const lowStockRes = await db.query('SELECT COUNT(*) FROM products WHERE stock <= min_stock');

    // Total de productos e IMEIs disponibles
    const totalProdRes = await db.query('SELECT COUNT(*) FROM products');
    const totalImeiRes = await db.query("SELECT COUNT(*) FROM device_imeis WHERE status = 'disponible'");

    // Top 5 productos más vendidos
    const topProdRes = await db.query(`
      SELECT si.product_name, SUM(si.quantity) AS total_sold, SUM(si.total_price) AS total_revenue
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE s.status = 'completada'
      GROUP BY si.product_name
      ORDER BY total_sold DESC
      LIMIT 5
    `);

    res.json({
      todaySales: parseFloat(todayRes.rows[0].today_sales),
      todayTransactions: parseInt(todayRes.rows[0].today_transactions),
      monthSales: parseFloat(monthRes.rows[0].month_sales),
      monthTransactions: parseInt(monthRes.rows[0].month_transactions),
      lowStockCount: parseInt(lowStockRes.rows[0].count),
      totalProducts: parseInt(totalProdRes.rows[0].count),
      availableImeis: parseInt(totalImeiRes.rows[0].count),
      topProducts: topProdRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manejo de rutas SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Inicializar Base de Datos y arrancar Servidor
db.initDb().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor CELLVENTAS escuchando en http://0.0.0.0:${PORT}`);
  });
}).catch(err => {
  console.error('❌ Error fatal al arrancar servidor:', err);
});
