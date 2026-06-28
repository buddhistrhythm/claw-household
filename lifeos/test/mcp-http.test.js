'use strict';

/**
 * mcp-http.test.js — round-trip the lifeos MCP server over Streamable HTTP.
 *
 * 用真实的 MCP 客户端经 StreamableHTTPClientTransport 连接 startHttp() 启动的
 * 服务，listTools() 校验包含 life_search，并顺带跑一次 life_stats；另校验
 * /healthz 返回 200。全程本地，无外部网络。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const { freshStore } = require('./helpers');
const { startHttp } = require('../src/mcp/http');

/** Minimal GET helper for /healthz. */
function getStatus(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      })
      .on('error', reject);
  });
}

/** Minimal POST helper (for auth checks). */
function postStatus(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('MCP over Streamable HTTP: client round-trip + healthz', async () => {
  const store = await freshStore();
  // port:0 -> ephemeral; host 127.0.0.1 keeps it local-only.
  const { port, close } = await startHttp({ port: 0, host: '127.0.0.1', store });

  try {
    // /healthz
    const health = await getStatus(`http://127.0.0.1:${port}/healthz`);
    assert.strictEqual(health.status, 200, 'healthz should be 200');
    assert.deepStrictEqual(JSON.parse(health.body), { ok: true, service: 'lifeos-mcp' });

    // Real MCP client round-trip.
    const client = new Client({ name: 'lifeos-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client.connect(transport);

    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      assert.ok(names.includes('life_search'), `expected life_search in tools, got: ${names.join(', ')}`);

      // Exercise an actual tool call.
      const stats = await client.callTool({ name: 'life_stats', arguments: {} });
      assert.ok(Array.isArray(stats.content) && stats.content.length > 0, 'life_stats should return content');
    } finally {
      await client.close();
    }
  } finally {
    await close();
  }
});

test('HTTP daemon: bearer-token auth gates /mcp, leaves /healthz open', async () => {
  const store = await freshStore();
  const { port, close } = await startHttp({ port: 0, host: '127.0.0.1', token: 'sekret', store });
  try {
    // health is unauthenticated
    const health = await getStatus(`http://127.0.0.1:${port}/healthz`);
    assert.strictEqual(health.status, 200);

    // POST /mcp without a token -> 401
    const unauth = await postStatus(`http://127.0.0.1:${port}/mcp`, {}, {});
    assert.strictEqual(unauth.status, 401, 'no token should be rejected');

    // wrong token -> 401
    const wrong = await postStatus(`http://127.0.0.1:${port}/mcp`, {}, { authorization: 'Bearer nope' });
    assert.strictEqual(wrong.status, 401, 'wrong token should be rejected');
  } finally {
    await close();
  }
});
