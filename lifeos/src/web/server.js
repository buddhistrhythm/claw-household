'use strict';

/**
 * web/server.js — minimal mobile-first PWA + HTTP API for lifeos.
 *
 * Long-lived daemon mirroring the structure of src/mcp/http.js:
 *   - node:http server, port/host/token from env or opts
 *   - optional bearer-token auth (constant-time)
 *   - /healthz, graceful SIGINT/SIGTERM shutdown in startWebMain()
 *
 * 一个常驻 HTTP 守护进程 + 移动端 PWA，结构对齐 src/mcp/http.js。
 *
 * Auth model / 鉴权模型:
 *   - LIFEOS_WEB_TOKEN 启用后，**所有 /api/* 都需要 Bearer**；
 *   - 公开豁免：/healthz、/（SPA shell，让 iOS 主屏安装可用）、
 *     /manifest.webmanifest、/sw.js、/static/*；
 *   - 同源访问：CORS 仅限同源（不返回 Access-Control-Allow-Origin: *）。
 *
 * No new deps. Pure builtins. PWA assets are plain HTML/CSS/JS shipped from
 * src/web/public, served with the right content-type.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { timingSafeEqual, createHash } = require('node:crypto');

const { createStore } = require('../store');
const captureFactory = require('../capture');
const semanticFactory = require('../semantic');

const PUBLIC_DIR = path.join(__dirname, 'public');

/** sha1 helper — same convention as capture/index.js. */
const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');

/** Read a JSON body with a 1MB cap. / 读 JSON 请求体，1MB 上限。 */
function readJsonBody(req, { maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('body_too_large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

/** Send a JSON response with the given status. / 统一 JSON 响应。 */
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** Constant-time bearer-token check (mirrors mcp/http.js authOk). */
function authOk(req, token) {
  if (!token) return true;
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Static MIME map for the PWA shell. / PWA 静态资源 MIME。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** Resolve a safe path under PUBLIC_DIR (prevents traversal). / 防穿越静态路径。 */
function resolvePublic(relPath) {
  const safe = path.normalize(relPath).replace(/^([./\\])+/, '');
  const full = path.join(PUBLIC_DIR, safe);
  if (!full.startsWith(PUBLIC_DIR)) return null;
  return full;
}

/** Serve a file from PUBLIC_DIR; 404 if missing. */
function serveStatic(res, relPath) {
  const full = resolvePublic(relPath);
  if (!full) return sendJson(res, 404, { error: 'not_found' });
  fs.readFile(full, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'not_found', path: relPath });
    const ext = path.extname(full).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(buf);
  });
}

/**
 * startWeb — boot the PWA + JSON API daemon over node:http.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.port]   LIFEOS_WEB_PORT 或 8850
 * @param {string}  [opts.host]   LIFEOS_WEB_HOST 或 127.0.0.1（仅本机）
 * @param {string}  [opts.token]  LIFEOS_WEB_TOKEN（设了才启用鉴权）
 * @param {object}  [opts.store]  复用既有 store；不传则自建
 * @returns {Promise<{server, port, close}>}
 */
async function startWeb({
  port = Number(process.env.LIFEOS_WEB_PORT) || 8850,
  host = process.env.LIFEOS_WEB_HOST || '127.0.0.1',
  token = process.env.LIFEOS_WEB_TOKEN || null,
  store,
} = {}) {
  // 若调用方未注入 store，则自建一个（close() 时一并关闭）。
  const ownStore = !store;
  if (!store) store = await createStore();

  const captureApi = captureFactory(store);
  const semantic = semanticFactory(store);

  // 尝试加载 baby domain（可能尚未着陆 —— 不影响 web 启动）。
  // Try to load the baby domain — tolerate absence so the web boots regardless.
  let babyDomain = null;
  let babyLoadError = null;
  try {
    babyDomain = require('../domains/baby')(store);
  } catch (e) {
    babyLoadError = e && e.message;
  }

  /** Paths that bypass auth even when LIFEOS_WEB_TOKEN is set. */
  function isPublicPath(pathname) {
    if (pathname === '/healthz') return true;
    if (pathname === '/') return true;
    if (pathname === '/manifest.webmanifest') return true;
    if (pathname === '/sw.js') return true;
    if (pathname.startsWith('/static/')) return true;
    return false;
  }

  // ── route handlers / 路由处理 ──────────────────────────────────────────────

  async function handleStats(_req, res) {
    sendJson(res, 200, await store.stats());
  }

  async function handleBabies(_req, res) {
    const list = await store.entities.list({ type: 'baby', limit: 100 });
    sendJson(res, 200, list);
  }

  async function handleBabyCry(req, res) {
    let body;
    try {
      body = (await readJsonBody(req)) || {};
    } catch (e) {
      return sendJson(res, 400, { error: e.message || 'invalid_json' });
    }

    if (!babyDomain || typeof babyDomain.inferCryReason !== 'function') {
      return sendJson(res, 404, {
        error: 'baby_domain_unavailable',
        detail: babyLoadError || 'baby domain not installed; ship src/domains/baby.js',
      });
    }

    // 解析 baby_id：没传时若仅有一名宝宝则用之，多名则要求显式指定。
    // Resolve baby_id: pick the lone baby if unspecified; otherwise 400 with list.
    let baby_id = body.baby_id;
    if (!baby_id) {
      const babies = await store.entities.list({ type: 'baby', limit: 100 });
      if (babies.length === 0) {
        return sendJson(res, 404, {
          error: 'no_baby',
          detail: 'no baby entity exists — create one first via store.entities.create({type:"baby", ...})',
        });
      }
      if (babies.length > 1) {
        return sendJson(res, 400, {
          error: 'baby_id_required',
          detail: 'multiple babies — pass baby_id',
          babies: babies.map((b) => ({ id: b.id, title: b.title })),
        });
      }
      baby_id = babies[0].id;
    }

    try {
      const result = await babyDomain.inferCryReason({
        baby_id,
        at: body.at,
        lookback_hours: body.lookback_hours,
      });
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 500, { error: 'infer_failed', detail: e && e.message });
    }
  }

  async function handleCapturesList(req, res) {
    const u = new URL(req.url, 'http://x');
    const limit = Math.max(1, Math.min(500, Number(u.searchParams.get('limit')) || 50));
    sendJson(res, 200, await captureApi.pending({ limit }));
  }

  async function handleCapturesCreate(req, res) {
    let body;
    try {
      body = (await readJsonBody(req)) || {};
    } catch (e) {
      return sendJson(res, 400, { error: e.message || 'invalid_json' });
    }
    const text = (body.text || '').trim();
    if (!text) return sendJson(res, 400, { error: 'text_required' });
    const channel = body.channel || 'web';
    // 确定性 source_ref：sha1(text+timestamp).slice(0,12)，与 capture 的幂等键贴合。
    const source_ref = 'web:' + sha1(text + ':' + Date.now()).slice(0, 12);
    try {
      const result = await captureApi.ingest({
        channel,
        source_ref,
        text,
        hints: body.hints || {},
      });
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 500, { error: 'ingest_failed', detail: e && e.message });
    }
  }

  async function handleCaptureConfirm(req, res, id) {
    let body;
    try {
      body = (await readJsonBody(req)) || {};
    } catch (e) {
      return sendJson(res, 400, { error: e.message || 'invalid_json' });
    }
    try {
      const result = await captureApi.confirm(id, {
        intent: body.intent,
        args: body.args,
      });
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 400, { error: 'confirm_failed', detail: e && e.message });
    }
  }

  async function handleCaptureDismiss(_req, res, id) {
    try {
      const result = await captureApi.dismiss(id);
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 400, { error: 'dismiss_failed', detail: e && e.message });
    }
  }

  async function handleSearch(req, res) {
    const u = new URL(req.url, 'http://x');
    const q = u.searchParams.get('q') || '';
    const type = u.searchParams.get('type') || undefined;
    const limit = Math.max(1, Math.min(100, Number(u.searchParams.get('limit')) || 25));
    if (!q.trim()) return sendJson(res, 200, []);
    try {
      const hits = await semantic.hybridSearch(q, { type, limit });
      sendJson(res, 200, hits);
    } catch (e) {
      sendJson(res, 500, { error: 'search_failed', detail: e && e.message });
    }
  }

  // ── server / 主路由 ────────────────────────────────────────────────────────

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://x');
      const pathname = u.pathname;

      // 鉴权：/api/* 全部需要 token；公开路径白名单豁免。
      // Auth: every /api/* requires the token; public paths exempted.
      if (pathname.startsWith('/api/')) {
        if (!authOk(req, token)) return sendJson(res, 401, { error: 'unauthorized' });
      } else if (!isPublicPath(pathname) && !pathname.startsWith('/static/')) {
        // unknown non-/api path: fall through to 404 below
      }

      // ── health ─────────────────────────────────────────────────────────────
      if (pathname === '/healthz') {
        return sendJson(res, 200, { ok: true, service: 'lifeos-web' });
      }

      // ── API endpoints ──────────────────────────────────────────────────────
      if (pathname === '/api/stats' && req.method === 'GET') return handleStats(req, res);
      if (pathname === '/api/babies' && req.method === 'GET') return handleBabies(req, res);
      if (pathname === '/api/baby/cry' && req.method === 'POST') return handleBabyCry(req, res);

      if (pathname === '/api/captures' && req.method === 'GET') return handleCapturesList(req, res);
      if (pathname === '/api/captures' && req.method === 'POST') return handleCapturesCreate(req, res);

      let m;
      if ((m = /^\/api\/captures\/([^/]+)\/confirm$/.exec(pathname)) && req.method === 'POST') {
        return handleCaptureConfirm(req, res, decodeURIComponent(m[1]));
      }
      if ((m = /^\/api\/captures\/([^/]+)\/dismiss$/.exec(pathname)) && req.method === 'POST') {
        return handleCaptureDismiss(req, res, decodeURIComponent(m[1]));
      }

      if (pathname === '/api/search' && req.method === 'GET') return handleSearch(req, res);

      // ── PWA shell + static / 静态资源 ──────────────────────────────────────
      if (pathname === '/' && req.method === 'GET') {
        return serveStatic(res, 'index.html');
      }
      if (pathname === '/manifest.webmanifest' && req.method === 'GET') {
        return serveStatic(res, 'manifest.webmanifest');
      }
      if (pathname === '/sw.js' && req.method === 'GET') {
        return serveStatic(res, 'sw.js');
      }
      if (pathname === '/main.css' && req.method === 'GET') {
        return serveStatic(res, 'main.css');
      }
      if (pathname === '/main.js' && req.method === 'GET') {
        return serveStatic(res, 'main.js');
      }
      if (pathname.startsWith('/static/') && req.method === 'GET') {
        return serveStatic(res, pathname.slice('/static/'.length));
      }

      sendJson(res, 404, { error: 'not_found', path: pathname });
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal', detail: err && err.message });
      else res.end();
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const actualPort = server.address().port;

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    if (ownStore) await store.close();
  }

  return { server, port: actualPort, close };
}

/**
 * startWebMain — entrypoint for `cli web` / docker-compose service.
 * Logs the URL, installs SIGINT/SIGTERM, and blocks forever.
 */
async function startWebMain({ port, host } = {}) {
  const { port: boundPort, close } = await startWeb({ port, host });
  const displayHost = host || process.env.LIFEOS_WEB_HOST || '127.0.0.1';
  const authNote = process.env.LIFEOS_WEB_TOKEN
    ? 'bearer-token auth ON'
    : 'NO auth (set LIFEOS_WEB_TOKEN if not localhost)';
  // eslint-disable-next-line no-console
  console.error(`[lifeos-web] PWA + API on http://${displayHost}:${boundPort} — ${authNote} (health: /healthz)`);

  const shutdown = async () => {
    try { await close(); } finally { process.exit(0); }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { startWeb, startWebMain };
