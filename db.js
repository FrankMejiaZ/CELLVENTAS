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

    // 5.0 KARDEX Y MOVIMIENTOS HISTÓRICOS DE INVENTARIO
    await query(`
      CREATE TABLE IF NOT EXISTS inventory_movements (
        id ${pkType},
        product_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        previous_stock INTEGER NOT NULL,
        new_stock INTEGER NOT NULL,
        reason TEXT NOT NULL,
        reference_code TEXT DEFAULT '',
        user_name TEXT DEFAULT 'Administrador',
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

    // 13. CONFIGURACIÓN DE TIENDA Y COMPROBANTES TÉRMICOS
    await query(`
      CREATE TABLE IF NOT EXISTS store_settings (
        id INTEGER PRIMARY KEY,
        store_name TEXT NOT NULL DEFAULT 'CELLVENTAS',
        store_subheading TEXT DEFAULT 'ACCESORIOS Y CELULARES',
        store_legal_name TEXT DEFAULT 'VT VALETEC',
        store_ruc TEXT DEFAULT '20601234567',
        store_address TEXT DEFAULT 'Av. Comercial 450 - Tienda 12',
        store_phone TEXT DEFAULT '987 654 321',
        ticket_footer TEXT DEFAULT '¡Gracias por su preferencia! Revise su producto antes de retirarse. Garantía válida con su ticket.',
        ticket_width TEXT DEFAULT '80mm',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const settingsCheck = await query(`SELECT id FROM store_settings WHERE id = 1`);
    if (settingsCheck.rows.length === 0) {
      await query(`
        INSERT INTO store_settings (id, store_name, store_subheading, store_legal_name, store_ruc, store_address, store_phone, ticket_footer, ticket_width)
        VALUES (1, 'CELLVENTAS', 'ACCESORIOS Y CELULARES', 'VT VALETEC', '20601234567', 'Av. Comercial 450 - Tienda 12', '987 654 321', '¡Gracias por su preferencia! Revise su producto antes de retirarse. Garantía válida con su ticket.', '80mm')
      `);
    }

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

    // Inyectar catálogo comercial real del mercado peruano de forma idempotente (sin duplicar ni borrar)
    await seedRealMarketData();

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

async function seedRealMarketData() {
  try {
    // 1. Marcas reales líderes de mercado
    const brandNames = [
      'Apple', 'Samsung', 'Xiaomi', 'Motorola', 'Honor',
      'TECNO', 'Infinix', 'ZTE', 'Realme', 'OPPO'
    ];
    const brandMap = {};
    for (const name of brandNames) {
      const existing = await query(`SELECT id FROM brands WHERE name = ?`, [name]);
      if (existing.rows.length > 0) {
        brandMap[name] = existing.rows[0].id;
      } else {
        const ins = await query(`INSERT INTO brands (name) VALUES (?) RETURNING id`, [name]);
        brandMap[name] = ins.rows[0]?.id || ins.lastID;
      }
    }

    // 2. Modelos reales por marca (catálogo comercial listo para mostrador)
    const modelsToSeed = [
      // Apple
      ['Apple', 'iPhone 16 Pro Max', 2024],
      ['Apple', 'iPhone 16 Pro', 2024],
      ['Apple', 'iPhone 16', 2024],
      ['Apple', 'iPhone 15 Pro Max', 2023],
      ['Apple', 'iPhone 15 Pro', 2023],
      ['Apple', 'iPhone 15', 2023],
      ['Apple', 'iPhone 14', 2022],
      ['Apple', 'iPhone 13', 2021],
      ['Apple', 'iPhone 12', 2020],
      ['Apple', 'iPhone 11', 2019],

      // Samsung
      ['Samsung', 'Samsung Galaxy S24 Ultra', 2024],
      ['Samsung', 'Samsung Galaxy S24+', 2024],
      ['Samsung', 'Samsung Galaxy S24', 2024],
      ['Samsung', 'Samsung Galaxy S23 FE', 2023],
      ['Samsung', 'Samsung Galaxy A55 5G', 2024],
      ['Samsung', 'Samsung Galaxy A35 5G', 2024],
      ['Samsung', 'Samsung Galaxy A25 5G', 2024],
      ['Samsung', 'Samsung Galaxy A15 4G', 2024],
      ['Samsung', 'Samsung Galaxy A05s', 2023],
      ['Samsung', 'Samsung Galaxy A54 5G', 2023],

      // Xiaomi
      ['Xiaomi', 'Xiaomi 14 Ultra', 2024],
      ['Xiaomi', 'Xiaomi Redmi Note 13 Pro+ 5G', 2024],
      ['Xiaomi', 'Xiaomi Redmi Note 13 Pro 4G', 2024],
      ['Xiaomi', 'Xiaomi Redmi Note 13 4G', 2024],
      ['Xiaomi', 'Xiaomi Poco X6 Pro', 2024],
      ['Xiaomi', 'Xiaomi Poco F6', 2024],
      ['Xiaomi', 'Xiaomi Redmi 13C', 2023],
      ['Xiaomi', 'Xiaomi Redmi 12', 2023],

      // Motorola
      ['Motorola', 'Motorola Edge 50 Ultra', 2024],
      ['Motorola', 'Motorola Edge 50 Fusion', 2024],
      ['Motorola', 'Motorola Moto G84 5G', 2023],
      ['Motorola', 'Motorola Moto G54 5G', 2023],
      ['Motorola', 'Motorola Moto G24 Power', 2024],
      ['Motorola', 'Motorola Moto G14', 2023],

      // Honor
      ['Honor', 'Honor Magic6 Pro', 2024],
      ['Honor', 'Honor Magic6 Lite 5G', 2024],
      ['Honor', 'Honor 90', 2023],
      ['Honor', 'Honor X8b', 2024],
      ['Honor', 'Honor X7b', 2024],
      ['Honor', 'Honor X6a', 2023],

      // TECNO Mobile
      ['TECNO', 'TECNO Camon 30 Pro 5G', 2024],
      ['TECNO', 'TECNO Camon 30', 2024],
      ['TECNO', 'TECNO Spark 20 Pro+', 2024],
      ['TECNO', 'TECNO Spark 20 Pro', 2024],
      ['TECNO', 'TECNO Spark 20', 2023],
      ['TECNO', 'TECNO Spark 10 Pro', 2023],
      ['TECNO', 'TECNO Pova 6 Pro 5G', 2024],

      // Infinix
      ['Infinix', 'Infinix Note 40 Pro+ 5G', 2024],
      ['Infinix', 'Infinix Note 40 Pro', 2024],
      ['Infinix', 'Infinix Hot 40 Pro', 2024],
      ['Infinix', 'Infinix Hot 40i', 2024],
      ['Infinix', 'Infinix Hot 30', 2023],
      ['Infinix', 'Infinix Smart 8', 2023],

      // ZTE
      ['ZTE', 'ZTE Blade V50 Smart', 2023],
      ['ZTE', 'ZTE Blade V50 Design', 2023],
      ['ZTE', 'ZTE Blade A72s', 2023],
      ['ZTE', 'ZTE Blade A54', 2024],
      ['ZTE', 'ZTE Nubia Neo 2 5G', 2024],

      // Realme
      ['Realme', 'Realme 12 Pro+ 5G', 2024],
      ['Realme', 'Realme 12+ 5G', 2024],
      ['Realme', 'Realme C67 4G', 2024],
      ['Realme', 'Realme C55', 2023],
      ['Realme', 'Realme C53', 2023],

      // OPPO
      ['OPPO', 'OPPO Reno 11F 5G', 2024],
      ['OPPO', 'OPPO Reno 11 5G', 2024],
      ['OPPO', 'OPPO A78 4G', 2023],
      ['OPPO', 'OPPO A58', 2023],
      ['OPPO', 'OPPO A38', 2023]
    ];

    const modelMap = {};
    for (const [bName, mName, year] of modelsToSeed) {
      const bId = brandMap[bName];
      if (!bId) continue;
      const existing = await query(`SELECT id FROM phone_models WHERE model_name = ?`, [mName]);
      if (existing.rows.length > 0) {
        modelMap[mName] = existing.rows[0].id;
      } else {
        const ins = await query(
          `INSERT INTO phone_models (brand_id, model_name, release_year) VALUES (?, ?, ?) RETURNING id`,
          [bId, mName, year]
        );
        modelMap[mName] = ins.rows[0]?.id || ins.lastID;
      }
    }

    // 3. Productos reales con SKUs, costos y precios en Soles (S/)
    const productsToSeed = [
      { code: 'CAS-101', name: 'Case MagSafe Silicona Líquida c/ Gamuza Interna (iPhone 15 Pro Max)', category: 'Cases / Fundas', purchase_price: 14.00, price: 35.00, stock: 18, min_stock: 5, is_serialized: 0, models: ['iPhone 15 Pro Max'] },
      { code: 'CAS-102', name: 'Case Antigolpe Armadura c/ Anillo Imantado (Galaxy A55 / A35 5G)', category: 'Cases / Fundas', purchase_price: 11.50, price: 28.00, stock: 22, min_stock: 5, is_serialized: 0, models: ['Samsung Galaxy A55 5G', 'Samsung Galaxy A35 5G'] },
      { code: 'CAS-103', name: 'Case Space Transparente Esquinas Reforzadas (Redmi Note 13 4G)', category: 'Cases / Fundas', purchase_price: 6.50, price: 18.00, stock: 35, min_stock: 8, is_serialized: 0, models: ['Xiaomi Redmi Note 13 4G'] },
      { code: 'CAS-104', name: 'Case Acrílico Mate MagSafe Bisel Metálico (iPhone 16 Pro Max)', category: 'Cases / Fundas', purchase_price: 16.00, price: 40.00, stock: 3, min_stock: 6, is_serialized: 0, models: ['iPhone 16 Pro Max'] },
      { code: 'CAS-105', name: 'Case Silicona Mate Diseño Fibra Carbono (Honor Magic6 Lite / X8b)', category: 'Cases / Fundas', purchase_price: 9.00, price: 22.00, stock: 14, min_stock: 5, is_serialized: 0, models: ['Honor Magic6 Lite 5G', 'Honor X8b'] },
      { code: 'MIC-201', name: 'Mica Vidrio Templado 9D Bordes Negros 6.67" (Multimodelo)', category: 'Micas / Protectores', purchase_price: 3.20, price: 15.00, stock: 65, min_stock: 15, is_serialized: 0, models: ['Xiaomi Redmi Note 13 4G', 'Xiaomi Poco X6 Pro', 'Samsung Galaxy A55 5G', 'Samsung Galaxy A35 5G'] },
      { code: 'MIC-202', name: 'Mica Privacidad Antiespía 28° Templado Mate (iPhone 13 / 14 / 15 / 15 Pro)', category: 'Micas / Protectores', purchase_price: 5.50, price: 25.00, stock: 28, min_stock: 10, is_serialized: 0, models: ['iPhone 13', 'iPhone 14', 'iPhone 15', 'iPhone 15 Pro'] },
      { code: 'MIC-203', name: 'Mica Hidrogel UV Curvo Autorreparable (Magic6 Lite / Edge 50 Fusion / Note 13 Pro+)', category: 'Micas / Protectores', purchase_price: 7.00, price: 30.00, stock: 4, min_stock: 10, is_serialized: 0, models: ['Honor Magic6 Lite 5G', 'Motorola Edge 50 Fusion', 'Xiaomi Redmi Note 13 Pro+ 5G'] },
      { code: 'MIC-204', name: 'Protector Lente de Cámara Zafiro Individual (iPhone 15 Pro / 15 Pro Max / 16 Pro Max)', category: 'Micas / Protectores', purchase_price: 4.50, price: 18.00, stock: 32, min_stock: 8, is_serialized: 0, models: ['iPhone 15 Pro', 'iPhone 15 Pro Max', 'iPhone 16 Pro Max', 'iPhone 16 Pro'] },
      { code: 'CAR-301', name: 'Cargador Original Samsung Super Fast Charging 25W USB-C (Sin Cable)', category: 'Cargadores', purchase_price: 42.00, price: 75.00, stock: 12, min_stock: 4, is_serialized: 0, models: ['Samsung Galaxy S24 Ultra', 'Samsung Galaxy A55 5G', 'Samsung Galaxy A35 5G', 'Samsung Galaxy A54 5G', 'Samsung Galaxy A15 4G'] },
      { code: 'CAR-302', name: 'Cubo Cargador Apple 20W USB-C Power Adapter Original', category: 'Cargadores', purchase_price: 55.00, price: 95.00, stock: 2, min_stock: 5, is_serialized: 0, models: ['iPhone 16 Pro Max', 'iPhone 16 Pro', 'iPhone 15 Pro Max', 'iPhone 15 Pro', 'iPhone 15', 'iPhone 14', 'iPhone 13'] },
      { code: 'CAR-303', name: 'Kit Cargador Xiaomi HyperCharge 67W Turbo + Cable USB-C 6A', category: 'Cargadores', purchase_price: 38.00, price: 69.00, stock: 10, min_stock: 4, is_serialized: 0, models: ['Xiaomi Redmi Note 13 Pro+ 5G', 'Xiaomi Redmi Note 13 4G', 'Xiaomi Poco X6 Pro', 'Xiaomi Redmi 13C'] },
      { code: 'CAB-304', name: 'Cable Trenzado Baseus Tipo C a Tipo C 60W 1m Carga Rápida', category: 'Cables / Datos', purchase_price: 9.50, price: 25.00, stock: 40, min_stock: 10, is_serialized: 0, models: ['iPhone 16 Pro Max', 'iPhone 15 Pro Max', 'Samsung Galaxy S24 Ultra', 'Samsung Galaxy A55 5G', 'Xiaomi Redmi Note 13 Pro+ 5G', 'Motorola Edge 50 Fusion', 'Honor Magic6 Lite 5G'] },
      { code: 'AUD-401', name: 'Audífonos Inalámbricos Xiaomi Redmi Buds 6 Play Bluetooth 5.4', category: 'Audio', purchase_price: 36.00, price: 65.00, stock: 14, min_stock: 4, is_serialized: 0, models: ['Xiaomi Redmi Note 13 Pro+ 5G', 'Samsung Galaxy A55 5G', 'iPhone 15', 'Honor Magic6 Lite 5G'] },
      { code: 'REP-501', name: 'Pantalla Completa OLED Incell p/ Samsung Galaxy A54 / A55 5G', category: 'Repuestos', purchase_price: 115.00, price: 190.00, stock: 3, min_stock: 3, is_serialized: 0, models: ['Samsung Galaxy A54 5G', 'Samsung Galaxy A55 5G'] },
      { code: 'CEL-002', name: 'Samsung Galaxy A55 5G 256GB / 8GB RAM - Azul Hielo (Liberado)', category: 'Equipos Celulares', purchase_price: 1180.00, price: 1449.00, stock: 3, min_stock: 2, is_serialized: 1, models: ['Samsung Galaxy A55 5G'] },
      { code: 'CEL-003', name: 'iPhone 15 Pro Max 256GB - Titanio Natural (Sellado Apple)', category: 'Equipos Celulares', purchase_price: 4150.00, price: 4699.00, stock: 2, min_stock: 1, is_serialized: 1, models: ['iPhone 15 Pro Max'] },
      { code: 'CEL-004', name: 'Honor Magic6 Lite 5G 256GB / 8GB RAM - Verde Esmeralda', category: 'Equipos Celulares', purchase_price: 890.00, price: 1129.00, stock: 2, min_stock: 2, is_serialized: 1, models: ['Honor Magic6 Lite 5G'] }
    ];

    const productMap = {};
    for (const p of productsToSeed) {
      const existing = await query(`SELECT id FROM products WHERE code = ?`, [p.code]);
      let prodId;
      if (existing.rows.length > 0) {
        prodId = existing.rows[0].id;
      } else {
        const ins = await query(
          `INSERT INTO products (code, name, category, purchase_price, price, stock, min_stock, is_serialized) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          [p.code, p.name, p.category, p.purchase_price, p.price, p.stock, p.min_stock, p.is_serialized]
        );
        prodId = ins.rows[0]?.id || ins.lastID;
      }
      productMap[p.code] = prodId;

      // Vincular compatibilidades multimodelo
      for (const mName of p.models) {
        const mId = modelMap[mName];
        if (!prodId || !mId) continue;
        const checkCompat = await query(
          `SELECT id FROM product_compatibilities WHERE product_id = ? AND phone_model_id = ?`,
          [prodId, mId]
        );
        if (checkCompat.rows.length === 0) {
          await query(
            `INSERT INTO product_compatibilities (product_id, phone_model_id) VALUES (?, ?)`,
            [prodId, mId]
          );
        }
      }
    }

    // 4. Series / IMEIs reales de 15 dígitos para los equipos celulares
    const imeisToSeed = [
      ['CEL-002', '354891124509811'],
      ['CEL-002', '354891124509812'],
      ['CEL-002', '354891124509813'],
      ['CEL-003', '359104821930411'],
      ['CEL-003', '359104821930412'],
      ['CEL-004', '860923067812301'],
      ['CEL-004', '860923067812302']
    ];
    for (const [prodCode, imei] of imeisToSeed) {
      const prodId = productMap[prodCode];
      if (!prodId) continue;
      const existingImei = await query(`SELECT id FROM device_imeis WHERE imei_code = ?`, [imei]);
      if (existingImei.rows.length === 0) {
        await query(
          `INSERT INTO device_imeis (product_id, imei_code, status) VALUES (?, ?, 'disponible')`,
          [prodId, imei]
        );
      }
    }

    // 5. Clientes reales con DNI / RUC y Cuentas por Cobrar
    const customersToSeed = [
      {
        doc: '72849103',
        name: 'Carlos Alberto Mendoza Quispe',
        phone: '987412365',
        address: 'Av. Arenales 1420 Tda. 214, Jesús María',
        debt: 120.00,
        records: [
          { type: 'CARGO', amount: 120.00, details: 'Venta al Crédito (Lote de Cases MagSafe y Micas 9D)', balance_after: 120.00, receipt_code: 'B001-000010', payment_method: 'Crédito' }
        ]
      },
      {
        doc: '20608491237',
        name: 'Inversiones Móviles del Norte S.A.C.',
        phone: '945102938',
        address: 'Jr. Leticia 642 Stand 108, Cercado de Lima',
        debt: 350.00,
        records: [
          { type: 'CARGO', amount: 500.00, details: 'Factura Mayorista de Cargadores 25W y Cables Baseus', balance_after: 500.00, receipt_code: 'F001-000004', payment_method: 'Crédito' },
          { type: 'ABONO', amount: 150.00, details: 'Abono parcial de cuenta corriente', balance_after: 350.00, receipt_code: 'ABN-000001', payment_method: 'Yape/Plin' }
        ]
      },
      {
        doc: '46192837',
        name: 'María Fernanda Paredes Rojas',
        phone: '991827364',
        address: 'Av. Los Próceres 820, Surco',
        debt: 0.00,
        records: []
      },
      {
        doc: '74910284',
        name: 'Luis Miguel Huamán Chávez (Técnico Aliado)',
        phone: '963852741',
        address: 'C.C. Polvos Azules Pasaje 14 Tda. 9',
        debt: 65.00,
        records: [
          { type: 'CARGO', amount: 190.00, details: 'Retiro de Pantalla OLED Samsung A54/A55 p/ taller', balance_after: 190.00, receipt_code: 'T001-000018', payment_method: 'Crédito' },
          { type: 'ABONO', amount: 125.00, details: 'Adelanto en efectivo en mostrador', balance_after: 65.00, receipt_code: 'ABN-000002', payment_method: 'Efectivo' }
        ]
      }
    ];

    for (const c of customersToSeed) {
      const existingCust = await query(`SELECT id FROM customers WHERE doc = ?`, [c.doc]);
      let custId;
      if (existingCust.rows.length > 0) {
        custId = existingCust.rows[0].id;
      } else {
        const ins = await query(
          `INSERT INTO customers (doc, name, phone, address, debt) VALUES (?, ?, ?, ?, ?) RETURNING id`,
          [c.doc, c.name, c.phone, c.address, c.debt]
        );
        custId = ins.rows[0]?.id || ins.lastID;

        for (const rec of c.records) {
          await query(
            `INSERT INTO fiado_records (customer_id, type, amount, details, balance_after, receipt_code, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [custId, rec.type, rec.amount, rec.details, rec.balance_after, rec.receipt_code, rec.payment_method]
          );
        }
      }
    }

    // 6. Órdenes de Servicio Técnico / Taller
    const repairsToSeed = [
      {
        order_code: 'ORD-0001',
        customer_name: 'María Fernanda Paredes Rojas',
        customer_phone: '991827364',
        device_brand: 'Samsung',
        device_model: 'Galaxy A54 5G',
        imei_or_serial: '356789110293847',
        unlock_pattern: 'Patrón: L de arriba a derecha',
        issue_description: 'Pantalla rota por caída, no da imagen pero vibra al recibir llamadas.',
        diagnosis: 'Cambio de módulo OLED original y limpieza ultrasónica de marco.',
        estimated_cost: 240.00,
        advance_payment: 100.00,
        payment_method: 'Yape/Plin',
        status: 'En Reparación'
      },
      {
        order_code: 'ORD-0002',
        customer_name: 'Jorge Luis Villanueva Castro',
        customer_phone: '978123456',
        device_brand: 'Apple',
        device_model: 'iPhone 13 128GB',
        imei_or_serial: '353091827364519',
        unlock_pattern: 'PIN: 258069',
        issue_description: 'No carga con ningún cable, conector Lightning flojo o dañado.',
        diagnosis: 'Reemplazo de flex de carga Lightning original y mantenimiento preventivo.',
        estimated_cost: 130.00,
        advance_payment: 50.00,
        payment_method: 'Efectivo',
        status: 'Listo'
      },
      {
        order_code: 'ORD-0003',
        customer_name: 'Andrea Sofía Gómez Vargas',
        customer_phone: '954789632',
        device_brand: 'Xiaomi',
        device_model: 'Redmi Note 13 Pro+ 5G',
        imei_or_serial: '867451069283741',
        unlock_pattern: 'PIN: 147896',
        issue_description: 'Tapa trasera trizada y batería calienta al conectar cargador rápido.',
        diagnosis: 'Pendiente de revisión de consumo en fuente regulada.',
        estimated_cost: 110.00,
        advance_payment: 30.00,
        payment_method: 'Efectivo',
        status: 'Recibido'
      },
      {
        order_code: 'ORD-0004',
        customer_name: 'Carlos Alberto Mendoza Quispe',
        customer_phone: '987412365',
        device_brand: 'Motorola',
        device_model: 'Moto G84 5G',
        imei_or_serial: '358910293847561',
        unlock_pattern: 'Sin clave',
        issue_description: 'Cambio de cristal visor (glass) conservando pantalla OLED original.',
        diagnosis: 'Laminado OCA completado con éxito. Touch al 100%.',
        estimated_cost: 120.00,
        advance_payment: 120.00,
        payment_method: 'Yape/Plin',
        status: 'Entregado'
      }
    ];

    for (const r of repairsToSeed) {
      const existingOrd = await query(`SELECT id FROM repair_orders WHERE order_code = ?`, [r.order_code]);
      if (existingOrd.rows.length === 0) {
        await query(
          `INSERT INTO repair_orders (order_code, customer_name, customer_phone, device_brand, device_model, imei_or_serial, unlock_pattern, issue_description, diagnosis, estimated_cost, advance_payment, payment_method, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [r.order_code, r.customer_name, r.customer_phone, r.device_brand, r.device_model, r.imei_or_serial, r.unlock_pattern, r.issue_description, r.diagnosis, r.estimated_cost, r.advance_payment, r.payment_method, r.status]
        );
      }
    }

    // Asegurar que el correlativo de OrdenServicio y ReciboAbono no colisione con los datos sembrados
    await query(`UPDATE counters SET last_number = 4 WHERE doc_type = 'OrdenServicio' AND last_number < 4`);
    await query(`UPDATE counters SET last_number = 2 WHERE doc_type = 'ReciboAbono' AND last_number < 2`);

    // Inicializar Kardex con stock inicial para productos existentes si la tabla está vacía
    const movCount = await query(`SELECT COUNT(*) as total FROM inventory_movements`);
    if (parseInt(movCount.rows[0]?.total || 0, 10) === 0) {
      const prodsToSeed = await query(`SELECT id, stock FROM products WHERE stock > 0`);
      for (const p of prodsToSeed.rows) {
        await query(`
          INSERT INTO inventory_movements (product_id, type, quantity, previous_stock, new_stock, reason, reference_code, user_name)
          VALUES (?, 'STOCK_INICIAL', ?, 0, ?, 'Inventario inicial de apertura de tienda', 'APERTURA', 'Sistema')
        `, [p.id, p.stock, p.stock]);
      }
    }

  } catch (err) {
    console.warn('⚠️ Aviso al sembrar datos comerciales reales:', err.message);
  }
}

module.exports = {
  query,
  withTransaction,
  syncSerializedProductStock,
  initDb,
  USE_POSTGRES
};
