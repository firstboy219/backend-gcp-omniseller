const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8080;

// Enable CORS for all origins
app.use(cors());
app.use(express.json());

// Request Logger
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// DB Connection
const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host: process.env.DB_HOST, 
  port: process.env.DB_PORT || 5432,
});

// --- HELPER FUNCTIONS ---
function generateSignature(path, params, appSecret) {
    const keys = Object.keys(params).filter(k => k !== 'sign' && k !== 'access_token').sort();
    let inputStr = path;
    for (const key of keys) {
        inputStr += key + params[key];
    }
    inputStr = appSecret + inputStr + appSecret;
    return crypto.createHmac('sha256', appSecret).update(inputStr).digest('hex');
}

// --- API ROUTES ---

// 0. ROOT HEALTH CHECK
app.get('/', (req, res) => {
    res.status(200).send(`
        <h1>🟢 OmniSeller Backend is Live!</h1>
        <p>Your server is running correctly.</p>
        <p><strong>Version:</strong> 2.2 (DB Login Enabled)</p>
    `);
});

// 1. AUTH LOGIN (UPDATED: Uses Database)
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    console.log("Login attempt:", username);
    
    try {
        // Check DB for user
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        
        if (result.rows.length > 0) {
            const user = result.rows[0];
            // WARNING: In production, use bcrypt.compare(password, user.password_hash)
            // For this demo with '111', direct comparison matches seed data.
            if (user.password_hash === password) {
                 console.log("Login success:", username);
                 res.json({
                    id: user.id,
                    username: user.username,
                    role: user.role,
                    name: user.username === 'admin' ? 'System Admin' : 'Seller Account',
                    email: user.email
                 });
                 return;
            }
        }
        
        console.log("Login failed: Invalid credentials for", username);
        res.status(401).json({ error: "Invalid credentials" });
        
    } catch (e) {
        console.error("Login DB Error:", e);
        // Fallback to hardcoded if DB fails (Emergency Access)
        if ((username === 'admin' && password === '111') || (username === 'seller' && password === '111')) {
             console.log("Login success (Fallback Mode)");
             const role = username === 'admin' ? 'admin' : 'seller';
             const id = username === 'admin' ? 'u-admin-01' : 'u-1234-5678';
             res.json({ id, username, role, name: username === 'admin' ? 'System Admin' : 'Demo Seller' });
        } else {
             res.status(500).json({ error: "Database Error: " + e.message });
        }
    }
});

// 2. Auth Callback (TIKTOK)
app.get('/api/auth/callback/tiktok', async (req, res) => {
    const { code, state } = req.query;
    console.log("Received TikTok Callback. Code present?", !!code);

    if (!code) return res.status(400).send("Error: No 'code' returned from TikTok.");

    let userId;
    try {
        const stateObj = JSON.parse(Buffer.from(state, 'base64').toString());
        userId = stateObj.u;
    } catch (e) { 
        return res.status(400).send("Error: Invalid State parameter."); 
    }

    try {
        const configRes = await pool.query('SELECT * FROM marketplace_configs WHERE user_id = $1 AND marketplace = $2', [userId, 'TikTok Shop']);
        
        if (configRes.rows.length === 0) {
            return res.status(400).send("Configuration Missing: App Key/Secret not found in DB. Please Save Settings in Admin Panel first.");
        }
        
        const { app_key, app_secret } = configRes.rows[0];
        
        // Exchange Token
        const tokenUrl = 'https://auth.tiktok-shops.com/api/v2/token/get';
        const response = await axios.get(tokenUrl, {
            params: {
                app_key: app_key,
                app_secret: app_secret,
                auth_code: code,
                grant_type: 'authorized_code'
            }
        });

        const data = response.data;
        if (data.code !== 0) {
            return res.status(500).send(`TikTok API Error: ${data.message}`);
        }

        const tokenData = data.data;
        const shopId = tokenData.shop_cipher;
        const shopName = tokenData.seller_name || `TikTok Shop (${shopId.substring(0,6)}...)`;

        // Upsert Store
        const checkStore = await pool.query('SELECT id FROM stores WHERE user_id = $1 AND marketplace_shop_id = $2', [userId, shopId]);

        if (checkStore.rows.length > 0) {
             await pool.query(
                `UPDATE stores SET access_token = $1, refresh_token = $2, is_connected = TRUE, last_sync = NOW() WHERE id = $3`,
                [tokenData.access_token, tokenData.refresh_token, checkStore.rows[0].id]
            );
        } else {
             await pool.query(
                `INSERT INTO stores (user_id, marketplace, store_name, access_token, refresh_token, marketplace_shop_id, is_connected)
                 VALUES ($1, 'TikTok Shop', $2, $3, $4, $5, TRUE)`,
                [userId, shopName, tokenData.access_token, tokenData.refresh_token, shopId]
            );
        }

        res.send(`
            <html>
                <head><title>Connected</title></head>
                <body style="text-align:center; padding:50px; font-family:sans-serif; background:#f0fdf4; color:#166534;">
                    <h1>✅ Connected!</h1>
                    <p>TikTok Shop <strong>${shopName}</strong> linked.</p>
                    <script>window.opener && window.opener.postMessage('tiktok-connected', '*');</script>
                </body>
            </html>
        `);

    } catch (err) {
        console.error("Callback Exception:", err);
        res.status(500).send("Internal Server Error: " + err.message);
    }
});

// 3. GET DATA ROUTES
app.get('/api/products', async (req, res) => {
    // Placeholder: Return empty array or mock data until real sync logic is added
    res.json([]); 
});

app.get('/api/orders', async (req, res) => {
    res.json([]); 
});

app.get('/api/stores', async (req, res) => {
    const { userId } = req.query;
    try {
        const result = await pool.query('SELECT * FROM stores WHERE user_id = $1', [userId]);
        res.json(result.rows.map(row => ({
            id: row.id, userId: row.user_id, name: row.store_name, marketplace: row.marketplace,
            connected: row.is_connected, lastSync: row.last_sync, avatarUrl: ''
        })));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/stores', async (req, res) => {
    const { userId, name, marketplace } = req.body;
    try {
        await pool.query('INSERT INTO stores (user_id, marketplace, store_name, is_connected) VALUES ($1, $2, $3, $4)', [userId, marketplace, name, true]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. SETTINGS ROUTES
app.get('/api/settings', async (req, res) => {
    const { userId } = req.query;
    try {
        const result = await pool.query('SELECT * FROM marketplace_configs WHERE user_id = $1', [userId]);
        const settings = {};
        result.rows.forEach(row => {
            settings[row.marketplace] = {
                appKey: row.app_key || '', appSecret: row.app_secret || '', serviceId: row.service_id || '', 
                webhookSecret: row.webhook_secret || '', apiUrl: row.api_url || ''
            };
        });
        res.json(settings);
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/settings', async (req, res) => {
    const { userId, settings } = req.body;
    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const [marketplace, config] of Object.entries(settings)) {
                await client.query(`
                    INSERT INTO marketplace_configs (user_id, marketplace, app_key, app_secret, service_id, webhook_secret, api_url)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (user_id, marketplace) 
                    DO UPDATE SET app_key=EXCLUDED.app_key, app_secret=EXCLUDED.app_secret, service_id=EXCLUDED.service_id, webhook_secret=EXCLUDED.webhook_secret, api_url=EXCLUDED.api_url
                `, [userId, marketplace, config.appKey, config.appSecret, config.serviceId, config.webhookSecret, config.apiUrl]);
            }
            await client.query('COMMIT');
            res.json({ success: true, message: "Cloud DB Updated" });
        } catch (e) { 
            await client.query('ROLLBACK'); 
            throw e; 
        } finally { client.release(); }
    } catch(e) { res.status(500).json({error: e.message}); }
});

// TEST CONNECTION ENDPOINT
app.post('/api/settings/test', async (req, res) => {
    console.log("Test connection received");
    res.json({ success: true, message: "Backend is reachable & updated." });
});

app.listen(port, () => {
  console.log(`OmniSeller API running on port ${port}`);
});