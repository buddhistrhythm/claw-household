'use strict';

/**
 * semantic.js — pgvector semantic retrieval + hybrid (FTS ⊕ vector) fusion.
 *               基于 pgvector 的语义检索，并与全文检索融合。
 *
 * Sits on top of the entities table's `embedding vector(256)` column (added by
 * sql/002_semantic.sql). Embeddings come from src/embeddings.js — a deterministic
 * offline embedder, so this works in dev/CI with no API key. Hybrid search fuses
 * the existing FTS (store.search) with cosine-similarity vector search via
 * Reciprocal Rank Fusion (RRF), so a doc that matches *only* semantically (no
 * shared keywords) can still surface, and exact-keyword hits stay strong.
 *
 * 建立在 entities 的 `embedding vector(256)` 列之上（由 sql/002_semantic.sql 加）。
 * 向量由 src/embeddings.js 产生（确定性离线嵌入器，dev/CI 无需 API key）。混合检索
 * 用「倒数排名融合」(RRF) 把既有全文检索 (store.search) 与余弦相似度向量检索融合：
 * 只在语义上相关（无共享关键词）的文档也能浮现，同时精确关键词命中依然强势。
 */

const { embed, toSqlVector } = require('./embeddings');

const RRF_K = 60; // RRF damping constant (standard). / RRF 阻尼常数（业界惯例）。

module.exports = function semantic(store) {
  const db = store.db;
  let _enabled; // cached isEnabled() result / 缓存的扩展可用性

  /** Project a pg row to the same shape store.search returns. / 与 store.search 同形投影。 */
  function projectRow(r, scoreField) {
    return {
      id: r.id,
      type: r.type,
      title: r.title,
      summary: r.summary,
      status: r.status,
      tags: r.tags || [],
      data: r.data || {},
      [scoreField]: r[scoreField],
    };
  }

  /**
   * isEnabled() — is the pgvector extension installed? Cached after first check.
   * 是否安装了 pgvector 扩展？首次检查后缓存。
   */
  async function isEnabled() {
    if (_enabled !== undefined) return _enabled;
    try {
      const r = await db.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
      _enabled = r.rows.length > 0;
    } catch {
      _enabled = false;
    }
    return _enabled;
  }

  /**
   * indexEntity(idOrEntity) — compute & store the embedding for one entity from
   * title + summary + body. Accepts an id or a full/partial entity object.
   * 为单条实体（title+summary+body）计算并写入嵌入；可传 id 或实体对象。
   */
  async function indexEntity(idOrEntity) {
    let ent = idOrEntity;
    if (typeof idOrEntity === 'string') {
      ent = await store.entities.get(idOrEntity);
      if (!ent) return { id: idOrEntity, indexed: false };
    }
    const text = [ent.title || '', ent.summary || '', ent.body || ''].join('\n');
    const vec = toSqlVector(embed(text));
    // public-qualify the cast: pgvector's `vector` type lives in `public`, but the
    // connection search_path may be schema-only (test schemas). / 用 public 限定 cast。
    await db.query('UPDATE entities SET embedding = $2::public.vector WHERE id = $1', [ent.id, vec]);
    return { id: ent.id, indexed: true };
  }

  /**
   * reindexAll({type, limit}) — backfill embeddings for entities that have none.
   * Handy after a bulk ingest. Returns {indexed:n}.
   * 为缺失嵌入的实体回填向量（批量导入后调用）。返回 {indexed:n}。
   */
  async function reindexAll({ type, limit } = {}) {
    if (!(await isEnabled())) return { indexed: 0 };
    const vals = [];
    let sql = 'SELECT id, title, summary, body FROM entities WHERE embedding IS NULL';
    if (type) { vals.push(type); sql += ` AND type = $${vals.length}`; }
    sql += ' ORDER BY created_at ASC';
    if (limit) { vals.push(limit); sql += ` LIMIT $${vals.length}`; }
    const r = await db.query(sql, vals);
    let n = 0;
    for (const row of r.rows) {
      await indexEntity(row);
      n++;
    }
    return { indexed: n };
  }

  /**
   * semanticSearch(query, {type, family_id, limit}) — cosine-similarity vector
   * search. Returns [{...,score}] (score = 1 - cosine_distance, higher = closer).
   * Skips (returns []) when the extension is off or nothing is embedded yet.
   * 余弦相似度向量检索，score = 1 - 距离（越大越近）。扩展未启用或无向量时返回 []。
   */
  async function semanticSearch(query, { type, family_id, limit = 25 } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];
    if (!(await isEnabled())) return [];

    const qvec = toSqlVector(embed(q));
    const vals = [qvec];
    // public-qualify the cast so it resolves under a schema-only search_path.
    // 用 public 限定 cast，确保仅含本 schema 的 search_path 也能解析。
    // OPERATOR(public.<=>) = cosine distance; schema-qualified so it resolves even
    // when search_path excludes `public`. / 用 OPERATOR(public.<=>) 限定余弦距离算子。
    let sql =
      'SELECT id, type, title, summary, status, tags, data, ' +
      '1 - (embedding OPERATOR(public.<=>) $1::public.vector) AS score ' +
      'FROM entities WHERE embedding IS NOT NULL AND archived = false';
    if (type) { vals.push(type); sql += ` AND type = $${vals.length}`; }
    if (family_id) { vals.push(family_id); sql += ` AND family_id = $${vals.length}`; }
    vals.push(limit);
    sql += ` ORDER BY embedding OPERATOR(public.<=>) $1::public.vector LIMIT $${vals.length}`;

    const r = await db.query(sql, vals);
    if (!r.rows.length) return [];
    return r.rows.map((row) => projectRow(row, 'score'));
  }

  /**
   * hybridSearch(query, opts) — Reciprocal Rank Fusion of FTS + vector results.
   *
   * Each result list contributes 1/(RRF_K + rank) per document (rank is 1-based
   * within that list); per-doc scores sum across lists, then we sort and trim.
   * This rewards docs that rank well in *either* signal and especially in *both*.
   * Gracefully degrades to FTS-only when semantic is disabled/empty.
   *
   * 倒数排名融合：每个结果列表对其文档贡献 1/(RRF_K + 名次)，跨列表求和后排序截断。
   * 在任一信号里靠前都加分，两个信号都靠前则加分更多。语义不可用/为空时退化为纯全文。
   */
  async function hybridSearch(query, { type, family_id, limit = 25 } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];

    // Pull a wider pool from each signal so fusion has room to work.
    // 每路多取一些候选，给融合留余地。
    const pool = Math.max(limit * 2, 25);
    const [ftsHits, semHits] = await Promise.all([
      store.search(q, { type, family_id, limit: pool }),
      semanticSearch(q, { type, family_id, limit: pool }),
    ]);

    const merged = new Map(); // id -> fused record / 融合后的记录

    function fold(hits, rankField) {
      hits.forEach((hit, i) => {
        const rank = i + 1; // 1-based / 从 1 起
        const contribution = 1 / (RRF_K + rank);
        let rec = merged.get(hit.id);
        if (!rec) {
          rec = {
            id: hit.id,
            type: hit.type,
            title: hit.title,
            summary: hit.summary,
            tags: hit.tags || [],
            data: hit.data || {},
            fts_rank: null,
            sem_rank: null,
            score: 0,
          };
          merged.set(hit.id, rec);
        }
        rec[rankField] = rank;
        rec.score += contribution;
      });
    }

    fold(ftsHits, 'fts_rank');
    fold(semHits, 'sem_rank');

    return Array.from(merged.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  return { isEnabled, indexEntity, reindexAll, semanticSearch, hybridSearch };
};
