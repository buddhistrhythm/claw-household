'use strict';

/**
 * search.js — full-text + filtered search over entities (the agentic-retrieval
 * entry point). Uses the generated tsvector column with ranking.
 */

module.exports = function search(db, query, { type, family_id, limit = 25 } = {}) {
  const q = String(query || '').trim();
  if (!q) return Promise.resolve([]);
  const vals = [q];
  let sql = `SELECT *, ts_rank(search, plainto_tsquery('simple', $1)) AS rank
             FROM entities
             WHERE archived = false AND search @@ plainto_tsquery('simple', $1)`;
  if (type) { vals.push(type); sql += ` AND type = $${vals.length}`; }
  if (family_id) { vals.push(family_id); sql += ` AND family_id = $${vals.length}`; }
  vals.push(limit);
  sql += ` ORDER BY rank DESC LIMIT $${vals.length}`;
  return db.query(sql, vals).then((r) =>
    r.rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      summary: row.summary,
      status: row.status,
      tags: row.tags || [],
      data: row.data || {},
      rank: row.rank,
    }))
  );
};
