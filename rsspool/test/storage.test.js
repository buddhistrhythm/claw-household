'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { create } = require('../src/storage/sqlite');
const { normalize } = require('../src/model/item');

function tmpDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-')), 'kb.db');
}

test('sqlite upsert reports inserted / unchanged / updated', async () => {
  const store = create(tmpDb());
  await store.init();

  const item = normalize({ source: 'x', source_id: '1', title: 'Hello', content: 'world' });
  assert.equal((await store.upsertItem(item)).status, 'inserted');
  assert.equal((await store.upsertItem(item)).status, 'unchanged');

  const changed = normalize({ source: 'x', source_id: '1', title: 'Hello', content: 'world again' });
  assert.equal((await store.upsertItem(changed)).status, 'updated');

  const got = await store.getItem(item.id);
  assert.equal(got.content, 'world again');
  await store.close();
});

test('sqlite full-text search + tag listing', async () => {
  const store = create(tmpDb());
  await store.init();
  await store.upsertItem(normalize({ source: 'rss', source_id: 'a', title: 'Postgres at scale', content: 'sharding database', tags: ['database'] }));
  await store.upsertItem(normalize({ source: 'rss', source_id: 'b', title: 'Rust ownership', content: 'borrow checker', tags: ['rust'] }));

  const hits = await store.searchItems('postgres');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, 'Postgres at scale');

  const byTag = await store.listItems({ tag: 'rust' });
  assert.equal(byTag.length, 1);
  assert.equal(byTag[0].title, 'Rust ownership');

  const stats = await store.stats();
  assert.equal(stats.total, 2);
  assert.equal(stats.sources.rss, 2);
  await store.close();
});
