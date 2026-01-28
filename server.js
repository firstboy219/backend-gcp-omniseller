const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());

// Google Cloud SQL Connection Pool
const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host: process.env.DB_HOST, 
  port: process.env.DB_PORT || 5432,
});

// --- API ROUTES ---

// 1. Auth (Mock)
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    // Simple mock auth logic. In production, check DB "users" table and hash password.
    if (username === 'admin' && password === '111') {
        res.json({ id: 'u-admin-01', username, role: 'admin', name: 'System Admin' });
    } else if (username === 'seller' && password === '111') {
        res.json({ id: 'u-1234-5678', username, role: 'seller', name: 'Seller Demo' });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

// 2. Stores
app.get('/api/stores', async (req, res) => {
    const { userId } = req.query;
    try {
        // Fetch stores from DB, or return empty array if table not yet populated
        const result = await pool.query('SELECT * FROM stores WHERE user_id = $1', [userId]);
        // Map snake_case DB fields to camelCase frontend fields
        const mapped = result.rows.map(r => ({
            id: r.id,
            userId: r.user_id,
            name: r.store_name,
            marketplace: r.marketplace,
            connected: r.is_connected,
            lastSync: r.last_sync,
            avatarUrl: 'https://picsum.photos/50' // Placeholder
        }));
        res.json(mapped);
    } catch (err) {
        console.error(err);
        res.json([]); // Return empty if error (e.g. table doesn't exist yet)
    }
});

app.post('/api/stores', async (req, res) => {
    const { userId, name, marketplace } = req.body;
    try {
        await pool.query(
            'INSERT INTO stores (user_id, store_name, marketplace, is_connected, last_sync) VALUES ($1, $2, $3, true, NOW())',
            [userId, name, marketplace]
        );
        res.json({ status: 'success' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Products
app.get('/api/products', async (req, res) => {
  try {
    // Join logic would go here to get Channel Products, but for now getting Master Products
    const result = await pool.query('SELECT * FROM master_products');
    // Map to frontend "Product" interface
    const mapped = result.rows.map(r => ({
        id: r.id,
        storeId: 's1', // Mock for now if not joined
        name: r.name,
        sku: 'SKU-' + r.id.substring(0,4),
        price: 100000, 
        stock: 100,
        imageUrl: r.image_url || 'https://picsum.photos/200',
        sold: 0,
        status: 'Active'
    }));
    
    // If DB is empty, return MOCK data so the user sees something
    if (mapped.length === 0) {
        return res.json([
             { id: 'p1', storeId: 's1', name: 'Kemeja Flannel (From DB)', sku: 'SHP-FL-001', price: 150000, stock: 45, imageUrl: 'https://picsum.photos/id/100/200/200', sold: 120, status: 'Active' }
        ]);
    }
    
    res.json(mapped);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// 4. Orders
app.get('/api/orders', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM orders');
        const mapped = result.rows.map(r => ({
            id: r.external_order_id || r.id,
            userId: r.user_id,
            storeId: r.store_id || 's1',
            customerName: r.customer_name,
            status: r.order_status,
            total: parseFloat(r.total_amount),
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            items: [] // Fetch items in real app
        }));

         // Fallback Mock if empty
        if (mapped.length === 0) {
             return res.json([
                 { id: 'ORD-DB-001', userId: 'u-1234', storeId: 's1', customerName: 'Database User', status: 'Processing', total: 500000, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), items: [{productId: 'p1', name: 'Item A', quantity: 1, price: 500000, imageUrl: 'https://picsum.photos/50'}] }
             ]);
        }

        res.json(mapped);
    } catch (err) {
        res.status(500).json({error: err.message});
    }
});

app.listen(port, () => {
  console.log(`OmniSeller API running on port ${port}`);
});