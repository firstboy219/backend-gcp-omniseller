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
function generateSignature(appSecret, path, params) {
  const keys = Object.keys(params).filter(k => k !== 'sign' && k !== 'access_token').sort();
  let inputStr = path;
  for (const key of keys) {
    inputStr += key + params[key];
  }
  inputStr = appSecret + inputStr + appSecret;
  return crypto.createHmac('sha256', appSecret).update(inputStr).digest('hex');
}

// --- API ROUTES ---

// 1. Auth & Settings (Existing)
app.post('/api/auth/login', async (req, res) => {
    // MOCK LOGIN FOR DEMO
    const { username, password } = req.body;
    if ((username === 'admin' && password === '111') || (username === 'seller' && password === '111')) {
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

// 2. Settings Management
app.get('/api/settings', async (req, res) => {
    const { userId } = req.query;
    try {
        const result = await pool.query('SELECT * FROM marketplace_configs WHERE user_id = $1', [userId]);
        const settings = {};
        result.rows.forEach(row => {
            settings[row.marketplace] = {
                appKey: row.app_key || '',
                appSecret: row.app_secret || '',
                serviceId: row.service_id || '', 
                webhookSecret: row.webhook_secret || '', 
                apiUrl: row.api_url || ''
            };
        });
        res.json(settings);
    } catch (err) { 
        console.error(err);
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
                    INSERT INTO marketplace_configs (user_id, marketplace, app_key, app_secret, service_id, webhook_secret, api_url)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (user_id, marketplace) 
                    DO UPDATE SET app_key=EXCLUDED.app_key, app_secret=EXCLUDED.app_secret, service_id=EXCLUDED.service_id, webhook_secret=EXCLUDED.webhook_secret, api_url=EXCLUDED.api_url
                `, [userId, marketplace, config.appKey, config.appSecret, config.serviceId, config.webhookSecret, config.apiUrl]);
            }
            await client.query('COMMIT');
            res.json({ success: true });
        } catch (e) { await client.query('ROLLBACK'); throw e; } 
        finally { client.release(); }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. TIKTOK SHOP AUTHENTICATION CALLBACK (NEW & CRITICAL)
// This route handles the redirect from TikTok after user clicks "Authorize"
app.get('/api/auth/callback/tiktok', async (req, res) => {
    const { code, state } = req.query;

    if (!code) {
        return res.status(400).send("Error: No 'code' returned from TikTok.");
    }

    let userId;
    try {
        // Decode the state parameter to find out WHICH user is connecting
        // Frontend sends state as base64 encoded JSON: { u: 'user_id', ... }
        const stateStr = Buffer.from(state, 'base64').toString();
        const stateObj = JSON.parse(stateStr);
        userId = stateObj.u;
    } catch (e) {
        console.error("State decode error", e);
        return res.status(400).send("Error: Invalid State parameter. Security verification failed.");
    }

    try {
        // 1. Get App Credentials for this User
        const configRes = await pool.query('SELECT * FROM marketplace_configs WHERE user_id = $1 AND marketplace = $2', [userId, 'TikTok Shop']);
        
        if (configRes.rows.length === 0) {
            return res.status(400).send("Configuration Missing: Please set your App Key & Secret in Admin Settings first.");
        }
        
        const { app_key, app_secret } = configRes.rows[0];

        // 2. Exchange Authorization Code for Access Token
        // Docs: https://partner.tiktokshop.com/docv2/page/6507b97987251502866b3d4f
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
        // tokenData contains: { access_token, refresh_token, access_token_expire_in, seller_name, shop_cipher, ... }

        // 3. Save/Update Store in Database
        // We use shop_cipher (Shop ID) to identify the store
        const shopId = tokenData.shop_cipher;
        const shopName = tokenData.seller_name || `TikTok Shop (${shopId})`;

        const checkStore = await pool.query('SELECT id FROM stores WHERE user_id = $1 AND marketplace_shop_id = $2', [userId, shopId]);

        if (checkStore.rows.length > 0) {
             // Update existing store token
             await pool.query(
                `UPDATE stores SET 
                    access_token = $1, 
                    refresh_token = $2, 
                    token_expiry = NOW() + interval '${tokenData.access_token_expire_in} seconds',
                    is_connected = TRUE,
                    store_name = $3,
                    last_sync = NOW() 
                WHERE id = $4`,
                [tokenData.access_token, tokenData.refresh_token, shopName, checkStore.rows[0].id]
            );
        } else {
             // Insert new store
             await pool.query(
                `INSERT INTO stores (user_id, marketplace, store_name, access_token, refresh_token, token_expiry, marketplace_shop_id, is_connected)
                 VALUES ($1, 'TikTok Shop', $2, $3, $4, NOW() + interval '${tokenData.access_token_expire_in} seconds', $5, TRUE)`,
                [userId, shopName, tokenData.access_token, tokenData.refresh_token, shopId]
            );
        }

        // 4. Send Success HTML
        res.send(`
            <html>
                <head>
                    <title>Connection Successful</title>
                    <style>body { font-family: sans-serif; text-align: center; padding-top: 50px; background: #f9fafb; } h1 { color: #10b981; } p { color: #6b7280; }</style>
                </head>
                <body>
                    <h1>✅ Connected Successfully!</h1>
                    <p>Your TikTok Shop has been linked to OmniSeller.</p>
                    <p>You can close this window now.</p>
                </body>
            </html>
        `);

    } catch (err) {
        console.error("Callback Exception:", err);
        res.status(500).send("Internal Server Error: " + err.message);
    }
});


// 4. UNIVERSAL PROXY for TikTok API (Existing)
app.post('/api/proxy/tiktok', async (req, res) => {
    // ... (Code same as previous version)
    // Simplified for brevity in this view, but ensure you keep the proxy logic here
    res.status(501).json({ error: "Proxy logic should be preserved here" });
});

app.listen(port, () => {
  console.log(`OmniSeller API running on port ${port}`);
});