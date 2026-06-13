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

// 第三方/可选领域的接入缝（运行时动态插件，SPEC-plugins §1.6）。目前为空；
// 未来在此按允许清单 require 外部模块即可，registry 仍是唯一登记处。
// Seam for optional / third-party domains (runtime plugins). Empty for now.
for (const [name, path] of []) {
  try { DOMAINS.push({ name, mod: require(path) }); } catch { /* not present */ }
}

/** 小工具，传给各 domain 的 commands() 当第二参。 Arg helpers for command runners. */
const util = {
  csv: (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined),
  num: (v) => (v === undefined || v === true ? undefined : Number(v)),
};

/** All NEW entity types contributed by domains. */
function allTypes() {
  return DOMAINS.flatMap((d) => d.mod.types || []);
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
      if (table[name]) throw new Error(`registry: duplicate command "${name}" (${table[name].domain} vs ${d.name})`);
      table[name] = { ...spec, domain: d.name };
      (byDomain[d.name] = byDomain[d.name] || []).push(name);
    }
  }
  return { table, byDomain };
}

/** All capture-router intents contributed by domains (SPEC-plugins §3.3). */
function allIntents(store) {
  return DOMAINS.flatMap((d) => (d.mod.intents ? d.mod.intents(store) : []));
}

module.exports = { DOMAINS, util, allTypes, instantiate, commandTable, allIntents };
