#!/usr/bin/env node
'use strict';

/**
 * cli.js — lifeos command line.
 *
 * Domain commands are NOT listed here: each domain declares its own commands
 * (module.exports.commands) and src/registry.js derives the dispatch table and
 * the help text. Only cross-domain infrastructure commands live in this file.
 * 领域命令不在本文件登记 —— 各领域模块自带 `commands` 声明，registry 派生分发表
 * 与帮助文本；这里只保留跨领域的基础设施命令。
 *
 * Run `node src/cli.js help` for the full, auto-generated command list.
 */

const { createStore } = require('./store');
const registry = require('./registry');
const graphFactory = require('./graph');
const semanticFactory = require('./semantic');
const { ingest } = require('./ingest');
const { writeEntityNote } = require('./obsidian');
const { BUILTIN_TYPES } = require('./store/types');
const config = require('./config');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const DOMAIN_OF = Object.fromEntries(BUILTIN_TYPES.map((t) => [t.type, t.domain]));
const { num } = registry.util;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  if (!cmd || cmd === 'help') return printHelp();

  // MCP servers run their own store + blocking transport; don't open/close here.
  if (cmd === 'mcp') return require('./mcp/server').startMcp();
  if (cmd === 'mcp-http') {
    return require('./mcp/http').startHttpMain({
      port: flags.port ? Number(flags.port) : undefined,
      host: typeof flags.host === 'string' ? flags.host : undefined,
    });
  }
  // PWA + JSON API daemon (mobile entry; behind Tailscale in compose).
  if (cmd === 'web') {
    return require('./web/server').startWebMain({
      port: flags.port ? Number(flags.port) : undefined,
      host: typeof flags.host === 'string' ? flags.host : undefined,
    });
  }
  // Plugin status (in-process allowlist + MCP). Read-only; no DB needed.
  // `--probe` also connects MCP plugins to report their tools.
  if (cmd === 'plugins') {
    if (flags.probe) await registry.initMcpPlugins().catch(() => {});
    console.log(JSON.stringify(registry.pluginStatus(), null, 2));
    if (flags.probe) await registry.closeMcpPlugins().catch(() => {});
    return;
  }

  const store = await createStore();
  const domains = registry.instantiate(store);
  const { table } = registry.commandTable(store, domains);
  const graph = graphFactory(store);
  const semantic = semanticFactory(store);
  const out = (o) => console.log(JSON.stringify(o, null, 2));

  try {
    // ── domain commands: derived from the manifests ──────────────────────────
    if (table[cmd]) { out(await table[cmd].run({ positional, flags, store, domains })); return; }

    switch (cmd) {
      // ── core ──────────────────────────────────────────────────────────────
      case 'migrate': out({ migrated: true, schema: store.db.schema }); break;
      case 'stats': out(await store.stats()); break;
      case 'search': out(await store.search(positional.join(' '), { type: flags.type })); break;
      case 'semantic-search': out(await semantic.semanticSearch(positional.join(' '), { type: flags.type, limit: num(flags.limit) })); break;
      case 'hybrid-search': out(await semantic.hybridSearch(positional.join(' '), { type: flags.type, limit: num(flags.limit) })); break;
      case 'reindex': out(await semantic.reindexAll({ type: flags.type, limit: num(flags.limit) })); break;

      // ── knowledge ingest（RSS/RSSHub → knowledge_item） ───────────────────
      case 'ingest': out(await ingest({ store, source: flags.source, category: flags.category, limit: num(flags.limit), log: (m) => console.error(m) })); break;

      // ── knowledge graph ───────────────────────────────────────────────────
      case 'graph-neighbors': out(await graph.neighbors(positional[0], { predicate: flags.predicate, limit: num(flags.limit) })); break;
      case 'graph-expand': out(await graph.expand(positional[0], { depth: flags.depth ? Number(flags.depth) : 1 })); break;
      case 'graph-build': out(await graph.buildSimilarityEdges({})); break;

      // ── migration importers（统一者，而非第三个 silo） ────────────────────
      case 'import-household': {
        const { importHousehold } = require('./import/household');
        out(await importHousehold({ store, dir: flags.dir || process.cwd(), dryRun: !!flags['dry-run'], log: (m) => console.error(m) }));
        break;
      }
      case 'import-rsspool': {
        const { importRsspool } = require('./import/rsspool');
        out(await importRsspool({ store, file: positional[0], log: (m) => console.error(m) }));
        break;
      }

      case 'sync-obsidian': {
        if (!config.obsidianEnabled) { console.error('Obsidian disabled'); break; }
        const all = await store.entities.list({ limit: 10000 });
        let n = 0;
        for (const e of all) {
          const rels = await store.relations.from(e.id);
          const edges = [];
          for (const r of rels) {
            const t = await store.entities.get(r.object_id);
            edges.push({ predicate: r.predicate, target: t ? { id: t.id, title: t.title } : { id: r.object_id, title: r.object_id } });
          }
          writeEntityNote(config.obsidianVault, e, edges, DOMAIN_OF[e.type] || 'general');
          n++;
        }
        console.error(`Wrote ${n} notes → ${config.obsidianVault}`);
        out({ synced: n });
        break;
      }

      default: console.error(`Unknown command: ${cmd}`); printHelp(); process.exitCode = 1;
    }
  } finally {
    await store.close();
  }
}

function printHelp() {
  const lines = [
    'lifeos — Postgres life/household info store (DB主 + Obsidian镜像)',
    '',
    '  core:      migrate | stats | search <q> [--type T] | hybrid-search <q> | semantic-search <q> | reindex',
    '             sync-obsidian | mcp | mcp-http [--port N] [--host H] | web [--port N] [--host H]',
    '             plugins [--probe]   (allowlist plugins: config/plugins.json; see plugins/README.md)',
    '  knowledge: ingest [--source S] [--category C] [--limit N]',
    '  graph:     graph-neighbors <id> [--predicate P] | graph-expand <id> [--depth N] | graph-build',
    '  import:    import-household [--dir D] [--dry-run] | import-rsspool <file.json|.jsonl|.db>',
  ];
  // Auto-generated from domain manifests / 以下由各领域 manifest 自动生成。
  const { table, byDomain } = registry.commandTable(null, mockInstances());
  for (const [domain, names] of Object.entries(byDomain)) {
    lines.push('', `  [${domain}]`);
    for (const name of names) lines.push(`    ${table[name].usage.padEnd(72)} ${table[name].desc}`);
  }
  lines.push('', 'Set DATABASE_URL (default postgres://lifeos:lifeos@localhost:5432/lifeos).');
  lines.push('MCP: `mcp` = stdio (client-spawned) · `mcp-http` = long-lived daemon (LIFEOS_MCP_TOKEN to auth).');
  console.log(lines.join('\n'));
}

/** help 不需要真 store：给 commands() 一个空实例占位。 No store needed for help. */
function mockInstances() {
  const out = {};
  for (const d of registry.DOMAINS) out[d.name] = new Proxy({}, { get: () => () => {} });
  return out;
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
