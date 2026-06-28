'use strict';

/**
 * ingest.js — the core pipeline: feeds → fetch/parse → normalize → enrich →
 * store + Obsidian. Everything upstream is RSS (native or via RSSHub).
 */

const { normalize, uniq } = require('../model/item');
const { deriveTags } = require('./enrich');
const { loadFeed } = require('../feed/load');
const { loadFeedsConfig, resolveRsshub } = require('../feed/rsshub');

/**
 * Run ingestion across the configured (or supplied) feeds.
 * @param {object} opts
 * @param {object} opts.store      storage backend (required)
 * @param {object} [opts.obsidian] obsidian sink (optional)
 * @param {Array}  [opts.feeds]    explicit feed list (defaults to feeds.json)
 * @param {object} [opts.rsshub]   explicit rsshub settings (defaults to feeds.json/env)
 * @param {string} [opts.source]   filter: only feeds with this source
 * @param {string} [opts.category] filter: only feeds with this category
 * @param {number} [opts.limit]    per-feed item limit
 * @param {function} [opts.log]    log callback(msg)
 * @returns {Promise<object>} summary
 */
async function ingest(opts = {}) {
  const { store, obsidian, source, category, limit, log = () => {} } = opts;
  if (!store) throw new Error('ingest: `store` is required');

  const cfg = loadFeedsConfig();
  const rsshub = opts.rsshub || resolveRsshub(cfg.rsshub);
  let feeds = opts.feeds || cfg.feeds || [];
  if (source) feeds = feeds.filter((f) => f.source === source);
  if (category) feeds = feeds.filter((f) => f.category === category);

  const summary = {
    total: 0, inserted: 0, updated: 0, unchanged: 0,
    feeds: feeds.length, bySource: {}, errors: [],
  };

  for (const feed of feeds) {
    const src = feed.source || 'rss';
    const bucket = summary.bySource[src] || (summary.bySource[src] = { fetched: 0, inserted: 0, updated: 0, unchanged: 0 });
    try {
      log(`→ ${feed.name} (${src})…`);
      const raw = await loadFeed(feed, { rsshub, limit });
      bucket.fetched += raw.length;

      for (const r of raw) {
        const item = normalize(r);
        item.tags = uniq([...(item.tags || []), ...deriveTags(item)]);
        const res = await store.upsertItem(item);
        summary[res.status]++;
        summary.total++;
        bucket[res.status]++;
        if (obsidian && obsidian.enabled && res.status !== 'unchanged') {
          await obsidian.writeItem(item);
        }
      }
      log(`  ${feed.name}: ${raw.length} fetched`);
    } catch (e) {
      summary.errors.push({ feed: feed.name, source: src, error: e.message });
      log(`  ✗ ${feed.name}: ${e.message}`);
    }
  }

  return summary;
}

module.exports = { ingest };
