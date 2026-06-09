'use strict';

/**
 * item.js — the canonical KnowledgeItem shape + normalization.
 *
 * Every connector emits "raw" items; `normalize()` turns them into the stable
 * schema the rest of the system (storage, Obsidian, MCP) relies on.
 *
 * Shape:
 *   {
 *     id, source, source_id, source_name, type, title, url, author,
 *     content, excerpt, tags[], topics[],
 *     liked_at, published_at, fetched_at, metadata{}, content_hash
 *   }
 */

const crypto = require('crypto');

function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

function slugify(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

/** Stable id derived from source + source_id, so re-ingesting dedups cleanly. */
function makeId(source, sourceId) {
  return 'ki_' + sha1(`${source}:${sourceId}`).slice(0, 20);
}

function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

function excerptOf(text, max = 240) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Normalize a raw connector item into a KnowledgeItem.
 * `source` may come from the raw item or be supplied by the caller.
 */
function normalize(raw) {
  const source = raw.source;
  if (!source) throw new Error('normalize: item is missing `source`');

  const sourceId = String(raw.source_id ?? raw.url ?? raw.title ?? sha1(JSON.stringify(raw)));
  const id = raw.id || makeId(source, sourceId);
  const title = (raw.title || '').toString().trim() || '(untitled)';
  const content = (raw.content || '').toString().trim();
  const tags = uniq((raw.tags || []).map((t) => String(t).toLowerCase().trim()));
  const topics = uniq((raw.topics || []).map((t) => String(t).toLowerCase().trim()));

  const item = {
    id,
    source,
    source_id: sourceId,
    source_name: raw.source_name || source,
    type: raw.type || 'item',
    title,
    url: raw.url || null,
    author: raw.author || null,
    content,
    excerpt: raw.excerpt || excerptOf(content || title),
    tags,
    topics,
    liked_at: raw.liked_at || null,
    published_at: raw.published_at || null,
    fetched_at: raw.fetched_at || new Date().toISOString(),
    metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {},
  };

  // content_hash ignores fetched_at so re-fetching unchanged content is a no-op.
  item.content_hash = sha1([title, item.url, content, tags.join(',')].join('|'));
  return item;
}

module.exports = { normalize, makeId, slugify, sha1, uniq, excerptOf };
