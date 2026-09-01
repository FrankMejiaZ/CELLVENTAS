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
  if (!token) return next(); // Permite operación local
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
  } catch (e) {}
  next();
}
app.use(verifyToken);

// ==========================================
// 1. MARCAS Y MODELOS DE CELULARES (MATRIZ COMPATIBILIDAD)
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
    res.json({ success: true, message: 'Modelo de celular registrado.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// BUSCADOR DE COMPATIBILIDAD POR MODELO DE CELULAR
// Devuelve todos los cases, micas y accesorios compatibles con un celular específico
app.get('/api/compatibilities/model/:modelId', async (req, res) => {
  try {
    const { modelId } = req.params;
    const queryStr = `
      SELECT p.*, pm.model_name
      FROM products p
      INNER JOIN product_compatibilities pc ON p.id = pc.product_id
      INNER JOIN phone_models pm ON pc.phone_model_id = pm.id
      WHERE pc.phone_model_id = ?
      ORDER BY p.name ASC
    `;
    const result = await db.query(queryStr, [modelId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2. PRODUCTOS E IMEIS (ACCESORIOS Y CELULARES)
// ==========================================

// Obtener todos los productos con sus modelos compatibles vinculados
app.get('/api/products', async (req, res) => {
  try {
    const prods = await db.query(`SELECT * FROM products ORDER BY name ASC`);
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
// 3. DASHBOARD Y MÉTRICAS
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

    res.json({
      todaySales: parseFloat(salesRes.rows[0]?.totalsales || salesRes.rows[0]?.totalSales || 0),
      todayTickets: parseInt(salesRes.rows[0]?.ticketscount || salesRes.rows[0]?.ticketsCount || 0),
      totalFiadosDebt: parseFloat(fiadosRes.rows[0]?.totaldebt || fiadosRes.rows[0]?.totalDebt || 0),
      topProduct: topRes.rows[0]?.product_name || 'N/A'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. CLIENTES Y CRM
// ==========================================
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

// ==========================================
// 5. VENTAS Y POS
// ==========================================
app.get('/api/sales', async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM sales ORDER BY id DESC LIMIT 100`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
        const prodCheck = await db.query(`SELECT name, stock FROM products WHERE id = ?`, [item.product_id]);
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

    // Insertar Items y decrementar stock
    for (const item of items) {
      const itemSubtotal = item.quantity * item.unit_price;
      await db.query(`
        INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, subtotal, imei_code)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [saleId, item.product_id, item.product_name, item.quantity, item.unit_price, itemSubtotal, item.imei || '']);

      if (item.product_id) {
        await db.query(`UPDATE products SET stock = stock - ? WHERE id = ?`, [item.quantity, item.product_id]);
      }
    }

    // Registrar Fiado si aplica
    if (payment_method === 'Fiado' && customer_id) {
      const custRes = await db.query(`SELECT debt FROM customers WHERE id = ?`, [customer_id]);
      const currentDebt = parseFloat(custRes.rows[0]?.debt || 0);
      const newDebt = currentDebt + total;
      const details = items.map(i => `${i.quantity}x ${i.product_name}`).join(', ');

      await db.query(`UPDATE customers SET debt = ? WHERE id = ?`, [newDebt, customer_id]);
      await db.query(`
        INSERT INTO fiado_records (customer_id, type, amount, details, balance_after)
        VALUES (?, 'COMPRA_FIADA', ?, ?, ?)
      `, [customer_id, total, details, newDebt]);
    }

    io.emit('sale_completed', { receipt_code, total });
    res.json({ success: true, receipt_code, saleId, total, payment_method });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Anular Venta
app.put('/api/sales/:id/anular', async (req, res) => {
  try {
    const { id } = req.params;
    const saleRes = await db.query(`SELECT * FROM sales WHERE id = ?`, [id]);
    const sale = saleRes.rows[0];

    if (!sale) return res.status(404).json({ error: 'Venta no encontrada.' });
    if (sale.status === 'anulada') return res.status(400).json({ error: 'La venta ya está anulada.' });

    await db.query(`UPDATE sales SET status = 'anulada' WHERE id = ?`, [id]);

    const itemsRes = await db.query(`SELECT product_id, quantity, product_name FROM sale_items WHERE sale_id = ?`, [id]);
    for (const item of itemsRes.rows) {
      if (item.product_id) {
        await db.query(`UPDATE products SET stock = stock + ? WHERE id = ?`, [item.quantity, item.product_id]);
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
    res.json({ success: true, message: 'Venta anulada con éxito y stock restaurado.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 6. MÓDULO FIADOS Y ABONOS
// ==========================================
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
