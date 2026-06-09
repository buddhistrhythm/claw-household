'use strict';

/**
 * connectors/index.js — connector registry + factory.
 */

const fs = require('fs');
const config = require('../config');
const { HackerNewsConnector } = require('./hackernews');
const { RssConnector } = require('./rss');
const { XConnector } = require('./x');
const { XiaohongshuConnector } = require('./xiaohongshu');

const REGISTRY = {
  hackernews: HackerNewsConnector,
  rss: RssConnector,
  x: XConnector,
  xiaohongshu: XiaohongshuConnector,
};

function loadSourcesConfig() {
  try {
    return JSON.parse(fs.readFileSync(config.sourcesConfig, 'utf8'));
  } catch {
    return { enabled: Object.keys(REGISTRY) };
  }
}

/**
 * Build connector instances.
 * @param {string[]} [only] restrict to these source keys
 * @returns {Array<{name, fetch}>}
 */
function buildConnectors(only) {
  const cfg = loadSourcesConfig();
  const enabled = only && only.length ? only : (cfg.enabled || Object.keys(REGISTRY));
  const connectors = [];
  for (const key of enabled) {
    const Cls = REGISTRY[key];
    if (!Cls) continue;
    connectors.push(new Cls(cfg[key] || {}));
  }
  return connectors;
}

module.exports = { REGISTRY, buildConnectors, loadSourcesConfig };
