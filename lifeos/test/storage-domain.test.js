'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { freshStore } = require('./helpers');
const storageDomain = require('../src/domains/storage');

test('storage: nested locations, placement, whereIs chain, contents', async () => {
  const store = await freshStore();
  const storage = storageDomain(store);
  try {
    const room = await storage.createLocation({ name: '书房', kind: 'room' });
    const cabinet = await storage.createLocation({ name: '文件柜', kind: 'cabinet', parentId: room.id });
    const drawer = await storage.createLocation({ name: '第二抽屉', kind: 'drawer', parentId: cabinet.id });

    const passport = await storage.createItem({ name: '护照', locationId: drawer.id });

    // whereIs walks drawer → cabinet → room
    const w = await storage.whereIs(passport.id);
    assert.equal(w.located, true);
    assert.deepEqual(w.chain.map((c) => c.name), ['第二抽屉', '文件柜', '书房']);
    assert.equal(w.path, '第二抽屉 / 文件柜 / 书房');

    // contents of the drawer: the passport
    const c = await storage.contents(drawer.id);
    assert.equal(c.items.length, 1);
    assert.equal(c.items[0].name, '护照');

    // contents of the cabinet: the drawer as a sublocation
    const cc = await storage.contents(cabinet.id);
    assert.equal(cc.sublocations.length, 1);
    assert.equal(cc.sublocations[0].name, '第二抽屉');
  } finally { await store.close(); }
});

test('storage: moving an item replaces its placement', async () => {
  const store = await freshStore();
  const storage = storageDomain(store);
  try {
    const box1 = await storage.createLocation({ name: 'Box 1' });
    const box2 = await storage.createLocation({ name: 'Box 2' });
    const cable = await storage.createItem({ name: 'HDMI cable', locationId: box1.id });

    assert.equal((await storage.whereIs(cable.id)).chain[0].name, 'Box 1');
    await storage.place(cable.id, box2.id);
    assert.equal((await storage.whereIs(cable.id)).chain[0].name, 'Box 2');

    // Box 1 is now empty
    assert.equal((await storage.contents(box1.id)).items.length, 0);
  } finally { await store.close(); }
});

test('storage: unplaced item reports not located', async () => {
  const store = await freshStore();
  const storage = storageDomain(store);
  try {
    const item = await storage.createItem({ name: 'orphan' });
    const w = await storage.whereIs(item.id);
    assert.equal(w.located, false);
    assert.deepEqual(w.chain, []);
  } finally { await store.close(); }
});
