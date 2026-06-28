'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { freshStore } = require('./helpers');
const graphFactory = require('../src/graph');
const { buildServer, assembleContext } = require('../src/mcp/server');

test('buildServer returns a truthy McpServer without throwing', async () => {
  const store = await freshStore();
  try {
    const server = await buildServer(store);
    assert.ok(server, 'expected a server instance');
    // McpServer exposes .connect — light structural sanity check, no private internals
    assert.equal(typeof server.connect, 'function');
  } finally { await store.close(); }
});

test('assembleContext: cited context includes the searched item + 1-hop neighbor', async () => {
  const store = await freshStore();
  try {
    const graph = graphFactory(store);

    const hit = await store.entities.create({
      type: 'knowledge_item',
      title: 'Postgres vacuum tuning',
      summary: 'How autovacuum keeps tables healthy.',
      body: 'autovacuum, bloat, indexes',
      data: { url: 'https://example.com/vacuum' },
      tags: ['postgres'],
    });
    const neighbor = await store.entities.create({
      type: 'knowledge_item',
      title: 'Index maintenance',
      summary: 'Reindexing strategies.',
      source_ref: 'ref-index-123',
      tags: ['postgres'],
    });
    // hit -references-> neighbor
    await store.relations.link(hit.id, 'references', neighbor.id);

    const ctx = await assembleContext(store, graph, 'postgres vacuum', { hops: 5, limit: 5 });

    assert.equal(ctx.query, 'postgres vacuum');
    assert.ok(ctx.note.includes('citations'));

    const direct = ctx.sources.find((s) => s.id === hit.id);
    assert.ok(direct, 'searched item must be in sources');
    assert.equal(direct.why, 'matched query');
    assert.equal(direct.citation, 'https://example.com/vacuum'); // data.url preferred
    assert.ok(direct.excerpt.length > 0);

    const linked = ctx.sources.find((s) => s.id === neighbor.id);
    assert.ok(linked, '1-hop neighbor must be pulled in');
    assert.equal(linked.why, 'linked via references');
    assert.equal(linked.citation, 'ref-index-123'); // falls back to source_ref
  } finally { await store.close(); }
});

test('assembleContext: empty query yields no sources', async () => {
  const store = await freshStore();
  try {
    const graph = graphFactory(store);
    const ctx = await assembleContext(store, graph, '', {});
    assert.deepEqual(ctx.sources, []);
  } finally { await store.close(); }
});
