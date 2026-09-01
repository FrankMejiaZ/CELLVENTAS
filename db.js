const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const USE_POSTGRES = process.env.POSTGRES_HOST ? true : false;
let pool = null;
let sqliteDb = null;

if (USE_POSTGRES) {
  pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    user: process.env.POSTGRES_USER || 'valetec',
    password: process.env.POSTGRES_PASSWORD || 'valetec_secure_pass',
    database: process.env.POSTGRES_DB || 'cellventas_db',
  });

  pool.on('error', (err) => {
    console.error('❌ Error in en Pool de PostgreSQL:', err);
  });
} else {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const dbPath = path.join(dataDir, 'cellventas.db');
  sqliteDb = new sqlite3.Database(dbPath);
}

// Wrapper unificado para queries (PG o SQLite)
async function query(text, params = []) {
  if (USE_POSTGRES) {
    // Convertir sintaxis ? a $1, $2 para Postgres
    let paramIndex = 1;
    const pgText = text.replace(/\?/g, () => `$${paramIndex++}`);
    const res = await pool.query(pgText, params);
    return res;
  } else {
    return new Promise((resolve, reject) => {
      const isSelect = text.trim().toUpperCase().startsWith('SELECT') || text.trim().toUpperCase().startsWith('PRAGMA');
      if (isSelect) {
        sqliteDb.all(text, params, (err, rows) => {
          if (err) reject(err);
          else resolve({ rows });
        });
      } else {
        sqliteDb.run(text, params, function (err) {
          if (err) reject(err);
          else resolve({ rows: [], lastID: this.lastID, rowCount: this.changes });
        });
      }
    });
  }
}

async function initDb() {
  try {
    console.log('⚡ Inicializando Tablas de CELLVENTAS (POS, Marcas, Modelos y Compatibilidades)...');

    // 1. MARCAS DE CELULARES (Apple, Samsung, Xiaomi, etc.)
    await query(`
      CREATE TABLE IF NOT EXISTS brands (
        id ${USE_POSTGRES ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
        name TEXT UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 2. MODELOS DE CELULARES (iPhone 15 Pro Max, Galaxy S24 Ultra, etc.)
    await query(`
      CREATE TABLE IF NOT EXISTS phone_models (
        id ${USE_POSTGRES ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
        brand_id INTEGER NOT NULL,
        model_name TEXT NOT NULL,
        release_year INTEGER DEFAULT 2024,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
      )
    `);

    // 3. PRODUCTOS (Fundas/Cases, Micas de Vidrio, Cargadores, Celulares, Repuestos)
    await query(`
      CREATE TABLE IF NOT EXISTS products (
        id ${USE_POSTGRES ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'Accesorios',
        purchase_price REAL DEFAULT 0,
        price REAL NOT NULL,
        stock INTEGER NOT NULL DEFAULT 0,
        min_stock INTEGER DEFAULT 5,
        is_serialized INTEGER DEFAULT 0, -- 1 si requiere IMEI (Celulares)
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 4. MATRIZ DE COMPATIBILIDAD (Asocia un producto con 1 o varios modelos de celular)
    await query(`
      CREATE TABLE IF NOT EXISTS product_compatibilities (
        id ${USE_POSTGRES ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
        product_id INTEGER NOT NULL,
        phone_model_id INTEGER NOT NULL,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        FOREIGN KEY (phone_model_id) REFERENCES phone_models(id) ON DELETE CASCADE
      )
    `);

    // 5. REGISTRO DE IMEIS PARA TELÉFONOS
    await query(`
      CREATE TABLE IF NOT EXISTS device_imeis (
        id ${USE_POSTGRES ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
        product_id INTEGER NOT NULL,
        imei_code TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'disponible', -- disponible, vendido, defectuoso
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
        id ${USE_POSTGRES ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
        user_name TEXT DEFAULT 'Administrador',
        initial_amount REAL NOT NULL DEFAULT 0,
        final_amount REAL DEFAULT 0,
        expected_amount REAL DEFAULT 0,
        difference REAL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'abierta', -- abierta, cerrada
        notes TEXT DEFAULT '',
        opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        closed_at TIMESTAMP
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS cash_movements (
        id ${USE_POSTGRES ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
        cash_register_id INTEGER NOT NULL,
        type TEXT NOT NULL, -- INGRESO, RETIRO
        amount REAL NOT NULL,
        reason TEXT NOT NULL,
        user_name TEXT DEFAULT 'Administrador',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (cash_register_id) REFERENCES cash_registers(id) ON DELETE CASCADE
      )
    `);

    // 6. CLIENTES (CRM)
    await query(`
      CREATE TABLE IF NOT EXISTS customers (
        id ${USE_POSTGRES ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
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
        id ${USE_POSTGRES ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
        receipt_code TEXT UNIQUE NOT NULL,
        doc_type TEXT NOT NULL,
        customer_id INTEGER,
        customer_name TEXT DEFAULT 'Público General',
        payment_method TEXT NOT NULL,
        subtotal REAL NOT NULL,
        tax REAL NOT NULL,
        total REAL NOT NULL,
        paid_amount REAL DEFAULT 0,
        change_amount REAL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'completada',
        user_name TEXT DEFAULT 'Administrador',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 8. DETALLE DE VENTAS
    await query(`
      CREATE TABLE IF NOT EXISTS sale_items (
        id ${USE_POSTGRES ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
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

    // 9. FIADOS Y ABONOS
    await query(`
      CREATE TABLE IF NOT EXISTS fiado_records (
        id ${USE_POSTGRES ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
        customer_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        amount REAL NOT NULL,
        details TEXT DEFAULT '',
        balance_after REAL NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 10. USUARIOS
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id ${USE_POSTGRES ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
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

    // SEED INICIAL DE MARCAS Y MODELOS DE CELULARES
    const brandCheck = await query(`SELECT COUNT(*) as count FROM brands`);
    const count = parseInt(brandCheck.rows[0].count);

    if (count === 0) {
      console.log('🌱 Sembrando datos iniciales de Marcas, Modelos y Accesorios...');

      // Insertar Marcas
      await query(`INSERT INTO brands (name) VALUES ('Apple'), ('Samsung'), ('Xiaomi'), ('Motorola')`);

      // Insertar Modelos
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

      // Insertar Productos Iniciales (Fundas, Micas, Cargadores, Celulares)
      await query(`
        INSERT INTO products (code, name, category, purchase_price, price, stock, min_stock, is_serialized) VALUES
        ('ACC-001', 'Case Silicona Magsafe Transparente', 'Cases / Fundas', 12.00, 25.00, 30, 5, 0),
        ('ACC-002', 'Mica de Vidrio Templado 9D HD', 'Micas / Protectores', 4.00, 15.00, 50, 10, 0),
        ('ACC-003', 'Protector de Lente Cámara Cristal 3D', 'Micas / Protectores', 5.00, 12.00, 40, 8, 0),
        ('ACC-004', 'Cargador Carga Rápida 25W USB-C', 'Cargadores', 22.00, 45.00, 15, 3, 0),
        ('CEL-001', 'Smartphone Xiaomi Redmi Note 13 256GB', 'Equipos Celulares', 650.00, 799.00, 5, 2, 1)
      `);

      // Asociar Compatibilidades (Case ACC-001 -> iPhone 15 Pro Max & iPhone 15 Pro)
      await query(`
        INSERT INTO product_compatibilities (product_id, phone_model_id) VALUES
        (1, 1), (1, 2), (1, 3),
        (2, 1), (2, 2), (2, 5), (2, 7),
        (3, 1), (3, 5)
      `);

      // Insertar IMEI de prueba para Xiaomi Redmi Note 13
      await query(`
        INSERT INTO device_imeis (product_id, imei_code, status) VALUES
        (5, '864201061234567', 'disponible'),
        (5, '864201061234568', 'disponible')
      `);

      // Seed Clientes
      await query(`
        INSERT INTO customers (doc, name, phone, debt) VALUES
        ('45891234', 'Juan Pérez (Taller Móvil)', '987654321', 0.00),
        ('10748392011', 'Importadora Tech SAC', '912345678', 0.00)
      `);

      // Seed Usuario Admin (pass: admin123)
      const defaultPassHash = '$2a$10$vN91xYk2oKqS0sE1nKxGxeX.oOq0k9yG1L/J5V5N0S7a3K5n5S7a3'; // bcrypt hash
      await query(`
        INSERT INTO users (username, name, role, password_hash) VALUES
        ('admin', 'Administrador Tech', 'Administrador', '${defaultPassHash}')
      `);

      // Seed Contadores
      await query(`INSERT INTO counters (doc_type, last_number) VALUES ('Ticket', 0), ('Boleta', 0), ('Factura', 0)`);

      console.log('✅ CELLVENTAS: Marcas, Modelos, Compatibilidades e IMEIs inicializados con éxito.');
    }

  } catch (err) {
    console.error('❌ Error inicializando DB de CELLVENTAS:', err);
  }
}

module.exports = {
  query,
  initDb,
  USE_POSTGRES
};
