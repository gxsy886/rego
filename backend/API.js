export default {
    async fetch(request, env, ctx) {
        const origin = request.headers.get("Origin") || "*";
        const url = new URL(request.url);

        if (request.method === "OPTIONS") {
            return withCors(new Response(null, { status: 204 }), origin);
        }

        if (url.pathname === "/__health") {
            return withCors(new Response("ok", { status: 200 }), origin);
        }

        if (url.pathname === "/__b2check") {
            try {
                const b2 = await b2Preflight(env);
                return json({ ok: true, b2 }, 200, origin);
            } catch (e) {
                return json({ ok: false, error: String(e) }, 500, origin);
            }
        }

        if (url.pathname === "/__vertexcheck") {
            try {
                const info = await vertexPreflight(env);
                return json({ ok: true, vertex: info }, 200, origin);
            } catch (e) {
                return json({ ok: false, error: String(e) }, 500, origin);
            }
        }

        // Task status query endpoint
        if (url.pathname.startsWith("/task/")) {
            const taskId = url.pathname.split("/")[2];
            if (!taskId) {
                return json({ error: "MISSING_TASK_ID" }, 400, origin);
            }

            try {
                const taskData = await env.TASKS.get(`task:${taskId}`, { type: "json" });
                if (!taskData) {
                    return json({ error: "TASK_NOT_FOUND", taskId }, 404, origin);
                }
                return json(taskData, 200, origin);
            } catch (e) {
                return json({ error: "TASK_QUERY_FAILED", message: String(e) }, 500, origin);
            }
        }

        if (url.pathname !== "/generate") {
            return json({ error: "NOT_FOUND", message: "Use POST /generate" }, 404, origin);
        }

        if (request.method !== "POST") {
            return json({ error: "METHOD_NOT_ALLOWED", message: "Use POST /generate" }, 405, origin);
        }

        // stop-loss: B2
        let b2;
        try {
            b2 = await b2Preflight(env);
        } catch (e) {
            return json(
                {
                    error: "B2_PRECHECK_FAILED",
                    message: String(e),
                    hint: "先访问 /__b2check 修好 B2，再请求生成，避免扣费后无法上传。",
                },
                500,
                origin
            );
        }

        // stop-loss: Vertex
        try {
            await vertexPreflight(env);
        } catch (e) {
            return json(
                {
                    error: "VERTEX_PRECHECK_FAILED",
                    message: String(e),
                    hint: "先访问 /__vertexcheck 修好 Vertex/服务账户，再请求生成。",
                },
                500,
                origin
            );
        }

        let input;
        try {
            input = await request.json();
        } catch {
            return json({ error: "BAD_JSON", message: "Request body must be JSON." }, 400, origin);
        }

        const prompt = String(input?.prompt || "").trim();
        if (!prompt) {
            return json({ error: "MISSING_PROMPT", message: "Field `prompt` is required." }, 400, origin);
        }

        const aspectRatio = String(input?.aspectRatio || "1:1").trim();
        const imageSize = String(input?.imageSize || "4K").trim().toUpperCase();
        const outMime = "image/png";

        // Generate unique task ID
        const taskId = crypto.randomUUID();
        const now = Date.now();

        // Initialize task in KV with 25% progress
        const initialTask = {
            taskId,
            status: "pending",
            progress: 25,
            prompt,
            options: { aspectRatio, imageSize },
            refImages: input?.images || [],
            result: null,
            error: null,
            createdAt: now,
            updatedAt: now
        };

        // Save to KV with 24-hour expiration
        await env.TASKS.put(`task:${taskId}`, JSON.stringify(initialTask), {
            expirationTtl: 86400 // 24 hours
        });

        // Start async generation in background
        ctx.waitUntil(executeGenerationTask(taskId, prompt, aspectRatio, imageSize, outMime, input?.images, env, b2));

        // Immediately return task ID and initial progress
        return json({ taskId, status: "pending", progress: 25 }, 202, origin);
    },
};

// ================ Async Task Execution ================
async function executeGenerationTask(taskId, prompt, aspectRatio, imageSize, outMime, images, env, b2) {
    const updateTask = async (updates) => {
        try {
            const existing = await env.TASKS.get(`task:${taskId}`, { type: "json" });
            if (!existing) return;

            const updated = { ...existing, ...updates, updatedAt: Date.now() };
            await env.TASKS.put(`task:${taskId}`, JSON.stringify(updated), {
                expirationTtl: 86400
            });
        } catch (e) {
            console.error(`Failed to update task ${taskId}:`, e);
        }
    };

    try {
        // Update status to processing
        await updateTask({ status: "processing", progress: 25 });

        // Process reference images (25% -> 50%)
        const imagesList = Array.isArray(images) ? images.slice(0, 2) : [];
        let img1 = null;
        let img2 = null;

        try {
            img1 = await normalizeIncomingImageAny(imagesList[0], env);
            img2 = await normalizeIncomingImageAny(imagesList[1], env);
        } catch (e) {
            await updateTask({
                status: "failed",
                progress: 25,
                error: `REF_IMAGE_INVALID: ${String(e)}`
            });
            return;
        }

        // Reference images processed, ready to call Vertex
        await updateTask({ progress: 50 });

        // Build Vertex request
        const parts = [];
        const systemish = [
            "You are an image generation model. Follow constraints strictly.",
            `Output image format: PNG (mimeType=${outMime}).`,
            `Aspect ratio: ${aspectRatio}.`,
            `Image size: ${imageSize}.`,
            "If reference images are provided, treat them as:",
            "- Image #1 (图一): the first reference image in the request",
            "- Image #2 (图二): the second reference image in the request",
            "Keep their roles distinct and do not swap them.",
            "Return both TEXT and IMAGE.",
        ].join("\n");

        parts.push({ text: `${systemish}\n\nUser prompt:\n${prompt}` });

        if (img1) {
            parts.push({ text: "Reference Image #1 (图一) below:" });
            parts.push({ inlineData: { mimeType: img1.mimeType, data: img1.data } });
        }
        if (img2) {
            parts.push({ text: "Reference Image #2 (图二) below:" });
            parts.push({ inlineData: { mimeType: img2.mimeType, data: img2.data } });
        }

        const projectId = pickProjectId(env);
        const location = String(env.VERTEX_LOCATION || "global").trim();
        const model = String(env.VERTEX_MODEL || "gemini-3-pro-image-preview").trim();
        const endpointHost = resolveVertexHost(env, location);

        const vertexUrl =
            `https://${endpointHost}/v1/projects/${encodeURIComponent(projectId)}` +
            `/locations/${encodeURIComponent(location)}` +
            `/publishers/google/models/${encodeURIComponent(model)}:generateContent`;

        const accessToken = await getGoogleAccessToken(env);

        const vertexReqBody = {
            contents: [{ role: "user", parts }],
            generationConfig: {
                responseModalities: ["TEXT", "IMAGE"],
                imageConfig: {
                    aspectRatio,
                    imageSize,
                    imageOutputOptions: { mimeType: outMime },
                },
                candidateCount: 1,
            },
        };

        // Call Vertex AI
        const upstreamResp = await fetch(vertexUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify(vertexReqBody),
        });

        const ct = upstreamResp.headers.get("content-type") || "";
        const rawText = await upstreamResp.text();

        if (!upstreamResp.ok) {
            await updateTask({
                status: "failed",
                progress: 50,
                error: `VERTEX_CALL_FAILED: ${upstreamResp.status} ${safeTruncate(rawText, 500)}`
            });
            return;
        }

        let data;
        try {
            data = ct.includes("application/json") ? JSON.parse(rawText) : null;
        } catch {
            data = null;
        }

        if (!data) {
            await updateTask({
                status: "failed",
                progress: 50,
                error: "VERTEX_NON_JSON"
            });
            return;
        }

        // Vertex responded, now upload to B2 (50% -> 75%)
        await updateTask({ progress: 75 });

        const partsOut = collectInlineParts(data);
        if (partsOut.length === 0) {
            await updateTask({
                status: "failed",
                progress: 75,
                error: "NO_IMAGE_IN_RESPONSE"
            });
            return;
        }

        const maxImages = Math.max(1, parseInt(env.MAX_IMAGES_PER_RESPONSE || "1", 10));
        const keyPrefix = env.KEY_PREFIX && env.KEY_PREFIX.length > 0 ? env.KEY_PREFIX : "gemini/";
        const imgBase = normalizeBase(env.IMG_RETURN_BASE);

        const urls = [];
        let processed = 0;

        for (const p of partsOut) {
            if (processed >= maxImages) break;

            const inline = p.inlineData ?? p.inline_data;
            if (!inline) continue;

            let b64 = inline.data;
            const mimeType = inline.mimeType || inline.mime_type || "application/octet-stream";
            if (typeof b64 !== "string" || b64.length < 16) continue;

            if (b64.startsWith("data:")) {
                const parsed = parseDataUrl(b64);
                if (parsed?.data) b64 = parsed.data;
            }

            const ext = extFromMime(mimeType);
            const key = `${datePrefix(keyPrefix)}/${crypto.randomUUID()}.${ext}`;
            const publicUrl = `${imgBase}/i/${key}`;

            try {
                const bytes = base64ToUint8ArrayChunked(b64);
                const sha1 = await sha1Hex(bytes);
                await b2UploadFile(env, b2, key, mimeType, bytes, sha1);
                urls.push(publicUrl);
                delete inline.data;
                processed++;
            } catch (e) {
                console.error("B2 upload error:", e);
            }
        }

        if (urls.length === 0) {
            await updateTask({
                status: "failed",
                progress: 75,
                error: "UPLOAD_FAILED: No image uploaded to B2"
            });
            return;
        }

        // Success! Update to 100%
        await updateTask({
            status: "completed",
            progress: 100,
            result: {
                url: urls[0],
                urls: urls.length > 1 ? urls : undefined
            }
        });

    } catch (error) {
        // Unexpected error
        await updateTask({
            status: "failed",
            error: String(error)
        });
    }
}

// ---------------- CORS/JSON helpers ----------------
function withCors(resp, origin) {
    const h = new Headers(resp.headers);
    h.set("Access-Control-Allow-Origin", origin || "*");
    h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    h.set("Access-Control-Expose-Headers", "Content-Type");
    h.set("Vary", "Origin");
    return new Response(resp.body, { status: resp.status, headers: h });
}

function json(obj, status, origin) {
    return withCors(
        new Response(JSON.stringify(obj), {
            status,
            headers: { "Content-Type": "application/json; charset=utf-8" },
        }),
        origin
    );
}

function normalizeBase(base) {
    let b = String(base || "").trim().replace(/\/+$/, "");
    if (!b) return "";
    if (!b.startsWith("http://") && !b.startsWith("https://")) b = "https://" + b;
    return b;
}

function safeTruncate(s, n) {
    const str = String(s || "");
    return str.length > n ? str.slice(0, n) + "...(truncated)" : str;
}

// ---------------- Reference image normalize (URL -> base64) ----------------
async function normalizeIncomingImageAny(x, env) {
    if (!x) return null;

    if (typeof x === "string") {
        return await normalizeByUrlOrDataUrl(x, env, null);
    }

    const forcedMimeType = x.mimeType ?? x.mime_type ?? x.mimetype;

    const u = x.uri ?? x.url ?? x.href;
    if (typeof u === "string" && u.trim()) {
        return await normalizeByUrlOrDataUrl(u, env, forcedMimeType);
    }

    const data = x.data ?? x.base64;
    if (typeof data === "string" && data.trim().length >= 16) {
        if (/^https?:\/\//i.test(data.trim())) {
            return await normalizeByUrlOrDataUrl(data.trim(), env, forcedMimeType);
        }
        return normalizeIncomingImageBase64({ data, mimeType: forcedMimeType });
    }

    return null;
}

async function normalizeByUrlOrDataUrl(urlOrDataUrl, env, forcedMimeType) {
    const s = String(urlOrDataUrl || "").trim();
    if (!s) return null;

    if (s.startsWith("data:")) {
        const parsed = parseDataUrl(s);
        if (!parsed) throw new Error("BAD_DATA_URL");
        return {
            mimeType: String(forcedMimeType || parsed.mimeType || "image/png").toLowerCase(),
            data: parsed.data,
        };
    }

    return await fetchImageAsInlineData(s, env, forcedMimeType);
}

function normalizeIncomingImageBase64(x) {
    let data = String(x?.data || "");
    if (data.startsWith("data:")) {
        const parsed = parseDataUrl(data);
        if (!parsed) return null;
        return {
            mimeType: String(x.mimeType || parsed.mimeType || "image/png").toLowerCase(),
            data: parsed.data,
        };
    }
    if (/^https?:\/\//i.test(data.trim())) throw new Error("BASE64_FIELD_CONTAINS_URL");
    const mimeType = String(x?.mimeType || "image/png").toLowerCase();
    return { mimeType, data };
}

function parseDataUrl(s) {
    const comma = s.indexOf(",");
    if (comma < 0) return null;
    const meta = s.slice(5, comma);
    const data = s.slice(comma + 1);
    if (!/;base64/i.test(meta)) return null;
    const mimeType = (meta.split(";")[0] || "application/octet-stream").toLowerCase();
    return { mimeType, data };
}

async function fetchImageAsInlineData(url, env, forcedMimeType) {
    const u = sanitizeHttpUrl(url, env);

    // 可选：域名白名单（你不配则不检查）
    const allow = String(env.ALLOW_REF_IMAGE_HOSTS || "").trim();
    if (allow) {
        const allowSet = new Set(allow.split("|").map(s => s.trim()).filter(Boolean));
        if (!allowSet.has(u.hostname)) {
            throw new Error(`REF_IMAGE_HOST_NOT_ALLOWED: ${u.hostname}`);
        }
    }

    const resp = await fetch(u.toString(), { method: "GET", redirect: "follow" });
    if (!resp.ok) throw new Error(`REF_IMAGE_FETCH_FAILED: ${resp.status}`);

    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    const mimeType = String(forcedMimeType || ct.split(";")[0] || "").trim();
    if (!mimeType.startsWith("image/")) {
        throw new Error(`REF_IMAGE_BAD_CONTENT_TYPE: ${mimeType || "(missing)"}`);
    }

    // ✅ 已去除大小限制：MAX_REF_IMAGE_BYTES <= 0 或未设置 => 不限制
    const rawLimit = parseInt(env.MAX_REF_IMAGE_BYTES || "0", 10);
    const maxBytes = isFinite(rawLimit) ? rawLimit : 0;

    if (maxBytes > 0) {
        const len = parseInt(resp.headers.get("content-length") || "0", 10);
        if (len && len > maxBytes) throw new Error(`REF_IMAGE_TOO_LARGE: ${len} > ${maxBytes}`);
    }

    const ab = await resp.arrayBuffer();

    if (maxBytes > 0 && ab.byteLength > maxBytes) {
        throw new Error(`REF_IMAGE_TOO_LARGE: ${ab.byteLength} > ${maxBytes}`);
    }

    const b64 = uint8ToBase64(new Uint8Array(ab));
    return { mimeType, data: b64 };
}

function sanitizeHttpUrl(url, env) {
    const s = String(url || "").trim();
    let u;
    try {
        u = new URL(s);
    } catch {
        throw new Error("REF_IMAGE_BAD_URL");
    }

    const allowHttp = String(env.ALLOW_REF_IMAGE_HTTP || "").trim() === "1";
    if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) {
        throw new Error(`REF_IMAGE_PROTOCOL_NOT_ALLOWED: ${u.protocol}`);
    }
    return u;
}

function uint8ToBase64(u8) {
    let s = "";
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
        s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(s);
}

// ---------------- Gemini inlineData extractor ----------------
function collectInlineParts(data) {
    const out = [];
    const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
    for (const c of candidates) {
        const parts = c?.content?.parts;
        if (!Array.isArray(parts)) continue;
        for (const p of parts) {
            const inline = p?.inlineData ?? p?.inline_data;
            if (inline?.data) out.push(p);
        }
    }
    return out;
}

// ---------------- base64/sha1 ----------------
function base64ToUint8ArrayChunked(b64) {
    let padding = 0;
    if (b64.endsWith("==")) padding = 2;
    else if (b64.endsWith("=")) padding = 1;
    const outLen = Math.floor((b64.length * 3) / 4) - padding;

    const out = new Uint8Array(outLen);
    const chunkChars = 4 * 16384;
    let outOffset = 0;

    for (let i = 0; i < b64.length; i += chunkChars) {
        let end = Math.min(i + chunkChars, b64.length);
        if (end < b64.length) {
            const mod = (end - i) % 4;
            if (mod !== 0) end -= mod;
        }
        const chunk = b64.slice(i, end);
        const bin = atob(chunk);
        for (let j = 0; j < bin.length; j++) out[outOffset++] = bin.charCodeAt(j);
    }
    return out;
}

async function sha1Hex(bytes) {
    const digest = await crypto.subtle.digest("SHA-1", bytes);
    const arr = new Uint8Array(digest);
    let hex = "";
    for (const b of arr) hex += b.toString(16).padStart(2, "0");
    return hex;
}

function extFromMime(mime) {
    const m = String(mime || "").toLowerCase();
    if (m.includes("png")) return "png";
    if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
    if (m.includes("webp")) return "webp";
    return "bin";
}

function datePrefix(prefix) {
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${prefix}${y}/${m}/${day}`;
}

// ---------------- Vertex (Service Account -> OAuth token) ----------------
let VERTEX_CACHE = { token: null, exp: 0 };
let ROUTER = { idx: 0 };

function pickProjectId(env) {
    const raw = String(env.VERTEX_PROJECT_IDS || "").trim();
    const list = raw ? raw.split("|").map(s => s.trim()).filter(Boolean) : [];
    if (!list.length) throw new Error("Missing env: VERTEX_PROJECT_IDS (use p1|p2|p3)");

    // 每次调用都轮询到下一个项目，无论成功或失败
    // 这样可以避免单个项目配额用完影响所有请求
    const i = (ROUTER.idx % list.length + list.length) % list.length;
    ROUTER.idx++; // 立即递增，确保下次使用不同项目

    return list[i];
}

function resolveVertexHost(env, location) {
    const mode = String(env.VERTEX_ENDPOINT_MODE || "").trim().toLowerCase();
    if (mode === "global" || location === "global") return "aiplatform.googleapis.com";
    return `${location}-aiplatform.googleapis.com`;
}

async function vertexPreflight(env) {
    if (!env.VERTEX_PROJECT_IDS) throw new Error("Missing env: VERTEX_PROJECT_IDS");
    if (!env.VERTEX_LOCATION) throw new Error("Missing env: VERTEX_LOCATION (recommend global)");
    if (!env.VERTEX_MODEL) throw new Error("Missing env: VERTEX_MODEL");

    const sa = readServiceAccount(env);
    if (!sa.client_email) throw new Error("Service account missing client_email");
    if (!sa.private_key) throw new Error("Service account missing private_key");

    const token = await getGoogleAccessToken(env);
    return {
        projectExample: pickProjectId(env),
        location: String(env.VERTEX_LOCATION),
        endpointHost: resolveVertexHost(env, String(env.VERTEX_LOCATION)),
        model: String(env.VERTEX_MODEL),
        tokenOk: !!token,
    };
}

function readServiceAccount(env) {
    const rawJson = env.GCP_SERVICE_ACCOUNT_JSON;
    if (rawJson) {
        const j = JSON.parse(String(rawJson));
        return {
            client_email: j.client_email,
            private_key: j.private_key,
            token_uri: j.token_uri || "https://oauth2.googleapis.com/token",
        };
    }
    return {
        client_email: String(env.GCP_SA_CLIENT_EMAIL || ""),
        private_key: String(env.GCP_SA_PRIVATE_KEY || ""),
        token_uri: String(env.GCP_TOKEN_URI || "https://oauth2.googleapis.com/token"),
    };
}

async function getGoogleAccessToken(env) {
    const now = Math.floor(Date.now() / 1000);
    if (VERTEX_CACHE.token && now < VERTEX_CACHE.exp - 60) return VERTEX_CACHE.token;

    const sa = readServiceAccount(env);
    const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";

    const iat = now;
    const exp = now + 3600;

    const header = { alg: "RS256", typ: "JWT" };
    const claim = {
        iss: sa.client_email,
        scope: "https://www.googleapis.com/auth/cloud-platform",
        aud: tokenUri,
        iat,
        exp,
    };

    const enc = new TextEncoder();
    const jwtUnsigned =
        base64url(enc.encode(JSON.stringify(header))) +
        "." +
        base64url(enc.encode(JSON.stringify(claim)));

    const key = await importPrivateKey(sa.private_key);
    const sig = await crypto.subtle.sign(
        { name: "RSASSA-PKCS1-v1_5" },
        key,
        enc.encode(jwtUnsigned)
    );

    const assertion = jwtUnsigned + "." + base64url(new Uint8Array(sig));

    const resp = await fetch(tokenUri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:
            "grant_type=" +
            encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
            "&assertion=" +
            encodeURIComponent(assertion),
    });

    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`oauth_token_failed: ${resp.status} ${JSON.stringify(j)}`);

    VERTEX_CACHE.token = j.access_token;
    VERTEX_CACHE.exp = now + (j.expires_in || 3600);
    return VERTEX_CACHE.token;
}

async function importPrivateKey(pem) {
    const pkcs8 = pemToArrayBuffer(pem);
    return crypto.subtle.importKey(
        "pkcs8",
        pkcs8,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"]
    );
}

function pemToArrayBuffer(pem) {
    const b64 = String(pem)
        .replace(/-----BEGIN PRIVATE KEY-----/g, "")
        .replace(/-----END PRIVATE KEY-----/g, "")
        .replace(/\s+/g, "");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
}

function base64url(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    const b64 = btoa(s);
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// ---------------- B2 Native API v4 ----------------
let CACHE = { auth: null, exp: 0, bucketId: null, upload: null, uploadExp: 0 };

async function b2Preflight(env) {
    if (!env.IMG_RETURN_BASE) throw new Error("Missing env: IMG_RETURN_BASE");
    if (!env.B2_KEY_ID || !env.B2_APP_KEY || !env.B2_BUCKET_NAME) {
        throw new Error("Missing B2 env: B2_KEY_ID / B2_APP_KEY / B2_BUCKET_NAME");
    }
    const auth = await b2Authorize(env);
    const bucketId = await b2ResolveBucketId(env, auth);
    const upload = await b2GetUploadUrl(auth, bucketId);
    return { apiUrl: auth.apiUrl, bucketId, uploadUrl: upload.uploadUrl };
}

async function b2Authorize(env) {
    const now = Date.now();
    if (CACHE.auth && now < CACHE.exp) return CACHE.auth;

    const basic = btoa(`${env.B2_KEY_ID}:${env.B2_APP_KEY}`);
    const resp = await fetch("https://api.backblazeb2.com/b2api/v4/b2_authorize_account", {
        method: "GET",
        headers: { Authorization: `Basic ${basic}` },
    });

    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`b2_authorize_account failed: ${resp.status} ${JSON.stringify(j)}`);

    const storageApi = j?.apiInfo?.storageApi;
    const apiUrl = storageApi?.apiUrl;
    if (!apiUrl) throw new Error(`authorize response missing apiUrl: ${JSON.stringify(j)}`);

    const auth = {
        accountId: j.accountId,
        authorizationToken: j.authorizationToken,
        apiUrl,
        allowedBuckets: storageApi?.allowed?.buckets || [],
    };

    CACHE.auth = auth;
    CACHE.exp = now + 23 * 60 * 60 * 1000;
    CACHE.bucketId = null;
    CACHE.upload = null;
    return auth;
}

async function b2ResolveBucketId(env, auth) {
    if (CACHE.bucketId) return CACHE.bucketId;

    if (Array.isArray(auth.allowedBuckets) && auth.allowedBuckets.length) {
        const hit = auth.allowedBuckets.find(b => b?.name === env.B2_BUCKET_NAME);
        if (hit?.id) {
            CACHE.bucketId = hit.id;
            return hit.id;
        }
    }

    const resp = await fetch(`${auth.apiUrl}/b2api/v4/b2_list_buckets`, {
        method: "POST",
        headers: {
            Authorization: auth.authorizationToken,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            accountId: auth.accountId,
            bucketName: env.B2_BUCKET_NAME,
        }),
    });

    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`b2_list_buckets failed: ${resp.status} ${JSON.stringify(j)}`);

    const bucket = (j.buckets || [])[0];
    if (!bucket?.bucketId) throw new Error(`Bucket not found: ${env.B2_BUCKET_NAME}`);

    CACHE.bucketId = bucket.bucketId;
    return bucket.bucketId;
}

async function b2GetUploadUrl(auth, bucketId) {
    const now = Date.now();
    if (CACHE.upload && now < CACHE.uploadExp) return CACHE.upload;

    const u = new URL(`${auth.apiUrl}/b2api/v4/b2_get_upload_url`);
    u.searchParams.set("bucketId", bucketId);

    const resp = await fetch(u.toString(), {
        method: "GET",
        headers: { Authorization: auth.authorizationToken },
    });

    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`b2_get_upload_url failed: ${resp.status} ${JSON.stringify(j)}`);

    CACHE.upload = { uploadUrl: j.uploadUrl, authorizationToken: j.authorizationToken };
    CACHE.uploadExp = now + 30 * 60 * 1000;
    return CACHE.upload;
}

async function b2UploadFile(env, pre, fileName, mimeType, bytes, sha1) {
    const auth = await b2Authorize(env);
    const bucketId = pre.bucketId || (await b2ResolveBucketId(env, auth));
    let upload = await b2GetUploadUrl(auth, bucketId);

    const doUpload = async () => {
        const resp = await fetch(upload.uploadUrl, {
            method: "POST",
            headers: {
                Authorization: upload.authorizationToken,
                "X-Bz-File-Name": encodeURIComponent(fileName).replace(/%2F/g, "/"),
                "Content-Type": mimeType || "b2/x-auto",
                "X-Bz-Content-Sha1": sha1,
            },
            body: bytes,
        });

        const j = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(`b2_upload_file failed: ${resp.status} ${JSON.stringify(j)}`);
        return j;
    };

    try {
        return await doUpload();
    } catch {
        CACHE.upload = null;
        upload = await b2GetUploadUrl(auth, bucketId);
        return await doUpload();
    }
}
