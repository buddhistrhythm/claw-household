'use strict';

/**
 * db.js — Postgres connection + schema migration.
 *
 * Uses a connection-level `search_path` so every query lands in the configured
 * schema. Tests pass a throwaway schema for isolation and call drop() after.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const SQL_DIR = path.join(__dirname, '..', 'sql');

function ident(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`unsafe schema name: ${name}`);
  }
  return `"${name}"`;
}

function createDb({ databaseUrl, schema = 'public' } = {}) {
  // Validate before interpolating into connection options (trust-boundary
  // consistency with ident() used in migrate/drop). / 入连接串前先校验，防注入。
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
    throw new Error(`unsafe schema name: ${schema}`);
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });

  return {
    schema,
    query: (text, params) => pool.query(text, params),

    async migrate() {
      // Qualified CREATE SCHEMA works regardless of (possibly missing) search_path.
      await pool.query(`CREATE SCHEMA IF NOT EXISTS ${ident(schema)}`);
      const files = fs.readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort();
      for (const f of files) {
        await pool.query(fs.readFileSync(path.join(SQL_DIR, f), 'utf8'));
      }
    },

    async drop() {
      await pool.query(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`);
    },

    async close() {
      await pool.end();
    },
  };
}

module.exports = { createDb };
