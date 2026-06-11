'use strict';

/**
 * index.js — RSS 入库管线：feeds → 抓取/解析 → 归一化 → 富化 → 写入实体库。
 * The RSS ingestion pipeline: feeds → fetch/parse → normalize → enrich →
 * store as knowledge_item entities. 上游全部是 RSS（原生或经 RSSHub）。
 */

const { normalize, uniq } = require('./normalize');
const { deriveTags } = require('./enrich');
const { loadFeed } = require('./load');
const { loadFeedsConfig, resolveRsshub } = require('./rsshub');
const knowledgeDomain = require('../domains/knowledge');

/**
 * 在配置的（或传入的）feeds 上运行入库。
 * Run ingestion across the configured (or supplied) feeds.
 * @param {object} opts
 * @param {object} opts.store      lifeos store（必填 / required）
 * @param {Array}  [opts.feeds]    显式 feed 列表（缺省读 feeds.json）
 * @param {object} [opts.rsshub]   显式 rsshub 设置（缺省读 feeds.json/env）
 * @param {string} [opts.source]   过滤：仅此 source 的 feeds
 * @param {string} [opts.category] 过滤：仅此 category 的 feeds
 * @param {number} [opts.limit]    每个 feed 的条目上限
 * @param {function} [opts.log]    日志回调 log(msg)
 * @returns {Promise<object>} summary { total, inserted, updated, unchanged, feeds, errors }
 */
async function ingest(opts = {}) {
  const { store, source, category, limit, log = () => {} } = opts;
  if (!store) throw new Error('ingest: `store` is required');

  const cfg = loadFeedsConfig();
  const rsshub = opts.rsshub || resolveRsshub(cfg.rsshub);
  let feeds = opts.feeds || cfg.feeds || [];
  if (source) feeds = feeds.filter((f) => f.source === source);
  if (category) feeds = feeds.filter((f) => f.category === category);

  const kn = knowledgeDomain(store);

  const summary = {
    total: 0, inserted: 0, updated: 0, unchanged: 0,
    feeds: feeds.length, errors: [],
  };

  for (const feed of feeds) {
    const src = feed.source || 'rss';
    try {
      log(`→ ${feed.name} (${src})…`);
      const raw = await loadFeed(feed, { rsshub, limit });
      for (const r of raw) {
        const item = normalize(r);
        item.tags = uniq([...(item.tags || []), ...deriveTags(item)]);
        const res = await kn.upsertItem(item);
        summary[res.status]++;
        summary.total++;
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
