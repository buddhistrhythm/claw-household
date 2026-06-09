'use strict';

/**
 * config.js — environment + path resolution for the knowledge base.
 *
 * All paths default to inside the project dir so it runs with zero setup.
 * Override anything via .env / environment variables (see .env.example).
 */

const path = require('path');
try { require('dotenv').config(); } catch { /* dotenv optional */ }

const ROOT = path.join(__dirname, '..');

function resolvePath(envName, def) {
  const v = process.env[envName];
  return v ? path.resolve(v) : path.join(ROOT, def);
}

const config = {
  root: ROOT,
  dataDir: resolvePath('KB_DATA_DIR', 'data'),
  dbPath: resolvePath('KB_DB_PATH', 'data/kb.db'),
  databaseUrl: process.env.DATABASE_URL || process.env.KB_DATABASE_URL || null,
  obsidianVault: resolvePath('KB_OBSIDIAN_VAULT', 'data/vault'),
  obsidianEnabled: !process.env.KB_OBSIDIAN_DISABLED,
  exportDir: resolvePath('KB_EXPORT_DIR', 'data/export'),
  sourcesConfig: path.join(ROOT, 'config', 'sources.json'),
  fixturesDir: path.join(ROOT, 'fixtures'),

  hn: {
    user: process.env.HN_USERNAME || null,
  },
  x: {
    bearer: process.env.X_BEARER_TOKEN || null,
    userId: process.env.X_USER_ID || null,
  },
  xhs: {
    cookie: process.env.XHS_COOKIE || null,
  },
};

module.exports = config;
