'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { normalize, makeId } = require('../src/model/item');

test('normalize derives a stable id from source + source_id', () => {
  const a = normalize({ source: 'hackernews', source_id: '123', title: 'A' });
  const b = normalize({ source: 'hackernews', source_id: '123', title: 'A different title' });
  assert.equal(a.id, b.id, 'same source+source_id → same id');
  assert.equal(a.id, makeId('hackernews', '123'));
});

test('normalize content_hash ignores fetched_at but tracks content', () => {
  const base = { source: 'rss', source_id: 'x', title: 'T', content: 'hello' };
  const a = normalize({ ...base, fetched_at: '2026-01-01T00:00:00Z' });
  const b = normalize({ ...base, fetched_at: '2026-06-01T00:00:00Z' });
  assert.equal(a.content_hash, b.content_hash, 'fetched_at must not change hash');

  const c = normalize({ ...base, content: 'hello world' });
  assert.notEqual(a.content_hash, c.content_hash, 'changed content → new hash');
});

test('normalize requires a source', () => {
  assert.throws(() => normalize({ title: 'no source' }), /source/);
});

test('normalize lowercases + dedups tags and builds an excerpt', () => {
  const item = normalize({
    source: 'x', source_id: '1', title: 'T',
    content: 'word '.repeat(200), tags: ['LLM', 'llm', 'Rust'],
  });
  assert.deepEqual(item.tags, ['llm', 'rust']);
  assert.ok(item.excerpt.length <= 241);
  assert.ok(item.excerpt.endsWith('…'));
});
