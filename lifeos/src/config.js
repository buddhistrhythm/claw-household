'use strict';

const path = require('path');
try { require('dotenv').config(); } catch { /* optional */ }

const ROOT = path.join(__dirname, '..');

module.exports = {
  root: ROOT,
  // Postgres is the primary store. Default points at the local dev cluster.
  databaseUrl: process.env.DATABASE_URL || 'postgres://lifeos:lifeos@localhost:5432/lifeos',
  schema: process.env.LIFEOS_PG_SCHEMA || 'public',
  obsidianVault: process.env.LIFEOS_OBSIDIAN_VAULT
    ? path.resolve(process.env.LIFEOS_OBSIDIAN_VAULT)
    : path.join(ROOT, 'data', 'vault'),
  obsidianEnabled: !process.env.LIFEOS_OBSIDIAN_DISABLED,
};
