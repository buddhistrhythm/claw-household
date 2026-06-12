'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { freshStore } = require('./helpers');
const eventsDomain = require('../src/domains/events');
const storageDomain = require('../src/domains/storage');

test('events: record creates a life_event with an `on` edge to the target', async () => {
  const store = await freshStore();
  const events = eventsDomain(store);
  const storage = storageDomain(store);
  try {
    const milk = await storage.createItem({ name: '牛奶', quantity: 6, unit: '盒' });
    const ev = await events.record({
      verb: 'fed', target_id: milk.id, qty: 1, unit: '盒',
      note: '晚上喂奶', source: 'manual', data: { who: '宝宝' },
    });

    assert.ok(ev.id.startsWith('evt_'));
    assert.equal(ev.type, 'life_event');
    assert.equal(ev.title, 'fed');
    assert.ok(ev.occurred_at, 'occurred_at defaults to now');
    assert.equal(ev.source, 'manual');
    assert.equal(ev.data.verb, 'fed');
    assert.equal(ev.data.qty, 1);
    assert.equal(ev.data.unit, '盒');
    assert.equal(ev.data.note, '晚上喂奶');
    assert.equal(ev.data.who, '宝宝');

    const edges = await store.relations.toward(milk.id, 'on');
    assert.equal(edges.length, 1);
    assert.equal(edges[0].subject_id, ev.id);
    assert.equal(edges[0].predicate, 'on');
  } finally { await store.close(); }
});

test('events: record without verb throws; event without target has no edge', async () => {
  const store = await freshStore();
  const events = eventsDomain(store);
  try {
    await assert.rejects(() => events.record({ qty: 1 }), /verb/);
    const ev = await events.record({ verb: 'paid', qty: 42 });
    assert.deepEqual(await store.relations.from(ev.id, 'on'), []);
  } finally { await store.close(); }
});

test('events: consume / restock sugar', async () => {
  const store = await freshStore();
  const events = eventsDomain(store);
  const storage = storageDomain(store);
  try {
    const rice = await storage.createItem({ name: '大米', quantity: 2, unit: '袋' });

    const c = await events.consume(rice.id, 3, { note: '做饭' });
    assert.equal(c.data.verb, 'consume');
    assert.equal(c.data.qty, 3);
    assert.equal(c.data.note, '做饭');

    const r = await events.restock(rice.id);
    assert.equal(r.data.verb, 'restock');
    assert.equal(r.data.qty, 1);

    const edges = await store.relations.toward(rice.id, 'on');
    assert.equal(edges.length, 2);
  } finally { await store.close(); }
});

test('events: timeline ordering, verb filter, and limit', async () => {
  const store = await freshStore();
  const events = eventsDomain(store);
  const storage = storageDomain(store);
  try {
    const item = await storage.createItem({ name: '纸巾', quantity: 10 });
    await events.record({ verb: 'consume', target_id: item.id, qty: 1, occurred_at: '2026-06-01T08:00:00Z' });
    await events.record({ verb: 'restock', target_id: item.id, qty: 5, occurred_at: '2026-06-03T08:00:00Z' });
    await events.record({ verb: 'consume', target_id: item.id, qty: 2, occurred_at: '2026-06-02T08:00:00Z' });

    // Newest first.
    const all = await events.timeline(item.id);
    assert.deepEqual(all.map((e) => e.data.verb), ['restock', 'consume', 'consume']);
    assert.deepEqual(all.map((e) => e.data.qty), [5, 2, 1]);

    // Verb filter.
    const consumes = await events.timeline(item.id, { verb: 'consume' });
    assert.deepEqual(consumes.map((e) => e.data.qty), [2, 1]);

    // Limit.
    const top2 = await events.timeline(item.id, { limit: 2 });
    assert.equal(top2.length, 2);
    assert.deepEqual(top2.map((e) => e.data.verb), ['restock', 'consume']);
  } finally { await store.close(); }
});

test('events: foldQuantity — baseline 10, consume 3+2, restock 5 → current 10', async () => {
  const store = await freshStore();
  const events = eventsDomain(store);
  const storage = storageDomain(store);
  try {
    const item = await storage.createItem({ name: '尿裤', quantity: 10, unit: '片' });
    await events.consume(item.id, 3);
    await events.consume(item.id, 2);
    await events.restock(item.id, 5);

    const fold = await events.foldQuantity(item.id);
    assert.deepEqual(fold, {
      target_id: item.id, baseline: 10, consumed: 5, restocked: 5, current: 10,
    });
  } finally { await store.close(); }
});

test('events: applyFold materializes quantity_current without clobbering quantity', async () => {
  const store = await freshStore();
  const events = eventsDomain(store);
  const storage = storageDomain(store);
  try {
    const item = await storage.createItem({ name: '奶粉', quantity: 10, unit: '罐' });
    await events.consume(item.id, 3);
    await events.consume(item.id, 2);
    await events.restock(item.id, 5);

    const fold = await events.applyFold(item.id);
    assert.equal(fold.current, 10);

    const after = await store.entities.get(item.id);
    assert.equal(after.data.quantity_current, 10, 'derived value materialized');
    assert.equal(after.data.quantity, 10, 'baseline quantity untouched');
  } finally { await store.close(); }
});

test('events: recent filters by verb across the global stream', async () => {
  const store = await freshStore();
  const events = eventsDomain(store);
  try {
    await events.record({ verb: 'consume', qty: 1, occurred_at: '2026-06-01T00:00:00Z' });
    await events.record({ verb: 'paid', qty: 99, occurred_at: '2026-06-02T00:00:00Z' });
    await events.record({ verb: 'consume', qty: 2, occurred_at: '2026-06-03T00:00:00Z' });

    const consumes = await events.recent({ verb: 'consume' });
    assert.equal(consumes.length, 2);
    assert.ok(consumes.every((e) => e.data.verb === 'consume'));
    assert.deepEqual(consumes.map((e) => e.data.qty), [2, 1], 'newest first');

    const paid = await events.recent({ verb: 'paid', limit: 10 });
    assert.equal(paid.length, 1);
    assert.equal(paid[0].data.qty, 99);
  } finally { await store.close(); }
});

test('events: deleting the target cascades edges away; event entities remain', async () => {
  const store = await freshStore();
  const events = eventsDomain(store);
  const storage = storageDomain(store);
  try {
    const item = await storage.createItem({ name: '临时物品', quantity: 1 });
    const ev = await events.consume(item.id, 1);
    assert.equal((await store.relations.toward(item.id, 'on')).length, 1);

    await store.entities.remove(item.id);

    // Edges are gone (ON DELETE CASCADE) but the event entity survives.
    assert.deepEqual(await store.relations.toward(item.id, 'on'), []);
    const survivor = await store.entities.get(ev.id);
    assert.ok(survivor);
    assert.equal(survivor.data.verb, 'consume');
    assert.deepEqual(await events.timeline(item.id), []);
  } finally { await store.close(); }
});
