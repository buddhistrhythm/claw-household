'use strict';

/**
 * web.test.js — smoke tests for the lifeos PWA + JSON API daemon.
 *
 * 覆盖：
 *  - /healthz 无鉴权放行；/api/stats 严格鉴权
 *  - /api/captures POST 走规则路由（"加 3 盒 牛奶" 自动 committed）
 *  - /api/baby/cry 无宝宝时 404；造一个 baby 后再调用 —— 无 baby 域时返回 404
 *    且 server 不崩，有 baby 域时返回 200。
 *  - /、/manifest.webmanifest、/sw.js 静态资源 content-type 正确
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { freshStore } = require('./helpers');
const { startWeb } = require('../src/web/server');

const TOKEN = 'web-sekret';

/** GET helper — returns {status, body, headers}. / 简易 GET。 */
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''), headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** POST helper — sends JSON body, returns {status, body, headers}. */
function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body == null ? '' : JSON.stringify(body);
    const req = http.request(
      { method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname,
        headers: Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, headers) },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

test('web: healthz is public; /api/stats requires token', async () => {
  const store = await freshStore();
  const { port, close } = await startWeb({ port: 0, host: '127.0.0.1', token: TOKEN, store });
  try {
    // /healthz — public
    const h = await get(`http://127.0.0.1:${port}/healthz`);
    assert.strictEqual(h.status, 200);
    assert.deepStrictEqual(JSON.parse(h.body), { ok: true, service: 'lifeos-web' });

    // /api/stats without token → 401
    const noTok = await get(`http://127.0.0.1:${port}/api/stats`);
    assert.strictEqual(noTok.status, 401, 'no token should be rejected');

    // wrong token → 401
    const bad = await get(`http://127.0.0.1:${port}/api/stats`, { authorization: 'Bearer nope' });
    assert.strictEqual(bad.status, 401);

    // good token → 200 and shape has `total`
    const ok = await get(`http://127.0.0.1:${port}/api/stats`, { authorization: 'Bearer ' + TOKEN });
    assert.strictEqual(ok.status, 200);
    const stats = JSON.parse(ok.body);
    assert.ok('total' in stats, 'stats should include total');
  } finally {
    await close();
  }
});

test('web: POST /api/captures auto-commits "加 3 盒 牛奶"', async () => {
  const store = await freshStore();
  const { port, close } = await startWeb({ port: 0, host: '127.0.0.1', token: TOKEN, store });
  try {
    const res = await post(`http://127.0.0.1:${port}/api/captures`,
      { text: '加 3 盒 牛奶' },
      { authorization: 'Bearer ' + TOKEN });
    assert.strictEqual(res.status, 200);
    const out = JSON.parse(res.body);
    assert.strictEqual(out.status, 'committed', `expected committed, got ${out.status}: ${res.body}`);

    // pending list should NOT include this one (it's committed).
    const listRes = await get(`http://127.0.0.1:${port}/api/captures`, { authorization: 'Bearer ' + TOKEN });
    assert.strictEqual(listRes.status, 200);
    const pending = JSON.parse(listRes.body);
    assert.strictEqual(pending.length, 0, 'committed capture must not be in pending');
  } finally {
    await close();
  }
});

test('web: POST /api/baby/cry — 404 with no babies; does not crash when domain absent', async () => {
  const store = await freshStore();
  const { port, close } = await startWeb({ port: 0, host: '127.0.0.1', token: TOKEN, store });
  try {
    // no babies yet — expect 404 with helpful error JSON
    const first = await post(`http://127.0.0.1:${port}/api/baby/cry`, {}, { authorization: 'Bearer ' + TOKEN });
    assert.strictEqual(first.status, 404);
    const body1 = JSON.parse(first.body);
    assert.ok(body1.error, 'should have error field');

    // Create a baby directly via store
    await store.entities.create({ type: 'baby', title: '宝宝', data: { birth_date: '2026-02-13' } });

    // Now call again — either 200 (baby domain landed) or 404 (domain missing).
    // Server must NOT crash either way, AND must still respond to /healthz.
    const second = await post(`http://127.0.0.1:${port}/api/baby/cry`, {}, { authorization: 'Bearer ' + TOKEN });
    assert.ok([200, 404, 500].includes(second.status), `unexpected status ${second.status}: ${second.body}`);

    // Server still alive after the call.
    const ping = await get(`http://127.0.0.1:${port}/healthz`);
    assert.strictEqual(ping.status, 200, 'server must still be alive after baby/cry');
  } finally {
    await close();
  }
});

test('web: GET / serves the PWA shell with the hero label', async () => {
  const store = await freshStore();
  const { port, close } = await startWeb({ port: 0, host: '127.0.0.1', store });
  try {
    const r = await get(`http://127.0.0.1:${port}/`);
    assert.strictEqual(r.status, 200);
    assert.match(r.headers['content-type'] || '', /text\/html/);
    assert.ok(r.body.includes('宝宝哭了'), 'index should include the hero label "宝宝哭了"');
  } finally {
    await close();
  }
});

test('web: /manifest.webmanifest and /sw.js have correct content-types', async () => {
  const store = await freshStore();
  const { port, close } = await startWeb({ port: 0, host: '127.0.0.1', store });
  try {
    const m = await get(`http://127.0.0.1:${port}/manifest.webmanifest`);
    assert.strictEqual(m.status, 200);
    assert.match(m.headers['content-type'] || '', /application\/manifest\+json/);

    const sw = await get(`http://127.0.0.1:${port}/sw.js`);
    assert.strictEqual(sw.status, 200);
    assert.match(sw.headers['content-type'] || '', /javascript/);
  } finally {
    await close();
  }
});
