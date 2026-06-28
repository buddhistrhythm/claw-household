'use strict';

/**
 * store/index.js — compose the storage layer: entities + relations + search,
 * over a migrated Postgres schema.
 */

const config = require('../config');
const { createDb } = require('../db');
const entitiesFactory = require('./entities');
const relationsFactory = require('./relations');
const searchFn = require('./search');
const { seedTypes } = require('./types');

async function createStore({ databaseUrl, schema } = {}) {
  const db = createDb({
    databaseUrl: databaseUrl || config.databaseUrl,
    schema: schema || config.schema,
  });
  await db.migrate();
  await seedTypes(db);

  const entities = entitiesFactory(db);
  const relations = relationsFactory(db);

  return {
    db,
    entities,
    relations,
    search: (q, o) => searchFn(db, q, o),

    async stats() {
      const byType = await db.query(
        'SELECT type, COUNT(*)::int c FROM entities WHERE archived = false GROUP BY type ORDER BY c DESC'
      );
      const total = await db.query('SELECT COUNT(*)::int c FROM entities WHERE archived = false');
      const rels = await db.query('SELECT COUNT(*)::int c FROM relations');
      const types = {};
      for (const r of byType.rows) types[r.type] = r.c;
      return { total: total.rows[0].c, relations: rels.rows[0].c, types };
    },

    close: () => db.close(),
    drop: () => db.drop(),
  };
}

module.exports = { createStore };
