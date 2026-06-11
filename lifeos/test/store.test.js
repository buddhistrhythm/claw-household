'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { freshStore } = require('./helpers');

test('entities: create / get / patch / mergeData', async () => {
  const store = await freshStore();
  try {
    const e = await store.entities.create({
      type: 'note', title: 'Hello', body: 'world', tags: ['a', 'b'], data: { n: 1 },
    });
    assert.match(e.id, /^ent_/);
    assert.deepEqual(e.tags, ['a', 'b']);
    assert.equal(e.data.n, 1);

    const got = await store.entities.get(e.id);
    assert.equal(got.title, 'Hello');

    const patched = await store.entities.patch(e.id, { status: 'done', tags: ['c'] });
    assert.equal(patched.status, 'done');
    assert.deepEqual(patched.tags, ['c']);

    const merged = await store.entities.mergeData(e.id, { m: 2 });
    assert.deepEqual(merged.data, { n: 1, m: 2 }); // merge, not replace
  } finally { await store.close(); }
});

test('entities: list filters by type / tag / status', async () => {
  const store = await freshStore();
  try {
    await store.entities.create({ type: 'note', title: 'n1', tags: ['x'], status: 'open' });
    await store.entities.create({ type: 'note', title: 'n2', tags: ['y'], status: 'open' });
    await store.entities.create({ type: 'item', title: 'i1', tags: ['x'] });

    assert.equal((await store.entities.list({ type: 'note' })).length, 2);
    assert.equal((await store.entities.list({ tag: 'x' })).length, 2);
    assert.equal((await store.entities.list({ type: 'note', status: 'open' })).length, 2);
    assert.equal((await store.entities.list({ type: 'item', tag: 'x' })).length, 1);
  } finally { await store.close(); }
});

test('full-text search ranks by relevance', async () => {
  const store = await freshStore();
  try {
    await store.entities.create({ type: 'note', title: 'Postgres tuning', body: 'vacuum and indexes' });
    await store.entities.create({ type: 'note', title: 'Rust ownership', body: 'borrow checker' });
    const hits = await store.search('postgres');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, 'Postgres tuning');
  } finally { await store.close(); }
});

test('relations: link / from / toward / replace / cascade delete', async () => {
  const store = await freshStore();
  try {
    const a = await store.entities.create({ type: 'item', title: 'A' });
    const l1 = await store.entities.create({ type: 'storage_location', title: 'Drawer' });
    const l2 = await store.entities.create({ type: 'storage_location', title: 'Cabinet' });

    await store.relations.link(a.id, 'stored_in', l1.id);
    assert.equal((await store.relations.from(a.id, 'stored_in'))[0].object_id, l1.id);
    assert.equal((await store.relations.toward(l1.id, 'stored_in')).length, 1);

    // replace → single-valued
    await store.relations.replace(a.id, 'stored_in', l2.id);
    const after = await store.relations.from(a.id, 'stored_in');
    assert.equal(after.length, 1);
    assert.equal(after[0].object_id, l2.id);

    // deleting the entity cascades its edges
    await store.entities.remove(a.id);
    assert.equal((await store.relations.toward(l2.id, 'stored_in')).length, 0);
  } finally { await store.close(); }
});

test('stats reports type counts + relation count', async () => {
  const store = await freshStore();
  try {
    const a = await store.entities.create({ type: 'item', title: 'A' });
    const b = await store.entities.create({ type: 'storage_location', title: 'B' });
    await store.relations.link(a.id, 'stored_in', b.id);
    const s = await store.stats();
    assert.equal(s.total, 2);
    assert.equal(s.relations, 1);
    assert.equal(s.types.item, 1);
  } finally { await store.close(); }
});
