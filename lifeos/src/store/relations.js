'use strict';

const { newId } = require('../ids');

const ISO = (v) => (v instanceof Date ? v.toISOString() : v);

function relRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    family_id: r.family_id,
    subject_id: r.subject_id,
    predicate: r.predicate,
    object_id: r.object_id,
    weight: r.weight,
    data: r.data || {},
    created_at: ISO(r.created_at),
  };
}

module.exports = function relations(db) {
  return {
    /** Create (or upsert) an edge subject -predicate-> object. */
    async link(subjectId, predicate, objectId, { weight = 1, data = {}, family_id = null } = {}) {
      const id = newId('rel');
      const r = await db.query(
        `INSERT INTO relations (id, family_id, subject_id, predicate, object_id, weight, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (subject_id, predicate, object_id)
         DO UPDATE SET weight = excluded.weight, data = excluded.data
         RETURNING *`,
        [id, family_id, subjectId, predicate, objectId, weight, JSON.stringify(data)]
      );
      return relRow(r.rows[0]);
    },

    async unlink(subjectId, predicate, objectId) {
      await db.query(
        'DELETE FROM relations WHERE subject_id = $1 AND predicate = $2 AND object_id = $3',
        [subjectId, predicate, objectId]
      );
    },

    /** Replace a single-valued relation: drop existing (subject,predicate) edges, add one. */
    async replace(subjectId, predicate, objectId, opts = {}) {
      await db.query('DELETE FROM relations WHERE subject_id = $1 AND predicate = $2', [subjectId, predicate]);
      return this.link(subjectId, predicate, objectId, opts);
    },

    /** Outgoing edges from subject (optionally filtered by predicate). */
    async from(subjectId, predicate) {
      const r = predicate
        ? await db.query('SELECT * FROM relations WHERE subject_id = $1 AND predicate = $2', [subjectId, predicate])
        : await db.query('SELECT * FROM relations WHERE subject_id = $1', [subjectId]);
      return r.rows.map(relRow);
    },

    /** Incoming edges toward object (optionally filtered by predicate). */
    async toward(objectId, predicate) {
      const r = predicate
        ? await db.query('SELECT * FROM relations WHERE object_id = $1 AND predicate = $2', [objectId, predicate])
        : await db.query('SELECT * FROM relations WHERE object_id = $1', [objectId]);
      return r.rows.map(relRow);
    },

    /** All edges touching an entity, in either direction. */
    async neighbors(id) {
      const r = await db.query(
        'SELECT * FROM relations WHERE subject_id = $1 OR object_id = $1',
        [id]
      );
      return r.rows.map(relRow);
    },
  };
};
