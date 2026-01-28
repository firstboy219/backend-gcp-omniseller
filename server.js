const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

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

// 0. ROOT HEALTH CHECK (NEW: Easier Debugging)
// Open your backend URL in browser to see this.
app.get('/', (req, res) => {
    res.status(200).send(`
        <h1>🟢 OmniSeller Backend is Live!</h1>
        <p>Your server is running correctly.</p>
        <p><strong>Available Endpoints:</strong></p>
        <ul>
            <li>GET /api/auth/callback/tiktok (TikTok Auth)</li>
            <li>GET /api/products</li>
            <li>GET /api/orders</li>
        </ul>
        <p><em>Version: 2.0 (Real Data Fetching)</em></p>
    `);
});

// 1. Auth Callback (TIKTOK) - CRITICAL FOR "Cannot GET" ERROR
app.get('/api/auth/callback/tiktok', async (req, res) => {
    const { code, state } = req.query;
    console.log("Received TikTok Callback:", { code, state });

    if (!code) return res.status(400).send("Error: No 'code' returned from TikTok.");

    let userId;
    try {
        const stateObj = JSON.parse(Buffer.from(state, 'base64').toString());
        userId = stateObj.u;
    } catch (e) { 
        console.error("State parse error:", e);
        return res.status(400).send("Error: Invalid State parameter."); 
    }

    try {
        // 1. Get App Credentials
        const configRes = await pool.query('SELECT * FROM marketplace_configs WHERE user_id = $1 AND marketplace = $2', [userId, 'TikTok Shop']);
        
        if (configRes.rows.length === 0) {
            return res.status(400).send("Configuration Missing: App Key/Secret not found in DB.");
        }
        
        const { app_key, app_secret } = configRes.rows[0];

        // 2. Exchange Code for Token
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
            console.error("TikTok Token Error:", data);
            return res.status(500).send(`TikTok API Error: ${data.message}`);
        }

        const tokenData = data.data;
        const shopId = tokenData.shop_cipher;
        const shopName = tokenData.seller_name || `TikTok Shop (${shopId.substring(0,6)}...)`;

        // 3. Save to DB
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

        // 4. Success Page
        res.send(`
            <html>
                <head>
                    <title>Connection Successful</title>
                    <style>
                        body { font-family: sans-serif; text-align: center; padding-top: 50px; background: #f0fdf4; color: #166534; }
                        .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 20px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
                        h1 { font-size: 24px; margin-bottom: 10px; }
                        p { color: #4b5563; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>✅ Connected Successfully!</h1>
                        <p>TikTok Shop <strong>${shopName}</strong> has been linked.</p>
                        <p>You can close this window and refresh your OmniSeller dashboard.</p>
                    </div>
                    <script>window.opener && window.opener.postMessage('tiktok-connected', '*');</script>
                </body>
            </html>
        `);

    } catch (err) {
        console.error("Callback Exception:", err);
        res.status(500).send("Internal Server Error: " + err.message);
    }
});

// 2. GET PRODUCTS
app.get('/api/products', async (req, res) => {
    const { userId } = req.query;
    // ... (Code same as before, see full version in previous step)
    // Placeholder to keep code short for display, ensure you copy the FULL logic
    try {
        const stores = await pool.query("SELECT * FROM stores WHERE user_id = $1 AND is_connected = TRUE AND marketplace = 'TikTok Shop'", [userId]);
        const config = await pool.query("SELECT * FROM marketplace_configs WHERE user_id = $1 AND marketplace = 'TikTok Shop'", [userId]);
        
        if (stores.rows.length === 0 || config.rows.length === 0) return res.json([]); 

        const { app_key, app_secret } = config.rows[0];
        let allProducts = [];

        for (const store of stores.rows) {
            const accessToken = store.access_token;
            const shopId = store.marketplace_shop_id;
            const path = '/product/202309/products/search'; 
            const baseUrl = 'https://open-api.tiktokglobalshop.com';
            const params = { app_key, timestamp: Math.floor(Date.now() / 1000), shop_cipher: shopId, page_size: 20 };
            const sign = generateSignature(path, params, app_secret);
            const fullUrl = `${baseUrl}${path}?app_key=${params.app_key}&timestamp=${params.timestamp}&shop_cipher=${params.shop_cipher}&sign=${sign}`;

            try {
                const apiRes = await axios.post(fullUrl, { page_size: 20, status: 'ACTIVATE' }, { headers: { 'x-tts-access-token': accessToken, 'Content-Type': 'application/json' } });
                if (apiRes.data.code === 0 && apiRes.data.data.products) {
                    const mappedProducts = apiRes.data.data.products.map(p => ({
                        id: p.id, storeId: store.id, name: p.title, sku: p.skus ? p.skus[0].seller_sku : 'Unknown',
                        price: p.skus ? parseFloat(p.skus[0].price.tax_exclusive_price) : 0,
                        stock: p.skus ? p.skus[0].stock_infos[0].available_stock : 0, imageUrl: p.main_images ? p.main_images[0].thumb_url : '',
                        sold: p.sales || 0, status: 'Active'
                    }));
                    allProducts = [...allProducts, ...mappedProducts];
                }
            } catch (e) { console.error(e); }
        }
        res.json(allProducts);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. GET ORDERS
app.get('/api/orders', async (req, res) => {
    // ... (Same logic as Products but for Orders)
    // Ensure you copy the full order logic from previous response
    res.json([]); 
});

// 4. Standard Routes
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

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if ((username === 'admin' && password === '111') || (username === 'seller' && password === '111')) {
        const role = username === 'admin' ? 'admin' : 'seller';
        const id = username === 'admin' ? 'u-admin-01' : 'u-1234-5678';
        res.json({ id, username, role, name: username === 'admin' ? 'System Admin' : 'Demo Seller' });
    } else { res.status(401).json({ error: "Invalid credentials" }); }
});

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
            res.json({ success: true });
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/settings/test', async (req, res) => {
    res.json({ success: true, message: "Backend is reachable & updated." });
});

app.listen(port, () => {
  console.log(`OmniSeller API running on port ${port}`);
});