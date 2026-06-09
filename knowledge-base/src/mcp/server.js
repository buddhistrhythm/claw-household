'use strict';

/**
 * mcp/server.js — Model Context Protocol server over the personal knowledge base.
 *
 * Exposes the KB to any MCP client (Claude Desktop, Cursor, etc.) via stdio.
 * Tools: search, get, recent, list_sources, stats, related, ingest, quiz.
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const { createStore, createObsidian } = require('../storage');
const { ingest } = require('../pipeline/ingest');
const { generateQuiz } = require('../quiz/generate');

function text(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

/** Trim items to the fields worth sending to an LLM client. */
function brief(item) {
  if (!item) return null;
  return {
    id: item.id,
    source: item.source,
    source_name: item.source_name,
    title: item.title,
    url: item.url,
    author: item.author,
    excerpt: item.excerpt,
    tags: item.tags,
    liked_at: item.liked_at,
    published_at: item.published_at,
  };
}

async function buildServer(store) {
  const server = new McpServer({ name: 'knowledge-base', version: '0.1.0' });

  server.tool(
    'kb_search',
    '在个人知识库中全文检索（标题/正文/作者）。Search the personal knowledge base.',
    {
      query: z.string().describe('搜索关键词'),
      source: z.enum(['hackernews', 'rss', 'x', 'xiaohongshu']).optional().describe('限定来源'),
      limit: z.number().optional().describe('返回条数，默认 15'),
    },
    async ({ query, source, limit }) => {
      const items = await store.searchItems(query, { limit: limit || 15, source });
      return text({ query, count: items.length, items: items.map(brief) });
    }
  );

  server.tool(
    'kb_get',
    '按 ID 获取一条知识条目的完整内容。Get a single item by id.',
    { id: z.string() },
    async ({ id }) => {
      const item = await store.getItem(id);
      return text(item || { error: 'not found', id });
    }
  );

  server.tool(
    'kb_recent',
    '查看最近收藏/抓取的条目。List recent items (by liked/published/fetched time).',
    {
      source: z.enum(['hackernews', 'rss', 'x', 'xiaohongshu']).optional(),
      tag: z.string().optional().describe('按标签筛选，如 llm、rust'),
      limit: z.number().optional(),
    },
    async ({ source, tag, limit }) => {
      const items = await store.listItems({ source, tag, limit: limit || 20 });
      return text({ count: items.length, items: items.map(brief) });
    }
  );

  server.tool(
    'kb_list_sources',
    '列出各来源的条目数量。Counts per source.',
    {},
    async () => text(await store.stats())
  );

  server.tool(
    'kb_stats',
    '知识库总览：总数、按来源统计、最近抓取时间。',
    {},
    async () => text(await store.stats())
  );

  server.tool(
    'kb_related',
    '查找与某条目相关的内容（基于共享标签）。Related items via shared tags.',
    { id: z.string(), limit: z.number().optional() },
    async ({ id, limit }) => {
      const item = await store.getItem(id);
      if (!item) return text({ error: 'not found', id });
      const seen = new Set([id]);
      const out = [];
      for (const tag of item.tags || []) {
        const matches = await store.listItems({ tag, limit: 30 });
        for (const m of matches) {
          if (!seen.has(m.id)) { seen.add(m.id); out.push(brief(m)); }
        }
      }
      return text({ source_item: item.title, count: out.length, items: out.slice(0, limit || 10) });
    }
  );

  server.tool(
    'kb_ingest',
    '触发抓取：从启用的来源拉取最新收藏并入库。Run ingestion now.',
    {
      sources: z.array(z.enum(['hackernews', 'rss', 'x', 'xiaohongshu'])).optional(),
      limit: z.number().optional(),
    },
    async ({ sources, limit }) => {
      const obsidian = createObsidian();
      const summary = await ingest({ store, obsidian, sources, limit });
      return text(summary);
    }
  );

  server.tool(
    'kb_quiz',
    '从知识库生成 A-Tour-of-Go 风格的测验关卡。Generate study quiz levels.',
    { topic: z.string().optional(), count: z.number().optional() },
    async ({ topic, count }) => text(await generateQuiz(store, { topic, count: count || 5 }))
  );

  return server;
}

async function startMcp() {
  const store = await createStore();
  const server = await buildServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

module.exports = { startMcp, buildServer };
