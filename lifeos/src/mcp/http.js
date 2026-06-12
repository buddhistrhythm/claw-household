'use strict';

/**
 * mcp/http.js — Streamable HTTP transport for the lifeos MCP server.
 *
 * Lets the MCP server run as a long-lived daemon (e.g. a docker-compose service)
 * instead of being spawned per-connection over stdio. Reuses buildServer(store)
 * from ./server.js unchanged; only the transport layer differs.
 *
 * 让 lifeos 的 MCP 服务以「常驻守护进程」（如 docker-compose 服务）方式运行，
 * 而不是仅由客户端按需 spawn stdio 进程。底层完全复用 server.js 的
 * buildServer(store)，仅替换传输层为 Streamable HTTP。
 *
 * Session model — **stateful**：每个客户端在 initialize 时由服务端生成
 * sessionId（randomUUID），后续请求带 `mcp-session-id` 头复用同一 transport。
 * 选择 stateful 而非 stateless：StreamableHTTP 客户端在 initialize 后会发起
 * GET（SSE 通知流）与 DELETE（结束会话），需要按 sessionId 路由到同一 transport
 * 才能正确处理；stateless 模式下 GET/DELETE 无法可靠对应。
 */

const http = require('node:http');
const { randomUUID, timingSafeEqual } = require('node:crypto');

const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');

const { createStore } = require('../store');
const { buildServer } = require('./server');

/** Read and JSON-parse a node request body. / 读取并解析 JSON 请求体。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** Send a tiny JSON-RPC error (used before a transport/session exists). */
function sendJsonRpcError(res, status, message, id = null) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id }));
}

/**
 * Optional bearer-token auth (constant-time). Enabled only when LIFEOS_MCP_TOKEN
 * is set. The store exposes personal/finance data, so anything beyond localhost
 * should set a token. / 设了 LIFEOS_MCP_TOKEN 才启用；非 localhost 暴露务必设置。
 */
function authOk(req, token) {
  if (!token) return true; // auth disabled
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * startHttp — boot a node:http server exposing the lifeos MCP over Streamable HTTP.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.port]  默认 LIFEOS_MCP_PORT 或 8848
 * @param {string}  [opts.host]  默认 LIFEOS_MCP_HOST 或 127.0.0.1（安全默认：仅本机）
 * @param {string}  [opts.token] bearer token；默认取 LIFEOS_MCP_TOKEN（设了才启用鉴权）
 * @param {object}  [opts.store] 复用已有 store；不传则用 createStore() 新建
 * @returns {Promise<{ server: http.Server, port: number, close: () => Promise<void> }>}
 */
async function startHttp({
  port = Number(process.env.LIFEOS_MCP_PORT) || 8848,
  host = process.env.LIFEOS_MCP_HOST || '127.0.0.1',
  token = process.env.LIFEOS_MCP_TOKEN || null,
  store,
} = {}) {
  // 若调用方未注入 store，则自建一个（close() 时一并关闭）。
  const ownStore = !store;
  if (!store) store = await createStore();

  // sessionId -> transport 映射（stateful 会话）。
  const transports = new Map();

  async function handleMcp(req, res) {
    if (!authOk(req, token)) return sendJsonRpcError(res, 401, 'Unauthorized');
    const sessionId = req.headers['mcp-session-id'];

    if (req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJsonRpcError(res, 400, 'Invalid JSON body');
      }

      let transport;
      if (sessionId && transports.has(sessionId)) {
        // 复用既有会话。/ Reuse existing session transport.
        transport = transports.get(sessionId);
      } else if (!sessionId && isInitializeRequest(body)) {
        // 新会话：生成 sessionId，构建独立的 server+transport。
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport);
          },
        });
        const server = await buildServer(store);
        // 会话结束时既清映射、也关掉这条会话的 server，避免守护进程长跑累积实例。
        transport.onclose = async () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
          try { await server.close(); } catch { /* ignore */ }
        };
        await server.connect(transport);
      } else {
        // 非 initialize 又无有效会话 → 拒绝。
        return sendJsonRpcError(res, 400, 'Bad Request: no valid session id for non-initialize request');
      }

      return transport.handleRequest(req, res, body);
    }

    // GET（SSE 通知流）与 DELETE（结束会话）必须命中既有会话。
    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!sessionId || !transports.has(sessionId)) {
        return sendJsonRpcError(res, 400, 'Bad Request: missing or invalid session id');
      }
      return transports.get(sessionId).handleRequest(req, res);
    }

    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, POST, DELETE' });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
  }

  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];

    if (url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'lifeos-mcp' }));
      return;
    }

    if (url === '/mcp') {
      handleMcp(req, res).catch((err) => {
        // 兜底：避免任何未捕获异常吊死连接。
        if (!res.headersSent) sendJsonRpcError(res, 500, 'Internal error: ' + (err && err.message));
        else res.end();
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const actualPort = server.address().port;

  async function close() {
    // 关闭所有会话 transport，再关 http，再（若自建）关 store。
    for (const t of transports.values()) {
      try {
        await t.close();
      } catch {
        /* ignore */
      }
    }
    transports.clear();
    await new Promise((resolve) => server.close(resolve));
    if (ownStore) await store.close();
  }

  return { server, port: actualPort, close };
}

/**
 * startHttpMain — entrypoint for the cli `mcp-http` command / docker-compose service.
 * Starts the server, logs the URL, and keeps the process alive.
 */
async function startHttpMain({ port, host } = {}) {
  const { port: boundPort, close } = await startHttp({ port, host });
  const displayHost = host || process.env.LIFEOS_MCP_HOST || '127.0.0.1';
  const authNote = process.env.LIFEOS_MCP_TOKEN ? 'bearer-token auth ON' : 'NO auth (set LIFEOS_MCP_TOKEN if not localhost)';
  // eslint-disable-next-line no-console
  console.error(`[lifeos-mcp] Streamable HTTP on http://${displayHost}:${boundPort}/mcp — ${authNote} (health: /healthz)`);

  // 优雅退出。/ Graceful shutdown.
  const shutdown = async () => {
    try {
      await close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { startHttp, startHttpMain };
