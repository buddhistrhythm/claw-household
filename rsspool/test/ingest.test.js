'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { create } = require('../src/storage/sqlite');
const obsidianFactory = require('../src/storage/obsidian');
const { ingest } = require('../src/pipeline/ingest');
const { generateQuiz } = require('../src/quiz/generate');
const { loadFeed } = require('../src/feed/load');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

// File-backed feeds so the pipeline runs fully offline (no RSSHub/network).
const FEEDS = [
  { name: 'Sample Eng Blog', source: 'blog', category: 'tech', file: path.join(FIXTURES, 'sample-blog.rss.xml') },
  { name: '小红书收藏', source: 'xiaohongshu', category: 'life', file: path.join(FIXTURES, 'sample-xhs.rss.xml') },
];

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rsspool-'));
}

test('loadFeed stamps feed identity (source / source_name / category)', async () => {
  const items = await loadFeed(FEEDS[0]);
  assert.equal(items.length, 3);
  assert.ok(items.every((i) => i.source === 'blog'));
  assert.ok(items.every((i) => i.source_name === 'Sample Eng Blog'));
  assert.ok(items.every((i) => i.topics.includes('tech')));
});

test('ingest pipeline: feeds → store + Obsidian, deterministic + idempotent', async () => {
  const dir = tmp();
  const store = create(path.join(dir, 'rsspool.db'));
  await store.init();
  const obsidian = obsidianFactory.create(path.join(dir, 'vault'), { enabled: true });

  const first = await ingest({ store, obsidian, feeds: FEEDS, rsshub: {} });
  assert.equal(first.errors.length, 0, JSON.stringify(first.errors));
  assert.equal(first.inserted, 5);
  assert.equal(first.total, 5);
  assert.equal(first.bySource.blog.inserted, 3);
  assert.equal(first.bySource.xiaohongshu.inserted, 2);

  // Obsidian notes written, organized by feed source.
  assert.ok(fs.existsSync(path.join(dir, 'vault', 'blog')));
  assert.ok(fs.existsSync(path.join(dir, 'vault', 'xiaohongshu')));
  const blogNotes = fs.readdirSync(path.join(dir, 'vault', 'blog'));
  assert.ok(blogNotes.length === 3 && blogNotes.every((f) => f.endsWith('.md')));

  // Enrichment derived topical tags beyond the source/category tags.
  const hits = await store.searchItems('mcp');
  assert.ok(hits.some((i) => (i.tags || []).includes('agents')), 'expected agents tag from enrich');

  // Re-running is idempotent (content unchanged → no inserts/updates).
  const second = await ingest({ store, obsidian, feeds: FEEDS, rsshub: {} });
  assert.equal(second.inserted, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.unchanged, 5);

  await store.close();
});

test('ingest source filter only pulls matching feeds', async () => {
  const dir = tmp();
  const store = create(path.join(dir, 'rsspool.db'));
  await store.init();
  const summary = await ingest({ store, feeds: FEEDS, rsshub: {}, source: 'blog' });
  assert.equal(summary.feeds, 1);
  assert.equal(summary.inserted, 3);
  await store.close();
});

test('quiz generates well-formed multiple-choice levels', async () => {
  const dir = tmp();
  const store = create(path.join(dir, 'rsspool.db'));
  await store.init();
  await ingest({ store, feeds: FEEDS, rsshub: {} });

  const quiz = await generateQuiz(store, { count: 3 });
  assert.ok(quiz.levels.length >= 1);
  for (const lvl of quiz.levels) {
    assert.ok(lvl.question.choices.length >= 3);
    assert.ok(lvl.question.answer >= 0 && lvl.question.answer < lvl.question.choices.length);
  }
  await store.close();
});
