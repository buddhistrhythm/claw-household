'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { freshStore } = require('./helpers');
const semanticFactory = require('../src/semantic');
const { embed, dim, toSqlVector, provider } = require('../src/embeddings');

/** Cosine similarity of two equal-length unit-ish vectors. / 余弦相似度。 */
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

test('embed: deterministic, fixed dim, unit length, local provider', () => {
  assert.equal(dim(), 256);
  assert.equal(provider(), 'local');

  const a1 = embed('postgres vacuum tuning autovacuum');
  const a2 = embed('postgres vacuum tuning autovacuum');
  assert.equal(a1.length, 256);
  // identical text → byte-identical vector / 同文本得相同向量
  assert.deepEqual(a1, a2);

  // unit vector / 单位向量
  const norm = Math.sqrt(a1.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, `expected unit norm, got ${norm}`);
});

test('embed: shared vocabulary scores higher than disjoint vocabulary', () => {
  const base = embed('postgres database index vacuum');
  const similar = embed('postgres database vacuum strategies');
  const unrelated = embed('banana smoothie recipe breakfast');

  const simShared = cosine(base, similar);
  const simDisjoint = cosine(base, unrelated);
  assert.ok(simShared > simDisjoint, `shared ${simShared} should exceed disjoint ${simDisjoint}`);
  assert.ok(simShared > 0, 'shared vocab should give positive cosine');
});

test('toSqlVector formats a pgvector literal', () => {
  const lit = toSqlVector([0, 1, 0.5]);
  assert.equal(lit, '[0,1,0.5]');
});

test('isEnabled() is true (pgvector installed)', async () => {
  const store = await freshStore();
  try {
    const s = semanticFactory(store);
    assert.equal(await s.isEnabled(), true);
  } finally {
    await store.close();
  }
});

test('indexEntity then semanticSearch ranks the relevant entity above an unrelated one', async () => {
  const store = await freshStore();
  try {
    const s = semanticFactory(store);

    const pg = await store.entities.create({
      type: 'knowledge_item',
      title: 'Postgres vacuum tuning',
      summary: 'How autovacuum keeps database tables healthy and avoids bloat.',
      body: 'autovacuum, bloat, indexes, postgres',
    });
    const cooking = await store.entities.create({
      type: 'knowledge_item',
      title: 'Banana smoothie recipe',
      summary: 'A breakfast smoothie with banana and yogurt.',
      body: 'banana, yogurt, blender, breakfast',
    });

    await s.indexEntity(pg.id);
    await s.indexEntity(cooking.id);

    const hits = await s.semanticSearch('postgres autovacuum bloat database', { limit: 10 });
    assert.ok(hits.length >= 1, 'expected at least one semantic hit');
    assert.equal(hits[0].id, pg.id, 'relevant entity should rank first');

    const pgRank = hits.findIndex((h) => h.id === pg.id);
    const cookRank = hits.findIndex((h) => h.id === cooking.id);
    assert.ok(pgRank > -1, 'pg entity present');
    if (cookRank > -1) {
      assert.ok(pgRank < cookRank, 'relevant ranked above unrelated');
      assert.ok(hits[pgRank].score > hits[cookRank].score, 'relevant has higher score');
    }
  } finally {
    await store.close();
  }
});

test('reindexAll embeds rows with NULL embedding', async () => {
  const store = await freshStore();
  try {
    const s = semanticFactory(store);

    await store.entities.create({ type: 'note', title: 'alpha one', body: 'first note text' });
    await store.entities.create({ type: 'note', title: 'beta two', body: 'second note text' });

    const before = await store.db.query('SELECT COUNT(*)::int c FROM entities WHERE embedding IS NULL');
    assert.equal(before.rows[0].c, 2);

    const res = await s.reindexAll({});
    assert.equal(res.indexed, 2);

    const after = await store.db.query('SELECT COUNT(*)::int c FROM entities WHERE embedding IS NULL');
    assert.equal(after.rows[0].c, 0);

    // reindex is idempotent: nothing left to embed / 再次回填无新增
    const again = await s.reindexAll({});
    assert.equal(again.indexed, 0);
  } finally {
    await store.close();
  }
});

test('reindexAll respects the type filter', async () => {
  const store = await freshStore();
  try {
    const s = semanticFactory(store);
    await store.entities.create({ type: 'note', title: 'note a', body: 'aaa' });
    await store.entities.create({ type: 'task', title: 'task b', body: 'bbb' });

    const res = await s.reindexAll({ type: 'note' });
    assert.equal(res.indexed, 1);

    const remaining = await store.db.query(
      "SELECT type FROM entities WHERE embedding IS NULL"
    );
    assert.equal(remaining.rows.length, 1);
    assert.equal(remaining.rows[0].type, 'task');
  } finally {
    await store.close();
  }
});

test('semanticSearch returns [] when nothing is embedded', async () => {
  const store = await freshStore();
  try {
    const s = semanticFactory(store);
    await store.entities.create({ type: 'note', title: 'unembedded', body: 'no vector yet' });
    const hits = await s.semanticSearch('anything', { limit: 5 });
    assert.deepEqual(hits, []);
  } finally {
    await store.close();
  }
});

test('hybridSearch fuses FTS + vector; a semantic-only match still surfaces', async () => {
  const store = await freshStore();
  try {
    const s = semanticFactory(store);

    // Doc A: shares the literal query keyword "kubernetes" (FTS will catch it).
    // 文档 A：含字面关键词，全文检索能命中。
    const ftsDoc = await store.entities.create({
      type: 'knowledge_item',
      title: 'Kubernetes pod scheduling',
      summary: 'kubernetes scheduler places pods onto nodes',
      body: 'kubernetes, scheduler, pods, nodes',
    });
    // Doc B: NO shared literal keyword with the query, but overlapping vocabulary
    // via the embedding bag-of-words ("container", "orchestration", "cluster").
    // 文档 B：与查询无字面共享词，但向量词袋有重叠词汇。
    const semDoc = await store.entities.create({
      type: 'knowledge_item',
      title: 'Container orchestration cluster basics',
      summary: 'container orchestration manages cluster workloads',
      body: 'container, orchestration, cluster, workloads, scheduler',
    });
    // Noise doc — should not crowd out the real hits.
    await store.entities.create({
      type: 'knowledge_item',
      title: 'Sourdough bread baking',
      summary: 'flour, water, salt, starter',
      body: 'baking bread sourdough',
    });

    await s.reindexAll({});

    // Query tokens are BOTH present in ftsDoc (so FTS's AND-semantics matches it)
    // but "kubernetes" is absent from semDoc (FTS misses it) — semDoc can only
    // surface through the vector signal. / 查询两词都在 ftsDoc，semDoc 无
    // "kubernetes"，全文检索漏掉它，只能靠向量信号浮现。
    const query = 'kubernetes scheduler';
    const results = await s.hybridSearch(query, { limit: 10 });
    assert.ok(results.length >= 2, 'expected fused results');

    const ids = results.map((r) => r.id);
    assert.ok(ids.includes(ftsDoc.id), 'FTS-matched doc present');
    assert.ok(ids.includes(semDoc.id), 'semantically-related doc surfaces via vector signal');

    // Fusion record shape: carries both rank signals + a combined score.
    // 融合记录形状：携带两路名次与综合分。
    const top = results[0];
    assert.ok('fts_rank' in top && 'sem_rank' in top, 'record carries both rank fields');
    assert.ok(typeof top.score === 'number' && top.score > 0, 'has a positive fused score');

    // ftsDoc matched FTS (its fts_rank is set); semDoc surfaced semantic-only.
    // ftsDoc 命中全文（fts_rank 非空）；semDoc 仅靠语义信号浮现。
    const ftsRec = results.find((r) => r.id === ftsDoc.id);
    const semRec = results.find((r) => r.id === semDoc.id);
    assert.ok(ftsRec.fts_rank !== null, 'fts doc has an fts rank');
    assert.ok(semRec.sem_rank !== null, 'semantic-only doc has a sem rank');
    assert.equal(semRec.fts_rank, null, 'semantic-only doc was NOT an FTS hit');
  } finally {
    await store.close();
  }
});

test('hybridSearch degrades to FTS-only results when nothing is embedded', async () => {
  const store = await freshStore();
  try {
    const s = semanticFactory(store);
    const doc = await store.entities.create({
      type: 'note',
      title: 'quarterly budget review',
      summary: 'review the quarterly budget numbers',
      body: 'budget finance review',
    });
    // No reindex → no embeddings. hybrid should still return the FTS hit.
    const results = await s.hybridSearch('quarterly budget', { limit: 5 });
    assert.ok(results.some((r) => r.id === doc.id), 'FTS-only fallback works');
    const rec = results.find((r) => r.id === doc.id);
    assert.equal(rec.sem_rank, null, 'no semantic rank when embeddings absent');
    assert.ok(rec.fts_rank !== null, 'has fts rank');
  } finally {
    await store.close();
  }
});
