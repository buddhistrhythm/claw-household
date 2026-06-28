'use strict';

/**
 * plugins-mcp.test.js — out-of-process MCP plugin bridge, fully in-process.
 *
 * 用 SDK 起一个内存里的 demo MCP server（一个 echo tool），再用 connectMcpPlugin
 * 作为客户端连上它，验证：tool→Intent 的形状（jsonSchema + confirm:'always'，无 zod
 * schema）、run() 把外部结果包成 plugin_result 实体并落库、以及 types 注册。
 * No external server, no network — InMemoryTransport 把 client/server 直连。
 */

const test = require('node:test');
const assert = require('node:assert');

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { z } = require('zod');

const { freshStore } = require('./helpers');
const bridge = require('../src/plugins/mcp_bridge');
const { connectMcpPlugin } = bridge;

test('connectMcpPlugin: lists tools as intents and wraps results into plugin_result', async () => {
  // ── 内存 demo MCP server / tiny in-process MCP server ──────────────────────
  const srv = new McpServer({ name: 'demo', version: '0.0.0' });
  srv.tool('echo', 'echo back the text', { text: z.string() }, async ({ text }) => ({
    content: [{ type: 'text', text: `echo:${text}` }],
  }));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await srv.connect(serverT);

  const { intents, close } = await connectMcpPlugin({ name: 'demo', transport: clientT });

  // ── Intent 形状 / intent shape ─────────────────────────────────────────────
  assert.strictEqual(intents.length, 1);
  const intent = intents[0];
  assert.strictEqual(intent.name, 'demo.echo');
  assert.strictEqual(intent.confirm, 'always');
  assert.strictEqual(typeof intent.jsonSchema, 'object');
  assert.ok(intent.jsonSchema.properties && intent.jsonSchema.properties.text,
    'jsonSchema should carry the tool inputSchema with a `text` property');
  assert.strictEqual(intent.schema, undefined); // jsonSchema path → no zod schema

  // ── run() 调外部 tool → 包成 plugin_result 实体 / run wraps into entity ──────
  const store = await freshStore();
  try {
    const ent = await intent.run({ text: 'hi' }, { store, capture: { id: 'cap_x' } });
    assert.strictEqual(ent.type, 'plugin_result');
    assert.strictEqual(ent.data.output, 'echo:hi');
    assert.strictEqual(ent.data.plugin, 'demo');
    assert.strictEqual(ent.data.tool, 'echo');

    const persisted = await store.entities.get(ent.id);
    assert.ok(persisted, 'entity should be persisted');
    assert.strictEqual(persisted.data.output, 'echo:hi');
  } finally {
    await close();
    await srv.close();
    await store.close();
  }
});

test('module.exports.types registers plugin_result', () => {
  assert.strictEqual(bridge.types[0].type, 'plugin_result');
});
