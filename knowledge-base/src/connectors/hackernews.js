'use strict';

/**
 * hackernews.js — ingests a user's Hacker News *favorites*.
 *
 * HN's API (Firebase) doesn't expose a user's upvotes/favorites, so we read the
 * public favorites page (`/favorites?id=<user>`), extract item ids, then fetch
 * each item's full detail from the Firebase API. Fully live, no auth needed.
 */

const { Connector } = require('./base');
const { httpText, httpJson } = require('../util/http');
const { stripTags } = require('./feed-parser');
const config = require('../config');

const FIREBASE = 'https://hacker-news.firebaseio.com/v0/item';

/** Extract ordered, de-duplicated story/comment ids from a favorites page. */
function parseFavorites(html) {
  const ids = [];
  const seen = new Set();
  const re = /item\?id=(\d+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return ids;
}

function mapItem(it) {
  if (!it || it.deleted || it.dead) return null;
  const hnUrl = `https://news.ycombinator.com/item?id=${it.id}`;
  const title = it.title || (it.text ? stripTags(it.text).slice(0, 80) : `HN item ${it.id}`);
  return {
    source: 'hackernews',
    source_name: 'Hacker News',
    type: it.type || 'story',
    source_id: String(it.id),
    title,
    url: it.url || hnUrl,
    author: it.by || null,
    content: it.text ? stripTags(it.text) : (it.title || ''),
    published_at: it.time ? new Date(it.time * 1000).toISOString() : null,
    liked_at: null, // favorites page exposes no timestamp
    tags: ['hackernews'],
    metadata: { score: it.score ?? null, descendants: it.descendants ?? null, hn_url: hnUrl },
  };
}

class HackerNewsConnector extends Connector {
  get name() {
    return 'hackernews';
  }

  async fetch(opts = {}) {
    const user = this.config.user || config.hn.user;
    if (!user) {
      throw new Error('Hacker News connector needs a username (set HN_USERNAME or sources.json hackernews.user)');
    }
    const limit = opts.limit || this.config.limit || 30;

    // Favorites are paginated (~30/page).
    const ids = [];
    for (let page = 1; ids.length < limit && page <= 5; page++) {
      const url = `https://news.ycombinator.com/favorites?id=${encodeURIComponent(user)}&p=${page}`;
      const html = await httpText(url);
      const pageIds = parseFavorites(html).filter((id) => !ids.includes(id));
      if (!pageIds.length) break;
      ids.push(...pageIds);
    }

    const wanted = ids.slice(0, limit);
    const items = [];
    for (const id of wanted) {
      try {
        const detail = await httpJson(`${FIREBASE}/${id}.json`);
        const mapped = mapItem(detail);
        if (mapped) items.push(mapped);
      } catch {
        /* skip a single failed item */
      }
    }
    return items;
  }
}

module.exports = { HackerNewsConnector, parseFavorites, mapItem };
