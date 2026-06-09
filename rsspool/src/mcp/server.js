'use strict';

/**
 * mcp/server.js — Model Context Protocol server over the rsspool feed pool.
 *
 * Exposes the pooled RSS knowledge to any MCP client (Claude Desktop, Cursor,
 * etc.) via stdio. Tools: search, get, recent, list_sources, stats, related,
 * ingest, quiz.
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
    topics: item.topics,
    published_at: item.published_at,
  };
}

async function buildServer(store) {
  const server = new McpServer({ name: 'rsspool', version: '0.1.0' });

  server.tool(
    'pool_search',
    '在 RSS 知识池中全文检索（标题/正文/作者）。Full-text search the feed pool.',
    {
      query: z.string().describe('搜索关键词'),
      source: z.string().optional().describe('限定来源（feed 的 source，如 blog、hackernews、x、xiaohongshu）'),
      limit: z.number().optional().describe('返回条数，默认 15'),
    },
    async ({ query, source, limit }) => {
      const items = await store.searchItems(query, { limit: limit || 15, source });
      return text({ query, count: items.length, items: items.map(brief) });
    }
  );

  server.tool(
    'pool_get',
    '按 ID 获取一条完整内容。Get a single item by id.',
    { id: z.string() },
    async ({ id }) => {
      const item = await store.getItem(id);
      return text(item || { error: 'not found', id });
    }
  );

  server.tool(
    'pool_recent',
    '查看最近入池的条目。List recent items.',
    {
      source: z.string().optional(),
      tag: z.string().optional().describe('按标签筛选，如 llm、rust、ai'),
      limit: z.number().optional(),
    },
    async ({ source, tag, limit }) => {
      const items = await store.listItems({ source, tag, limit: limit || 20 });
      return text({ count: items.length, items: items.map(brief) });
    }
  );

  server.tool(
    'pool_list_sources',
    '列出各来源的条目数量。Counts per source.',
    {},
    async () => text(await store.stats())
  );

  server.tool(
    'pool_stats',
    '知识池总览：总数、按来源统计、最近抓取时间。',
    {},
    async () => text(await store.stats())
  );

  server.tool(
    'pool_related',
    '查找相关条目（基于共享标签）。Related items via shared tags.',
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
    'pool_ingest',
    '触发抓取：从配置的 RSS / RSSHub 源拉取最新内容入池。Run ingestion now.',
    {
      source: z.string().optional().describe('只抓取该 source 的 feed'),
      category: z.string().optional().describe('只抓取该 category 的 feed'),
      limit: z.number().optional(),
    },
    async ({ source, category, limit }) => {
      const obsidian = createObsidian();
      const summary = await ingest({ store, obsidian, source, category, limit });
      return text(summary);
    }
  );

  server.tool(
    'pool_quiz',
    '从知识池生成 A-Tour-of-Go 风格的测验关卡。Generate study quiz levels.',
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
