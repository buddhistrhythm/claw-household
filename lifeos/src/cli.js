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
const notesDomain = require('./domains/notes');
const libraryDomain = require('./domains/library');
const financeDomain = require('./domains/finance');
const knowledgeDomain = require('./domains/knowledge');
const graphFactory = require('./graph');
const { ingest } = require('./ingest');
const { writeEntityNote } = require('./obsidian');
const { BUILTIN_TYPES } = require('./store/types');
const config = require('./config');

const csv = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const num = (v) => (v === undefined || v === true ? undefined : Number(v));

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

  // MCP runs its own store + a blocking stdio transport; don't open/close here.
  if (cmd === 'mcp') return require('./mcp/server').startMcp();

  const store = await createStore();
  const storage = storageDomain(store);
  const cc = creditCardDomain(store);
  const notes = notesDomain(store);
  const library = libraryDomain(store);
  const finance = financeDomain(store);
  const knowledge = knowledgeDomain(store);
  const graph = graphFactory(store);
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

      // notes
      case 'note-add': out(await notes.create({ title: positional.join(' '), body: typeof flags.body === 'string' ? flags.body : undefined, tags: csv(flags.tags), topics: csv(flags.topics), about: typeof flags.about === 'string' ? flags.about : undefined, family_id: flags.family })); break;
      case 'note-append': out(await notes.append(positional[0], positional.slice(1).join(' '))); break;
      case 'note-link': out(await notes.link(positional[0], positional[1], flags.predicate || 'about')); break;
      case 'note-for': out(await notes.forEntity(positional[0])); break;
      case 'notes': out(await notes.list({ tag: flags.tag, family_id: flags.family })); break;
      case 'note-search': out(await notes.search(positional.join(' '), { family_id: flags.family })); break;

      // reading / books
      case 'book-add': out(await library.addBook({ title: positional.join(' '), author: flags.author, isbn: flags.isbn, year: num(flags.year), publisher: flags.publisher, total_pages: num(flags.pages), status: flags.status, family_id: flags.family })); break;
      case 'book-status': out(await library.setStatus(positional[0], positional[1], { rating: num(flags.rating), started_on: flags.started, finished_on: flags.finished })); break;
      case 'book-progress': out(await library.updateProgress(positional[0], Number(positional[1]))); break;
      case 'book-rate': out(await library.rate(positional[0], Number(positional[1]))); break;
      case 'reading': out(await library.currentlyReading()); break;
      case 'books': out(await library.list({ status: flags.status, family_id: flags.family })); break;
      case 'books-finished': out(await library.finishedInYear(Number(positional[0]))); break;

      // finance
      case 'acct-add': out(await finance.createAccount({ name: positional.join(' '), kind: flags.kind, institution: flags.institution, currency: flags.currency, last4: flags.last4, account_number: flags['account-number'], family_id: flags.family })); break;
      case 'txn-add': out(await finance.addTxn({ account_id: flags.account, amount_cents: num(flags['amount-cents']), direction: flags.direction, category: flags.category, merchant: flags.merchant, posted_on: flags['posted-on'], memo: flags.memo, raw_descriptor: flags['raw-descriptor'], currency: flags.currency, family_id: flags.family })); break;
      case 'txn-list': out(await finance.listTxns({ account_id: flags.account, category: flags.category, from: flags.from, to: flags.to, limit: num(flags.limit) })); break;
      case 'balance': out(await finance.balance(positional[0])); break;
      case 'spend': out(await finance.spendByCategory({ from: flags.from, to: flags.to, family_id: flags.family })); break;
      case 'reveal': out(await finance.reveal(positional[0])); break;
      case 'acct-reveal': out(await finance.revealAccount(positional[0])); break;

      // knowledge / rss ingest
      case 'ingest': out(await ingest({ store, source: flags.source, category: flags.category, limit: num(flags.limit), log: (m) => console.error(m) })); break;
      case 'ki-recent': out(await knowledge.recent({ tag: flags.tag, limit: num(flags.limit) })); break;
      case 'ki-related': out(await knowledge.related(positional[0], { limit: num(flags.limit) })); break;
      case 'ki-search': out(await knowledge.search(positional.join(' '), {})); break;

      // knowledge graph
      case 'graph-neighbors': out(await graph.neighbors(positional[0], { predicate: flags.predicate, limit: num(flags.limit) })); break;
      case 'graph-expand': out(await graph.expand(positional[0], { depth: flags.depth ? Number(flags.depth) : 1 })); break;
      case 'graph-build': out(await graph.buildSimilarityEdges({})); break;

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

  core:     migrate | stats | search <q> [--type T] | sync-obsidian | mcp
  storage:  loc <name> [--kind K] [--parent ID]
            put <item> [--qty N] [--in LOC_ID] | where <item id> | contents <loc id>
  credit:   cc-add <card> [--issuer X] [--applied DATE] [--fee N] [--bonus-deadline DATE]
            cc-list [--status S] | cc-deadlines [--days N]
  notes:    note-add <title> [--body B] [--tags a,b] [--about ID] | note-append <id> <text>
            note-link <noteId> <targetId> [--predicate P] | note-for <id> | notes [--tag T] | note-search <q>
  reading:  book-add <title> [--author A] [--year N] [--status want|reading|finished|abandoned]
            book-status <id> <status> [--rating N] [--finished DATE] | book-progress <id> <pct>
            book-rate <id> <n> | reading | books [--status S] | books-finished <year>
  finance:  acct-add <name> [--kind K] [--institution I] [--last4 N] [--account-number N]
            txn-add --account ID --amount-cents N --direction debit|credit [--category C] [--merchant M] [--posted-on DATE] [--memo M]
            txn-list [--account ID] [--category C] [--from DATE] [--to DATE] | balance <acct id>
            spend [--from DATE] [--to DATE] | reveal <txn id> | acct-reveal <acct id>
  knowledge: ingest [--source S] [--category C] [--limit N] | ki-recent [--tag T] | ki-related <id> | ki-search <q>
  graph:    graph-neighbors <id> [--predicate P] | graph-expand <id> [--depth N] | graph-build

Set DATABASE_URL (default postgres://lifeos:lifeos@localhost:5432/lifeos).
MCP: \`node src/cli.js mcp\` starts a stdio Model Context Protocol server.`);
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
