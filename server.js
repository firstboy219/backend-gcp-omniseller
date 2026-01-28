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

// --- TIKTOK API HELPER FUNCTIONS ---

// 1. Generate Signature (HMAC-SHA256)
// TikTok requires params to be sorted alphabetically, concatenated with secret, then hashed.
function generateSignature(path, params, appSecret) {
    const keys = Object.keys(params).filter(k => k !== 'sign' && k !== 'access_token').sort();
    let inputStr = path;
    for (const key of keys) {
        inputStr += key + params[key];
    }
    inputStr = appSecret + inputStr + appSecret; // Wrap with secret
    return crypto.createHmac('sha256', appSecret).update(inputStr).digest('hex');
}

// 2. Get Common Params for Requests
function getCommonParams(appKey, accessToken, shopId) {
    return {
        app_key: appKey,
        timestamp: Math.floor(Date.now() / 1000),
        shop_cipher: shopId,
        version: '202309'
    };
}

// --- API ROUTES ---

// 1. Auth Callback (Existing - Kept for reference)
app.get('/api/auth/callback/tiktok', async (req, res) => {
    const { code, state } = req.query;
    if (!code) return res.status(400).send("No code returned");

    let userId;
    try {
        const stateObj = JSON.parse(Buffer.from(state, 'base64').toString());
        userId = stateObj.u;
    } catch (e) { return res.status(400).send("Invalid State"); }

    try {
        const configRes = await pool.query('SELECT * FROM marketplace_configs WHERE user_id = $1 AND marketplace = $2', [userId, 'TikTok Shop']);
        if (configRes.rows.length === 0) return res.status(400).send("Config missing");
        
        const { app_key, app_secret } = configRes.rows[0];
        const tokenUrl = 'https://auth.tiktok-shops.com/api/v2/token/get';
        
        const response = await axios.get(tokenUrl, {
            params: { app_key, app_secret, auth_code: code, grant_type: 'authorized_code' }
        });

        if (response.data.code !== 0) return res.status(500).send(response.data.message);

        const tokenData = response.data.data;
        const shopId = tokenData.shop_cipher;
        const shopName = tokenData.seller_name || `TikTok Shop ${shopId.substr(0,6)}...`;

        const checkStore = await pool.query('SELECT id FROM stores WHERE user_id = $1 AND marketplace_shop_id = $2', [userId, shopId]);

        if (checkStore.rows.length > 0) {
             await pool.query(
                `UPDATE stores SET access_token = $1, refresh_token = $2, is_connected = TRUE, last_sync = NOW() WHERE id = $3`,
                [tokenData.access_token, tokenData.refresh_token, checkStore.rows[0].id]
            );
        } else {
             await pool.query(
                `INSERT INTO stores (user_id, marketplace, store_name, access_token, refresh_token, marketplace_shop_id, is_connected) VALUES ($1, 'TikTok Shop', $2, $3, $4, $5, TRUE)`,
                [userId, shopName, tokenData.access_token, tokenData.refresh_token, shopId]
            );
        }
        res.send("<h1>Connected! You can close this window.</h1>");
    } catch (err) { res.status(500).send(err.message); }
});

// 2. GET PRODUCTS (REAL API CALL)
app.get('/api/products', async (req, res) => {
    const { userId } = req.query;
    try {
        // A. Get Connected Stores & Config
        const stores = await pool.query("SELECT * FROM stores WHERE user_id = $1 AND is_connected = TRUE AND marketplace = 'TikTok Shop'", [userId]);
        const config = await pool.query("SELECT * FROM marketplace_configs WHERE user_id = $1 AND marketplace = 'TikTok Shop'", [userId]);
        
        if (stores.rows.length === 0 || config.rows.length === 0) return res.json([]); // Return empty if no stores

        const { app_key, app_secret } = config.rows[0];
        let allProducts = [];

        // B. Loop through each store and fetch from TikTok
        for (const store of stores.rows) {
            const accessToken = store.access_token;
            const shopId = store.marketplace_shop_id;
            
            // TikTok API Path for Search Products
            const path = '/product/202309/products/search'; 
            const baseUrl = 'https://open-api.tiktokglobalshop.com';
            
            // Prepare Params
            const params = {
                app_key: app_key,
                timestamp: Math.floor(Date.now() / 1000),
                shop_cipher: shopId,
                page_size: 20 // Limit for demo
            };

            // Sign Request
            const sign = generateSignature(path, params, app_secret);
            const fullUrl = `${baseUrl}${path}?app_key=${params.app_key}&timestamp=${params.timestamp}&shop_cipher=${params.shop_cipher}&sign=${sign}`;

            try {
                const apiRes = await axios.post(fullUrl, {
                    page_size: 20,
                    status: 'ACTIVATE' // Only active products
                }, {
                    headers: { 'x-tts-access-token': accessToken, 'Content-Type': 'application/json' }
                });

                if (apiRes.data.code === 0 && apiRes.data.data.products) {
                    const mappedProducts = apiRes.data.data.products.map(p => ({
                        id: p.id,
                        storeId: store.id,
                        name: p.title,
                        sku: p.skus ? p.skus[0].seller_sku : 'Unknown',
                        price: p.skus ? parseFloat(p.skus[0].price.tax_exclusive_price) : 0,
                        stock: p.skus ? p.skus[0].stock_infos[0].available_stock : 0,
                        imageUrl: p.main_images ? p.main_images[0].thumb_url : '',
                        sold: p.sales || 0,
                        status: 'Active'
                    }));
                    allProducts = [...allProducts, ...mappedProducts];
                }
            } catch (innerErr) {
                console.error(`Failed to fetch products for store ${store.store_name}: `, innerErr.response?.data || innerErr.message);
            }
        }

        res.json(allProducts);

    } catch (err) {
        console.error("Get Products Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// 3. GET ORDERS (REAL API CALL)
app.get('/api/orders', async (req, res) => {
    const { userId } = req.query;
    try {
        const stores = await pool.query("SELECT * FROM stores WHERE user_id = $1 AND is_connected = TRUE AND marketplace = 'TikTok Shop'", [userId]);
        const config = await pool.query("SELECT * FROM marketplace_configs WHERE user_id = $1 AND marketplace = 'TikTok Shop'", [userId]);
        
        if (stores.rows.length === 0 || config.rows.length === 0) return res.json([]);

        const { app_key, app_secret } = config.rows[0];
        let allOrders = [];

        for (const store of stores.rows) {
            const accessToken = store.access_token;
            const shopId = store.marketplace_shop_id;
            
            const path = '/order/202309/orders/search';
            const baseUrl = 'https://open-api.tiktokglobalshop.com';
            
            const params = {
                app_key: app_key,
                timestamp: Math.floor(Date.now() / 1000),
                shop_cipher: shopId,
                page_size: 20
            };

            const sign = generateSignature(path, params, app_secret);
            const fullUrl = `${baseUrl}${path}?app_key=${params.app_key}&timestamp=${params.timestamp}&shop_cipher=${params.shop_cipher}&sign=${sign}`;

            try {
                const apiRes = await axios.post(fullUrl, {
                    page_size: 20,
                    sort_by: 'CREATE_TIME',
                    sort_type: 'DESC'
                }, {
                    headers: { 'x-tts-access-token': accessToken, 'Content-Type': 'application/json' }
                });

                if (apiRes.data.code === 0 && apiRes.data.data.orders) {
                    const mappedOrders = apiRes.data.data.orders.map(o => ({
                        id: o.id,
                        userId: userId,
                        storeId: store.id,
                        customerName: o.buyer_email || 'TikTok User', // TikTok PII is restricted
                        status: mapTikTokStatus(o.order_status),
                        total: parseFloat(o.payment.total_amount),
                        items: o.line_items.map(item => ({
                            productId: item.product_id,
                            name: item.product_name,
                            quantity: 1, // Simplified
                            price: parseFloat(item.sale_price),
                            imageUrl: item.sku_image
                        })),
                        createdAt: new Date(parseInt(o.create_time)).toISOString().split('T')[0],
                        updatedAt: new Date(parseInt(o.update_time)).toISOString()
                    }));
                    allOrders = [...allOrders, ...mappedOrders];
                }
            } catch (innerErr) {
                 console.error(`Failed to fetch orders for store ${store.store_name}: `, innerErr.response?.data || innerErr.message);
            }
        }
        res.json(allOrders);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function mapTikTokStatus(ttsStatus) {
    // UNPAID, AWAITING_SHIPMENT, AWAITING_COLLECTION, IN_TRANSIT, DELIVERED, COMPLETED, CANCELLED
    if (ttsStatus === 'UNPAID') return 'Unpaid';
    if (ttsStatus === 'AWAITING_SHIPMENT' || ttsStatus === 'AWAITING_COLLECTION') return 'Processing';
    if (ttsStatus === 'IN_TRANSIT') return 'Shipped';
    if (ttsStatus === 'COMPLETED') return 'Completed';
    if (ttsStatus === 'CANCELLED') return 'Cancelled';
    return 'Processing';
}

// 4. Stores & Login (Standard)
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

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    // Simple demo auth
    if ((username === 'admin' && password === '111') || (username === 'seller' && password === '111')) {
        const role = username === 'admin' ? 'admin' : 'seller';
        const id = username === 'admin' ? 'u-admin-01' : 'u-1234-5678';
        res.json({ id, username, role, name: username === 'admin' ? 'System Admin' : 'Demo Seller' });
    } else {
        res.status(401).json({ error: "Invalid credentials" });
    }
});

// 5. Settings Routes
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
    // Simple verification endpoint
    res.json({ success: true, message: "Backend is reachable." });
});

app.listen(port, () => {
  console.log(`OmniSeller API running on port ${port}`);
});