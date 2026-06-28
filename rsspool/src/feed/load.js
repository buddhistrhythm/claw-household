'use strict';

/**
 * load.js — fetch + parse a single feed into raw items, stamped with the
 * feed's identity (source / source_name / category).
 */

const fs = require('fs');
const path = require('path');
const { httpText } = require('../util/http');
const { parseFeed } = require('./parser');
const { resolveFeedUrl } = require('./rsshub');
const config = require('../config');

async function readFeedBody(feed, rsshub) {
  if (feed.file) {
    const p = path.isAbsolute(feed.file) ? feed.file : path.join(config.root, feed.file);
    return fs.readFileSync(p, 'utf8');
  }
  return httpText(resolveFeedUrl(feed, rsshub));
}

/**
 * @param {object} feed   { name, source, category, url|rsshub|file, limit }
 * @param {object} [opts] { rsshub, limit }
 * @returns {Promise<Array>} raw items
 */
async function loadFeed(feed, opts = {}) {
  const xml = await readFeedBody(feed, opts.rsshub || {});
  let items = parseFeed(xml, feed.name);
  const limit = opts.limit || feed.limit;
  if (limit) items = items.slice(0, limit);

  const source = feed.source || 'rss';
  const category = feed.category || null;
  return items.map((it) => ({
    ...it,
    source,
    source_name: feed.name || it.source_name,
    topics: category ? [category] : [],
    tags: [source, ...(category ? [category] : [])],
    metadata: { ...it.metadata, feed: feed.name, category },
  }));
}

module.exports = { loadFeed };
