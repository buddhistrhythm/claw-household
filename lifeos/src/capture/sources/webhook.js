'use strict';

/**
 * capture/sources/webhook.js — Webhook Source（入站适配器）.
 *
 * 任意能发 HTTP POST 的东西（iOS 快捷指令、Zapier、扫码枪网关…）都能经
 * POST /ingest/webhook 喂进同一条捕获管线。安全（SPEC §6）：设置了 secret 时
 * 必须带 `x-lifeos-secret` 头，否则 401 —— webhook 默认不裸奔。
 */

const http = require('http');
const crypto = require('crypto');

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const MAX_BODY = 1024 * 1024; // 1MB 上限，防滥用

/** 读取并解析 JSON body（限长）。 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

/**
 * 返回 node:http 风格的 async (req,res) 处理器。
 * body: { text?, kind?, source_ref?, channel?, hints?, media? }
 * 无 source_ref 时用 body+时间戳的 sha1 兜底（不保证跨重发幂等 —— 调用方应尽量自带稳定 ID）。
 */
function createWebhookHandler(captureApi, { secret } = {}) {
  return async (req, res) => {
    try {
      if (secret && req.headers['x-lifeos-secret'] !== secret) {
        return send(res, 401, { error: 'unauthorized' });
      }
      const body = await readJson(req);
      const out = await captureApi.ingest({
        channel: body.channel || 'webhook',
        kind: body.kind || 'text',
        source_ref: body.source_ref || sha1(JSON.stringify(body) + '|' + Date.now()),
        text: body.text,
        hints: body.hints,
        media: body.media,
        raw: body,
      });
      return send(res, 200, { status: out.status, id: out.id, route: out.route || null });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  };
}

/**
 * 极小 HTTP 服务：POST /ingest/webhook → 管线；GET /healthz → ok。
 * port=0 时由系统分配端口（测试友好）。返回 { server, port, close }。
 */
function startWebhookSource({ captureApi, port = 0, host = '127.0.0.1', secret } = {}) {
  const handler = createWebhookHandler(captureApi, { secret });
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/ingest/webhook') return handler(req, res);
    if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true });
    return send(res, 404, { error: 'not found' });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve({
        server,
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { createWebhookHandler, startWebhookSource };
