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
const JWT_SECRET = process.env.JWT_SECRET || 'cellventas_jwt_secret_key_2026';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Inicializar DB al arrancar
db.initDb();

// WebSockets para sincronización en tiempo real
io.on('connection', (socket) => {
  console.log('⚡ Nuevo cliente Socket.io conectado a CELLVENTAS POS:', socket.id);
});

// Middleware JWT opcional / helper
function verifyToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
  } catch (e) {}
  next();
}
app.use(verifyToken);

// ==========================================
// 1. MARCAS, MODELOS Y ASISTENTE DE COMPATIBILIDAD 360°
// ==========================================

// Obtener todas las marcas con sus modelos
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
    res.status(500).json({ error: err.message });
  }
});

// Registrar nueva marca
app.post('/api/brands', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Nombre de marca es requerido.' });
    await db.query(`INSERT INTO brands (name) VALUES (?)`, [name]);
    io.emit('compatibility_updated');
    res.json({ success: true, message: 'Marca registrada exitosamente' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Registrar nuevo modelo de celular
app.post('/api/models', async (req, res) => {
  try {
    const { brand_id, model_name, release_year } = req.body;
    if (!brand_id || !model_name) {
      return res.status(400).json({ error: 'Marca y Nombre de Modelo son requeridos.' });
    }
    await db.query(`INSERT INTO phone_models (brand_id, model_name, release_year) VALUES (?, ?, ?)`, [brand_id, model_name, release_year || 2024]);
    io.emit('compatibility_updated');
    res.json({ success: true, message: 'Modelo de celular registrado.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eliminar modelo de celular
app.delete('/api/models/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.query(`DELETE FROM phone_models WHERE id = ?`, [id]);
    io.emit('compatibility_updated');
    res.json({ success: true, message: 'Modelo eliminado.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ASISTENTE DE MOSTRADOR: FICHA 360° DE COMPATIBILIDADES PARA UN MODELO
// Devuelve todos los accesorios compatibles clasificados y qué otros modelos comparten cada accesorio
app.get('/api/compatibilities/assistant/:modelId', async (req, res) => {
  try {
    const { modelId } = req.params;

    // Obtener modelo y marca
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

    // Obtener productos compatibles
    const prodsRes = await db.query(`
      SELECT p.*
      FROM products p
      INNER JOIN product_compatibilities pc ON p.id = pc.product_id
      WHERE pc.phone_model_id = ?
      ORDER BY p.category ASC, p.name ASC
    `, [modelId]);

    // Obtener todos los demás modelos que comparten estos productos
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// ASIGNADOR RÁPIDO MASIVO DE COMPATIBILIDAD (Producto ↔ Múltiples Modelos)
app.post('/api/compatibilities/bulk', async (req, res) => {
  try {
    const { product_id, model_ids } = req.body;
    if (!product_id || !Array.isArray(model_ids)) {
      return res.status(400).json({ error: 'Producto y array de modelos requeridos.' });
    }

    await db.query(`DELETE FROM product_compatibilities WHERE product_id = ?`, [product_id]);

    for (const mId of model_ids) {
      await db.query(`INSERT INTO product_compatibilities (product_id, phone_model_id) VALUES (?, ?)`, [product_id, mId]);
    }

    io.emit('compatibility_updated');
    res.json({ success: true, message: `Compatibilidad actualizada (${model_ids.length} modelos asignados).` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2. PRODUCTOS E INVENTARIO
// ==========================================

// Obtener todos los productos con modelos compatibles vinculados
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
    res.status(500).json({ error: err.message });
  }
});

// Crear Producto y asociar modelos compatibles de celulares
app.post('/api/products', async (req, res) => {
  try {
    const { code, name, category, purchase_price, price, stock, min_stock, is_serialized, model_ids } = req.body;

    if (!code || !name || !price) {
      return res.status(400).json({ error: 'Código, Nombre y Precio son requeridos.' });
    }

    const insertRes = await db.query(`
      INSERT INTO products (code, name, category, purchase_price, price, stock, min_stock, is_serialized)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [code, name, category || 'Accesorios', purchase_price || 0, price, stock || 0, min_stock || 5, is_serialized ? 1 : 0]);

    const productId = insertRes.lastID || (insertRes.rows && insertRes.rows[0] ? insertRes.rows[0].id : null);

    // Asociar modelos compatibles
    if (productId && model_ids && Array.isArray(model_ids)) {
      for (const mId of model_ids) {
        await db.query(`INSERT INTO product_compatibilities (product_id, phone_model_id) VALUES (?, ?)`, [productId, mId]);
      }
    }

    io.emit('product_updated', { action: 'created', productId });
    res.json({ success: true, productId, message: 'Producto guardado con éxito con su matriz de compatibilidad.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Editar Producto
app.put('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { code, name, category, purchase_price, price, stock, min_stock, is_serialized, model_ids } = req.body;

    await db.query(`
      UPDATE products 
      SET code = ?, name = ?, category = ?, purchase_price = ?, price = ?, stock = ?, min_stock = ?, is_serialized = ?
      WHERE id = ?
    `, [code, name, category, purchase_price, price, stock, min_stock, is_serialized ? 1 : 0, id]);

    if (model_ids && Array.isArray(model_ids)) {
      await db.query(`DELETE FROM product_compatibilities WHERE product_id = ?`, [id]);
      for (const mId of model_ids) {
        await db.query(`INSERT INTO product_compatibilities (product_id, phone_model_id) VALUES (?, ?)`, [id, mId]);
      }
    }

    io.emit('product_updated', { action: 'updated', productId: id });
    res.json({ success: true, message: 'Producto actualizado.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eliminar producto
app.delete('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.query(`DELETE FROM products WHERE id = ?`, [id]);
    io.emit('product_updated', { action: 'deleted', productId: id });
    res.json({ success: true, message: 'Producto eliminado.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. GESTIÓN INTEGRAL Y TRAZABILIDAD DE IMEIS
// ==========================================

// Obtener IMEIs disponibles para el POS de un producto específico
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
    res.status(500).json({ error: err.message });
  }
});

// Obtener todos los IMEIs de un producto (disponibles, vendidos, etc.)
app.get('/api/imeis/product/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const result = await db.query(`
      SELECT di.*, s.receipt_code, s.customer_name 
      FROM device_imeis di
      LEFT JOIN sales s ON di.sale_id = s.id
      WHERE di.product_id = ?
      ORDER BY di.id DESC
    `, [productId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Registrar lote de IMEIs a un producto
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
        } catch (e) {
          console.warn(`IMEI ${cleanImei} ya registrado o inválido`);
        }
      }
    }

    // Actualizar stock del producto
    await db.query(`UPDATE products SET stock = stock + ? WHERE id = ?`, [insertedCount, product_id]);

    io.emit('product_updated', { action: 'imei_added', productId: product_id });
    res.json({ success: true, message: `${insertedCount} IMEIs registrados exitosamente.`, insertedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TRAZABILIDAD / BUSCADOR DE IMEI
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
    `, [`%${query}%`]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. VENTAS, POS E IMPRESIÓN DE TICKETS
// ==========================================

// Listar ventas con detalle
app.get('/api/sales', async (req, res) => {
  try {
    const salesRes = await db.query(`SELECT * FROM sales ORDER BY id DESC LIMIT 150`);
    const itemsRes = await db.query(`SELECT * FROM sale_items ORDER BY id ASC`);

    const salesWithItems = salesRes.rows.map(s => ({
      ...s,
      items: itemsRes.rows.filter(i => i.sale_id === s.id)
    }));

    res.json(salesWithItems);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obtener detalle de 1 venta
app.get('/api/sales/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const saleRes = await db.query(`SELECT * FROM sales WHERE id = ?`, [id]);
    if (saleRes.rows.length === 0) return res.status(404).json({ error: 'Venta no encontrada' });

    const itemsRes = await db.query(`SELECT * FROM sale_items WHERE sale_id = ?`, [id]);

    res.json({
      ...saleRes.rows[0],
      items: itemsRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Procesar Venta (con asignación de IMEIs, stock y vuelto)
app.post('/api/sales', async (req, res) => {
  try {
    const { doc_type, customer_id, customer_name, payment_method, items, paid_amount, change_amount } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'El carrito no puede estar vacío.' });
    }

    let total = 0;
    items.forEach(i => { total += i.quantity * i.unit_price; });
    const subtotal = total / 1.18;
    const tax = total - subtotal;

    // Validar Stock
    for (const item of items) {
      if (item.product_id) {
        const prodCheck = await db.query(`SELECT name, stock, is_serialized FROM products WHERE id = ?`, [item.product_id]);
        const prod = prodCheck.rows[0];
        if (!prod || prod.stock < item.quantity) {
          return res.status(400).json({ error: `Stock insuficiente para ${item.product_name}. Stock: ${prod ? prod.stock : 0}` });
        }
      }
    }

    // Generar correlativo
    const prefijo = doc_type === 'Factura' ? 'F' : (doc_type === 'Boleta' ? 'B' : 'T');
    const counterRes = await db.query(`SELECT last_number FROM counters WHERE doc_type = ?`, [doc_type || 'Ticket']);
    const lastNum = counterRes.rows[0] ? parseInt(counterRes.rows[0].last_number) : 0;
    const nextNum = lastNum + 1;
    const receipt_code = `${prefijo}001-${String(nextNum).padStart(6, '0')}`;

    await db.query(`UPDATE counters SET last_number = ? WHERE doc_type = ?`, [nextNum, doc_type || 'Ticket']);

    // Registrar Venta
    const saleInsert = await db.query(`
      INSERT INTO sales (receipt_code, doc_type, customer_id, customer_name, payment_method, subtotal, tax, total, paid_amount, change_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [receipt_code, doc_type || 'Ticket', customer_id || null, customer_name || 'Público General', payment_method, subtotal, tax, total, paid_amount || total, change_amount || 0]);

    const saleId = saleInsert.lastID || (saleInsert.rows && saleInsert.rows[0] ? saleInsert.rows[0].id : null);

    // Insertar Items, decrementar stock y marcar IMEIs como vendidos
    for (const item of items) {
      const itemSubtotal = item.quantity * item.unit_price;
      const imeiCode = item.imei || '';

      await db.query(`
        INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, subtotal, imei_code)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [saleId, item.product_id, item.product_name, item.quantity, item.unit_price, itemSubtotal, imeiCode]);

      if (item.product_id) {
        await db.query(`UPDATE products SET stock = stock - ? WHERE id = ?`, [item.quantity, item.product_id]);
      }

      // Si tiene IMEI, actualizar su estado en device_imeis
      if (imeiCode) {
        await db.query(`
          UPDATE device_imeis 
          SET status = 'vendido', sale_id = ?, sold_at = CURRENT_TIMESTAMP 
          WHERE imei_code = ?
        `, [saleId, imeiCode]);
      }
    }

    // Registrar Fiado si aplica
    if (payment_method === 'Fiado' && customer_id) {
      const custRes = await db.query(`SELECT debt FROM customers WHERE id = ?`, [customer_id]);
      const currentDebt = parseFloat(custRes.rows[0]?.debt || 0);
      const newDebt = currentDebt + total;
      const details = items.map(i => `${i.quantity}x ${i.product_name} ${i.imei ? '(IMEI: ' + i.imei + ')' : ''}`).join(', ');

      await db.query(`UPDATE customers SET debt = ? WHERE id = ?`, [newDebt, customer_id]);
      await db.query(`
        INSERT INTO fiado_records (customer_id, type, amount, details, balance_after)
        VALUES (?, 'COMPRA_FIADA', ?, ?, ?)
      `, [customer_id, total, details, newDebt]);
    }

    const completedSale = {
      id: saleId,
      receipt_code,
      doc_type: doc_type || 'Ticket',
      customer_name: customer_name || 'Público General',
      payment_method,
      subtotal,
      tax,
      total,
      paid_amount: paid_amount || total,
      change_amount: change_amount || 0,
      created_at: new Date().toISOString(),
      items: items.map(i => ({ ...i, imei_code: i.imei || '' }))
    };

    io.emit('sale_completed', completedSale);
    res.json({ success: true, sale: completedSale, receipt_code, saleId, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Anular Venta y restituir Stock + IMEIs
app.put('/api/sales/:id/anular', async (req, res) => {
  try {
    const { id } = req.params;
    const saleRes = await db.query(`SELECT * FROM sales WHERE id = ?`, [id]);
    const sale = saleRes.rows[0];

    if (!sale) return res.status(404).json({ error: 'Venta no encontrada.' });
    if (sale.status === 'anulada') return res.status(400).json({ error: 'La venta ya está anulada.' });

    await db.query(`UPDATE sales SET status = 'anulada' WHERE id = ?`, [id]);

    const itemsRes = await db.query(`SELECT product_id, quantity, product_name, imei_code FROM sale_items WHERE sale_id = ?`, [id]);
    for (const item of itemsRes.rows) {
      if (item.product_id) {
        await db.query(`UPDATE products SET stock = stock + ? WHERE id = ?`, [item.quantity, item.product_id]);
      }
      if (item.imei_code) {
        await db.query(`
          UPDATE device_imeis 
          SET status = 'disponible', sale_id = NULL, sold_at = NULL 
          WHERE imei_code = ?
        `, [item.imei_code]);
      }
    }

    if (sale.payment_method === 'Fiado' && sale.customer_id) {
      const custRes = await db.query(`SELECT debt FROM customers WHERE id = ?`, [sale.customer_id]);
      const currentDebt = parseFloat(custRes.rows[0]?.debt || 0);
      const newDebt = Math.max(0, currentDebt - parseFloat(sale.total));

      await db.query(`UPDATE customers SET debt = ? WHERE id = ?`, [newDebt, sale.customer_id]);
      await db.query(`
        INSERT INTO fiado_records (customer_id, type, amount, details, balance_after)
        VALUES (?, 'ANULACION', ?, ?, ?)
      `, [sale.customer_id, parseFloat(sale.total), `Anulación venta #${sale.receipt_code}`, newDebt]);
    }

    io.emit('sale_annulled', { saleId: id });
    res.json({ success: true, message: `Venta #${sale.receipt_code} anulada. Stock e IMEIs restituidos con éxito.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 5. CONTROL DE CAJA Y ARQUEO Z
// ==========================================

// Obtener estado actual de la caja
app.get('/api/cash/status', async (req, res) => {
  try {
    const regRes = await db.query(`SELECT * FROM cash_registers WHERE status = 'abierta' ORDER BY id DESC LIMIT 1`);
    const activeRegister = regRes.rows[0] || null;

    if (!activeRegister) {
      return res.json({ isOpen: false, register: null });
    }

    // Calcular ventas desde la apertura
    const salesRes = await db.query(`
      SELECT payment_method, SUM(total) as total 
      FROM sales 
      WHERE status = 'completada' AND created_at >= ?
      GROUP BY payment_method
    `, [activeRegister.opened_at]);

    // Calcular movimientos manuales
    const movsRes = await db.query(`
      SELECT * FROM cash_movements 
      WHERE cash_register_id = ?
      ORDER BY id DESC
    `, [activeRegister.id]);

    let efectivoSales = 0;
    let tarjetaSales = 0;
    let yapeSales = 0;
    let fiadoSales = 0;

    salesRes.rows.forEach(r => {
      const t = parseFloat(r.total || 0);
      if (r.payment_method === 'Efectivo') efectivoSales += t;
      else if (r.payment_method === 'Tarjeta') tarjetaSales += t;
      else if (r.payment_method === 'Yape' || r.payment_method === 'Plin') yapeSales += t;
      else if (r.payment_method === 'Fiado') fiadoSales += t;
    });

    let ingresos = 0;
    let retiros = 0;
    movsRes.rows.forEach(m => {
      const a = parseFloat(m.amount || 0);
      if (m.type === 'INGRESO') ingresos += a;
      else if (m.type === 'RETIRO') retiros += a;
    });

    const initial = parseFloat(activeRegister.initial_amount || 0);
    const expectedCash = initial + efectivoSales + ingresos - retiros;

    res.json({
      isOpen: true,
      register: activeRegister,
      initialAmount: initial,
      efectivoSales,
      tarjetaSales,
      yapeSales,
      fiadoSales,
      totalSales: efectivoSales + tarjetaSales + yapeSales + fiadoSales,
      ingresos,
      retiros,
      expectedCash,
      movements: movsRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Apertura de caja
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
    `, [user_name || 'Administrador', parseFloat(initial_amount) || 0]);

    io.emit('cash_updated');
    res.json({ success: true, message: 'Caja abierta exitosamente.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Registrar movimiento (Ingreso / Retiro)
app.post('/api/cash/movement', async (req, res) => {
  try {
    const { type, amount, reason } = req.body;
    const checkOpen = await db.query(`SELECT id FROM cash_registers WHERE status = 'abierta' ORDER BY id DESC LIMIT 1`);
    if (checkOpen.rows.length === 0) {
      return res.status(400).json({ error: 'No hay ninguna caja abierta.' });
    }

    const regId = checkOpen.rows[0].id;
    await db.query(`
      INSERT INTO cash_movements (cash_register_id, type, amount, reason)
      VALUES (?, ?, ?, ?)
    `, [regId, type, parseFloat(amount), reason]);

    io.emit('cash_updated');
    res.json({ success: true, message: `Movimiento de ${type} registrado.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cierre de caja (Arqueo Z)
app.post('/api/cash/close', async (req, res) => {
  try {
    const { final_amount, notes } = req.body;
    const checkOpen = await db.query(`SELECT * FROM cash_registers WHERE status = 'abierta' ORDER BY id DESC LIMIT 1`);
    if (checkOpen.rows.length === 0) {
      return res.status(400).json({ error: 'No hay ninguna caja abierta.' });
    }

    const reg = checkOpen.rows[0];

    // Calcular montos finales
    const salesRes = await db.query(`
      SELECT payment_method, SUM(total) as total 
      FROM sales 
      WHERE status = 'completada' AND created_at >= ?
      GROUP BY payment_method
    `, [reg.opened_at]);

    const movsRes = await db.query(`SELECT type, amount FROM cash_movements WHERE cash_register_id = ?`, [reg.id]);

    let efectivoSales = 0;
    salesRes.rows.forEach(r => {
      if (r.payment_method === 'Efectivo') efectivoSales += parseFloat(r.total || 0);
    });

    let ingresos = 0;
    let retiros = 0;
    movsRes.rows.forEach(m => {
      if (m.type === 'INGRESO') ingresos += parseFloat(m.amount || 0);
      else if (m.type === 'RETIRO') retiros += parseFloat(m.amount || 0);
    });

    const initial = parseFloat(reg.initial_amount || 0);
    const expected = initial + efectivoSales + ingresos - retiros;
    const finalAmt = parseFloat(final_amount) || 0;
    const difference = finalAmt - expected;

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
        initialAmount: initial,
        efectivoSales,
        ingresos,
        retiros,
        expectedAmount: expected,
        finalAmount: finalAmt,
        difference
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Historial de Arqueos de Caja
app.get('/api/cash/history', async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM cash_registers ORDER BY id DESC LIMIT 50`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 6. DASHBOARD, CLIENTES Y CRM
// ==========================================
app.get('/api/dashboard', async (req, res) => {
  try {
    const salesRes = await db.query(`
      SELECT COALESCE(SUM(total), 0) AS totalSales, COUNT(id) AS ticketsCount
      FROM sales WHERE DATE(created_at) = CURRENT_DATE AND status = 'completada'
    `);
    const fiadosRes = await db.query(`SELECT COALESCE(SUM(debt), 0) AS totalDebt FROM customers`);
    const topRes = await db.query(`
      SELECT product_name, SUM(quantity) as totalQty 
      FROM sale_items 
      GROUP BY product_name 
      ORDER BY totalQty DESC LIMIT 1
    `);
    const lowStockRes = await db.query(`SELECT COUNT(id) as lowCount FROM products WHERE stock <= min_stock`);

    res.json({
      todaySales: parseFloat(salesRes.rows[0]?.totalsales || salesRes.rows[0]?.totalSales || 0),
      todayTickets: parseInt(salesRes.rows[0]?.ticketscount || salesRes.rows[0]?.ticketsCount || 0),
      totalFiadosDebt: parseFloat(fiadosRes.rows[0]?.totaldebt || fiadosRes.rows[0]?.totalDebt || 0),
      topProduct: topRes.rows[0]?.product_name || 'N/A',
      lowStockCount: parseInt(lowStockRes.rows[0]?.lowcount || lowStockRes.rows[0]?.lowCount || 0)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/customers', async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM customers ORDER BY name ASC`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/customers', async (req, res) => {
  try {
    const { doc, name, phone, address } = req.body;
    if (!doc || !name) return res.status(400).json({ error: 'DNI/RUC y Nombre son requeridos.' });
    await db.query(`INSERT INTO customers (doc, name, phone, address, debt) VALUES (?, ?, ?, ?, 0)`, [doc, name, phone || '', address || '']);
    res.json({ success: true, message: 'Cliente registrado con éxito.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// FIADOS Y ABONOS
app.get('/api/fiados/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const result = await db.query(`SELECT * FROM fiado_records WHERE customer_id = ? ORDER BY id DESC`, [customerId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/fiados/abono', async (req, res) => {
  try {
    const { customer_id, amount } = req.body;
    const abonoAmt = parseFloat(amount);

    if (!customer_id || isNaN(abonoAmt) || abonoAmt <= 0) {
      return res.status(400).json({ error: 'Monto de abono válido es requerido.' });
    }

    const custRes = await db.query(`SELECT debt, name FROM customers WHERE id = ?`, [customer_id]);
    const customer = custRes.rows[0];
    if (!customer) return res.status(404).json({ error: 'Cliente no encontrado.' });

    const currentDebt = parseFloat(customer.debt || 0);
    const newDebt = Math.max(0, currentDebt - abonoAmt);

    await db.query(`UPDATE customers SET debt = ? WHERE id = ?`, [newDebt, customer_id]);
    await db.query(`
      INSERT INTO fiado_records (customer_id, type, amount, details, balance_after)
      VALUES (?, 'ABONO', ?, 'Abono / Pago en efectivo', ?)
    `, [customer_id, abonoAmt, newDebt]);

    io.emit('abono_registered', { customerId: customer_id, newDebt });
    res.json({ success: true, message: `Abono de S/ ${abonoAmt.toFixed(2)} registrado correctamente`, newDebt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Captura SPA Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor CELLVENTAS (POS, Fundas & Matriz de Compatibilidad) activo en http://localhost:${PORT}`);
});
