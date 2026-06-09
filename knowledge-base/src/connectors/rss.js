'use strict';

/**
 * rss.js — ingests articles from followed tech-blog feeds (Anthropic, Uber,
 * Google, …). These are "follows" rather than per-item likes, so liked_at is
 * null and articles are deduped by guid via the content hash.
 */

const { Connector } = require('./base');
const { httpText } = require('../util/http');
const { parseFeed } = require('./feed-parser');

class RssConnector extends Connector {
  get name() {
    return 'rss';
  }

  async fetch(opts = {}) {
    const feeds = this.config.feeds || [];
    const perFeed = opts.limit || this.config.limit || 20;
    const items = [];
    for (const feed of feeds) {
      try {
        const xml = await httpText(feed.url);
        const parsed = parseFeed(xml, feed.name).slice(0, perFeed);
        items.push(...parsed);
      } catch (e) {
        // One bad feed shouldn't abort the whole source.
        items.push({ _error: true, source: 'rss', feed: feed.name, message: e.message });
      }
    }
    return items.filter((i) => !i._error);
  }
}

module.exports = { RssConnector };
