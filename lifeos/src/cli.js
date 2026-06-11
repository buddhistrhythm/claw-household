#!/usr/bin/env node
'use strict';

/**
 * cli.js — lifeos command line.
 *
 *   node src/cli.js migrate
 *   node src/cli.js stats
 *   node src/cli.js search <query> [--type T]
 *   node src/cli.js sync-obsidian
 *   storage:
 *     node src/cli.js loc <name> [--kind K] [--parent ID]
 *     node src/cli.js put <item name> [--qty N] [--in LOCATION_ID]
 *     node src/cli.js where <item id>
 *     node src/cli.js contents <location id>
 *   credit card:
 *     node src/cli.js cc-add <card> [--issuer X] [--applied YYYY-MM-DD] [--fee N] [--bonus-deadline YYYY-MM-DD]
 *     node src/cli.js cc-list [--status S]
 *     node src/cli.js cc-deadlines [--days N]
 */

const { createStore } = require('./store');
const storageDomain = require('./domains/storage');
const creditCardDomain = require('./domains/credit_card');
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

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  if (!cmd || cmd === 'help') return printHelp();

  const store = await createStore();
  const storage = storageDomain(store);
  const cc = creditCardDomain(store);
  const out = (o) => console.log(JSON.stringify(o, null, 2));

  try {
    switch (cmd) {
      case 'migrate': out({ migrated: true, schema: store.db.schema }); break;
      case 'stats': out(await store.stats()); break;
      case 'search': out(await store.search(positional.join(' '), { type: flags.type })); break;

      case 'loc': out(await storage.createLocation({ name: positional.join(' '), kind: flags.kind, parentId: flags.parent })); break;
      case 'put': out(await storage.createItem({ name: positional.join(' '), quantity: flags.qty ? Number(flags.qty) : 1, locationId: flags.in })); break;
      case 'where': out(await storage.whereIs(positional[0])); break;
      case 'contents': out(await storage.contents(positional[0])); break;

      case 'cc-add': out(await cc.create({
        card: positional.join(' '), issuer: flags.issuer, applied_on: flags.applied,
        annual_fee: flags.fee ? Number(flags.fee) : undefined, bonus_deadline: flags['bonus-deadline'],
      })); break;
      case 'cc-list': out(await cc.list({ status: flags.status })); break;
      case 'cc-deadlines': out(await cc.upcomingBonusDeadlines({ days: flags.days ? Number(flags.days) : 30 })); break;

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
  console.log(`lifeos — Postgres life/household info store (DB主 + Obsidian镜像)

  migrate | stats | search <q> [--type T] | sync-obsidian
  storage:  loc <name> [--kind K] [--parent ID]
            put <item> [--qty N] [--in LOC_ID] | where <item id> | contents <loc id>
  credit:   cc-add <card> [--issuer X] [--applied YYYY-MM-DD] [--fee N] [--bonus-deadline DATE]
            cc-list [--status S] | cc-deadlines [--days N]

Set DATABASE_URL (default postgres://lifeos:lifeos@localhost:5432/lifeos).`);
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
