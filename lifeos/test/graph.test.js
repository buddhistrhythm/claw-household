'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { freshStore } = require('./helpers');
const graphFactory = require('../src/graph');

test('neighbors: out / in / both + predicate filter', async () => {
  const store = await freshStore();
  try {
    const g = graphFactory(store);
    const a = await store.entities.create({ type: 'note', title: 'A' });
    const b = await store.entities.create({ type: 'note', title: 'B' });
    const c = await store.entities.create({ type: 'note', title: 'C' });
    // A -links_to-> B ; C -mentions-> A
    await store.relations.link(a.id, 'links_to', b.id);
    await store.relations.link(c.id, 'mentions', a.id);

    const out = await g.neighbors(a.id, { direction: 'out' });
    assert.equal(out.length, 1);
    assert.equal(out[0].node.id, b.id);
    assert.equal(out[0].edge.dir, 'out');

    const inc = await g.neighbors(a.id, { direction: 'in' });
    assert.equal(inc.length, 1);
    assert.equal(inc[0].node.id, c.id);
    assert.equal(inc[0].edge.dir, 'in');

    const both = await g.neighbors(a.id, { direction: 'both' });
    assert.equal(both.length, 2);

    const filtered = await g.neighbors(a.id, { predicate: 'links_to' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].node.id, b.id);

    // briefNode shape
    assert.ok('url' in out[0].node);
    assert.equal(out[0].node.title, 'B');
  } finally { await store.close(); }
});

test('expand: depth=1 and depth=2 node/edge counts', async () => {
  const store = await freshStore();
  try {
    const g = graphFactory(store);
    // chain A - B - C - D
    const a = await store.entities.create({ type: 'note', title: 'A' });
    const b = await store.entities.create({ type: 'note', title: 'B' });
    const c = await store.entities.create({ type: 'note', title: 'C' });
    const d = await store.entities.create({ type: 'note', title: 'D' });
    await store.relations.link(a.id, 'r', b.id);
    await store.relations.link(b.id, 'r', c.id);
    await store.relations.link(c.id, 'r', d.id);

    const d1 = await g.expand(a.id, { depth: 1 });
    // root A + neighbor B
    assert.equal(d1.nodes.length, 2);
    assert.equal(d1.edges.length, 1);
    assert.ok(d1.nodes.some((n) => n.id === a.id));
    assert.ok(d1.nodes.some((n) => n.id === b.id));

    const d2 = await g.expand(a.id, { depth: 2 });
    // A, B, C  (+ edges A-B, B-C)
    assert.equal(d2.nodes.length, 3);
    assert.equal(d2.edges.length, 2);
    assert.ok(d2.nodes.some((n) => n.id === c.id));
    assert.equal(d2.root, a.id);

    // node cap respected
    const capped = await g.expand(a.id, { depth: 3, limit: 2 });
    assert.ok(capped.nodes.length <= 2);
  } finally { await store.close(); }
});

test('buildSimilarityEdges: links pairs sharing >= minShared, skips fewer', async () => {
  const store = await freshStore();
  try {
    const g = graphFactory(store);
    // k1 & k2 share two tags (rust, async) → edge.
    const k1 = await store.entities.create({ type: 'knowledge_item', title: 'K1', tags: ['rust', 'async'], topics: [] });
    const k2 = await store.entities.create({ type: 'knowledge_item', title: 'K2', tags: ['rust', 'async'], topics: [] });
    // k3 shares only one tag with k1 → no edge.
    const k3 = await store.entities.create({ type: 'knowledge_item', title: 'K3', tags: ['rust'], topics: [] });

    const res = await g.buildSimilarityEdges({ type: 'knowledge_item', minShared: 2 });
    assert.equal(res.pairs, 1);
    assert.equal(res.created, 1);

    // canonical edge between k1,k2 exists (in either subject/object slot)
    const subj = k1.id < k2.id ? k1.id : k2.id;
    const obj = k1.id < k2.id ? k2.id : k1.id;
    const edges = await store.relations.from(subj, 'related_to');
    assert.equal(edges.length, 1);
    assert.equal(edges[0].object_id, obj);
    assert.equal(edges[0].weight, 2);
    assert.deepEqual(edges[0].data.shared.sort(), ['async', 'rust']);

    // k3 has no related_to edge
    const noEdge = await store.relations.neighbors(k3.id);
    assert.equal(noEdge.filter((e) => e.predicate === 'related_to').length, 0);

    // neighbors treats it as bidirectional (from + toward)
    const k2nbrs = await g.neighbors(k2.id, { predicate: 'related_to' });
    assert.equal(k2nbrs.length, 1);
    assert.equal(k2nbrs[0].node.id, k1.id);

    // idempotent upsert: re-run does not duplicate
    const res2 = await g.buildSimilarityEdges({ type: 'knowledge_item', minShared: 2 });
    assert.equal(res2.created, 1);
    assert.equal((await store.relations.from(subj, 'related_to')).length, 1);
  } finally { await store.close(); }
});
