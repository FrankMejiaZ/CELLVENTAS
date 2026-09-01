// =========================================================================
// MÓDULO DE BASE DE DATOS POSTGRESQL - CELLVENTAS
// Sistema POS, Almacén y Matriz de Compatibilidad para Celulares y Accesorios
// =========================================================================
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5434'),
  user: process.env.POSTGRES_USER || 'cellventas_user',
  password: process.env.POSTGRES_PASSWORD || 'cellventas_secure_pass',
  database: process.env.POSTGRES_DB || 'cellventas_db'
});

// Inicialización de Esquemas y Semillas
async function initDb() {
  let client;
  try {
    client = await pool.connect();
    console.log('✅ Base de Datos PostgreSQL conectada exitosamente a CELLVENTAS.');

    // 1. MARCAS DE CELULARES (Apple, Samsung, Xiaomi, Motorola, etc.)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS brands (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        logo VARCHAR(255) DEFAULT '',
        order_index INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_brands_name ON brands(name);
    `);

    // 2. MODELOS DE CELULARES ESPECÍFICOS
    await pool.query(`
      CREATE TABLE IF NOT EXISTS phone_models (
        id SERIAL PRIMARY KEY,
        brand_id INT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
        name VARCHAR(150) NOT NULL,
        release_year INT DEFAULT NULL,
        screen_size VARCHAR(50) DEFAULT '',
        notes TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT unique_brand_model UNIQUE (brand_id, name)
      );
      CREATE INDEX IF NOT EXISTS idx_models_brand_id ON phone_models(brand_id);
      CREATE INDEX IF NOT EXISTS idx_models_name ON phone_models(name);
    `);

    // 3. PRODUCTOS Y ACCESORIOS
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        code VARCHAR(100) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(100) NOT NULL DEFAULT 'Accesorios',
        purchase_price NUMERIC(10,2) DEFAULT 0,
        price NUMERIC(10,2) NOT NULL,
        stock INT NOT NULL DEFAULT 0,
        min_stock INT DEFAULT 5,
        has_imei BOOLEAN DEFAULT FALSE,
        brand_id INT REFERENCES brands(id) ON DELETE SET NULL,
        phone_model_id INT REFERENCES phone_models(id) ON DELETE SET NULL,
        description TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_products_code ON products(code);
      CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
      CREATE INDEX IF NOT EXISTS idx_products_has_imei ON products(has_imei);
    `);

    // 4. MATRIZ DE COMPATIBILIDAD CRUZADA (M:N Producto <-> Modelos de Celular)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS product_compatibilities (
        id SERIAL PRIMARY KEY,
        product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        phone_model_id INT NOT NULL REFERENCES phone_models(id) ON DELETE CASCADE,
        notes VARCHAR(255) DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT unique_product_compat UNIQUE (product_id, phone_model_id)
      );
      CREATE INDEX IF NOT EXISTS idx_compat_product ON product_compatibilities(product_id);
      CREATE INDEX IF NOT EXISTS idx_compat_model ON product_compatibilities(phone_model_id);
    `);

    // 5. REGISTRO Y SEGUIMIENTO DE IMEIS / NÚMEROS DE SERIE
    await pool.query(`
      CREATE TABLE IF NOT EXISTS device_imeis (
        id SERIAL PRIMARY KEY,
        product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        imei VARCHAR(30) UNIQUE NOT NULL,
        serial_number VARCHAR(100) DEFAULT '',
        status VARCHAR(20) NOT NULL DEFAULT 'disponible', -- 'disponible', 'vendido', 'defectuoso', 'devuelto'
        sale_id INT DEFAULT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        sold_at TIMESTAMPTZ DEFAULT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_imeis_product ON device_imeis(product_id);
      CREATE INDEX IF NOT EXISTS idx_imeis_code ON device_imeis(imei);
      CREATE INDEX IF NOT EXISTS idx_imeis_status ON device_imeis(status);
    `);

    // 6. CLIENTES (CRM Básico para Boletas / Facturas / Comprobantes)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        doc VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(50) DEFAULT '',
        address VARCHAR(255) DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_customers_doc ON customers(doc);
    `);

    // 7. USUARIOS Y CONTROL DE ACCESO (RBAC)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'Vendedor', -- 'Administrador', 'Vendedor'
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 8. ARQUEO Y CIERRE DE CAJA DIARIO (TURNO Z)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cash_registers (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE SET NULL,
        user_name VARCHAR(255) NOT NULL,
        opening_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
        cash_sales NUMERIC(10,2) DEFAULT 0,
        card_sales NUMERIC(10,2) DEFAULT 0,
        transfer_sales NUMERIC(10,2) DEFAULT 0,
        total_withdrawals NUMERIC(10,2) DEFAULT 0,
        expected_cash NUMERIC(10,2) DEFAULT 0,
        actual_cash NUMERIC(10,2) DEFAULT 0,
        difference NUMERIC(10,2) DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'abierta',
        notes VARCHAR(255) DEFAULT '',
        opened_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        closed_at TIMESTAMPTZ
      );
    `);

    // 9. MOVIMIENTOS Y RETIROS DE CAJA EN EFECTIVO
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cash_movements (
        id SERIAL PRIMARY KEY,
        cash_register_id INT REFERENCES cash_registers(id) ON DELETE CASCADE,
        user_id INT REFERENCES users(id) ON DELETE SET NULL,
        user_name VARCHAR(255) NOT NULL,
        type VARCHAR(20) NOT NULL DEFAULT 'RETIRO', -- 'RETIRO', 'INGRESO'
        amount NUMERIC(10,2) NOT NULL,
        reason VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 10. VENTAS (CON AUDITORÍA DE VENDEDOR, VÍNCULO A CAJA Y ESTADO)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales (
        id SERIAL PRIMARY KEY,
        receipt_code VARCHAR(100) UNIQUE NOT NULL,
        doc_type VARCHAR(50) NOT NULL DEFAULT 'Ticket', -- 'Ticket', 'Boleta', 'Factura'
        customer_id INT REFERENCES customers(id) ON DELETE SET NULL,
        customer_name VARCHAR(255) DEFAULT 'Público General',
        payment_method VARCHAR(50) NOT NULL DEFAULT 'Efectivo', -- 'Efectivo', 'Tarjeta', 'Yape / Plin'
        subtotal NUMERIC(10,2) NOT NULL,
        tax NUMERIC(10,2) NOT NULL DEFAULT 0,
        total NUMERIC(10,2) NOT NULL,
        paid_amount NUMERIC(10,2) DEFAULT 0,
        change_amount NUMERIC(10,2) DEFAULT 0,
        user_id INT REFERENCES users(id) ON DELETE SET NULL,
        user_name VARCHAR(255) DEFAULT 'Administrador',
        cash_register_id INT REFERENCES cash_registers(id) ON DELETE SET NULL,
        status VARCHAR(20) DEFAULT 'completada', -- 'completada', 'anulada'
        notes TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_sales_receipt ON sales(receipt_code);
      CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
      CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status);
    `);

    // 11. DETALLE DE VENTAS (INCLUYENDO REGISTRO DE IMEIS VENDIDOS)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sale_items (
        id SERIAL PRIMARY KEY,
        sale_id INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        product_id INT REFERENCES products(id) ON DELETE SET NULL,
        product_name VARCHAR(255) NOT NULL,
        quantity INT NOT NULL,
        unit_price NUMERIC(10,2) NOT NULL,
        total_price NUMERIC(10,2) NOT NULL,
        imeis JSONB DEFAULT '[]'::jsonb
      );
      CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
    `);

    // 12. TABLA DE CORRELATIVOS / CONTADORES
    await pool.query(`
      CREATE TABLE IF NOT EXISTS counters (
        id VARCHAR(50) PRIMARY KEY,
        value INT NOT NULL DEFAULT 0
      );
    `);

    // Sembrado inicial de datos
    await seedInitialData();

  } catch (error) {
    console.error('❌ Error al inicializar esquemas PostgreSQL:', error.message);
  } finally {
    if (client) client.release();
  }
}

// Sembrado inicial: Administrador, Marcas, Modelos populares y Productos demo
async function seedInitialData() {
  try {
    // 1. Usuario Administrador por defecto (admin / admin123)
    const userCheck = await pool.query("SELECT COUNT(*) FROM users WHERE username = 'admin'");
    if (parseInt(userCheck.rows[0].count) === 0) {
      const hashedPassword = await bcrypt.hash('admin123', 10);
      await pool.query(`
        INSERT INTO users (username, password, name, role)
        VALUES ($1, $2, $3, $4)
      `, ['admin', hashedPassword, 'Administrador General', 'Administrador']);
      console.log('👤 Usuario administrador inicial creado: admin / admin123');
    }

    // 2. Marcas de telefonía
    const brandsList = [
      { name: 'Apple', logo: 'apple', order_index: 1 },
      { name: 'Samsung', logo: 'samsung', order_index: 2 },
      { name: 'Xiaomi', logo: 'xiaomi', order_index: 3 },
      { name: 'Motorola', logo: 'motorola', order_index: 4 },
      { name: 'Honor', logo: 'honor', order_index: 5 },
      { name: 'Realme', logo: 'realme', order_index: 6 },
      { name: 'Infinix', logo: 'infinix', order_index: 7 },
      { name: 'Huawei', logo: 'huawei', order_index: 8 },
      { name: 'Tecno', logo: 'tecno', order_index: 9 },
      { name: 'ZTE', logo: 'zte', order_index: 10 }
    ];

    for (const b of brandsList) {
      await pool.query(`
        INSERT INTO brands (name, logo, order_index)
        VALUES ($1, $2, $3)
        ON CONFLICT (name) DO NOTHING
      `, [b.name, b.logo, b.order_index]);
    }

    // 3. Modelos más populares por marca
    const modelsByBrand = {
      'Apple': [
        { name: 'iPhone 15 Pro Max', year: 2023, screen: '6.7"' },
        { name: 'iPhone 15 Pro', year: 2023, screen: '6.1"' },
        { name: 'iPhone 15 Plus', year: 2023, screen: '6.7"' },
        { name: 'iPhone 15', year: 2023, screen: '6.1"' },
        { name: 'iPhone 14 Pro Max', year: 2022, screen: '6.7"' },
        { name: 'iPhone 14 Pro', year: 2022, screen: '6.1"' },
        { name: 'iPhone 14', year: 2022, screen: '6.1"' },
        { name: 'iPhone 13', year: 2021, screen: '6.1"' },
        { name: 'iPhone 12', year: 2020, screen: '6.1"' },
        { name: 'iPhone 11', year: 2019, screen: '6.1"' }
      ],
      'Samsung': [
        { name: 'Galaxy S24 Ultra', year: 2024, screen: '6.8"' },
        { name: 'Galaxy S24+', year: 2024, screen: '6.7"' },
        { name: 'Galaxy S24', year: 2024, screen: '6.2"' },
        { name: 'Galaxy S23 Ultra', year: 2023, screen: '6.8"' },
        { name: 'Galaxy A54 5G', year: 2023, screen: '6.4"' },
        { name: 'Galaxy A34 5G', year: 2023, screen: '6.6"' },
        { name: 'Galaxy A15 4G/5G', year: 2024, screen: '6.5"' },
        { name: 'Galaxy A05s', year: 2023, screen: '6.7"' },
        { name: 'Galaxy A24', year: 2023, screen: '6.5"' }
      ],
      'Xiaomi': [
        { name: 'Redmi Note 13 Pro+ 5G', year: 2024, screen: '6.67"' },
        { name: 'Redmi Note 13 Pro 4G/5G', year: 2024, screen: '6.67"' },
        { name: 'Redmi Note 13 4G', year: 2024, screen: '6.67"' },
        { name: 'Redmi 13C', year: 2023, screen: '6.74"' },
        { name: 'Redmi Note 12 4G', year: 2023, screen: '6.67"' },
        { name: 'Redmi Note 12 Pro', year: 2023, screen: '6.67"' },
        { name: 'Poco X6 Pro 5G', year: 2024, screen: '6.67"' },
        { name: 'Poco M6 Pro', year: 2024, screen: '6.67"' },
        { name: 'Poco F5', year: 2023, screen: '6.67"' }
      ],
      'Motorola': [
        { name: 'Edge 40 Neo', year: 2023, screen: '6.55"' },
        { name: 'Moto G84 5G', year: 2023, screen: '6.5"' },
        { name: 'Moto G54 5G', year: 2023, screen: '6.5"' },
        { name: 'Moto G24 Power', year: 2024, screen: '6.56"' },
        { name: 'Moto G14', year: 2023, screen: '6.5"' },
        { name: 'Moto E13', year: 2023, screen: '6.5"' }
      ],
      'Honor': [
        { name: 'Honor 90', year: 2023, screen: '6.7"' },
        { name: 'Honor Magic 6 Lite', year: 2024, screen: '6.78"' },
        { name: 'Honor X8b', year: 2024, screen: '6.7"' },
        { name: 'Honor X7b', year: 2024, screen: '6.8"' },
        { name: 'Honor X6a', year: 2023, screen: '6.56"' }
      ],
      'Realme': [
        { name: 'Realme 12 Pro+ 5G', year: 2024, screen: '6.7"' },
        { name: 'Realme C67', year: 2023, screen: '6.72"' },
        { name: 'Realme C55', year: 2023, screen: '6.72"' },
        { name: 'Realme 11 Pro+', year: 2023, screen: '6.7"' }
      ]
    };

    for (const [brandName, models] of Object.entries(modelsByBrand)) {
      const brandRes = await pool.query('SELECT id FROM brands WHERE name = $1', [brandName]);
      if (brandRes.rows.length > 0) {
        const brandId = brandRes.rows[0].id;
        for (const m of models) {
          await pool.query(`
            INSERT INTO phone_models (brand_id, name, release_year, screen_size)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (brand_id, name) DO NOTHING
          `, [brandId, m.name, m.year, m.screen]);
        }
      }
    }

    // 4. Sembrado de Productos de prueba (Celulares con IMEI, Micas con Compatibilidad Cruzada, Cases)
    const prodCount = await pool.query('SELECT COUNT(*) FROM products');
    if (parseInt(prodCount.rows[0].count) === 0) {
      console.log('📦 Sembrando productos y compatibilidades iniciales...');

      // Producto 1: Mica de Vidrio Templado 9D Universal iPhone 13 / 14
      const p1 = await pool.query(`
        INSERT INTO products (code, name, category, purchase_price, price, stock, min_stock, has_imei, description)
        VALUES ('MICA-IP13-14', 'Mica Cristal Templado 9D - iPhone 13 / iPhone 14', 'Micas y Vidrios', 2.50, 15.00, 30, 5, false, 'Cristal 9D cobertura completa anti-huella')
        RETURNING id
      `);
      const micaIpId = p1.rows[0].id;

      // Vincular Mica con iPhone 13 e iPhone 14
      const ip13 = await pool.query("SELECT id FROM phone_models WHERE name = 'iPhone 13'");
      const ip14 = await pool.query("SELECT id FROM phone_models WHERE name = 'iPhone 14'");
      if (ip13.rows[0]) await pool.query("INSERT INTO product_compatibilities (product_id, phone_model_id, notes) VALUES ($1, $2, 'Ajuste perfecto') ON CONFLICT DO NOTHING", [micaIpId, ip13.rows[0].id]);
      if (ip14.rows[0]) await pool.query("INSERT INTO product_compatibilities (product_id, phone_model_id, notes) VALUES ($1, $2, 'Ajuste perfecto') ON CONFLICT DO NOTHING", [micaIpId, ip14.rows[0].id]);

      // Producto 2: Mica Cerámica Mate Galaxy A54
      const p2 = await pool.query(`
        INSERT INTO products (code, name, category, purchase_price, price, stock, min_stock, has_imei, description)
        VALUES ('MICA-A54-MAT', 'Mica Cerámica Mate Irrompible - Galaxy A54 5G', 'Micas y Vidrios', 3.00, 20.00, 25, 5, false, 'Mica de cerámica flexible efecto mate antibrillo')
        RETURNING id
      `);
      const micaA54Id = p2.rows[0].id;
      const a54 = await pool.query("SELECT id FROM phone_models WHERE name = 'Galaxy A54 5G'");
      if (a54.rows[0]) await pool.query("INSERT INTO product_compatibilities (product_id, phone_model_id, notes) VALUES ($1, $2, 'Cerámica Mate') ON CONFLICT DO NOTHING", [micaA54Id, a54.rows[0].id]);

      // Producto 3: Case Antishock Space Transparente Redmi Note 13 Pro 4G/5G
      const p3 = await pool.query(`
        INSERT INTO products (code, name, category, purchase_price, price, stock, min_stock, has_imei, description)
        VALUES ('CASE-RN13PRO-CLR', 'Funda Antishock Space Clear - Redmi Note 13 Pro', 'Fundas y Cases', 4.50, 25.00, 15, 3, false, 'Funda con esquinas reforzadas de aire y acrílico rígido')
        RETURNING id
      `);
      const caseRnId = p3.rows[0].id;
      const rn13pro = await pool.query("SELECT id FROM phone_models WHERE name LIKE 'Redmi Note 13 Pro%'");
      for (const row of rn13pro.rows) {
        await pool.query("INSERT INTO product_compatibilities (product_id, phone_model_id, notes) VALUES ($1, $2, 'Space Clear') ON CONFLICT DO NOTHING", [caseRnId, row.id]);
      }

      // Producto 4: Protector de Lentes de Cámara iPhone 15 Pro / Pro Max
      const p4 = await pool.query(`
        INSERT INTO products (code, name, category, purchase_price, price, stock, min_stock, has_imei, description)
        VALUES ('CAM-IP15PRO-TIT', 'Anillos Protectores de Cámara Titanio - iPhone 15 Pro / Max', 'Protectores de Cámara', 5.00, 30.00, 20, 4, false, 'Vidrio templado zafiro con borde metálico')
        RETURNING id
      `);
      const camIpId = p4.rows[0].id;
      const ip15pro = await pool.query("SELECT id FROM phone_models WHERE name IN ('iPhone 15 Pro', 'iPhone 15 Pro Max')");
      for (const row of ip15pro.rows) {
        await pool.query("INSERT INTO product_compatibilities (product_id, phone_model_id, notes) VALUES ($1, $2, 'Anillos 3 Lentes') ON CONFLICT DO NOTHING", [camIpId, row.id]);
      }

      // Producto 5: Cargador Rápido 20W USB-C PD (Universal)
      await pool.query(`
        INSERT INTO products (code, name, category, purchase_price, price, stock, min_stock, has_imei, description)
        VALUES ('CARG-20W-PD', 'Cargador Carga Rápida 20W Power Delivery Tipo C', 'Cargadores y Cables', 8.00, 35.00, 40, 8, false, 'Cubo cargador 20W compatible con iPhone, Samsung y Xiaomi')
      `);

      // Producto 6: Teléfono Celular Xiaomi Redmi 13C 128GB (Con gestión de IMEIs)
      const p6 = await pool.query(`
        INSERT INTO products (code, name, category, purchase_price, price, stock, min_stock, has_imei, description)
        VALUES ('TEL-REDMI-13C', 'Smartphone Xiaomi Redmi 13C 6GB/128GB Azul', 'Celulares', 380.00, 499.00, 3, 1, true, 'Equipo nuevo sellado con garantía 1 año')
        RETURNING id
      `);
      const telId = p6.rows[0].id;

      // Insertar 3 IMEIs de prueba disponibles para el teléfono
      const imeis = ['862345061234561', '862345061234562', '862345061234563'];
      for (const imei of imeis) {
        await pool.query(`
          INSERT INTO device_imeis (product_id, imei, serial_number, status)
          VALUES ($1, $2, $3, 'disponible')
          ON CONFLICT (imei) DO NOTHING
        `, [telId, imei, 'SN-' + imei.slice(-6)]);
      }

      console.log('✅ Catálogo de productos, compatibilidades cruzadas e IMEIs inicializado.');
    }

  } catch (error) {
    console.error('❌ Error en el sembrado de datos iniciales:', error.message);
  }
}

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  initDb
};
