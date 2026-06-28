'use strict';

/**
 * knowledge.js — 知识条目（RSS / 收藏 / 剪藏）。Knowledge items (RSS / clips).
 *
 * 每条知识条目是一个实体（type=knowledge_item）。归一化后的 RSS item 映射为
 * 实体：标题/正文/摘要走顶层列，作者/URL/feed/哈希等元信息走 JSONB `data`，
 * occurred_at = published_at。content_hash 用于重复入库时的去重判定。
 * Each item is an entity (type=knowledge_item). occurred_at = published_at;
 * domain metadata lives in JSONB `data`; content_hash drives re-ingest dedup.
 *
 * 注意：knowledge_item 类型已在 store/types.js 注册，本模块不重复声明。
 * Note: the knowledge_item type already exists; do not redeclare it.
 */

module.exports = function knowledgeDomain(store) {
  const { entities } = store;

  /** 把归一化 item 映射为实体 props。Map a normalized item -> entity props. */
  function toEntityProps(item) {
    return {
      id: item.id,
      type: 'knowledge_item',
      source: item.source,
      source_ref: item.url || null,
      title: item.title,
      body: item.content || '',
      summary: item.excerpt || '',
      tags: item.tags || [],
      topics: item.topics || [],
      occurred_at: item.published_at || null,
      data: {
        author: item.author || null,
        url: item.url || null,
        feed: (item.metadata && item.metadata.feed) || item.source_name || null,
        source_id: item.source_id,
        source_name: item.source_name || null,
        content_hash: item.content_hash,
      },
    };
  }

  return {
    /**
     * 幂等 upsert：id 缺失 -> 创建；content_hash 未变 -> unchanged；否则 patch。
     * Idempotent upsert keyed on the deterministic id + content_hash.
     * @returns {Promise<{status:'inserted'|'updated'|'unchanged', id:string}>}
     */
    async upsertItem(item) {
      const props = toEntityProps(item);
      const existing = await entities.get(props.id);
      if (!existing) {
        await entities.create(props);
        return { status: 'inserted', id: props.id };
      }
      if (existing.data && existing.data.content_hash === item.content_hash) {
        return { status: 'unchanged', id: props.id };
      }
      await entities.patch(props.id, {
        title: props.title,
        body: props.body,
        summary: props.summary,
        tags: props.tags,
        topics: props.topics,
        occurred_at: props.occurred_at,
        source_ref: props.source_ref,
        data: props.data,
      });
      return { status: 'updated', id: props.id };
    },

    /** 最近条目（可按标签过滤）。Recent items, optionally filtered by tag. */
    async recent({ tag, limit = 20 } = {}) {
      return entities.list({ type: 'knowledge_item', tag, limit });
    },

    /**
     * 与给定条目共享标签的相关条目（去重、排除自身）。
     * Items sharing tags with `id` (deduped, self excluded).
     */
    async related(id, { limit = 10 } = {}) {
      const self = await entities.get(id);
      if (!self) return [];
      const seen = new Map();
      for (const tag of self.tags || []) {
        const hits = await entities.list({ type: 'knowledge_item', tag, limit: limit + 1 });
        for (const h of hits) {
          if (h.id === id) continue;
          if (!seen.has(h.id)) seen.set(h.id, h);
        }
      }
      return [...seen.values()].slice(0, limit);
    },

    /** 全文检索（限定 knowledge_item）。Full-text search over knowledge items. */
    async search(q, { limit = 25 } = {}) {
      return store.search(q, { type: 'knowledge_item', limit });
    },
  };
};

module.exports.types = [];

// ─── manifest: CLI commands ───────────────────────────────────────────────────
module.exports.commands = (d, { num }) => ({
  'ki-recent': { desc: '最近知识条目', usage: 'ki-recent [--tag T] [--limit N]', run: ({ flags }) => d.recent({ tag: flags.tag, limit: num(flags.limit) }) },
  'ki-related': { desc: '相关条目（共享标签）', usage: 'ki-related <id> [--limit N]', run: ({ positional, flags }) => d.related(positional[0], { limit: num(flags.limit) }) },
  'ki-search': { desc: '检索知识条目', usage: 'ki-search <q>', run: ({ positional }) => d.search(positional.join(' '), {}) },
});
