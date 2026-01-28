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

// --- TIKTOK SHOP API HELPERS (V202309) ---

// Calculate HMAC-SHA256 Signature according to TikTok Doc V2
const calculateSignature = (appSecret, path, queryParams) => {
    // 1. Extract keys excluding 'sign' and 'access_token'
    const keys = Object.keys(queryParams)
        .filter(k => k !== 'sign' && k !== 'access_token')
        .sort();

    // 2. Concatenate: app_secret + path + key+value... + app_secret
    let input = appSecret + path;
    for (const key of keys) {
        input += key + queryParams[key];
    }
    input += appSecret;

    // 3. HMAC-SHA256
    return crypto.createHmac('sha256', appSecret).update(input).digest('hex');
};

// Generic Call to TikTok API
const callTikTokAPI = async (appKey, appSecret, accessToken, shopCipher, path, body = {}) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const baseUrl = 'https://open-api.tiktokglobalshop.com';
    
    // Common System Parameters
    let params = {
        app_key: appKey,
        timestamp: timestamp,
        shop_cipher: shopCipher, // Required for V202309
        version: '202309'
    };
    
    // Generate Signature
    const signature = calculateSignature(appSecret, path, params);
    
    // Final Params with Signature
    const finalParams = {
        ...params,
        sign: signature
    };

    try {
        const url = `${baseUrl}${path}`;
        console.log(`[TikTok API] POST ${url}`);
        
        const response = await axios.post(url, body, {
            params: finalParams,
            headers: { 
                'Content-Type': 'application/json', 
                'x-tts-access-token': accessToken // Access Token goes in Header for V2
            }
        });

        if (response.data.code !== 0) {
            console.error(`[TikTok Error] Code: ${response.data.code}, Msg: ${response.data.message}, ID: ${response.data.request_id}`);
            return null;
        }
        return response.data.data;
    } catch (e) {
        console.error("[TikTok API Exception]", e.response?.data || e.message);
        return null;
    }
};

// Root
app.get('/', (req, res) => {
    res.status(200).send(`
        <h1>🟢 OmniSeller Backend is Live!</h1>
        <p><strong>Version:</strong> 3.5 (TikTok V2 API Integration)</p>
    `);
});

// 0. ADMIN SQL EXECUTION
app.post('/api/admin/sql', async (req, res) => {
    const { sql } = req.body;
    if (!sql) return res.status(400).json({ error: "No SQL provided" });
    try {
        await pool.query(sql);
        res.json({ success: true, message: "SQL executed successfully" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 1. AUTH LOGIN
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length > 0) {
            const user = result.rows[0];
            if (user.password_hash === password) {
                 res.json({
                    id: user.id, username: user.username, role: user.role,
                    name: user.username === 'admin' ? 'System Admin' : 'Seller Account', email: user.email
                 });
                 return;
            }
        }
        res.status(401).json({ error: "Invalid credentials" });
    } catch (e) {
        // Fallback for demo if DB fails
        if ((username === 'admin' && password === '111') || (username === 'seller' && password === '111')) {
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
    if (!code) return res.status(400).send("Error: No 'code' returned from TikTok.");

    let userId;
    try {
        const stateObj = JSON.parse(Buffer.from(state, 'base64').toString());
        userId = stateObj.u; 
    } catch (e) { return res.status(400).send("Error: Invalid State."); }

    try {
        const configRes = await pool.query('SELECT * FROM marketplace_configs WHERE user_id = $1 AND marketplace = $2', ['u-admin-01', 'TikTok Shop']);
        if (configRes.rows.length === 0) return res.status(400).send("System Error: Admin keys missing.");
        
        const { app_key, app_secret } = configRes.rows[0];
        
        // V2 Token Endpoint
        const tokenUrl = 'https://auth.tiktok-shops.com/api/v2/token/get';
        const response = await axios.get(tokenUrl, {
            params: { app_key, app_secret, auth_code: code, grant_type: 'authorized_code' }
        });

        if (response.data.code !== 0) return res.status(500).send(`TikTok Token Error: ${response.data.message}`);

        const tokenData = response.data.data;
        const shopCipher = tokenData.shop_cipher; 
        const shopName = tokenData.seller_name || `TikTok Shop ${shopCipher.substring(0,6)}`;

        // Upsert Store
        const checkStore = await pool.query('SELECT id FROM stores WHERE user_id = $1 AND marketplace_shop_id = $2', [userId, shopCipher]);

        if (checkStore.rows.length > 0) {
             await pool.query(
                `UPDATE stores SET access_token = $1, refresh_token = $2, is_connected = TRUE, last_sync = NOW() WHERE id = $3`,
                [tokenData.access_token, tokenData.refresh_token, checkStore.rows[0].id]
            );
        } else {
             await pool.query(
                `INSERT INTO stores (user_id, marketplace, store_name, access_token, refresh_token, marketplace_shop_id, is_connected, last_sync)
                 VALUES ($1, 'TikTok Shop', $2, $3, $4, $5, TRUE, NOW())`,
                [userId, shopName, tokenData.access_token, tokenData.refresh_token, shopCipher]
            );
        }

        res.send(`
            <html>
                <body style="text-align:center; padding:50px; font-family:sans-serif; background:#f0fdf4; color:#166534; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; margin:0;">
                    <h1>✅ Connected Successfully!</h1>
                    <p>TikTok Shop <strong>${shopName}</strong> has been linked.</p>
                    <script>
                        if (window.opener) {
                            window.opener.postMessage('tiktok-connected', '*');
                            setTimeout(() => window.close(), 1500);
                        }
                    </script>
                </body>
            </html>
        `);
    } catch (err) { res.status(500).send("Internal Server Error: " + err.message); }
});

// 3. STORE ROUTES
app.get('/api/stores', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM stores WHERE user_id = $1', [req.query.userId]);
        res.json(result.rows.map(row => ({
            id: row.id, userId: row.user_id, name: row.store_name, marketplace: row.marketplace,
            connected: row.is_connected, lastSync: row.last_sync, avatarUrl: ''
        })));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/stores', async (req, res) => {
    try {
        await pool.query('INSERT INTO stores (user_id, marketplace, store_name, is_connected, last_sync) VALUES ($1, $2, $3, $4, NOW())', [req.body.userId, req.body.marketplace, req.body.name, true]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/stores/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM stores WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. FETCH PRODUCTS (Real TikTok API V2 Call)
app.get('/api/products', async (req, res) => {
    try {
        const { userId, storeId } = req.query;
        let query = 'SELECT * FROM stores WHERE user_id = $1';
        let params = [userId];

        if (storeId) {
            query += ' AND id = $2';
            params.push(storeId);
        }

        const stores = await pool.query(query, params);
        if (stores.rows.length === 0) return res.json([]);

        // Get System Admin Keys (Only TikTok supported for now)
        const configRes = await pool.query('SELECT * FROM marketplace_configs WHERE user_id = $1 AND marketplace = $2', ['u-admin-01', 'TikTok Shop']);
        const tikTokConfig = configRes.rows[0];

        let allProducts = [];

        for (const store of stores.rows) {
            if (store.marketplace === 'TikTok Shop' && tikTokConfig) {
                // Endpoint: POST /product/202309/products/search
                const result = await callTikTokAPI(
                    tikTokConfig.app_key,
                    tikTokConfig.app_secret,
                    store.access_token,
                    store.marketplace_shop_id,
                    '/product/202309/products/search',
                    { 
                        page_size: 20, 
                        status: 'ACTIVATE' // Filter active products
                    }
                );

                if (result && result.products) {
                    await pool.query('UPDATE stores SET last_sync = NOW() WHERE id = $1', [store.id]);

                    // Map TikTok Schema to App Schema
                    const mapped = result.products.map(p => ({
                        id: p.id,
                        storeId: store.id,
                        name: p.title,
                        sku: (p.skus && p.skus[0]) ? p.skus[0].seller_sku : 'NO-SKU',
                        price: (p.skus && p.skus[0]) ? parseFloat(p.skus[0].price.tax_exclusive_price) : 0,
                        stock: (p.skus && p.skus[0]) ? p.skus[0].inventory[0].quantity : 0,
                        imageUrl: (p.main_images && p.main_images[0]) ? p.main_images[0].thumb_urls[0] : '',
                        sold: p.sales || 0,
                        status: p.status === 'ACTIVATE' ? 'Active' : 'Inactive'
                    }));
                    allProducts = [...allProducts, ...mapped];
                }
            }
        }
        res.json(allProducts);
    } catch (err) { 
        console.error("Fetch Products Error:", err);
        res.status(500).json({ error: err.message }); 
    }
});

// 5. FETCH ORDERS (Real TikTok API V2 Call)
app.get('/api/orders', async (req, res) => {
    try {
        const { userId, storeId } = req.query;
        let query = 'SELECT * FROM stores WHERE user_id = $1';
        let params = [userId];

        if (storeId) {
            query += ' AND id = $2';
            params.push(storeId);
        }

        const stores = await pool.query(query, params);
        if (stores.rows.length === 0) return res.json([]);

        const configRes = await pool.query('SELECT * FROM marketplace_configs WHERE user_id = $1 AND marketplace = $2', ['u-admin-01', 'TikTok Shop']);
        const tikTokConfig = configRes.rows[0];

        let allOrders = [];

        for (const store of stores.rows) {
             if (store.marketplace === 'TikTok Shop' && tikTokConfig) {
                 // Endpoint: POST /order/202309/orders/search
                 const result = await callTikTokAPI(
                    tikTokConfig.app_key,
                    tikTokConfig.app_secret,
                    store.access_token,
                    store.marketplace_shop_id,
                    '/order/202309/orders/search',
                    { 
                        page_size: 20,
                        sort_by: 'CREATE_TIME',
                        sort_type: 'DESC'
                    }
                );

                if (result && result.orders) {
                    await pool.query('UPDATE stores SET last_sync = NOW() WHERE id = $1', [store.id]);
                    
                    const mapped = result.orders.map(o => ({
                        id: o.id,
                        userId: req.query.userId,
                        storeId: store.id,
                        customerName: o.buyer_email || 'TikTok User', 
                        status: mapTikTokStatus(o.status),
                        total: parseFloat(o.payment_info.total_amount),
                        createdAt: new Date(parseInt(o.create_time)).toISOString().split('T')[0],
                        updatedAt: new Date(parseInt(o.update_time)).toISOString(),
                        items: o.line_items.map(item => ({
                            productId: item.product_id,
                            name: item.product_name,
                            quantity: 1, 
                            price: parseFloat(item.sale_price),
                            imageUrl: item.sku_image || ''
                        }))
                    }));
                    allOrders = [...allOrders, ...mapped];
                }
            }
        }
        res.json(allOrders);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const mapTikTokStatus = (status) => {
    const map = {
        'UNPAID': 'Unpaid',
        'AWAITING_SHIPMENT': 'Processing',
        'AWAITING_COLLECTION': 'Processing',
        'IN_TRANSIT': 'Shipped',
        'DELIVERED': 'Completed',
        'COMPLETED': 'Completed',
        'CANCELLED': 'Cancelled'
    };
    return map[status] || 'Processing';
};

app.get('/api/settings', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM marketplace_configs WHERE user_id = $1', [req.query.userId]);
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
            for (const [m, c] of Object.entries(settings)) {
                await client.query(`
                    INSERT INTO marketplace_configs (user_id, marketplace, app_key, app_secret, service_id, webhook_secret, api_url)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (user_id, marketplace) 
                    DO UPDATE SET app_key=EXCLUDED.app_key, app_secret=EXCLUDED.app_secret, service_id=EXCLUDED.service_id, webhook_secret=EXCLUDED.webhook_secret, api_url=EXCLUDED.api_url
                `, [userId, m, c.appKey, c.appSecret, c.serviceId, c.webhookSecret, c.apiUrl]);
            }
            await client.query('COMMIT');
            res.json({ success: true, message: "Cloud DB Updated" });
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/settings/test', async (req, res) => {
    res.json({ success: true, message: "Backend is reachable." });
});

app.listen(port, () => console.log(`OmniSeller API running on port ${port}`));