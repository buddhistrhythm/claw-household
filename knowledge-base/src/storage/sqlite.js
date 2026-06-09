'use strict';

/**
 * sqlite.js — default storage backend (better-sqlite3 + FTS5).
 *
 * The interface is async (returns Promises) so it's interchangeable with the
 * Postgres backend even though better-sqlite3 itself is synchronous.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const COLUMNS = [
  'id', 'source', 'source_id', 'source_name', 'type', 'title', 'url', 'author',
  'content', 'excerpt', 'tags', 'topics', 'liked_at', 'published_at',
  'fetched_at', 'metadata', 'content_hash',
];

const JSON_COLS = new Set(['tags', 'topics', 'metadata']);

function create(dbPath) {
  let db;

  function rowToItem(row) {
    if (!row) return null;
    const item = { ...row };
    for (const c of JSON_COLS) {
      try { item[c] = row[c] ? JSON.parse(row[c]) : (c === 'metadata' ? {} : []); }
      catch { item[c] = c === 'metadata' ? {} : []; }
    }
    return item;
  }

  function itemToRow(item) {
    const row = {};
    for (const c of COLUMNS) {
      row[c] = JSON_COLS.has(c) ? JSON.stringify(item[c] ?? (c === 'metadata' ? {} : [])) : (item[c] ?? null);
    }
    return row;
  }

  return {
    kind: 'sqlite',

    async init() {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.exec(`
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
          tags         TEXT DEFAULT '[]',
          topics       TEXT DEFAULT '[]',
          liked_at     TEXT,
          published_at TEXT,
          fetched_at   TEXT,
          metadata     TEXT DEFAULT '{}',
          content_hash TEXT,
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_ki_source ON knowledge_items(source);
        CREATE INDEX IF NOT EXISTS idx_ki_liked  ON knowledge_items(liked_at);

        CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
          id UNINDEXED, title, content, tags, author
        );
      `);
      return this;
    },

    async upsertItem(item) {
      const existing = db.prepare('SELECT content_hash FROM knowledge_items WHERE id = ?').get(item.id);
      if (existing && existing.content_hash === item.content_hash) {
        return { status: 'unchanged', id: item.id };
      }
      const row = itemToRow(item);
      const cols = COLUMNS.join(', ');
      const placeholders = COLUMNS.map((c) => '@' + c).join(', ');
      const updates = COLUMNS.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ');
      db.prepare(`
        INSERT INTO knowledge_items (${cols})
        VALUES (${placeholders})
        ON CONFLICT(id) DO UPDATE SET ${updates}, updated_at = datetime('now')
      `).run(row);

      // Refresh FTS row.
      db.prepare('DELETE FROM knowledge_fts WHERE id = ?').run(item.id);
      db.prepare('INSERT INTO knowledge_fts (id, title, content, tags, author) VALUES (?, ?, ?, ?, ?)')
        .run(item.id, item.title, item.content, (item.tags || []).join(' '), item.author || '');

      return { status: existing ? 'updated' : 'inserted', id: item.id };
    },

    async getItem(id) {
      return rowToItem(db.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(id));
    },

    async listItems({ source, tag, limit = 50, offset = 0, since } = {}) {
      const where = [];
      const params = {};
      if (source) { where.push('source = @source'); params.source = source; }
      if (since) { where.push('(liked_at >= @since OR published_at >= @since)'); params.since = since; }
      if (tag) { where.push("tags LIKE @tag"); params.tag = `%"${String(tag).toLowerCase()}"%`; }
      const sql = `
        SELECT * FROM knowledge_items
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY COALESCE(liked_at, published_at, fetched_at) DESC
        LIMIT @limit OFFSET @offset
      `;
      return db.prepare(sql).all({ ...params, limit, offset }).map(rowToItem);
    },

    async searchItems(query, { limit = 25, source } = {}) {
      const match = ftsQuery(query);
      if (!match) return [];
      const rows = db.prepare(`
        SELECT k.* FROM knowledge_fts f
        JOIN knowledge_items k ON k.id = f.id
        WHERE knowledge_fts MATCH ?
        ${source ? 'AND k.source = ?' : ''}
        ORDER BY bm25(knowledge_fts)
        LIMIT ?
      `).all(...(source ? [match, source, limit] : [match, limit]));
      return rows.map(rowToItem);
    },

    async stats() {
      const total = db.prepare('SELECT COUNT(*) c FROM knowledge_items').get().c;
      const bySource = db.prepare('SELECT source, COUNT(*) c FROM knowledge_items GROUP BY source ORDER BY c DESC').all();
      const sources = {};
      for (const r of bySource) sources[r.source] = r.c;
      const latest = db.prepare('SELECT MAX(fetched_at) m FROM knowledge_items').get().m;
      return { total, sources, latest_fetch: latest };
    },

    async close() {
      if (db) db.close();
    },
  };
}

/** Build a safe FTS5 prefix query from free text. */
function ftsQuery(query) {
  const terms = String(query || '')
    .toLowerCase()
    .replace(/["()*:^]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (!terms.length) return null;
  return terms.map((t) => `${t}*`).join(' OR ');
}

module.exports = { create };
