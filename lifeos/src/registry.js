'use strict';

/**
 * registry.js — the single domain manifest registry.
 * 领域清单的唯一登记处：一个领域 = 一个 `src/domains/<x>.js` 模块，可导出
 *   - module.exports          factory(store) -> domain instance
 *   - module.exports.types    NEW entity types it introduces（types.js 派生注册）
 *   - module.exports.commands (instance, util) -> { name: {desc, usage, run} }（cli 派生分发）
 *   - module.exports.intents  (store) -> Intent[]（捕获 Router 的可路由目标，见 docs/SPEC-plugins.md）
 *
 * cli 的命令表、entity_types 注册、捕获路由目标都从这里派生 —— 一个领域只声明一次。
 * One declaration per domain; CLI dispatch, type seeding and capture routing all derive from it.
 */

const DOMAINS = [
  { name: 'storage', mod: require('./domains/storage') },
  { name: 'credit_card', mod: require('./domains/credit_card') },
  { name: 'notes', mod: require('./domains/notes') },
  { name: 'library', mod: require('./domains/library') },
  { name: 'finance', mod: require('./domains/finance') },
  { name: 'knowledge', mod: require('./domains/knowledge') },
  { name: 'events', mod: require('./domains/events') },
  { name: 'meals', mod: require('./domains/meals') },
  { name: 'baby', mod: require('./domains/baby') },
  { name: 'capture', mod: require('./capture') },
];

// ── 运行时插件（允许清单，SPEC-plugins §1.6） ─────────────────────────────
// 进程内插件：config/plugins.json 里 enabled 的模块，加载期 require 进来，与内置
// 领域同契约（factory + types/commands/intents）。一个坏插件不连累其它（loader 容错）。
// In-process allowlist plugins, required at load time — same contract as built-ins.
const _pluginLoad = require('./plugins/loader')();
for (const p of _pluginLoad.loaded) DOMAINS.push({ name: p.name, mod: p.mod, plugin: true });

// 跨进程 MCP 插件由 initMcpPlugins() 异步连接后填充（外部进程，永不碰 DB）。
// Out-of-process MCP plugins are populated by initMcpPlugins() (lazy, best-effort).
let _mcpIntents = [];
let _mcpClosers = [];
let _mcpInited = false;
let _mcpStatus = { connected: [], errors: [] };

/** 小工具，传给各 domain 的 commands() 当第二参。 Arg helpers for command runners. */
const util = {
  csv: (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined),
  num: (v) => (v === undefined || v === true ? undefined : Number(v)),
};

/** All NEW entity types contributed by domains (+ the MCP-bridge plugin_result). */
function allTypes() {
  const fromDomains = DOMAINS.flatMap((d) => d.mod.types || []);
  const bridgeTypes = require('./plugins/mcp_bridge').types || []; // plugin_result
  return [...fromDomains, ...bridgeTypes];
}

/** Instantiate every domain over a store: { name -> instance }. */
function instantiate(store) {
  const out = {};
  for (const d of DOMAINS) out[d.name] = d.mod(store);
  return out;
}

/**
 * Build the full CLI command table from domain manifests.
 * @returns {{ table: Object<string,{desc,usage,run,domain}>, byDomain: Object<string,string[]> }}
 */
function commandTable(store, instances) {
  const inst = instances || instantiate(store);
  const table = {};
  const byDomain = {};
  for (const d of DOMAINS) {
    if (!d.mod.commands) continue;
    const cmds = d.mod.commands(inst[d.name], util);
    for (const [name, spec] of Object.entries(cmds)) {
      if (table[name]) {
        // 插件命令与已注册命令冲突 → 跳过+告警（不让一个插件搞挂整个 CLI）；
        // 内置之间冲突才抛错（开发期错误）。Plugin collisions warn+skip; built-in
        // collisions throw (a developer bug).
        if (d.plugin) { console.error(`registry: plugin "${d.name}" command "${name}" collides with ${table[name].domain}; skipped`); continue; }
        throw new Error(`registry: duplicate command "${name}" (${table[name].domain} vs ${d.name})`);
      }
      table[name] = { ...spec, domain: d.name };
      (byDomain[d.name] = byDomain[d.name] || []).push(name);
    }
  }
  return { table, byDomain };
}

/**
 * All capture-router intents: domain-declared (built-in + in-process plugins)
 * ∪ connected MCP-plugin intents. Deduped by name (first wins → built-ins
 * shadow plugins). MCP intents appear only after initMcpPlugins() has run.
 */
function allIntents(store) {
  const out = [];
  const seen = new Set();
  const add = (it) => { if (it && !seen.has(it.name)) { seen.add(it.name); out.push(it); } };
  for (const d of DOMAINS) {
    if (d.mod.intents) for (const it of d.mod.intents(store)) add(it);
  }
  for (const it of _mcpIntents) add(it);
  return out;
}

/**
 * Connect the kind:'mcp' plugins from config/plugins.json and cache their
 * tool-derived intents. Best-effort + idempotent: a dead/missing plugin is
 * recorded in status and skipped, never fatal. Call once at daemon startup.
 * 连接跨进程 MCP 插件并缓存其 Intent；尽力而为且幂等，坏插件只记录不致命。
 */
async function initMcpPlugins({ config } = {}) {
  if (_mcpInited) return _mcpStatus;
  _mcpInited = true;
  const cfg = config || require('./plugins/loader').readPluginConfig();
  const bridge = require('./plugins/mcp_bridge');
  const entries = (cfg.plugins || []).filter((p) => p && p.kind === 'mcp' && p.enabled !== false);
  for (const entry of entries) {
    try {
      const transport = entry.transport || bridge.buildTransportFromConfig(entry);
      const { intents, close } = await bridge.connectMcpPlugin({
        name: entry.name, transport, confirm: entry.confirm || 'always',
      });
      _mcpIntents.push(...intents);
      _mcpClosers.push(close);
      _mcpStatus.connected.push({ name: entry.name, tools: intents.map((i) => i.name) });
    } catch (e) {
      _mcpStatus.errors.push({ name: entry.name, error: e.message });
    }
  }
  return _mcpStatus;
}

/** Close all connected MCP plugins (daemon shutdown). */
async function closeMcpPlugins() {
  for (const close of _mcpClosers) { try { await close(); } catch { /* ignore */ } }
  _mcpClosers = []; _mcpIntents = []; _mcpInited = false;
  _mcpStatus = { connected: [], errors: [] };
}

/** Operator view: which plugins are loaded / disabled / errored (in-proc + mcp). */
function pluginStatus() {
  return {
    inproc: {
      loaded: _pluginLoad.loaded.map((p) => ({ name: p.name, module: p.module })),
      disabled: _pluginLoad.disabled,
      errors: _pluginLoad.errors,
    },
    mcp: { inited: _mcpInited, ..._mcpStatus },
  };
}

module.exports = {
  DOMAINS, util, allTypes, instantiate, commandTable, allIntents,
  initMcpPlugins, closeMcpPlugins, pluginStatus,
};
