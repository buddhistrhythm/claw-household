'use strict';

/**
 * storage/index.js — pick the storage backend.
 *   - Postgres when DATABASE_URL (or opts.databaseUrl) is present
 *   - SQLite otherwise (zero-setup default)
 */

const config = require('../config');

async function createStore(opts = {}) {
  const url = opts.databaseUrl !== undefined ? opts.databaseUrl : config.databaseUrl;
  const store = url
    ? require('./postgres').create(url)
    : require('./sqlite').create(opts.dbPath || config.dbPath);
  await store.init();
  return store;
}

function createObsidian(opts = {}) {
  const dir = opts.vaultDir || config.obsidianVault;
  const enabled = opts.enabled !== undefined ? opts.enabled : config.obsidianEnabled;
  return require('./obsidian').create(dir, { enabled });
}

module.exports = { createStore, createObsidian };
