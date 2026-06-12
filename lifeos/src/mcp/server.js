'use strict';

/**
 * mcp/server.js — Model Context Protocol server over the lifeos graph.
 *
 * Exposes agentic retrieval (search + relation expansion + cited context) to any
 * MCP client (Claude Desktop, Cursor, etc.) via stdio. The graph is just queries
 * over the existing entities + relations tables — "direct edges = strongest
 * signal". No LLM calls happen server-side; `life_context` assembles cited
 * context deterministically for the *client* LLM to answer with.
 *
 * 把「搜索 + 关系扩展 + 带引用的上下文」这套 agentic 检索经 stdio 暴露给任意
 * MCP 客户端。图谱即对既有 实体 + 关系 表的查询（「直接边 = 最强信号」）。
 * 服务端不调用任何大模型；`life_context` 确定性地组装带引用的上下文，交由
 * 客户端 LLM 作答。
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const { createStore } = require('../store');
const graphFactory = require('../graph');
const semanticFactory = require('../semantic');

function text(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

/** Trim a long string into a citation excerpt. / 截取一段引用摘录。 */
function excerptOf(e) {
  const s = e.summary || e.body || '';
  return s.length > 280 ? s.slice(0, 280) + '…' : s;
}

/**
 * assembleContext — the deterministic citation engine behind `life_context`.
 *
 * Retrieves the top hits (via `opts.retrieve`, default store.search; the MCP tool
 * passes semantic.hybridSearch so retrieval fuses FTS + vector), and for each
 * pulls 1-hop graph neighbors as supporting context. Every source carries a
 * `citation` (data.url || source_ref || id) and a `why` explaining how it entered
 * the set ("matched query" for direct hits, "linked via <predicate>" for
 * neighbors). NO LLM call. Stays a pure function of (store, graph, query, opts).
 *
 * 确定性的引用组装：用 `opts.retrieve`（默认 store.search；MCP 工具传入
 * semantic.hybridSearch，使检索为「全文 + 向量」融合）取 top 命中，对每条拉取
 * 1 跳邻居作为佐证。每个 source 都带 `citation` 与 `why`（直接命中为 matched
 * query，邻居为 linked via <predicate>）。服务端不调用大模型，且保持为纯函数。
 */
async function assembleContext(store, graph, query, { hops = 5, limit = 5, retrieve } = {}) {
  const search = retrieve || ((q, o) => store.search(q, o));
  const hits = await search(query, { limit });
  const sources = [];
  const seen = new Set();

  for (const hit of hits) {
    const full = await store.entities.get(hit.id);
    if (!full || seen.has(full.id)) continue;
    seen.add(full.id);
    sources.push({
      id: full.id,
      title: full.title,
      excerpt: excerptOf(full),
      citation: (full.data && full.data.url) || full.source_ref || full.id,
      why: 'matched query',
    });

    // 1-hop context around each hit / 每条命中的 1 跳上下文
    const nbrs = await graph.neighbors(full.id, { limit: hops });
    for (const { edge, node } of nbrs) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      const e = await store.entities.get(node.id);
      sources.push({
        id: node.id,
        title: node.title,
        excerpt: e ? excerptOf(e) : node.summary || '',
        citation: node.url || node.id,
        why: `linked via ${edge.predicate}`,
      });
    }
  }

  return {
    query,
    sources,
    note: 'assembled context for the client LLM to answer WITH citations (no LLM call server-side)',
  };
}

async function buildServer(store) {
  const server = new McpServer({ name: 'lifeos', version: '0.1.0' });
  const graph = graphFactory(store);
  const semantic = semanticFactory(store);

  server.tool(
    'life_search',
    '在 lifeos 中全文检索实体（标题/摘要/正文）。Full-text search entities.',
    {
      query: z.string().describe('搜索关键词'),
      type: z.string().optional().describe('限定实体类型，如 knowledge_item、item、note'),
      limit: z.number().optional().describe('返回条数，默认 25'),
    },
    async ({ query, type, limit }) => {
      const hits = await store.search(query, { type, limit });
      return text({ query, count: hits.length, hits });
    }
  );

  server.tool(
    'life_get',
    '按 ID 获取一条完整实体。Get a single entity by id.',
    { id: z.string() },
    async ({ id }) => {
      const e = await store.entities.get(id);
      return text(e || { error: 'not found', id });
    }
  );

  server.tool(
    'life_neighbors',
    '取某实体的直接邻居（按关系边）。Direct graph neighbors via relation edges.',
    {
      id: z.string(),
      predicate: z.string().optional().describe('限定关系谓词，如 related_to、stored_in'),
      limit: z.number().optional().describe('返回条数，默认 50'),
    },
    async ({ id, predicate, limit }) => {
      const nbrs = await graph.neighbors(id, { predicate, limit: limit || 50 });
      return text({ id, count: nbrs.length, neighbors: nbrs });
    }
  );

  server.tool(
    'life_expand',
    '从某实体出发做有界 BFS 子图扩展。Bounded BFS subgraph expansion from a node.',
    {
      id: z.string(),
      depth: z.number().optional().describe('跳数，默认 1'),
      limit: z.number().optional().describe('节点上限，默认 100'),
    },
    async ({ id, depth, limit }) => {
      const sub = await graph.expand(id, { depth: depth || 1, limit: limit || 100 });
      return text(sub);
    }
  );

  server.tool(
    'life_recent',
    '查看最近的实体（可按类型/标签筛选）。List recent entities.',
    {
      type: z.string().optional(),
      tag: z.string().optional().describe('按标签筛选'),
      limit: z.number().optional().describe('返回条数，默认 20'),
    },
    async ({ type, tag, limit }) => {
      const items = await store.entities.list({ type, tag, limit: limit || 20 });
      return text({ count: items.length, items });
    }
  );

  server.tool(
    'life_stats',
    'lifeos 总览：实体总数、按类型统计、关系数量。Store overview.',
    {},
    async () => text(await store.stats())
  );

  server.tool(
    'life_context',
    '智能检索：搜索 + 1 跳关系扩展，组装成带引用的上下文，供客户端 LLM 作答。' +
      'Agentic retrieval: search + 1-hop expansion → cited context for the client LLM.',
    {
      query: z.string().describe('问题或检索意图'),
      hops: z.number().optional().describe('每条命中拉取的邻居数，默认 5'),
      limit: z.number().optional().describe('参与的检索命中数，默认 5'),
    },
    async ({ query, hops, limit }) =>
      text(
        await assembleContext(store, graph, query, {
          hops: hops || 5,
          limit: limit || 5,
          // Fuse FTS + vector for retrieval. / 检索用「全文 + 向量」融合。
          retrieve: (q, o) => semantic.hybridSearch(q, o),
        })
      )
  );

  server.tool(
    'life_semantic_search',
    '向量语义检索（pgvector 余弦相似度），可发现无共享关键词但语义相关的实体。' +
      'Vector semantic search (pgvector cosine) — finds entities related in meaning.',
    {
      query: z.string().describe('检索意图'),
      type: z.string().optional().describe('限定实体类型'),
      limit: z.number().optional().describe('返回条数，默认 25'),
    },
    async ({ query, type, limit }) => {
      const hits = await semantic.semanticSearch(query, { type, limit });
      return text({ query, count: hits.length, hits, enabled: await semantic.isEnabled() });
    }
  );

  server.tool(
    'life_reindex',
    '为缺失向量的实体回填嵌入（批量导入后调用）。Backfill embeddings for entities lacking one.',
    {
      type: z.string().optional().describe('仅回填某类型'),
      limit: z.number().optional().describe('本次最多回填条数'),
    },
    async ({ type, limit }) => text(await semantic.reindexAll({ type, limit }))
  );

  return server;
}

async function startMcp() {
  const store = await createStore();
  const server = await buildServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

module.exports = { startMcp, buildServer, assembleContext };
