'use strict';

/**
 * postgres.js — Postgres storage backend (activated when DATABASE_URL is set).
 *
 * Uses JSONB for array/object columns and a generated tsvector + GIN index for
 * full-text search. `pg` is an optional dependency, lazily required so the
 * SQLite-only path never needs it installed.
 */

function create(connectionString) {
  let pool;

  function rowToItem(row) {
    if (!row) return null;
    return {
      ...row,
      tags: row.tags || [],
      topics: row.topics || [],
      metadata: row.metadata || {},
    };
  }

  return {
    kind: 'postgres',

    async init() {
      let Pool;
      try {
        ({ Pool } = require('pg'));
      } catch {
        throw new Error(
          "DATABASE_URL is set but the 'pg' package isn't installed. Run `npm install pg`."
        );
      }
      pool = new Pool({ connectionString });
      await pool.query(`
        CREATE TABLE IF NOT EXISTS knowledge_items (
          id           TEXT PRIMARY KEY,
          source       TEXT NOT NULL,
          source_id    TEXT,
          source_name  TEXT,
          type         TEXT,
          title        TEXT,
          url          TEXT,
          author       TEXT,
          content      TEXT,
          excerpt      TEXT,
          tags         JSONB NOT NULL DEFAULT '[]',
          topics       JSONB NOT NULL DEFAULT '[]',
          liked_at     TIMESTAMPTZ,
          published_at TIMESTAMPTZ,
          fetched_at   TIMESTAMPTZ,
          metadata     JSONB NOT NULL DEFAULT '{}',
          content_hash TEXT,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          search       tsvector GENERATED ALWAYS AS (
            to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(content,'') || ' ' || coalesce(author,''))
          ) STORED
        );
        CREATE INDEX IF NOT EXISTS idx_ki_source ON knowledge_items(source);
        CREATE INDEX IF NOT EXISTS idx_ki_search ON knowledge_items USING GIN(search);
        CREATE INDEX IF NOT EXISTS idx_ki_tags   ON knowledge_items USING GIN(tags);
      `);
      return this;
    },

    async upsertItem(item) {
      const existing = await pool.query('SELECT content_hash FROM knowledge_items WHERE id = $1', [item.id]);
      if (existing.rows[0] && existing.rows[0].content_hash === item.content_hash) {
        return { status: 'unchanged', id: item.id };
      }
      await pool.query(
        `INSERT INTO knowledge_items
          (id, source, source_id, source_name, type, title, url, author, content, excerpt,
           tags, topics, liked_at, published_at, fetched_at, metadata, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (id) DO UPDATE SET
           source=excluded.source, source_id=excluded.source_id, source_name=excluded.source_name,
           type=excluded.type, title=excluded.title, url=excluded.url, author=excluded.author,
           content=excluded.content, excerpt=excluded.excerpt, tags=excluded.tags, topics=excluded.topics,
           liked_at=excluded.liked_at, published_at=excluded.published_at, fetched_at=excluded.fetched_at,
           metadata=excluded.metadata, content_hash=excluded.content_hash, updated_at=now()`,
        [
          item.id, item.source, item.source_id, item.source_name, item.type, item.title,
          item.url, item.author, item.content, item.excerpt,
          JSON.stringify(item.tags || []), JSON.stringify(item.topics || []),
          item.liked_at, item.published_at, item.fetched_at,
          JSON.stringify(item.metadata || {}), item.content_hash,
        ]
      );
      return { status: existing.rows[0] ? 'updated' : 'inserted', id: item.id };
    },

    async getItem(id) {
      const r = await pool.query('SELECT * FROM knowledge_items WHERE id = $1', [id]);
      return rowToItem(r.rows[0]);
    },

    async listItems({ source, tag, limit = 50, offset = 0, since } = {}) {
      const where = [];
      const params = [];
      if (source) { params.push(source); where.push(`source = $${params.length}`); }
      if (since) { params.push(since); where.push(`(liked_at >= $${params.length} OR published_at >= $${params.length})`); }
      if (tag) { params.push(JSON.stringify([String(tag).toLowerCase()])); where.push(`tags @> $${params.length}::jsonb`); }
      params.push(limit); const lim = params.length;
      params.push(offset); const off = params.length;
      const r = await pool.query(
        `SELECT * FROM knowledge_items
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY COALESCE(liked_at, published_at, fetched_at) DESC
         LIMIT $${lim} OFFSET $${off}`,
        params
      );
      return r.rows.map(rowToItem);
    },

    async searchItems(query, { limit = 25, source } = {}) {
      const q = String(query || '').trim();
      if (!q) return [];
      const params = [q];
      let sql = `SELECT *, ts_rank(search, plainto_tsquery('simple', $1)) AS rank
                 FROM knowledge_items
                 WHERE search @@ plainto_tsquery('simple', $1)`;
      if (source) { params.push(source); sql += ` AND source = $${params.length}`; }
      params.push(limit);
      sql += ` ORDER BY rank DESC LIMIT $${params.length}`;
      const r = await pool.query(sql, params);
      return r.rows.map(rowToItem);
    },

    async stats() {
      const total = (await pool.query('SELECT COUNT(*)::int c FROM knowledge_items')).rows[0].c;
      const bySource = (await pool.query('SELECT source, COUNT(*)::int c FROM knowledge_items GROUP BY source ORDER BY c DESC')).rows;
      const sources = {};
      for (const r of bySource) sources[r.source] = r.c;
      const latest = (await pool.query('SELECT MAX(fetched_at) m FROM knowledge_items')).rows[0].m;
      return { total, sources, latest_fetch: latest };
    },

    async close() {
      if (pool) await pool.end();
    },
  };
}

module.exports = { create };
