#!/usr/bin/env node
'use strict';

/**
 * cli.js — command-line entry point for the personal knowledge base.
 *
 *   node src/cli.js ingest [sources...] [--limit N]
 *   node src/cli.js search <query> [--source S] [--limit N]
 *   node src/cli.js recent [--source S] [--tag T] [--limit N]
 *   node src/cli.js get <id>
 *   node src/cli.js stats
 *   node src/cli.js quiz [--topic T] [--count N]
 *   node src/cli.js export-notebooklm [--topic T]
 *   node src/cli.js mcp                 # start the MCP stdio server
 */

const { createStore, createObsidian } = require('./storage');
const { ingest } = require('./pipeline/ingest');
const { generateQuiz } = require('./quiz/generate');
const { exportForNotebookLM } = require('./export/notebooklm');
const config = require('./config');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  if (cmd === 'mcp') {
    // MCP speaks on stdio — nothing else may write to stdout.
    return require('./mcp/server').startMcp();
  }

  if (!cmd || cmd === 'help' || cmd === '--help') {
    printHelp();
    return;
  }

  const store = await createStore();
  try {
    switch (cmd) {
      case 'ingest': {
        const sources = positional.length ? positional : undefined;
        const obsidian = createObsidian();
        const summary = await ingest({
          store, obsidian, sources,
          limit: flags.limit ? Number(flags.limit) : undefined,
          log: (m) => console.error(m),
        });
        console.log(JSON.stringify(summary, null, 2));
        if (obsidian.enabled) console.error(`Obsidian vault: ${obsidian.vaultDir}`);
        break;
      }
      case 'search': {
        const items = await store.searchItems(positional.join(' '), {
          limit: flags.limit ? Number(flags.limit) : 15,
          source: flags.source,
        });
        printList(items);
        break;
      }
      case 'recent': {
        const items = await store.listItems({
          source: flags.source, tag: flags.tag,
          limit: flags.limit ? Number(flags.limit) : 20,
        });
        printList(items);
        break;
      }
      case 'get': {
        const item = await store.getItem(positional[0]);
        console.log(JSON.stringify(item, null, 2));
        break;
      }
      case 'stats': {
        console.log(JSON.stringify(await store.stats(), null, 2));
        break;
      }
      case 'quiz': {
        const quiz = await generateQuiz(store, {
          topic: flags.topic,
          count: flags.count ? Number(flags.count) : 5,
        });
        console.log(JSON.stringify(quiz, null, 2));
        break;
      }
      case 'export-notebooklm': {
        const res = await exportForNotebookLM(store, { topic: flags.topic, dir: config.exportDir });
        console.log(`Exported ${res.count} items → ${res.dir}`);
        for (const f of res.files) console.log(`  - ${f}`);
        break;
      }
      default:
        console.error(`Unknown command: ${cmd}`);
        printHelp();
        process.exitCode = 1;
    }
  } finally {
    await store.close();
  }
}

function printList(items) {
  if (!items.length) { console.log('(no results)'); return; }
  for (const i of items) {
    console.log(`\n[${i.source_name}] ${i.title}`);
    if (i.tags && i.tags.length) console.log(`  tags: ${i.tags.join(', ')}`);
    if (i.url) console.log(`  ${i.url}`);
    console.log(`  id: ${i.id}`);
  }
  console.log(`\n${items.length} result(s)`);
}

function printHelp() {
  console.log(`knowledge-base CLI

  ingest [sources...] [--limit N]      pull likes/feeds → store + Obsidian
  search <query> [--source S] [--limit N]
  recent [--source S] [--tag T] [--limit N]
  get <id>
  stats
  quiz [--topic T] [--count N]         A-Tour-of-Go-style study levels
  export-notebooklm [--topic T]        bundle markdown sources for NotebookLM
  mcp                                  start the MCP stdio server

Sources: hackernews, rss, x, xiaohongshu`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
