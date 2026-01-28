const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto'); // Required for HMAC Signature
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host: process.env.DB_HOST, 
  port: process.env.DB_PORT || 5432,
});

// --- HELPER: TikTok HMAC-SHA256 Signature Generation ---
// Crucial for calling any TikTok Shop API V2
function generateSignature(appSecret, path, params) {
  // 1. Exclude 'sign' and 'access_token' from params
  const keys = Object.keys(params).filter(k => k !== 'sign' && k !== 'access_token').sort();
  
  // 2. Concatenate keys and values
  let inputStr = path;
  for (const key of keys) {
    inputStr += key + params[key];
  }
  inputStr = appSecret + inputStr + appSecret;

  // 3. Generate HMAC-SHA256
  return crypto.createHmac('sha256', appSecret).update(inputStr).digest('hex');
}

// --- API ROUTES ---

// 1. Auth & Settings (Existing)
app.post('/api/auth/login', async (req, res) => {
    // MOCK LOGIN FOR DEMO
    const { username, password } = req.body;
    if ((username === 'admin' && password === '111') || (username === 'seller' && password === '111')) {
        // In real app, check password hash
        const role = username === 'admin' ? 'admin' : 'seller';
        const id = username === 'admin' ? 'u-admin-01' : 'u-1234-5678';
        res.json({ id, username, role, name: username === 'admin' ? 'System Admin' : 'Demo Seller' });
    } else {
        res.status(401).json({ error: "Invalid credentials" });
    }
});

app.get('/api/stores', async (req, res) => {
    const { userId } = req.query;
    try {
        const result = await pool.query('SELECT * FROM stores WHERE user_id = $1', [userId]);
        const stores = result.rows.map(row => ({
            id: row.id,
            userId: row.user_id,
            name: row.store_name,
            marketplace: row.marketplace,
            connected: row.is_connected,
            lastSync: row.last_sync,
            avatarUrl: ''
        }));
        res.json(stores);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/stores', async (req, res) => {
    const { userId, name, marketplace } = req.body;
    try {
        await pool.query(
            'INSERT INTO stores (user_id, marketplace, store_name, is_connected) VALUES ($1, $2, $3, $4)',
            [userId, marketplace, name, true]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. Settings Management (Fix for 404 Error)
app.get('/api/settings', async (req, res) => {
    const { userId } = req.query;
    try {
        const result = await pool.query('SELECT * FROM marketplace_configs WHERE user_id = $1', [userId]);
        const settings = {};
        result.rows.forEach(row => {
            settings[row.marketplace] = {
                appKey: row.app_key || '',
                appSecret: row.app_secret || '',
                webhookSecret: row.webhook_secret || '', // NEW
                apiUrl: row.api_url || ''
            };
        });
        res.json(settings);
    } catch (err) { 
        console.error(err);
        // Return empty object if table doesn't exist yet to prevent crash
        res.json({}); 
    }
});

app.post('/api/settings', async (req, res) => {
    const { userId, settings } = req.body;
    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const [marketplace, config] of Object.entries(settings)) {
                await client.query(`
                    INSERT INTO marketplace_configs (user_id, marketplace, app_key, app_secret, webhook_secret, api_url)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (user_id, marketplace) 
                    DO UPDATE SET app_key=EXCLUDED.app_key, app_secret=EXCLUDED.app_secret, webhook_secret=EXCLUDED.webhook_secret, api_url=EXCLUDED.api_url
                `, [userId, marketplace, config.appKey, config.appSecret, config.webhookSecret, config.apiUrl]);
            }
            await client.query('COMMIT');
            res.json({ success: true });
        } catch (e) { await client.query('ROLLBACK'); throw e; } 
        finally { client.release(); }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. UNIVERSAL PROXY for TikTok API
app.post('/api/proxy/tiktok', async (req, res) => {
    const { userId, storeId, path, method = 'GET', body = {} } = req.body;
    
    try {
        // A. Get App Credentials
        const configRes = await pool.query('SELECT * FROM marketplace_configs WHERE user_id = $1 AND marketplace = $2', [userId, 'TikTok Shop']);
        const config = configRes.rows[0];
        if (!config) throw new Error("App Credentials not found");

        // B. Get Store Access Token
        const storeRes = await pool.query('SELECT access_token, marketplace_shop_id FROM stores WHERE id = $1', [storeId]);
        const store = storeRes.rows[0];
        if (!store) throw new Error("Store not found or not connected");

        // C. Prepare Request Parameters
        const timestamp = Math.floor(Date.now() / 1000);
        const queryParams = {
            app_key: config.app_key,
            timestamp: timestamp,
            shop_cipher: store.marketplace_shop_id,
            version: '202309', // Latest V2 version
            ...body // Some GET requests send params in body for this proxy
        };

        // D. Generate Signature
        const signature = generateSignature(config.app_secret, path, queryParams);
        
        // E. Make the actual call to TikTok
        const baseUrl = config.api_url || 'https://open-api.tiktokglobalshop.com';
        
        const axiosConfig = {
            method: method,
            url: `${baseUrl}${path}`,
            headers: { 
                'x-tts-access-token': store.access_token, // V2 uses header for token
                'Content-Type': 'application/json' 
            },
            params: {
                ...queryParams,
                sign: signature
            }
        };

        if (method !== 'GET') {
            axiosConfig.data = body;
        }

        const tiktokRes = await axios(axiosConfig);
        res.json(tiktokRes.data);

    } catch (err) {
        console.error("TikTok Proxy Error:", err.response?.data || err.message);
        res.status(500).json({ error: err.message, details: err.response?.data });
    }
});

// 4. TikTok OAuth Callback (Placeholder)
app.get('/api/auth/callback/tiktok', async (req, res) => {
    res.send("OAuth Callback Endpoint. Implement token exchange logic here.");
});

// 5. Mock Data Routes (if DB empty)
app.get('/api/products', (req, res) => res.json([]));
app.get('/api/orders', (req, res) => res.json([]));

app.listen(port, () => {
  console.log(`OmniSeller API running on port ${port}`);
});