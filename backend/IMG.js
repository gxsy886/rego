// Worker B: /i/<key> -> 从 B2 下载 -> Cloudflare edge cache 加速

const B2_AUTH_URL = "https://api.backblazeb2.com/b2api/v4/b2_authorize_account";

let AUTH_CACHE = null; // { apiUrl, downloadUrl, token, exp }
let AUTH_EXP = 0;

export default {
    async fetch(request, env, ctx) {
        if (request.method === "OPTIONS") return handleOptions(request);

        const url = new URL(request.url);

        // 只允许 GET/HEAD
        if (request.method !== "GET" && request.method !== "HEAD") {
            return new Response("Method Not Allowed", { status: 405 });
        }

        // 路径必须是 /i/<key>
        if (!url.pathname.startsWith("/i/")) {
            return new Response("Not Found", { status: 404 });
        }

        const key = decodeURIComponent(url.pathname.slice(3));
        if (!key || key.includes("..")) return new Response("Bad Request", { status: 400 });

        // Range 请求先不缓存（简单可靠）
        const hasRange = request.headers.has("Range");

        // cacheKey 不带 query（你的 URL 设计也建议不要带 query）
        const cacheKey = new Request(url.origin + url.pathname, { method: "GET" });

        if (!hasRange) {
            const hit = await caches.default.match(cacheKey);
            if (hit) return withCors(hit, request);
        }

        // 1) B2 authorize 拿 downloadUrl + token
        const auth = await b2Authorize(env);

        // 2) 拼下载 URL：downloadUrl/file/<bucketName>/<fileName>
        const fileName = encodePreserveSlash(key);
        const download = `${auth.downloadUrl}/file/${encodeURIComponent(env.B2_BUCKET_NAME)}/${fileName}`;

        const headers = new Headers();
        headers.set("Authorization", auth.token);
        if (hasRange) headers.set("Range", request.headers.get("Range"));

        const originResp = await fetch(download, { method: request.method, headers });

        // 透传错误
        if (!originResp.ok) {
            return withCors(new Response(await originResp.text(), { status: originResp.status }), request);
        }

        const outHeaders = new Headers(originResp.headers);
        outHeaders.set("Cache-Control", "public, max-age=31536000, immutable");

        const out = new Response(originResp.body, { status: originResp.status, headers: outHeaders });

        if (!hasRange) {
            ctx.waitUntil(caches.default.put(cacheKey, out.clone()));
        }

        return withCors(out, request);
    },
};

function withCors(resp, request) {
    const origin = request.headers.get("Origin") || "*";
    const h = new Headers(resp.headers);
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
    h.set("Access-Control-Allow-Headers", "Range,If-None-Match,If-Modified-Since,Content-Type");
    h.set("Access-Control-Expose-Headers", "Content-Type,Content-Length,ETag,Last-Modified,Accept-Ranges");
    h.set("Vary", "Origin");
    return new Response(resp.body, { status: resp.status, headers: h });
}

function handleOptions(request) {
    const origin = request.headers.get("Origin") || "*";
    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
            "Access-Control-Allow-Headers": "Range,If-None-Match,If-Modified-Since,Content-Type",
            "Access-Control-Max-Age": "86400",
            "Vary": "Origin",
        },
    });
}

// 保留 / ，其余 encode
function encodePreserveSlash(s) {
    return String(s).split("/").map(encodeURIComponent).join("/");
}

async function b2Authorize(env) {
    const now = Date.now();
    if (AUTH_CACHE && now < AUTH_EXP) return AUTH_CACHE;

    if (!env.B2_KEY_ID || !env.B2_APP_KEY) {
        throw new Error("Missing B2_KEY_ID / B2_APP_KEY");
    }

    const basic = btoa(`${env.B2_KEY_ID}:${env.B2_APP_KEY}`);
    const resp = await fetch(B2_AUTH_URL, {
        method: "GET",
        headers: { Authorization: `Basic ${basic}` },
    });

    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`b2_authorize_account failed: ${resp.status} ${JSON.stringify(j)}`);

    // v4: downloadUrl 和 apiUrl 在 apiInfo.storageApi 下
    const storage = j?.apiInfo?.storageApi;
    const downloadUrl = storage?.downloadUrl;
    const apiUrl = storage?.apiUrl;
    const token = j.authorizationToken;

    if (!downloadUrl || !apiUrl || !token) {
        throw new Error(`Bad authorize response: ${JSON.stringify(j)}`);
    }

    AUTH_CACHE = { apiUrl, downloadUrl, token };
    AUTH_EXP = now + 23 * 60 * 60 * 1000;
    return AUTH_CACHE;
}
