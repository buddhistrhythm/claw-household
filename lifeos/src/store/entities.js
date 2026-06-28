'use strict';

const { newId } = require('../ids');

const ISO = (v) => (v instanceof Date ? v.toISOString() : v);

/** Normalize a pg row into a plain entity object. */
function row(r) {
  if (!r) return null;
  return {
    id: r.id,
    type: r.type,
    family_id: r.family_id,
    created_by: r.created_by,
    title: r.title,
    body: r.body,
    summary: r.summary,
    status: r.status,
    tags: r.tags || [],
    topics: r.topics || [],
    data: r.data || {},
    source: r.source,
    source_ref: r.source_ref,
    occurred_at: ISO(r.occurred_at),
    archived: r.archived,
    created_at: ISO(r.created_at),
    updated_at: ISO(r.updated_at),
  };
}

const PATCHABLE = ['title', 'body', 'summary', 'status', 'tags', 'topics', 'data', 'source', 'source_ref', 'occurred_at', 'archived'];

module.exports = function entities(db) {
  return {
    row,

    async create(p) {
      if (!p.type) throw new Error('entity.create: `type` is required');
      const id = p.id || newId('ent');
      const r = await db.query(
        `INSERT INTO entities
          (id, type, family_id, created_by, title, body, summary, status,
           tags, topics, data, source, source_ref, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          id, p.type, p.family_id || null, p.created_by || null,
          p.title || '', p.body || '', p.summary || '', p.status || null,
          p.tags || [], p.topics || [], JSON.stringify(p.data || {}),
          p.source || null, p.source_ref || null, p.occurred_at || null,
        ]
      );
      return row(r.rows[0]);
    },

    async get(id) {
      const r = await db.query('SELECT * FROM entities WHERE id = $1', [id]);
      return row(r.rows[0]);
    },

    async patch(id, props) {
      const sets = [];
      const vals = [];
      for (const key of PATCHABLE) {
        if (props[key] === undefined) continue;
        vals.push(key === 'data' ? JSON.stringify(props[key]) : props[key]);
        sets.push(`${key} = $${vals.length}`);
      }
      if (!sets.length) return this.get(id);
      vals.push(id);
      const r = await db.query(
        `UPDATE entities SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length} RETURNING *`,
        vals
      );
      return row(r.rows[0]);
    },

    /** Merge a partial object into the JSONB `data` column (server-side). */
    async mergeData(id, partial) {
      const r = await db.query(
        `UPDATE entities SET data = data || $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, JSON.stringify(partial || {})]
      );
      return row(r.rows[0]);
    },

    async list({ type, family_id, status, tag, source, limit = 100, offset = 0, includeArchived = false } = {}) {
      const where = [];
      const vals = [];
      if (type) { vals.push(type); where.push(`type = $${vals.length}`); }
      if (family_id) { vals.push(family_id); where.push(`family_id = $${vals.length}`); }
      if (status) { vals.push(status); where.push(`status = $${vals.length}`); }
      if (source) { vals.push(source); where.push(`source = $${vals.length}`); }
      if (tag) { vals.push([tag]); where.push(`tags @> $${vals.length}`); }
      if (!includeArchived) where.push('archived = false');
      vals.push(limit); const lim = vals.length;
      vals.push(offset); const off = vals.length;
      const r = await db.query(
        `SELECT * FROM entities
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY COALESCE(occurred_at, created_at) DESC
         LIMIT $${lim} OFFSET $${off}`,
        vals
      );
      return r.rows.map(row);
    },

    async archive(id) {
      await db.query('UPDATE entities SET archived = true, updated_at = now() WHERE id = $1', [id]);
    },

    async remove(id) {
      await db.query('DELETE FROM entities WHERE id = $1', [id]);
    },
  };
};
