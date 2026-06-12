'use strict';

/**
 * import/rsspool.js — 把 rsspool 的知识条目导入 lifeos（knowledge_item）。
 * Import rsspool knowledge items into lifeos via the knowledge domain.
 *
 * 支持三种输入 / accepted inputs:
 *   - JSON 数组文件（.json）：[ {id:'ki_*', title, content_hash, …}, … ]
 *   - JSONL 文件（.jsonl / 每行一个对象）
 *   - rsspool 的 sqlite 库（.db）：尝试从 rsspool/node_modules 解析
 *     better-sqlite3；解析不到则报错提示先导出 JSON：
 *     If better-sqlite3 cannot be resolved, export JSON first with:
 *       sqlite3 -json /path/to/rsspool.db \
 *         "SELECT * FROM knowledge_items;" > rsspool-items.json
 *     （tags/topics/metadata 列为 JSON 字符串，本导入器会自动解析。）
 *
 * 每条 item 走 knowledgeDomain(store).upsertItem：按保留的 ki_* id 建实体、
 * 按 content_hash 去重，所以重复导入是幂等的。
 * Each item goes through knowledgeDomain.upsertItem, which preserves the
 * ki_* id and dedups on content_hash — re-imports are idempotent.
 */

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const knowledgeDomain = require('../domains/knowledge');

// rsspool sqlite 的 JSON 文本列。JSON-encoded text columns in rsspool's sqlite.
const JSON_COLS = ['tags', 'topics', 'metadata'];

/** 解析 .json（数组）或 .jsonl 文件。Parse a JSON-array or JSONL file. */
function readJsonOrJsonl(file) {
  const text = fs.readFileSync(file, 'utf-8').trim();
  if (!text) return [];
  if (text[0] === '[') return JSON.parse(text);
  return text.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** sqlite 行 → item（解析 JSON 文本列）。Decode a sqlite row into an item. */
function rowToItem(row) {
  const item = { ...row };
  for (const c of JSON_COLS) {
    if (typeof item[c] === 'string') {
      try { item[c] = JSON.parse(item[c]); }
      catch { item[c] = c === 'metadata' ? {} : []; }
    }
    if (item[c] == null) item[c] = c === 'metadata' ? {} : [];
  }
  return item;
}

/** 从 rsspool 的 node_modules 解析 better-sqlite3 并读取全部条目。 */
function readSqlite(file) {
  // 优先 .db 同级的 node_modules，其次仓库内 rsspool/node_modules。
  // Try node_modules next to the .db, then the in-repo rsspool checkout.
  const candidates = [
    path.join(path.dirname(file), 'node_modules'),
    path.resolve(__dirname, '../../../rsspool/node_modules'),
    '/home/user/claw-household/rsspool/node_modules',
  ];
  let Database = null;
  for (const dir of candidates) {
    try {
      Database = createRequire(path.join(dir, 'noop.js'))('better-sqlite3');
      break;
    } catch { /* try next candidate */ }
  }
  if (!Database) {
    throw new Error(
      'importRsspool: cannot resolve better-sqlite3 (looked in ' +
      candidates.join(', ') + '). Export JSON first and import that instead:\n' +
      `  sqlite3 -json ${file} "SELECT * FROM knowledge_items;" > rsspool-items.json`
    );
  }
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT * FROM knowledge_items').all().map(rowToItem);
  } finally {
    db.close();
  }
}

/**
 * @param {{ store: object, file: string, log?: Function }} opts
 * @returns {Promise<{total:number, inserted:number, updated:number, unchanged:number, errors:string[]}>}
 */
async function importRsspool({ store, file, log = () => {} }) {
  if (!store) throw new Error('importRsspool: `store` is required');
  if (!file) throw new Error('importRsspool: `file` is required');

  const items = file.endsWith('.db') ? readSqlite(file) : readJsonOrJsonl(file);
  const knowledge = knowledgeDomain(store);

  const summary = { total: 0, inserted: 0, updated: 0, unchanged: 0, errors: [] };
  for (const raw of items) {
    summary.total += 1;
    const item = rowToItem(raw); // JSON 文件里若已是数组/对象则原样保留
    try {
      const r = await knowledge.upsertItem(item);
      summary[r.status] += 1;
      log(`${r.status} ${r.id}`);
    } catch (err) {
      summary.errors.push(`${item && item.id}: ${err.message}`);
    }
  }
  log(`done: total=${summary.total} inserted=${summary.inserted} updated=${summary.updated} unchanged=${summary.unchanged}`);
  return summary;
}

module.exports = { importRsspool };
