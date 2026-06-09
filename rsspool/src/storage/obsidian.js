'use strict';

/**
 * obsidian.js — mirrors each KnowledgeItem into an Obsidian-friendly markdown
 * vault: one note per item under `<vault>/<source>/<id>__<slug>.md`, with YAML
 * frontmatter Obsidian (and Dataview) can query.
 */

const path = require('path');
const fs = require('fs');
const { slugify } = require('../model/item');

function yamlScalar(v) {
  if (v == null) return '""';
  const s = String(v);
  if (/^[\w@.\-+/:]+$/.test(s) && !/^\d{4}-\d{2}/.test(s)) return s;
  return JSON.stringify(s);
}

function yamlList(arr) {
  if (!arr || !arr.length) return '[]';
  return '[' + arr.map((t) => yamlScalar(t)).join(', ') + ']';
}

function frontmatter(item) {
  const lines = ['---'];
  lines.push(`id: ${yamlScalar(item.id)}`);
  lines.push(`source: ${yamlScalar(item.source)}`);
  lines.push(`source_name: ${yamlScalar(item.source_name)}`);
  lines.push(`type: ${yamlScalar(item.type)}`);
  lines.push(`title: ${yamlScalar(item.title)}`);
  if (item.url) lines.push(`url: ${yamlScalar(item.url)}`);
  if (item.author) lines.push(`author: ${yamlScalar(item.author)}`);
  lines.push(`tags: ${yamlList(item.tags)}`);
  if (item.topics && item.topics.length) lines.push(`topics: ${yamlList(item.topics)}`);
  if (item.liked_at) lines.push(`liked_at: ${yamlScalar(item.liked_at)}`);
  if (item.published_at) lines.push(`published_at: ${yamlScalar(item.published_at)}`);
  lines.push(`fetched_at: ${yamlScalar(item.fetched_at)}`);
  lines.push('---');
  return lines.join('\n');
}

function renderNote(item) {
  const body = [];
  body.push(frontmatter(item));
  body.push('');
  body.push(`# ${item.title}`);
  body.push('');
  const meta = [`**Source:** ${item.source_name}`];
  if (item.author) meta.push(`**By:** ${item.author}`);
  if (item.published_at) meta.push(`**Published:** ${item.published_at.slice(0, 10)}`);
  body.push(meta.join('  ·  '));
  body.push('');
  if (item.content) {
    body.push(item.content);
    body.push('');
  }
  if (item.url) body.push(`🔗 [Open original](${item.url})`);
  return body.join('\n') + '\n';
}

function create(vaultDir, { enabled = true } = {}) {
  return {
    enabled,
    vaultDir,

    pathFor(item) {
      const file = `${item.id}__${slugify(item.title)}.md`;
      return path.join(vaultDir, item.source, file);
    },

    async writeItem(item) {
      if (!enabled) return null;
      const p = this.pathFor(item);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, renderNote(item));
      return p;
    },
  };
}

module.exports = { create, renderNote };
