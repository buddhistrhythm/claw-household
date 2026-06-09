'use strict';

/**
 * rsshub.js — feed configuration + URL resolution.
 *
 * A feed is one of:
 *   - { url }     an absolute RSS/Atom URL (native blog feed)
 *   - { rsshub }  an RSSHub route path, resolved against the RSSHub base URL
 *   - { file }    a local feed file (used for tests / offline pools)
 * plus identity: { name, source, category, limit }.
 */

const fs = require('fs');
const config = require('../config');

function loadFeedsConfig() {
  try {
    return JSON.parse(fs.readFileSync(config.feedsConfig, 'utf8'));
  } catch {
    return { rsshub: {}, feeds: [] };
  }
}

/**
 * Merge the RSSHub settings from feeds.json with env overrides.
 * Env (RSSHUB_BASE / RSSHUB_ACCESS_KEY) wins when set.
 */
function resolveRsshub(fileRsshub = {}) {
  return {
    base: config.rsshub.base || fileRsshub.base || 'https://rsshub.app',
    accessKey: config.rsshub.accessKey || fileRsshub.accessKey || null,
  };
}

/**
 * Resolve the fetchable URL for a feed (or null for file-backed feeds).
 * @param {object} feed
 * @param {object} rsshub resolved { base, accessKey }
 */
function resolveFeedUrl(feed, rsshub = {}) {
  if (feed.url) return feed.url;
  if (feed.file) return null;
  if (feed.rsshub) {
    const base = (rsshub.base || 'https://rsshub.app').replace(/\/+$/, '');
    const route = feed.rsshub.startsWith('/') ? feed.rsshub : '/' + feed.rsshub;
    let url = base + route;
    if (rsshub.accessKey) {
      url += (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(rsshub.accessKey);
    }
    return url;
  }
  throw new Error(`feed "${feed.name || '?'}" has none of url / rsshub / file`);
}

module.exports = { loadFeedsConfig, resolveRsshub, resolveFeedUrl };
