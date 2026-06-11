'use strict';

/**
 * normalize.js — 规范化的 KnowledgeItem 形状 + 归一化逻辑（ported from rsspool）。
 * The canonical KnowledgeItem shape + normalization.
 *
 * 每个 connector 产出「原始」条目；`normalize()` 把它们转成存储 / 检索依赖的
 * 稳定结构。Every connector emits "raw" items; `normalize()` turns them into the
 * stable schema the rest of the system relies on.
 *
 * Shape:
 *   { id, source, source_id, source_name, type, title, url, author,
 *     content, excerpt, tags[], topics[],
 *     liked_at, published_at, fetched_at, metadata{}, content_hash }
 */

const crypto = require('crypto');

function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

/** 由 source + source_id 派生的稳定 id，重复入库可干净去重。
 *  Stable id derived from source + source_id, so re-ingesting dedups cleanly. */
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
 * 把原始 connector 条目规范化为 KnowledgeItem。
 * Normalize a raw connector item into a KnowledgeItem.
 * `source` 可来自原始条目或由调用方提供。
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

  // content_hash 忽略 fetched_at，因此重抓未变化的内容是 no-op。
  // content_hash ignores fetched_at so re-fetching unchanged content is a no-op.
  item.content_hash = sha1([title, item.url, content, tags.join(',')].join('|'));
  return item;
}

module.exports = { normalize, makeId, sha1, uniq, excerptOf };
