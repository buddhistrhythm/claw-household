'use strict';

/**
 * notebooklm.js — export the knowledge base as upload-ready sources for
 * Google NotebookLM.
 *
 * NotebookLM has no public ingestion API, so the integration is export-based:
 * we bundle items into a small number of clean markdown documents (one per
 * source, NotebookLM caps sources per notebook) that you upload as sources.
 * Each doc stays under NotebookLM's per-source word budget by chunking.
 */

const fs = require('fs');
const path = require('path');

function itemSection(item) {
  const lines = [];
  lines.push(`## ${item.title}`);
  const meta = [item.source_name];
  if (item.author) meta.push(item.author);
  if (item.published_at) meta.push(item.published_at.slice(0, 10));
  lines.push(`*${meta.join(' · ')}*`);
  if (item.tags && item.tags.length) lines.push(`Tags: ${item.tags.join(', ')}`);
  lines.push('');
  if (item.content) lines.push(item.content);
  if (item.url) lines.push(`\nSource: ${item.url}`);
  lines.push('\n---\n');
  return lines.join('\n');
}

/**
 * @param {object} store storage backend
 * @param {object} [opts] { topic, dir, maxPerFile }
 * @returns {Promise<{dir, files, count}>}
 */
async function exportForNotebookLM(store, { topic, dir, maxPerFile = 200 } = {}) {
  const items = topic
    ? await store.searchItems(topic, { limit: 2000 })
    : await store.listItems({ limit: 5000 });

  // Group by source so each NotebookLM "source" doc is coherent.
  const groups = {};
  for (const it of items) {
    (groups[it.source_name] || (groups[it.source_name] = [])).push(it);
  }

  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const [sourceName, list] of Object.entries(groups)) {
    for (let part = 0; part * maxPerFile < list.length; part++) {
      const chunk = list.slice(part * maxPerFile, (part + 1) * maxPerFile);
      const safe = sourceName.replace(/[^\w一-龥-]+/g, '_');
      const suffix = list.length > maxPerFile ? `_part${part + 1}` : '';
      const file = path.join(dir, `${safe}${suffix}.md`);
      const body = [`# ${sourceName} — knowledge base export`, '', ...chunk.map(itemSection)].join('\n');
      fs.writeFileSync(file, body);
      files.push(file);
    }
  }

  // A README with upload instructions.
  const readme = [
    '# NotebookLM upload bundle',
    '',
    `Generated ${new Date().toISOString()} — ${items.length} items across ${Object.keys(groups).length} sources.`,
    '',
    '## How to use',
    '1. Open https://notebooklm.google.com and create (or open) a notebook.',
    '2. Click **+ Add source → Markdown / Text** and upload the `.md` files below.',
    '3. NotebookLM will index them; you can then chat, generate study guides, or an audio overview.',
    '',
    '## Files',
    ...files.map((f) => `- ${path.basename(f)}`),
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'README.md'), readme);

  return { dir, files, count: items.length };
}

module.exports = { exportForNotebookLM };
