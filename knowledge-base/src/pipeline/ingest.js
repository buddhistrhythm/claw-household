'use strict';

/**
 * ingest.js — the core pipeline: connectors → normalize → enrich → store + Obsidian.
 */

const { normalize, uniq } = require('../model/item');
const { deriveTags } = require('./enrich');
const { buildConnectors } = require('../connectors');

/**
 * Run ingestion.
 * @param {object} opts
 * @param {object} opts.store     storage backend (required)
 * @param {object} [opts.obsidian] obsidian sink (optional)
 * @param {string[]} [opts.sources] restrict to these source keys
 * @param {number} [opts.limit]   per-connector item limit
 * @param {function} [opts.log]   log callback(msg)
 * @returns {Promise<object>} summary
 */
async function ingest(opts = {}) {
  const { store, obsidian, sources, limit, log = () => {} } = opts;
  if (!store) throw new Error('ingest: `store` is required');

  const connectors = buildConnectors(sources);
  const summary = {
    total: 0, inserted: 0, updated: 0, unchanged: 0,
    bySource: {}, errors: [],
  };

  for (const connector of connectors) {
    const src = connector.name;
    summary.bySource[src] = { fetched: 0, inserted: 0, updated: 0, unchanged: 0 };
    try {
      log(`→ fetching ${src}…`);
      const raw = await connector.fetch({ limit });
      summary.bySource[src].fetched = raw.length;

      for (const r of raw) {
        const item = normalize({ ...r, source: r.source || src });
        item.tags = uniq([...(item.tags || []), ...deriveTags(item)]);
        const res = await store.upsertItem(item);
        summary[res.status]++;
        summary.total++;
        summary.bySource[src][res.status]++;
        if (obsidian && obsidian.enabled && res.status !== 'unchanged') {
          await obsidian.writeItem(item);
        }
      }
      log(`  ${src}: ${raw.length} fetched (${summary.bySource[src].inserted} new, ${summary.bySource[src].updated} updated)`);
    } catch (e) {
      summary.errors.push({ source: src, error: e.message });
      log(`  ✗ ${src}: ${e.message}`);
    }
  }

  return summary;
}

module.exports = { ingest };
