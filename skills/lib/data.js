'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE_DIR = path.join(__dirname, '../..');

const PATHS = {
  INVENTORY:             path.join(BASE_DIR, 'data/inventory.json'),
  CONSUMPTION:           path.join(BASE_DIR, 'data/consumption_history.json'),
  BABY_LOG:              path.join(BASE_DIR, 'data/baby_log.json'),
  MEAL_DIARY:            path.join(BASE_DIR, 'data/meal_diary.json'),
  CATEGORIES:            path.join(BASE_DIR, 'config/categories.json'),
  PREFERENCES:           path.join(BASE_DIR, 'config/preferences.json'),
  DIAPER_SEGMENTS:       path.join(BASE_DIR, 'config/diaper_segments.json'),
  DIAPER_BRAND_SEGMENTS: path.join(BASE_DIR, 'config/diaper_brand_segments.json'),
  MANUAL_IMPORT_RECENT:  path.join(BASE_DIR, 'data/manual_import_recent.json'),
  PURCHASE_CHANNELS:     path.join(BASE_DIR, 'config/purchase_channels.json'),
  LOCATIONS:             path.join(BASE_DIR, 'config/locations.json'),
  CARS:                  path.join(BASE_DIR, 'config/cars.json'),
  TRANSIT:               path.join(BASE_DIR, 'data/transit.json'),
  SHOPPING_HISTORY:      path.join(BASE_DIR, 'data/shopping_history.json'),
};

// ─── mtime-based JSON cache ───────────────────────────────────────────────────
const _jsonCache = new Map(); // filePath → { mtimeMs, data }

/** Read and parse a JSON file with mtime-based caching. */
function readJSON(filePath, fallback) {
  try {
    const stat = fs.statSync(filePath);
    const cached = _jsonCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.data;
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    _jsonCache.set(filePath, { mtimeMs: stat.mtimeMs, data });
    return data;
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new Error(`readJSON failed for ${filePath}: ${err.message}`);
  }
}

/** Atomically write data as formatted JSON to filePath. Invalidates cache. */
function writeJSON(filePath, data) {
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
  _jsonCache.delete(filePath); // invalidate so next read sees fresh data
}

/** Returns today's local date as YYYY-MM-DD. */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

/** Formats a Date object as local YYYY-MM-DD. */
function formatLocalDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

/** Returns days from today (local midnight) to dateStr. Positive = future. */
function daysUntil(dateStr) {
  const now = new Date();
  const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(dateStr + 'T00:00:00');
  return Math.round((target - localMidnight) / 86400000);
}

/** Generates a unique ID: {prefix}_{YYYYMMDD}_{6-char-hex}. */
function generateId(prefix = 'inv') {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const hex = crypto.randomBytes(3).toString('hex');
  return `${prefix}_${date}_${hex}`;
}

module.exports = { PATHS, readJSON, writeJSON, today, formatLocalDate, daysUntil, generateId };
