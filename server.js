const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());

// --- KONFIGURASI DATABASE (Disesuaikan untuk Cloud Run) ---
const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

// Cek apakah jalan di Cloud Run atau Laptop
if (process.env.INSTANCE_CONNECTION_NAME) {
  // Koneksi Cloud Run (Pakai Unix Socket - Lebih Stabil)
  dbConfig.host = `/cloudsql/${process.env.INSTANCE_CONNECTION_NAME}`;
} else {
  // Koneksi Laptop (Pakai TCP/Localhost)
  dbConfig.host = process.env.DB_HOST || 'localhost';
  dbConfig.port = process.env.DB_PORT || 5432;
}

const pool = new Pool(dbConfig);

// Test Connection saat server nyala
pool.connect((err, client, release) => {
  if (err) {
    return console.error('❌ Error acquiring client', err.stack);
  }
  client.query('SELECT NOW()', (err, result) => {
    release();
    if (err) {
      return console.error('❌ Error executing query', err.stack);
    }
    console.log('✅ Connected to Database:', result.rows[0]);
  });
});

// --- API ROUTES ---

// 1. Get All Products (Contoh)
app.get('/api/products', async (req, res) => {
  try {
    // Pastikan tabel 'master_products' sudah dibuat di database!
    const result = await pool.query('SELECT * FROM master_products');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server Error', details: err.message });
  }
});

// 2. Create Order (Contoh)
app.post('/api/orders', async (req, res) => {
  const { userId, total, items } = req.body;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Insert ke tabel orders
    const orderRes = await client.query(
      'INSERT INTO orders(user_id, total_amount, order_status) VALUES($1, $2, $3) RETURNING id',
      [userId, total, 'Processing']
    );
    const orderId = orderRes.rows[0].id;
    
    // (Logic Insert Items bisa ditambahkan di sini nanti)
    
    await client.query('COMMIT');
    res.json({ id: orderId, status: 'Order Created Successfully' });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Root Route (Supaya kalau dibuka browser tidak 404)
app.get('/', (req, res) => {
  res.send('OmniSeller API Backend is Running!');
});

app.listen(port, () => {
  console.log(`OmniSeller API running on port ${port}`);
});