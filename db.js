const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

// Cargador nativo de archivo .env sin dependencias externas
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    content.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) return;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key && process.env[key] === undefined) {
        process.env[key] = val;
      }
    });
  } catch (err) {
    console.error('⚠️ Error leyendo archivo .env:', err.message);
  }
}

loadEnvFile();

const USE_POSTGRES = Boolean(process.env.POSTGRES_HOST);
let pool = null;
let sqliteDb = null;

if (USE_POSTGRES) {
  pool = new Pool({
    host: process.env.POSTGRES_HOST,
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'cellventas_db',
  });

  pool.on('error', (err) => {
    console.error('❌ Error en Pool de PostgreSQL:', err.message);
  });
} else {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const dbPath = path.join(dataDir, 'cellventas.db');
  sqliteDb = new sqlite3.Database(dbPath);
}

// Convierte marcadores ? a parámetros posicionales $1, $2... para PostgreSQL
function formatPostgresQuery(text) {
  let paramIndex = 1;
  return text.replace(/\?/g, () => `$${paramIndex++}`);
}

// Wrapper unificado y parametrizado para consultas en PostgreSQL o SQLite
async function query(text, params = [], txClient = null) {
  if (USE_POSTGRES) {
    const pgText = formatPostgresQuery(text);
    const executor = txClient || pool;
    return executor.query(pgText, params);
  }

  return new Promise((resolve, reject) => {
    const trimmed = text.trim();
    const upper = trimmed.toUpperCase();
    const isSelect = upper.startsWith('SELECT') || upper.startsWith('PRAGMA');

    if (isSelect) {
      sqliteDb.all(trimmed, params, (err, rows) => {
        if (err) reject(err);
        else resolve({ rows: rows || [] });
      });
    } else {
      // Compatibilidad con cláusula RETURNING id en SQLite
      const cleanedSql = trimmed.replace(/\s+RETURNING\s+id\s*;?$/i, '');
      sqliteDb.run(cleanedSql, params, function (err) {
        if (err) {
          reject(err);
        } else {
          const lastId = this.lastID;
          resolve({
            rows: lastId ? [{ id: lastId }] : [],
            lastID: lastId,
            rowCount: this.changes
          });
        }
      });
    }
  });
}

// Ejecuta múltiples operaciones dentro de una transacción atómica (BEGIN / COMMIT / ROLLBACK)
async function withTransaction(callback) {
  if (USE_POSTGRES) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const txQuery = (text, params = []) => query(text, params, client);
      const result = await callback(txQuery);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('❌ Error ejecutando ROLLBACK en PostgreSQL:', rollbackErr.message);
      }
      throw err;
    } finally {
      client.release();
    }
  } else {
    await query('BEGIN TRANSACTION');
    try {
      const result = await callback(query);
      await query('COMMIT');
      return result;
    } catch (err) {
      try {
        await query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('❌ Error ejecutando ROLLBACK en SQLite:', rollbackErr.message);
      }
      throw err;
    }
  }
}

// Agrega una columna de forma segura sin afectar datos existentes
async function safeAddColumn(tableName, columnName, columnDefinition) {
  try {
    if (USE_POSTGRES) {
      await query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${columnName} ${columnDefinition}`);
    } else {
      const tableInfo = await query(`PRAGMA table_info(${tableName})`);
      const exists = tableInfo.rows.some((col) => col.name === columnName);
      if (!exists) {
        await query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
      }
    }
  } catch (err) {
    console.warn(`ℹ️ Aviso al verificar columna ${tableName}.${columnName}:`, err.message);
  }
}

// Sincroniza el stock de productos con IMEI según la cantidad real de IMEIs disponibles
async function syncSerializedProductStock(productId = null, txQuery = query) {
  if (productId) {
    const prodRes = await txQuery(`SELECT id, is_serialized FROM products WHERE id = ?`, [productId]);
    const prod = prodRes.rows[0];
    if (prod && Number(prod.is_serialized) === 1) {
      const countRes = await txQuery(
        `SELECT COUNT(*) as total FROM device_imeis WHERE product_id = ? AND status = 'disponible'`,
        [productId]
      );
      const availableCount = parseInt(countRes.rows[0]?.total || 0, 10);
      await txQuery(`UPDATE products SET stock = ? WHERE id = ?`, [availableCount, productId]);
    }
    return;
  }

  const serializedRes = await txQuery(`SELECT id FROM products WHERE is_serialized = 1`);
  for (const row of serializedRes.rows) {
    const countRes = await txQuery(
      `SELECT COUNT(*) as total FROM device_imeis WHERE product_id = ? AND status = 'disponible'`,
      [row.id]
    );
    const availableCount = parseInt(countRes.rows[0]?.total || 0, 10);
    await txQuery(`UPDATE products SET stock = ? WHERE id = ?`, [availableCount, row.id]);
  }
}

async function initDb() {
  try {
    const pkType = USE_POSTGRES ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
    console.log('⚡ Inicializando Tablas de CELLVENTAS (POS, Marcas, Modelos, Compatibilidades y Taller)...');

    // 1. MARCAS DE CELULARES
    await query(`
      CREATE TABLE IF NOT EXISTS brands (
        id ${pkType},
        name TEXT UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 2. MODELOS DE CELULARES
    await query(`
      CREATE TABLE IF NOT EXISTS phone_models (
        id ${pkType},
        brand_id INTEGER NOT NULL,
        model_name TEXT NOT NULL,
        release_year INTEGER DEFAULT 2024,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
      )
    `);

    // 3. PRODUCTOS
    await query(`
      CREATE TABLE IF NOT EXISTS products (
        id ${pkType},
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'Accesorios',
        purchase_price REAL DEFAULT 0,
        price REAL NOT NULL,
        stock INTEGER NOT NULL DEFAULT 0,
        min_stock INTEGER DEFAULT 5,
        is_serialized INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 4. MATRIZ DE COMPATIBILIDAD
    await query(`
      CREATE TABLE IF NOT EXISTS product_compatibilities (
        id ${pkType},
        product_id INTEGER NOT NULL,
        phone_model_id INTEGER NOT NULL,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        FOREIGN KEY (phone_model_id) REFERENCES phone_models(id) ON DELETE CASCADE
      )
    `);

    // 5. REGISTRO DE IMEIS PARA TELÉFONOS
    await query(`
      CREATE TABLE IF NOT EXISTS device_imeis (
        id ${pkType},
        product_id INTEGER NOT NULL,
        imei_code TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'disponible',
        sale_id INTEGER,
        sold_at TIMESTAMP,
        notes TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      )
    `);

    // 5.1 CONTROL DE CAJA Y ARQUEO
    await query(`
      CREATE TABLE IF NOT EXISTS cash_registers (
        id ${pkType},
        user_name TEXT DEFAULT 'Administrador',
        initial_amount REAL NOT NULL DEFAULT 0,
        final_amount REAL DEFAULT 0,
        expected_amount REAL DEFAULT 0,
        difference REAL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'abierta',
        notes TEXT DEFAULT '',
        opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        closed_at TIMESTAMP
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS cash_movements (
        id ${pkType},
        cash_register_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        amount REAL NOT NULL,
        reason TEXT NOT NULL,
        payment_method TEXT DEFAULT 'Efectivo',
        user_name TEXT DEFAULT 'Administrador',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (cash_register_id) REFERENCES cash_registers(id) ON DELETE CASCADE
      )
    `);

    // 6. CLIENTES (CRM)
    await query(`
      CREATE TABLE IF NOT EXISTS customers (
        id ${pkType},
        doc TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        phone TEXT DEFAULT '',
        address TEXT DEFAULT '',
        debt REAL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 7. VENTAS
    await query(`
      CREATE TABLE IF NOT EXISTS sales (
        id ${pkType},
        receipt_code TEXT UNIQUE NOT NULL,
        doc_type TEXT NOT NULL,
        customer_id INTEGER,
        customer_name TEXT DEFAULT 'Público General',
        payment_method TEXT NOT NULL,
        payment_details TEXT DEFAULT '',
        subtotal REAL NOT NULL,
        tax REAL NOT NULL,
        discount REAL DEFAULT 0,
        total REAL NOT NULL,
        paid_amount REAL DEFAULT 0,
        change_amount REAL DEFAULT 0,
        cash_register_id INTEGER,
        status TEXT NOT NULL DEFAULT 'completada',
        user_name TEXT DEFAULT 'Administrador',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migraciones no destructivas para columnas agregadas sobre bases existentes
    await safeAddColumn('sales', 'payment_details', "TEXT DEFAULT ''");
    await safeAddColumn('sales', 'discount', 'REAL DEFAULT 0');
    await safeAddColumn('sales', 'cash_register_id', 'INTEGER');
    await safeAddColumn('cash_movements', 'payment_method', "TEXT DEFAULT 'Efectivo'");

    // 8. DETALLE DE VENTAS
    await query(`
      CREATE TABLE IF NOT EXISTS sale_items (
        id ${pkType},
        sale_id INTEGER NOT NULL,
        product_id INTEGER,
        product_name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        unit_price REAL NOT NULL,
        subtotal REAL NOT NULL,
        imei_code TEXT DEFAULT '',
        FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE
      )
    `);

    // 9. FIADOS / CRÉDITOS Y ABONOS
    await query(`
      CREATE TABLE IF NOT EXISTS fiado_records (
        id ${pkType},
        customer_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        amount REAL NOT NULL,
        details TEXT DEFAULT '',
        balance_after REAL NOT NULL,
        receipt_code TEXT DEFAULT '',
        payment_method TEXT DEFAULT 'Efectivo',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 10. USUARIOS
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id ${pkType},
        username TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'Vendedor',
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 11. CONTADORES DE COMPROBANTES
    await query(`
      CREATE TABLE IF NOT EXISTS counters (
        doc_type TEXT PRIMARY KEY,
        last_number INTEGER NOT NULL DEFAULT 0
      )
    `);

    // 12. ÓRDENES DE SERVICIO TÉCNICO / REPARACIONES
    await query(`
      CREATE TABLE IF NOT EXISTS repair_orders (
        id ${pkType},
        order_code TEXT UNIQUE NOT NULL,
        customer_id INTEGER,
        customer_name TEXT NOT NULL,
        customer_phone TEXT DEFAULT '',
        device_brand TEXT NOT NULL,
        device_model TEXT NOT NULL,
        imei_or_serial TEXT DEFAULT '',
        unlock_pattern TEXT DEFAULT '',
        issue_description TEXT NOT NULL,
        diagnosis TEXT DEFAULT '',
        estimated_cost REAL NOT NULL DEFAULT 0,
        advance_payment REAL NOT NULL DEFAULT 0,
        payment_method TEXT DEFAULT 'Efectivo',
        status TEXT NOT NULL DEFAULT 'Recibido',
        notes TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        delivered_at TIMESTAMP
      )
    `);

    // Asegurar contadores requeridos sin sobrescribir los existentes
    const requiredCounters = ['Ticket', 'Boleta', 'Factura', 'ReciboAbono', 'OrdenServicio'];
    for (const docType of requiredCounters) {
      const counterCheck = await query(`SELECT doc_type FROM counters WHERE doc_type = ?`, [docType]);
      if (counterCheck.rows.length === 0) {
        await query(`INSERT INTO counters (doc_type, last_number) VALUES (?, 0)`, [docType]);
      }
    }

    // SEED INICIAL DE MARCAS Y MODELOS (Solo si la base está vacía)
    const brandCheck = await query(`SELECT COUNT(*) as count FROM brands`);
    const count = parseInt(brandCheck.rows[0].count, 10);

    if (count === 0) {
      console.log('🌱 Sembrando datos iniciales de Marcas, Modelos y Accesorios...');

      await query(`INSERT INTO brands (name) VALUES ('Apple'), ('Samsung'), ('Xiaomi'), ('Motorola')`);

      await query(`
        INSERT INTO phone_models (brand_id, model_name, release_year) VALUES 
        (1, 'iPhone 15 Pro Max', 2023),
        (1, 'iPhone 15 Pro', 2023),
        (1, 'iPhone 15', 2023),
        (1, 'iPhone 14', 2022),
        (2, 'Samsung Galaxy S24 Ultra', 2024),
        (2, 'Samsung Galaxy A55 5G', 2024),
        (3, 'Xiaomi Redmi Note 13 Pro+ 5G', 2024),
        (3, 'Xiaomi Poco X6 Pro', 2024),
        (4, 'Motorola Moto G84 5G', 2023)
      `);

      await query(`
        INSERT INTO products (code, name, category, purchase_price, price, stock, min_stock, is_serialized) VALUES
        ('ACC-001', 'Case Silicona Magsafe Transparente', 'Cases / Fundas', 12.00, 25.00, 30, 5, 0),
        ('ACC-002', 'Mica de Vidrio Templado 9D HD', 'Micas / Protectores', 4.00, 15.00, 50, 10, 0),
        ('ACC-003', 'Protector de Lente Cámara Cristal 3D', 'Micas / Protectores', 5.00, 12.00, 40, 8, 0),
        ('ACC-004', 'Cargador Carga Rápida 25W USB-C', 'Cargadores', 22.00, 45.00, 15, 3, 0),
        ('CEL-001', 'Smartphone Xiaomi Redmi Note 13 256GB', 'Equipos Celulares', 650.00, 799.00, 2, 2, 1)
      `);

      await query(`
        INSERT INTO product_compatibilities (product_id, phone_model_id) VALUES
        (1, 1), (1, 2), (1, 3),
        (2, 1), (2, 2), (2, 5), (2, 7),
        (3, 1), (3, 5)
      `);

      await query(`
        INSERT INTO device_imeis (product_id, imei_code, status) VALUES
        (5, '864201061234567', 'disponible'),
        (5, '864201061234568', 'disponible')
      `);

      await query(`
        INSERT INTO customers (doc, name, phone, debt) VALUES
        ('45891234', 'Juan Pérez (Taller Móvil)', '987654321', 0.00),
        ('10748392011', 'Importadora Tech SAC', '912345678', 0.00)
      `);

      console.log('✅ CELLVENTAS: Marcas, Modelos, Compatibilidades e IMEIs inicializados con éxito.');
    }

    // Asegurar usuarios base con hashes bcrypt reales (admin / admin123 y vendedor / vendedor123)
    const adminHash = bcrypt.hashSync(process.env.ADMIN_INITIAL_PASSWORD || 'admin123', 10);
    const sellerHash = bcrypt.hashSync(process.env.SELLER_INITIAL_PASSWORD || 'vendedor123', 10);

    const adminUser = await query(`SELECT id, password_hash FROM users WHERE username = ?`, ['admin']);
    if (adminUser.rows.length === 0) {
      await query(
        `INSERT INTO users (username, name, role, password_hash) VALUES (?, ?, ?, ?)`,
        ['admin', 'Administrador Tech', 'Administrador', adminHash]
      );
    } else if (String(adminUser.rows[0].password_hash).endsWith('5S7a3')) {
      // Corrige hash placeholder inválido de versiones anteriores
      await query(`UPDATE users SET password_hash = ? WHERE username = ?`, [adminHash, 'admin']);
    }

    const sellerUser = await query(`SELECT id FROM users WHERE username = ?`, ['vendedor']);
    if (sellerUser.rows.length === 0) {
      await query(
        `INSERT INTO users (username, name, role, password_hash) VALUES (?, ?, ?, ?)`,
        ['vendedor', 'Mostrador Tech', 'Vendedor', sellerHash]
      );
    }

    // Sincronizar el stock de productos con IMEI al iniciar
    await syncSerializedProductStock();

  } catch (err) {
    console.error('❌ Error inicializando DB de CELLVENTAS:', err);
  }
}

module.exports = {
  query,
  withTransaction,
  syncSerializedProductStock,
  initDb,
  USE_POSTGRES
};
