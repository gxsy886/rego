/**
 * Rego Backend - 单文件 Worker 🚀
 * 
 * 使用方式：
 * 1. 在 Cloudflare Dashboard 创建 Worker，复制粘贴此文件全部内容
 * 2. 在 Settings → Bindings 添加 D1 数据库（变量名: DB）
 * 3. 在 Settings → Environment Variables 添加 JWT_SECRET
 * 4. 访问 https://your-worker.workers.dev/__shujuku 自动初始化数据库
 * 
 * ⚡ 自动初始化：访问 /__shujuku 路由会自动创建所有表和默认管理员账户
 * 
 * ==================== 数据库 Schema ====================
 * 复制下面的 SQL 在 D1 Console 中执行：
 * 
 * -- 用户表
 * CREATE TABLE IF NOT EXISTS users (
 *     id INTEGER PRIMARY KEY AUTOINCREMENT,
 *     username TEXT UNIQUE NOT NULL,
 *     password TEXT NOT NULL,
 *     role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
 *     quota INTEGER DEFAULT 0,
 *     used INTEGER DEFAULT 0,
 *     created_at INTEGER NOT NULL,
 *     updated_at INTEGER NOT NULL
 * );
 * 
 * -- 兑换码表
 * CREATE TABLE IF NOT EXISTS redeem_codes (
 *     id INTEGER PRIMARY KEY AUTOINCREMENT,
 *     code TEXT UNIQUE NOT NULL,
 *     quota INTEGER NOT NULL,
 *     used BOOLEAN DEFAULT 0,
 *     used_by TEXT,
 *     used_at INTEGER,
 *     created_at INTEGER NOT NULL
 * );
 * 
 * -- 使用记录表
 * CREATE TABLE IF NOT EXISTS usage_logs (
 *     id INTEGER PRIMARY KEY AUTOINCREMENT,
 *     user_id INTEGER NOT NULL,
 *     action TEXT NOT NULL,
 *     details TEXT,
 *     ip_address TEXT,
 *     created_at INTEGER NOT NULL,
 *     FOREIGN KEY (user_id) REFERENCES users(id)
 * );
 * 
 * -- 历史记录表
 * CREATE TABLE IF NOT EXISTS history_records (
 *     id INTEGER PRIMARY KEY AUTOINCREMENT,
 *     user_id INTEGER NOT NULL,
 *     prompt TEXT NOT NULL,
 *     image_url TEXT NOT NULL,
 *     options TEXT,
 *     ref_images TEXT,
 *     created_at INTEGER NOT NULL,
 *     FOREIGN KEY (user_id) REFERENCES users(id)
 * );
 * 
 * -- 创建索引
 * CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
 * CREATE INDEX IF NOT EXISTS idx_codes_code ON redeem_codes(code);
 * CREATE INDEX IF NOT EXISTS idx_codes_used ON redeem_codes(used);
 * CREATE INDEX IF NOT EXISTS idx_logs_user ON usage_logs(user_id);
 * CREATE INDEX IF NOT EXISTS idx_history_user ON history_records(user_id);
 * CREATE INDEX IF NOT EXISTS idx_history_created ON history_records(created_at);
 * 
 * -- 插入默认管理员 (密码: admin)
 * INSERT OR IGNORE INTO users (username, password, role, quota, used, created_at, updated_at)
 * VALUES ('admin', '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918', 'admin', 9999, 0, 
 *         strftime('%s', 'now') * 1000, strftime('%s', 'now') * 1000);
 * 
 * ======================================================
 */

// ==================== JWT 工具 ====================
const JWT = {
    async sign(payload, secret) {
        const header = { alg: 'HS256', typ: 'JWT' };
        const encodedHeader = btoa(JSON.stringify(header));
        const encodedPayload = btoa(JSON.stringify(payload));
        const data = `${encodedHeader}.${encodedPayload}`;

        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
            'raw',
            encoder.encode(secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );

        const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
        const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)));

        return `${data}.${encodedSignature}`;
    },

    async verify(token, secret) {
        try {
            const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
            const data = `${encodedHeader}.${encodedPayload}`;

            const encoder = new TextEncoder();
            const key = await crypto.subtle.importKey(
                'raw',
                encoder.encode(secret),
                { name: 'HMAC', hash: 'SHA-256' },
                false,
                ['verify']
            );

            const signature = Uint8Array.from(atob(encodedSignature), c => c.charCodeAt(0));
            const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(data));

            if (!valid) return null;

            return JSON.parse(atob(encodedPayload));
        } catch (e) {
            return null;
        }
    }
};

// ==================== CORS 配置 ====================
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ==================== 响应助手 ====================
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
}

// ==================== 认证中间件 ====================
async function authenticate(request, env) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null;
    }

    const token = authHeader.substring(7);
    const payload = await JWT.verify(token, env.JWT_SECRET);

    return payload;
}

// ==================== 兑换码生成器 ====================
function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 16; i++) {
        if (i > 0 && i % 4 === 0) code += '-';
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// ==================== B2存储辅助函数 ====================
let B2_CACHE = { auth: null, exp: 0, bucketId: null, upload: null, uploadExp: 0 };

async function b2Authorize(env) {
    const now = Date.now();
    if (B2_CACHE.auth && now < B2_CACHE.exp) return B2_CACHE.auth;

    if (!env.B2_KEY_ID || !env.B2_APP_KEY) {
        throw new Error('Missing B2_KEY_ID / B2_APP_KEY');
    }

    const basic = btoa(`${env.B2_KEY_ID}:${env.B2_APP_KEY}`);
    const resp = await fetch('https://api.backblazeb2.com/b2api/v4/b2_authorize_account', {
        method: 'GET',
        headers: { Authorization: `Basic ${basic}` }
    });

    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`B2 authorize failed: ${resp.status}`);

    const storageApi = j?.apiInfo?.storageApi;
    const apiUrl = storageApi?.apiUrl || j?.apiUrl;
    if (!apiUrl) throw new Error('B2 authorize response missing apiUrl');

    const auth = {
        accountId: j.accountId,
        authorizationToken: j.authorizationToken,
        apiUrl,
        allowedBuckets: storageApi?.allowed?.buckets || []
    };

    B2_CACHE.auth = auth;
    B2_CACHE.exp = now + 23 * 60 * 60 * 1000;
    return auth;
}

async function b2ResolveBucketId(env, auth) {
    if (B2_CACHE.bucketId) return B2_CACHE.bucketId;

    // 从allowed buckets中查找
    if (Array.isArray(auth.allowedBuckets)) {
        const hit = auth.allowedBuckets.find(b => b?.name === env.B2_BUCKET_NAME);
        if (hit?.id) {
            B2_CACHE.bucketId = hit.id;
            return hit.id;
        }
    }

    // fallback: list_buckets
    const resp = await fetch(`${auth.apiUrl}/b2api/v4/b2_list_buckets`, {
        method: 'POST',
        headers: {
            'Authorization': auth.authorizationToken,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            accountId: auth.accountId,
            bucketName: env.B2_BUCKET_NAME
        })
    });

    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`B2 list_buckets failed: ${resp.status}`);

    const bucket = (j.buckets || [])[0];
    if (!bucket?.bucketId) throw new Error(`Bucket not found: ${env.B2_BUCKET_NAME}`);

    B2_CACHE.bucketId = bucket.bucketId;
    return bucket.bucketId;
}

async function b2GetUploadUrl(auth, bucketId) {
    const now = Date.now();
    if (B2_CACHE.upload && now < B2_CACHE.uploadExp) return B2_CACHE.upload;

    const u = new URL(`${auth.apiUrl}/b2api/v4/b2_get_upload_url`);
    u.searchParams.set('bucketId', bucketId);

    const resp = await fetch(u.toString(), {
        method: 'GET',
        headers: { 'Authorization': auth.authorizationToken }
    });

    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`B2 get_upload_url failed: ${resp.status}`);

    B2_CACHE.upload = { uploadUrl: j.uploadUrl, authorizationToken: j.authorizationToken };
    B2_CACHE.uploadExp = now + 30 * 60 * 1000;
    return B2_CACHE.upload;
}

function base64ToUint8Array(b64) {
    // 去除data URL前缀
    if (b64.startsWith('data:')) {
        const comma = b64.indexOf(',');
        if (comma > 0) b64 = b64.slice(comma + 1);
    }

    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
}

async function sha1Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-1', bytes);
    const arr = new Uint8Array(digest);
    let hex = '';
    for (const b of arr) hex += b.toString(16).padStart(2, '0');
    return hex;
}

function extFromMime(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.includes('png')) return 'png';
    if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
    if (m.includes('webp')) return 'webp';
    return 'bin';
}

function datePrefix(prefix) {
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${prefix}${y}/${m}/${day}`;
}

async function b2UploadFile(env, fileName, mimeType, bytes, sha1) {
    const auth = await b2Authorize(env);
    const bucketId = await b2ResolveBucketId(env, auth);
    let upload = await b2GetUploadUrl(auth, bucketId);

    const doUpload = async () => {
        const resp = await fetch(upload.uploadUrl, {
            method: 'POST',
            headers: {
                'Authorization': upload.authorizationToken,
                'X-Bz-File-Name': encodeURIComponent(fileName).replace(/%2F/g, '/'),
                'Content-Type': mimeType || 'b2/x-auto',
                'X-Bz-Content-Sha1': sha1
            },
            body: bytes
        });

        const j = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(`B2 upload failed: ${resp.status}`);
        return j;
    };

    try {
        return await doUpload();
    } catch (e) {
        // 刷新uploadUrl重试
        B2_CACHE.upload = null;
        upload = await b2GetUploadUrl(auth, bucketId);
        return await doUpload();
    }
}

// ==================== 主要 Worker ====================
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        // 处理 OPTIONS 请求
        if (method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        try {
            // ===== 数据库初始化 =====

            // 访问 /__shujuku 自动初始化数据库
            if (path === '/__shujuku') {
                try {
                    // 创建用户表
                    await env.DB.prepare(`
                        CREATE TABLE IF NOT EXISTS users (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            username TEXT UNIQUE NOT NULL,
                            password TEXT NOT NULL,
                            role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
                            quota INTEGER DEFAULT 0,
                            used INTEGER DEFAULT 0,
                            created_at INTEGER NOT NULL,
                            updated_at INTEGER NOT NULL
                        )
                    `).run();

                    // 创建兑换码表
                    await env.DB.prepare(`
                        CREATE TABLE IF NOT EXISTS redeem_codes (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            code TEXT UNIQUE NOT NULL,
                            quota INTEGER NOT NULL,
                            used BOOLEAN DEFAULT 0,
                            used_by TEXT,
                            used_at INTEGER,
                            created_at INTEGER NOT NULL
                        )
                    `).run();

                    // 创建使用记录表
                    await env.DB.prepare(`
                        CREATE TABLE IF NOT EXISTS usage_logs (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            user_id INTEGER NOT NULL,
                            action TEXT NOT NULL,
                            details TEXT,
                            ip_address TEXT,
                            created_at INTEGER NOT NULL,
                            FOREIGN KEY (user_id) REFERENCES users(id)
                        )
                    `).run();

                    // 创建历史记录表
                    await env.DB.prepare(`
                        CREATE TABLE IF NOT EXISTS history_records (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            user_id INTEGER NOT NULL,
                            prompt TEXT NOT NULL,
                            image_url TEXT NOT NULL,
                            options TEXT,
                            ref_images TEXT,
                            created_at INTEGER NOT NULL,
                            FOREIGN KEY (user_id) REFERENCES users(id)
                        )
                    `).run();

                    // 创建索引
                    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)').run();
                    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_codes_code ON redeem_codes(code)').run();
                    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_codes_used ON redeem_codes(used)').run();
                    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_logs_user ON usage_logs(user_id)').run();
                    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_history_user ON history_records(user_id)').run();
                    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_history_created ON history_records(created_at)').run();

                    // 插入默认管理员 (密码: admin)
                    const now = Date.now();
                    await env.DB.prepare(`
                        INSERT OR IGNORE INTO users (username, password, role, quota, used, created_at, updated_at)
                        VALUES ('admin', '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918', 'admin', 9999, 0, ?, ?)
                    `).bind(now, now).run();

                    return new Response(`
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <meta charset="UTF-8">
                            <title>数据库初始化成功</title>
                            <style>
                                body { font-family: Arial; max-width: 600px; margin: 100px auto; padding: 20px; }
                                .success { background: #d4edda; padding: 20px; border-radius: 8px; border: 1px solid #c3e6cb; }
                                h1 { color: #155724; }
                                code { background: #f8f9fa; padding: 2px 6px; border-radius: 3px; }
                                .info { margin-top: 20px; padding: 15px; background: #fff3cd; border-radius: 8px; }
                            </style>
                        </head>
                        <body>
                            <div class="success">
                                <h1>✅ 数据库初始化成功！</h1>
                                <p>所有表已创建：</p>
                                <ul>
                                    <li>users (用户表)</li>
                                    <li>redeem_codes (兑换码表)</li>
                                    <li>usage_logs (使用记录表)</li>
                                    <li>history_records (历史记录表)</li>
                                </ul>
                                <p>默认管理员账户：<code>admin</code> / <code>admin</code></p>
                            </div>
                            <div class="info">
                                <strong>⚠️ 安全提示：</strong>
                                <p>请立即修改默认管理员密码！</p>
                                <p>可以删除此初始化路由或限制访问。</p>
                            </div>
                        </body>
                        </html>
                    `, {
                        headers: { 'Content-Type': 'text/html; charset=utf-8' }
                    });

                } catch (error) {
                    return new Response(`
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <meta charset="UTF-8">
                            <title>数据库初始化失败</title>
                            <style>
                                body { font-family: Arial; max-width: 600px; margin: 100px auto; padding: 20px; }
                                .error { background: #f8d7da; padding: 20px; border-radius: 8px; border: 1px solid #f5c6cb; }
                                h1 { color: #721c24; }
                                pre { background: #f8f9fa; padding: 10px; overflow: auto; }
                            </style>
                        </head>
                        <body>
                            <div class="error">
                                <h1>❌ 数据库初始化失败</h1>
                                <p>错误信息：</p>
                                <pre>${error.message}</pre>
                                <p>请检查：</p>
                                <ul>
                                    <li>D1 数据库是否已创建</li>
                                    <li>D1 绑定是否正确 (变量名: DB)</li>
                                    <li>Worker 是否有数据库访问权限</li>
                                </ul>
                            </div>
                        </body>
                        </html>
                    `, {
                        status: 500,
                        headers: { 'Content-Type': 'text/html; charset=utf-8' }
                    });
                }
            }

            // ===== B2配置测试 =====

            // 测试B2配置是否正确
            if (path === '/__b2check') {
                try {
                    // 检查环境变量
                    if (!env.B2_KEY_ID || !env.B2_APP_KEY || !env.B2_BUCKET_NAME) {
                        return jsonResponse({
                            ok: false,
                            error: 'Missing B2 environment variables',
                            missing: {
                                B2_KEY_ID: !env.B2_KEY_ID,
                                B2_APP_KEY: !env.B2_APP_KEY,
                                B2_BUCKET_NAME: !env.B2_BUCKET_NAME,
                                IMG_RETURN_BASE: !env.IMG_RETURN_BASE
                            }
                        }, 400);
                    }

                    // 尝试认证B2
                    const auth = await b2Authorize(env);
                    const bucketId = await b2ResolveBucketId(env, auth);
                    const upload = await b2GetUploadUrl(auth, bucketId);

                    return jsonResponse({
                        ok: true,
                        message: 'B2 configuration is valid',
                        details: {
                            apiUrl: auth.apiUrl,
                            bucketId: bucketId,
                            uploadUrl: upload.uploadUrl ? 'OK' : 'Failed',
                            imgReturnBase: env.IMG_RETURN_BASE || 'Not set'
                        }
                    }, 200);
                } catch (e) {
                    return jsonResponse({
                        ok: false,
                        error: String(e),
                        hint: '请检查B2环境变量是否正确配置'
                    }, 500);
                }
            }

            // ===== 认证 API =====

            // 用户登录
            if (path === '/api/auth/login' && method === 'POST') {
                const { username, password } = await request.json();

                const user = await env.DB.prepare(
                    'SELECT * FROM users WHERE username = ?'
                ).bind(username).first();

                if (!user || user.password !== password) {
                    return jsonResponse({ error: '用户名或密码错误' }, 401);
                }

                const token = await JWT.sign({
                    id: user.id,
                    username: user.username,
                    role: user.role
                }, env.JWT_SECRET);

                await env.DB.prepare(
                    'INSERT INTO usage_logs (user_id, action, created_at) VALUES (?, ?, ?)'
                ).bind(user.id, 'login', Date.now()).run();

                return jsonResponse({
                    token,
                    user: {
                        id: user.id,
                        username: user.username,
                        role: user.role,
                        quota: user.quota,
                        used: user.used
                    }
                });
            }

            // 获取当前用户信息
            if (path === '/api/auth/me' && method === 'GET') {
                const payload = await authenticate(request, env);
                if (!payload) {
                    return jsonResponse({ error: '未授权' }, 401);
                }

                const user = await env.DB.prepare(
                    'SELECT id, username, role, quota, used FROM users WHERE id = ?'
                ).bind(payload.id).first();

                return jsonResponse({ user });
            }

            // ===== 用户管理 API (需要管理员权限) =====

            // 获取用户列表
            if (path === '/api/users' && method === 'GET') {
                const payload = await authenticate(request, env);
                if (!payload || payload.role !== 'admin') {
                    return jsonResponse({ error: '权限不足' }, 403);
                }

                const users = await env.DB.prepare(
                    'SELECT id, username, role, quota, used, created_at FROM users'
                ).all();

                return jsonResponse({ users: users.results });
            }

            // 创建用户
            if (path === '/api/users' && method === 'POST') {
                const payload = await authenticate(request, env);
                if (!payload || payload.role !== 'admin') {
                    return jsonResponse({ error: '权限不足' }, 403);
                }

                const { username, password, role, quota } = await request.json();

                const now = Date.now();
                const result = await env.DB.prepare(
                    'INSERT INTO users (username, password, role, quota, used, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)'
                ).bind(username, password, role, quota, now, now).run();

                return jsonResponse({ success: true, id: result.meta.last_row_id });
            }

            // 更新用户
            if (path.startsWith('/api/users/') && method === 'PUT') {
                const payload = await authenticate(request, env);
                if (!payload || payload.role !== 'admin') {
                    return jsonResponse({ error: '权限不足' }, 403);
                }

                const userId = path.split('/')[3];
                const { quota, password } = await request.json();

                let query = 'UPDATE users SET updated_at = ?';
                const params = [Date.now()];

                if (quota !== undefined) {
                    query += ', quota = ?';
                    params.push(quota);
                }

                if (password) {
                    query += ', password = ?';
                    params.push(password);
                }

                query += ' WHERE id = ?';
                params.push(userId);

                await env.DB.prepare(query).bind(...params).run();

                return jsonResponse({ success: true });
            }

            // 删除用户
            if (path.startsWith('/api/users/') && method === 'DELETE') {
                const payload = await authenticate(request, env);
                if (!payload || payload.role !== 'admin') {
                    return jsonResponse({ error: '权限不足' }, 403);
                }

                const userId = path.split('/')[3];
                await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();

                return jsonResponse({ success: true });
            }

            // ===== 配额管理 API =====

            // 获取配额
            if (path === '/api/quota' && method === 'GET') {
                const payload = await authenticate(request, env);
                if (!payload) {
                    return jsonResponse({ error: '未授权' }, 401);
                }

                const user = await env.DB.prepare(
                    'SELECT quota, used FROM users WHERE id = ?'
                ).bind(payload.id).first();

                return jsonResponse({
                    quota: user.quota,
                    used: user.used,
                    remaining: user.quota - user.used
                });
            }

            // 消费配额
            if (path === '/api/quota/consume' && method === 'PUT') {
                const payload = await authenticate(request, env);
                if (!payload) {
                    return jsonResponse({ error: '未授权' }, 401);
                }

                const { count = 1 } = await request.json();

                const user = await env.DB.prepare(
                    'SELECT quota, used FROM users WHERE id = ?'
                ).bind(payload.id).first();

                if (user.quota - user.used < count) {
                    return jsonResponse({ error: '配额不足' }, 400);
                }

                await env.DB.prepare(
                    'UPDATE users SET used = used + ?, updated_at = ? WHERE id = ?'
                ).bind(count, Date.now(), payload.id).run();

                await env.DB.prepare(
                    'INSERT INTO usage_logs (user_id, action, details, created_at) VALUES (?, ?, ?, ?)'
                ).bind(payload.id, 'consume_quota', `count: ${count}`, Date.now()).run();

                return jsonResponse({
                    success: true,
                    remaining: user.quota - user.used - count
                });
            }

            // ===== 兑换码 API =====

            // 兑换码兑换
            if (path === '/api/redeem' && method === 'POST') {
                const payload = await authenticate(request, env);
                if (!payload) {
                    return jsonResponse({ error: '未授权' }, 401);
                }

                const { code } = await request.json();

                const redeemCode = await env.DB.prepare(
                    'SELECT * FROM redeem_codes WHERE code = ? AND used = 0'
                ).bind(code).first();

                if (!redeemCode) {
                    return jsonResponse({ error: '兑换码无效或已使用' }, 400);
                }

                await env.DB.prepare(
                    'UPDATE redeem_codes SET used = 1, used_by = ?, used_at = ? WHERE id = ?'
                ).bind(payload.username, Date.now(), redeemCode.id).run();

                await env.DB.prepare(
                    'UPDATE users SET quota = quota + ?, updated_at = ? WHERE id = ?'
                ).bind(redeemCode.quota, Date.now(), payload.id).run();

                await env.DB.prepare(
                    'INSERT INTO usage_logs (user_id, action, details, created_at) VALUES (?, ?, ?, ?)'
                ).bind(payload.id, 'redeem_code', `code: ${code}, quota: ${redeemCode.quota}`, Date.now()).run();

                return jsonResponse({
                    success: true,
                    quota: redeemCode.quota
                });
            }

            // 获取兑换码列表 (管理员)
            if (path === '/api/codes' && method === 'GET') {
                const payload = await authenticate(request, env);
                if (!payload || payload.role !== 'admin') {
                    return jsonResponse({ error: '权限不足' }, 403);
                }

                const codes = await env.DB.prepare(
                    'SELECT * FROM redeem_codes ORDER BY created_at DESC'
                ).all();

                return jsonResponse({ codes: codes.results });
            }

            // 生成兑换码 (管理员)
            if (path === '/api/codes' && method === 'POST') {
                const payload = await authenticate(request, env);
                if (!payload || payload.role !== 'admin') {
                    return jsonResponse({ error: '权限不足' }, 403);
                }

                const { count, quota } = await request.json();
                const now = Date.now();
                const codes = [];

                for (let i = 0; i < count; i++) {
                    const code = generateCode();
                    await env.DB.prepare(
                        'INSERT INTO redeem_codes (code, quota, used, created_at) VALUES (?, ?, 0, ?)'
                    ).bind(code, quota, now).run();
                    codes.push(code);
                }

                return jsonResponse({ success: true, codes });
            }

            // ===== 历史记录 API =====

            // 获取用户历史记录
            if (path === '/api/history' && method === 'GET') {
                const payload = await authenticate(request, env);
                if (!payload) {
                    return jsonResponse({ error: '未授权' }, 401);
                }

                const limit = parseInt(url.searchParams.get('limit')) || 50;
                const offset = parseInt(url.searchParams.get('offset')) || 0;

                const history = await env.DB.prepare(
                    'SELECT * FROM history_records WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
                ).bind(payload.id, limit, offset).all();

                // 解析JSON字段
                const records = history.results.map(record => ({
                    ...record,
                    options: record.options ? JSON.parse(record.options) : null,
                    ref_images: record.ref_images ? JSON.parse(record.ref_images) : []
                }));

                return jsonResponse({ history: records });
            }

            // 保存历史记录
            if (path === '/api/history' && method === 'POST') {
                const payload = await authenticate(request, env);
                if (!payload) {
                    return jsonResponse({ error: '未授权' }, 401);
                }

                const { prompt, image_url, options, ref_images } = await request.json();

                await env.DB.prepare(
                    'INSERT INTO history_records (user_id, prompt, image_url, options, ref_images, created_at) VALUES (?, ?, ?, ?, ?, ?)'
                ).bind(
                    payload.id,
                    prompt,
                    image_url,
                    JSON.stringify(options || {}),
                    JSON.stringify(ref_images || []),
                    Date.now()
                ).run();

                return jsonResponse({ success: true });
            }

            // 删除历史记录
            if (path.startsWith('/api/history/') && method === 'DELETE') {
                const payload = await authenticate(request, env);
                if (!payload) {
                    return jsonResponse({ error: '未授权' }, 401);
                }

                const historyId = path.split('/')[3];

                // 确保只能删除自己的历史记录
                await env.DB.prepare(
                    'DELETE FROM history_records WHERE id = ? AND user_id = ?'
                ).bind(historyId, payload.id).run();

                return jsonResponse({ success: true });
            }

            // ===== B2图片上传 API =====

            // 上传参考图到B2
            if (path === '/api/upload/image' && method === 'POST') {
                const payload = await authenticate(request, env);
                if (!payload) {
                    return jsonResponse({ error: '未授权' }, 401);
                }

                try {
                    const { image, mimeType } = await request.json();

                    if (!image) {
                        return jsonResponse({ error: '缺少图片数据' }, 400);
                    }

                    // 转换base64到bytes
                    const bytes = base64ToUint8Array(image);
                    const sha1 = await sha1Hex(bytes);

                    // 生成文件名: cankaotu/YYYY/MM/DD/uuid.ext
                    const ext = extFromMime(mimeType);
                    const fileName = `${datePrefix('cankaotu/')}/${crypto.randomUUID()}.${ext}`;

                    // 上传到B2
                    await b2UploadFile(env, fileName, mimeType, bytes, sha1);

                    // 返回公开访问URL
                    const imgBase = env.IMG_RETURN_BASE || 'https://your-domain.com';
                    const url = `${imgBase}/i/${fileName}`;

                    return jsonResponse({
                        success: true,
                        url,
                        fileName,
                        size: bytes.byteLength
                    });
                } catch (error) {
                    console.error('Upload error:', error);
                    return jsonResponse({ error: error.message }, 500);
                }
            }

            return jsonResponse({ error: 'Not Found' }, 404);

        } catch (error) {
            console.error('API Error:', error);
            return jsonResponse({ error: error.message }, 500);
        }
    }
};
