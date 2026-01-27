const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Konfigurasi Database
const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

// Cek apakah sedang berjalan di Cloud Run atau Lokal
if (process.env.INSTANCE_CONNECTION_NAME) {
  // Koneksi Cloud Run (Unix Socket)
  dbConfig.host = `/cloudsql/${process.env.INSTANCE_CONNECTION_NAME}`;
} else {
  // Koneksi Lokal (TCP)
  dbConfig.host = 'localhost';
  dbConfig.port = 5432;
}

const pool = new Pool(dbConfig);

app.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() as time');
    res.json({ 
      status: 'Sukses', 
      message: 'Aplikasi terhubung ke Cloud SQL!',
      waktu_server: result.rows[0].time 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal koneksi database', detail: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});