'use strict';

/**
 * rsshub.js — feed 配置 + URL 解析。Feed configuration + URL resolution.
 *
 * 一个 feed 是以下之一 / A feed is one of:
 *   - { url }     绝对 RSS/Atom URL（原生博客 feed）
 *   - { rsshub }  RSSHub 路由路径，相对 RSSHub base 解析
 *   - { file }    本地 feed 文件（测试 / 离线池用）
 * 外加身份字段 / plus identity: { name, source, category, limit }.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

// lifeos config 没有 feedsConfig/rsshub —— 这里自行计算路径。
// lifeos config has no feedsConfig/rsshub — compute the path ourselves.
const FEEDS_CONFIG_PATH = path.join(config.root, 'config', 'feeds.json');

function loadFeedsConfig() {
  try {
    return JSON.parse(fs.readFileSync(FEEDS_CONFIG_PATH, 'utf8'));
  } catch {
    return { rsshub: {}, feeds: [] };
  }
}

/**
 * 合并 feeds.json 的 RSSHub 设置与环境变量覆盖。
 * Merge the RSSHub settings from feeds.json with env overrides.
 * 环境变量（RSSHUB_BASE / RSSHUB_ACCESS_KEY）在设置时优先。
 * Env (RSSHUB_BASE / RSSHUB_ACCESS_KEY) wins when set.
 */
function resolveRsshub(fileRsshub = {}) {
  return {
    base: process.env.RSSHUB_BASE || fileRsshub.base || 'https://rsshub.app',
    accessKey: process.env.RSSHUB_ACCESS_KEY || fileRsshub.accessKey || null,
  };
}

/**
 * 解析 feed 的可抓取 URL（file 类型返回 null）。
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

module.exports = { loadFeedsConfig, resolveRsshub, resolveFeedUrl, FEEDS_CONFIG_PATH };
