'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { freshStore } = require('./helpers');
const { ingest } = require('../src/ingest');
const knowledgeDomain = require('../src/domains/knowledge');

// 离线 file-backed feeds（显式传入，避免命中网络）。
// Offline file-backed feeds, passed explicitly so the test never hits the network.
const FILE_FEEDS = [
  { name: 'Sample Blog', source: 'rss', category: 'tech', file: 'fixtures/sample-blog.rss.xml', limit: 20 },
  { name: '小红书样例', source: 'rss', category: 'life', file: 'fixtures/sample-xhs.rss.xml', limit: 20 },
];

test('ingest: file feeds insert knowledge_items, re-ingest is a no-op', async () => {
  const store = await freshStore();
  try {
    const first = await ingest({ store, feeds: FILE_FEEDS });
    assert.ok(first.total > 0, 'total should be > 0');
    assert.ok(first.inserted > 0, 'inserted should be > 0');
    assert.equal(first.errors.length, 0, 'no errors');
    assert.equal(first.inserted, first.total, 'all items inserted on first run');

    // 第二次入库：内容未变 -> 全部 unchanged。
    // Second ingest: content unchanged -> everything is unchanged.
    const second = await ingest({ store, feeds: FILE_FEEDS });
    assert.equal(second.inserted, 0, 're-ingest inserts nothing');
    assert.equal(second.unchanged, second.total, 're-ingest is all unchanged');
    assert.equal(second.total, first.total, 'same item count both runs');
  } finally { await store.close(); }
});

test('ingest: search finds an ingested item; related() works', async () => {
  const store = await freshStore();
  try {
    await ingest({ store, feeds: FILE_FEEDS });

    // "postgres" 出现在 blog fixture 的一条目标题里。
    // "postgres" appears in a blog fixture item title.
    const hits = await store.search('postgres', { type: 'knowledge_item' });
    assert.ok(hits.length > 0, 'search returns a knowledge_item');
    assert.equal(hits[0].type, 'knowledge_item');

    const kn = knowledgeDomain(store);
    const recent = await kn.recent({ limit: 50 });
    assert.ok(recent.length > 0, 'recent returns items');
    assert.equal(recent[0].type, 'knowledge_item');

    // related() 应正常运行（返回数组，不含自身）。
    // related() runs and excludes the seed item itself.
    const related = await kn.related(recent[0].id, { limit: 10 });
    assert.ok(Array.isArray(related));
    assert.ok(related.every((r) => r.id !== recent[0].id), 'related excludes self');
  } finally { await store.close(); }
});

test('ingest: deterministic ids dedup across stores (ki_ prefix)', async () => {
  const store = await freshStore();
  try {
    await ingest({ store, feeds: FILE_FEEDS });
    const kn = knowledgeDomain(store);
    const items = await kn.recent({ limit: 50 });
    assert.ok(items.every((i) => /^ki_/.test(i.id)), 'ids use ki_ prefix');
  } finally { await store.close(); }
});

// 引用 fixture 路径以确认相对 lifeos root 解析正确（防回归）。
// Reference the fixture path to confirm relative-to-root resolution.
test('fixtures resolve relative to lifeos root', () => {
  const fs = require('fs');
  const config = require('../src/config');
  const p = path.join(config.root, 'fixtures', 'sample-blog.rss.xml');
  assert.ok(fs.existsSync(p), 'blog fixture exists at lifeos/fixtures');
});
