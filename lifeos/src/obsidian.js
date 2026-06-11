'use strict';

/**
 * obsidian.js — render an entity (+ its outgoing relations) as an Obsidian note.
 * DB is the source of truth; the vault is a rich, queryable mirror.
 *
 * Layout: <vault>/<domain>/<type>/<id>__<slug>.md
 */

const fs = require('fs');
const path = require('path');
const { slugify } = require('./ids');

function yamlScalar(v) {
  if (v == null) return '""';
  const s = String(v);
  if (/^[\w@.\-+/:]+$/.test(s) && !/^\d{4}-\d{2}/.test(s)) return s;
  return JSON.stringify(s);
}

function yamlList(arr) {
  return arr && arr.length ? '[' + arr.map(yamlScalar).join(', ') + ']' : '[]';
}

/**
 * @param {object} entity
 * @param {Array}  edges  [{ predicate, target: { id, title } }]
 * @returns {string} markdown
 */
function renderEntityNote(entity, edges = []) {
  const fm = ['---'];
  fm.push(`id: ${yamlScalar(entity.id)}`);
  fm.push(`type: ${yamlScalar(entity.type)}`);
  fm.push(`title: ${yamlScalar(entity.title)}`);
  if (entity.status) fm.push(`status: ${yamlScalar(entity.status)}`);
  fm.push(`tags: ${yamlList(entity.tags)}`);
  if (entity.topics && entity.topics.length) fm.push(`topics: ${yamlList(entity.topics)}`);
  if (entity.occurred_at) fm.push(`occurred_at: ${yamlScalar(entity.occurred_at)}`);
  for (const [k, v] of Object.entries(entity.data || {})) {
    if (v === null || v === undefined || v === '') continue;
    fm.push(`${k}: ${Array.isArray(v) ? yamlList(v) : yamlScalar(v)}`);
  }
  fm.push('---');

  const body = [fm.join('\n'), '', `# ${entity.title || '(untitled)'}`, ''];
  if (entity.body) { body.push(entity.body, ''); }
  if (edges.length) {
    body.push('## Relations', '');
    for (const e of edges) {
      const t = e.target || {};
      body.push(`- ${e.predicate} → [[${noteBasename({ id: t.id, title: t.title })}]]`);
    }
    body.push('');
  }
  return body.join('\n') + '\n';
}

function noteBasename(entity) {
  return `${entity.id}__${slugify(entity.title)}`;
}

function pathFor(vault, entity, domain = 'general') {
  return path.join(vault, domain, entity.type, `${noteBasename(entity)}.md`);
}

function writeEntityNote(vault, entity, edges = [], domain = 'general') {
  const p = pathFor(vault, entity, domain);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, renderEntityNote(entity, edges));
  return p;
}

module.exports = { renderEntityNote, writeEntityNote, noteBasename, pathFor };
