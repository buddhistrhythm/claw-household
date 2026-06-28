'use strict';

/**
 * config.js — environment + path resolution for rsspool.
 *
 * rsspool is a downstream of RSSHub: it subscribes to feeds (RSSHub routes +
 * native RSS), pools them into Postgres/SQLite + Obsidian, and serves MCP.
 *
 * Everything defaults to inside the project dir so it runs with zero setup.
 * Override via .env / environment variables (see .env.example).
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
  dataDir: resolvePath('RSSPOOL_DATA_DIR', 'data'),
  dbPath: resolvePath('RSSPOOL_DB_PATH', 'data/rsspool.db'),
  databaseUrl: process.env.DATABASE_URL || process.env.RSSPOOL_DATABASE_URL || null,
  obsidianVault: resolvePath('RSSPOOL_OBSIDIAN_VAULT', 'data/vault'),
  obsidianEnabled: !process.env.RSSPOOL_OBSIDIAN_DISABLED,
  exportDir: resolvePath('RSSPOOL_EXPORT_DIR', 'data/export'),
  feedsConfig: resolvePath('RSSPOOL_FEEDS', 'config/feeds.json'),

  // RSSHub upstream. Override the public instance with your self-hosted one.
  rsshub: {
    base: process.env.RSSHUB_BASE || null, // null → fall back to feeds.json value
    accessKey: process.env.RSSHUB_ACCESS_KEY || null,
  },
};

module.exports = config;
