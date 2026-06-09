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

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kb-ing-'));
}

// Only the fixture-backed connectors (x, xiaohongshu) — no network.
test('ingest pipeline: fixtures → store + Obsidian, deterministic + idempotent', async () => {
  const dir = tmp();
  const store = create(path.join(dir, 'kb.db'));
  await store.init();
  const obsidian = obsidianFactory.create(path.join(dir, 'vault'), { enabled: true });

  const first = await ingest({ store, obsidian, sources: ['x', 'xiaohongshu'] });
  assert.equal(first.errors.length, 0, JSON.stringify(first.errors));
  assert.ok(first.inserted >= 5, `expected >=5 inserted, got ${first.inserted}`);
  assert.equal(first.total, first.inserted);

  // Obsidian notes written, organized by source.
  assert.ok(fs.existsSync(path.join(dir, 'vault', 'x')));
  assert.ok(fs.existsSync(path.join(dir, 'vault', 'xiaohongshu')));
  const xNotes = fs.readdirSync(path.join(dir, 'vault', 'x'));
  assert.ok(xNotes.length >= 3 && xNotes.every((f) => f.endsWith('.md')));

  // Enrichment derived topical tags (not just the source tag).
  const llmHits = await store.searchItems('mcp');
  assert.ok(llmHits.some((i) => (i.tags || []).includes('agents')), 'expected agents tag from enrich');

  // Re-running is idempotent (content unchanged → no inserts/updates).
  const second = await ingest({ store, obsidian, sources: ['x', 'xiaohongshu'] });
  assert.equal(second.inserted, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.unchanged, first.total);

  await store.close();
});

test('quiz generates well-formed multiple-choice levels', async () => {
  const dir = tmp();
  const store = create(path.join(dir, 'kb.db'));
  await store.init();
  await ingest({ store, sources: ['x', 'xiaohongshu'] });

  const quiz = await generateQuiz(store, { count: 3 });
  assert.ok(quiz.levels.length >= 1);
  for (const lvl of quiz.levels) {
    assert.ok(lvl.question.choices.length >= 3);
    assert.ok(lvl.question.answer >= 0 && lvl.question.answer < lvl.question.choices.length);
    assert.equal(lvl.question.choices[lvl.question.answer] !== undefined, true);
  }
  await store.close();
});
