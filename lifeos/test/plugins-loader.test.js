'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { freshStore } = require('./helpers');
const loadPlugins = require('../src/plugins/loader');
const { root } = require('../src/config');

test('loader: enabled water plugin loads with full contract', () => {
  const { loaded, disabled, errors } = loadPlugins({
    config: { plugins: [{ name: 'water', module: './plugins/water.js', enabled: true }] },
    root,
  });
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(disabled.length, 0);
  assert.equal(loaded.length, 1);
  const water = loaded[0];
  assert.equal(water.name, 'water');
  assert.equal(typeof water.mod, 'function');
  assert.equal(water.mod.types[0].type, 'hydration_log');
  assert.equal(typeof water.mod.commands, 'function');
  assert.equal(typeof water.mod.intents, 'function');
});

test('loader: enabled:false → disabled, not loaded', () => {
  const { loaded, disabled } = loadPlugins({
    config: { plugins: [{ name: 'water', module: './plugins/water.js', enabled: false }] },
    root,
  });
  assert.deepEqual(disabled, ['water']);
  assert.equal(loaded.find((p) => p.name === 'water'), undefined);
});

test('loader: non-existent module → error, no throw, other plugins still load', () => {
  const { loaded, errors } = loadPlugins({
    config: {
      plugins: [
        { name: 'ghost', module: './plugins/does-not-exist.js', enabled: true },
        { name: 'water', module: './plugins/water.js', enabled: true },
      ],
    },
    root,
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].name, 'ghost');
  // the valid plugin in the same config still loads
  assert.ok(loaded.find((p) => p.name === 'water'));
});

test('loader: module exporting a non-function → recorded in errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-plugin-'));
  const file = path.join(dir, 'bad.js');
  fs.writeFileSync(file, 'module.exports = 42;\n');
  try {
    const { loaded, errors } = loadPlugins({
      config: { plugins: [{ name: 'bad', module: file, enabled: true }] },
      root,
    });
    assert.equal(loaded.length, 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].name, 'bad');
    assert.match(errors[0].error, /factory function/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loader: kind:'mcp' entry is left for the bridge (not loaded, not errored)", () => {
  const { loaded, errors } = loadPlugins({
    config: { plugins: [{ name: 'remote', module: 'some-mcp-pkg', enabled: true, kind: 'mcp' }] },
    root,
  });
  assert.equal(loaded.find((p) => p.name === 'remote'), undefined);
  assert.equal(errors.find((e) => e.name === 'remote'), undefined);
});

test('loader: missing/invalid config file → { plugins: [] }, no throw', () => {
  const cfg = loadPlugins.readPluginConfig(path.join(os.tmpdir(), 'nope-' + Date.now()));
  assert.deepEqual(cfg, { plugins: [] });
});

test('loader end-to-end: loaded water domain writes & sums over a store', async () => {
  const store = await freshStore();
  try {
    const { loaded } = loadPlugins({
      config: { plugins: [{ name: 'water', module: './plugins/water.js', enabled: true }] },
      root,
    });
    const water = loaded.find((p) => p.name === 'water').mod;
    const d = water(store);
    await d.log({ ml: 200 });
    await d.log({ ml: 300 });
    const t = await d.today({});
    assert.equal(t.total_ml, 500);
    assert.equal(t.count, 2);
  } finally {
    await store.close();
  }
});
