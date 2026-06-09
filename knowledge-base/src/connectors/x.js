'use strict';

/**
 * x.js — ingests your X.com (Twitter) likes.
 *
 * X's "liked tweets" endpoint requires a paid API bearer token + your numeric
 * user id. When both are present we call the live API; otherwise we fall back
 * to fixtures/x_likes.sample.json so the pipeline is fully exercisable offline.
 *
 * Live endpoint: GET https://api.twitter.com/2/users/:id/liked_tweets
 */

const fs = require('fs');
const path = require('path');
const { Connector } = require('./base');
const { httpJson } = require('../util/http');
const config = require('../config');

function mapTweet(t, includesUsers = {}) {
  const text = t.text || '';
  const author = includesUsers[t.author_id]?.username
    ? '@' + includesUsers[t.author_id].username
    : t.author || null;
  return {
    source: 'x',
    source_name: 'X.com',
    type: 'post',
    source_id: String(t.id),
    title: text.split('\n')[0].slice(0, 80) || `tweet ${t.id}`,
    url: `https://x.com/i/web/status/${t.id}`,
    author,
    content: text,
    published_at: t.created_at || null,
    liked_at: t.liked_at || null,
    tags: ['x'],
    metadata: { metrics: t.public_metrics || null },
  };
}

class XConnector extends Connector {
  get name() {
    return 'x';
  }

  async fetch(opts = {}) {
    const limit = opts.limit || this.config.limit || 50;
    const bearer = config.x.bearer;
    const userId = config.x.userId;

    if (bearer && userId) {
      const url = `https://api.twitter.com/2/users/${userId}/liked_tweets` +
        `?max_results=${Math.min(limit, 100)}` +
        `&tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=username`;
      const data = await httpJson(url, { headers: { Authorization: `Bearer ${bearer}` } });
      const users = {};
      for (const u of data.includes?.users || []) users[u.id] = u;
      return (data.data || []).map((t) => mapTweet(t, users));
    }

    // Fallback: fixtures.
    return loadFixture('x_likes.sample.json').slice(0, limit).map((t) => mapTweet(t));
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

module.exports = { XConnector, mapTweet };
