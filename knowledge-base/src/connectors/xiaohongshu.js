'use strict';

/**
 * xiaohongshu.js — ingests your 小红书 (RED) collected/favorited notes.
 *
 * 小红书 has no official public API. A real integration needs a logged-in web
 * cookie (XHS_COOKIE) and calls the private web endpoints; that's intentionally
 * left as a single `fetchLive()` seam. Without a cookie we fall back to
 * fixtures/xiaohongshu_favorites.sample.json so the pipeline runs offline.
 */

const fs = require('fs');
const path = require('path');
const { Connector } = require('./base');
const config = require('../config');

function mapNote(n) {
  return {
    source: 'xiaohongshu',
    source_name: '小红书',
    type: 'note',
    source_id: String(n.id || n.note_id),
    title: n.title || (n.desc ? n.desc.slice(0, 40) : `笔记 ${n.id}`),
    url: n.url || (n.id ? `https://www.xiaohongshu.com/explore/${n.id}` : null),
    author: n.author || n.nickname || null,
    content: n.desc || n.content || '',
    published_at: n.published_at || null,
    liked_at: n.liked_at || n.collected_at || null,
    tags: ['xiaohongshu', ...(n.tags || [])],
    metadata: { likes: n.likes ?? null, collects: n.collects ?? null },
  };
}

class XiaohongshuConnector extends Connector {
  get name() {
    return 'xiaohongshu';
  }

  async fetch(opts = {}) {
    const limit = opts.limit || this.config.limit || 50;
    if (config.xhs.cookie) {
      const notes = await this.fetchLive(config.xhs.cookie, limit);
      return notes.map(mapNote);
    }
    return loadFixture('xiaohongshu_favorites.sample.json').slice(0, limit).map(mapNote);
  }

  /**
   * Live fetch seam. Implement against the private web endpoints using the
   * provided cookie. Throws by default so it's obvious the seam is unimplemented.
   */
  async fetchLive() {
    throw new Error(
      'xiaohongshu live fetch is not implemented — provide an implementation of fetchLive(cookie, limit), or unset XHS_COOKIE to use fixtures.'
    );
  }
}

function loadFixture(name) {
  const p = path.join(config.fixturesDir, name);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}

module.exports = { XiaohongshuConnector, mapNote };
