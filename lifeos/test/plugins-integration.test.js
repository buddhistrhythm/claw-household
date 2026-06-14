'use strict';

/**
 * plugins-integration.test.js — the runtime-plugin glue end to end.
 *
 * Covers the seam the unit tests (loader / mcp_bridge) don't: registry
 * initMcpPlugins() → allIntents() merge → capture pipeline routing/commit into
 * a `plugin_result` entity, for an out-of-process MCP plugin (here an in-memory
 * MCP server, so no external process/network). Also checks an in-process
 * allowlist plugin's intent reaches the same router.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { z } = require('zod');

const { freshStore } = require('./helpers');
const registry = require('../src/registry');
const captureFactory = require('../src/capture');

test('MCP plugin: initMcpPlugins → allIntents → capture confirm writes plugin_result', async () => {
  const store = await freshStore();
  // tiny in-process MCP server exposing one tool
  const srv = new McpServer({ name: 'demo', version: '0.0.0' });
  srv.tool('echo', 'echo back the text', { text: z.string() },
    async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await srv.connect(serverT);

  try {
    // clean global state (process isolation makes this defensive only) then wire
    // the plugin in via an INJECTED transport (config path without a real server).
    await registry.closeMcpPlugins();
    const status = await registry.initMcpPlugins({
      config: { plugins: [{ name: 'demo', kind: 'mcp', transport: clientT }] },
    });
    assert.ok(status.connected.some((c) => c.name === 'demo'), 'demo plugin connected');

    // the tool surfaces as a router intent
    const intents = registry.allIntents(store);
    const echo = intents.find((i) => i.name === 'demo.echo');
    assert.ok(echo, 'demo.echo intent present in allIntents');
    assert.equal(echo.confirm, 'always', 'external plugin intents are human-gated');
    assert.ok(echo.jsonSchema && echo.jsonSchema.properties, 'carries the tool jsonSchema');

    // capture pipeline can route+commit to it (no rule/LLM → explicit confirm)
    const cap = captureFactory(store);
    const ing = await cap.ingest({ channel: 'test', source_ref: 'mcp-1', text: 'route me to a plugin' });
    assert.equal(ing.status, 'pending');
    const done = await cap.confirm(ing.id, { intent: 'demo.echo', args: { text: 'hi' } });
    assert.equal(done.status, 'committed');

    const ent = await store.entities.get(done.result_id);
    assert.equal(ent.type, 'plugin_result');
    assert.equal(ent.data.output, 'echo:hi');
    assert.equal(ent.data.plugin, 'demo');
    // provenance edge back to the capture
    const prov = await store.relations.from(ent.id, 'captured_from');
    assert.equal(prov.length, 1);
    assert.equal(prov[0].object_id, ing.id);
  } finally {
    await registry.closeMcpPlugins();
    await srv.close();
    await store.close();
  }
});

test('in-process allowlist plugin: loaded via config → intent reaches the router', async () => {
  const store = await freshStore();
  try {
    // the water reference plugin, enabled via an inline config through the loader
    const loadPlugins = require('../src/plugins/loader');
    const { loaded } = loadPlugins({
      config: { plugins: [{ name: 'water', module: './plugins/water.js', enabled: true }] },
    });
    const water = loaded.find((p) => p.name === 'water');
    assert.ok(water && typeof water.mod === 'function', 'water plugin loaded as a factory');
    const ints = water.mod.intents(store);
    const logWater = ints.find((i) => i.name === 'health.log_water');
    assert.ok(logWater, 'plugin contributes the health.log_water intent');
    // its rule fires on a natural phrase
    const hit = logWater.rules({ body: '喝了 250ml' });
    assert.ok(hit && hit.args.ml === 250, 'rule extracts ml');
  } finally {
    await store.close();
  }
});
