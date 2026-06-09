'use strict';

/**
 * base.js — the connector contract.
 *
 * A connector knows how to pull "liked"/"favorited"/"followed" items from one
 * source and return them as raw items (the ingest pipeline normalizes them).
 *
 * Subclasses implement `fetch(opts)` → Promise<Array<rawItem>>.
 */

class Connector {
  /** @param {object} [config] source-specific config from sources.json */
  constructor(config = {}) {
    this.config = config;
  }

  /** @returns {string} unique source key, e.g. 'hackernews' */
  get name() {
    throw new Error('Connector subclass must define `name`');
  }

  /**
   * @param {object} [opts] runtime options (e.g. { limit })
   * @returns {Promise<Array>} raw items
   */
  async fetch() {
    return [];
  }
}

module.exports = { Connector };
