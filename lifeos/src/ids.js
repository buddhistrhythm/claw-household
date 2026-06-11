'use strict';

const crypto = require('crypto');

/** Time-sortable-ish unique id with a domain prefix, e.g. ent_lz4k9f3a1b2c. */
function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
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

module.exports = { newId, slugify };
