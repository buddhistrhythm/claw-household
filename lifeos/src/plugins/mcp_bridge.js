'use strict';

/**
 * plugins/mcp_bridge.js — 把外部 MCP 插件接成 lifeos 的捕获 Intent（out-of-process bridge）.
 *
 * 信任模型 / TRUST MODEL：
 *   外部插件是一个独立的 MCP server，跑在它自己的进程里（stdio 子进程或 HTTP 远端）。
 *   lifeos 作为 MCP **客户端** 连接它、`listTools()`、把每个 tool 暴露成一个 Intent。
 *   外部代码 **永远不碰** lifeos 的数据库：它的 tool 结果只是文本/JSON，由我们这边
 *   包成一个一等公民实体（`plugin_result`，带 provenance：plugin/tool/args/output）。
 *   因为是外部/不受信来源，这些 Intent 默认 `confirm:'always'` —— 人工确认之前
 *   pending 不会真正调用 `callTool`，外部副作用也就不会发生（human-gated）。
 *
 *   The external plugin is an independent MCP server in its OWN process. lifeos is
 *   the MCP CLIENT: it connects, lists tools, and exposes each tool as a capture
 *   Intent. External code NEVER touches lifeos's DB — its tool result is wrapped
 *   into a first-class `plugin_result` entity carrying provenance. Because the
 *   source is external/untrusted, intents default to confirm:'always', so the
 *   external `callTool` is NOT made until a human confirms the pending capture.
 *
 * 生命周期 / LIFECYCLE：
 *   connectMcpPlugin() 懒连接（lazy connect），返回 { intents, client, close }。
 *   close() 关闭 client（及其拥有的 transport）。集成方在 registry 的
 *   async initMcpPlugins() 里逐个连接 kind:'mcp' 的条目、缓存 intents、best-effort
 *   try-catch（单个插件挂掉不影响其它），再把 intents 并进 allIntents。
 */

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');

/**
 * connectMcpPlugin — 连上一个外部 MCP 插件，把它的每个 tool 暴露成一个 Intent.
 *
 * @param {object}   opts
 * @param {string}   opts.name        插件名（Intent 前缀 + provenance）/ plugin name.
 * @param {object}   opts.transport   已构造的 MCP client transport（测试注入 InMemory，
 *                                     生产用 buildTransportFromConfig 造）/ a client transport.
 * @param {string}  [opts.confirm='always']     确认策略；外部默认人工确认。
 * @param {string}  [opts.resultType='plugin_result']  落库实体类型。
 * @returns {Promise<{ intents: object[], client: Client, close: () => Promise<void> }>}
 */
async function connectMcpPlugin({ name, transport, confirm = 'always', resultType = 'plugin_result' }) {
  if (!name) throw new Error('connectMcpPlugin: `name` is required');
  if (!transport) throw new Error('connectMcpPlugin: `transport` is required');

  const client = new Client({ name: 'lifeos', version: '0.1.0' });
  await client.connect(transport);

  const { tools = [] } = await client.listTools();

  const intents = tools.map((tool) => {
    const toolName = tool.name;
    const intentName = `${name}.${toolName}`;
    return {
      name: intentName,
      description: tool.description || intentName,
      // jsonSchema 路径：直接携带 MCP tool 的 inputSchema（本就是 JSON Schema），
      // 不带 zod `schema`。捕获管线支持 jsonSchema 作为 zod schema 的替代。
      // jsonSchema path: carry the MCP tool's inputSchema as-is; no zod schema.
      jsonSchema: tool.inputSchema || { type: 'object', properties: {} },
      confirm,
      plugin: name,
      tool: toolName,
      async run(args, ctx) {
        // 真正调用外部 tool —— 只有走到这里（已人工确认）外部副作用才发生。
        // The external call happens ONLY here — after the human-gated confirm.
        const res = await client.callTool({ name: toolName, arguments: args || {} });
        const text = (Array.isArray(res.content) ? res.content : [])
          .filter((c) => c && c.type === 'text')
          .map((c) => c.text)
          .join('\n');
        // 把外部结果包成可溯源实体；外部代码从不直接写库。
        // Wrap the external result into a provenance-bearing entity.
        return ctx.store.entities.create({
          type: resultType,
          title: intentName,
          body: text,
          source: 'plugin:' + name,
          source_ref: name + ':' + toolName + ':' + Date.now().toString(36),
          data: {
            plugin: name,
            tool: toolName,
            args: args || {},
            output: text,
            isError: !!res.isError,
          },
        });
      },
    };
  });

  async function close() {
    await client.close();
    // transport 由 client 拥有，client.close() 会一并关闭它；若 transport 另有
    // 自己的 close 则尽力调用（best-effort，不抛）。
    if (transport && typeof transport.close === 'function') {
      try { await transport.close(); } catch (_) { /* already closed */ }
    }
  }

  return { intents, client, close };
}

/**
 * buildTransportFromConfig — 从 plugins.json 的一条 kind:'mcp' 配置造一个 client transport.
 *
 *   { command, args?, env? } → StdioClientTransport（启动外部子进程）
 *   { url }                  → StreamableHTTPClientTransport（连远端 HTTP MCP）
 *
 * 测试不走这里（注入 InMemoryTransport）；这是生产路径。
 * Production-only; tests inject an InMemoryTransport instead.
 */
function buildTransportFromConfig(entry) {
  if (entry && entry.command) {
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    return new StdioClientTransport({
      command: entry.command,
      args: entry.args || [],
      env: { ...process.env, ...(entry.env || {}) },
    });
  }
  if (entry && entry.url) {
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    return new StreamableHTTPClientTransport(new URL(entry.url));
  }
  throw new Error('buildTransportFromConfig: mcp plugin entry needs either `command` (stdio) or `url` (http)');
}

module.exports = { connectMcpPlugin, buildTransportFromConfig };

// ─── entity type registration（集成方 seed 这个类型）─────────────────────────
module.exports.types = [
  {
    type: 'plugin_result',
    domain: 'plugins',
    label: '插件结果',
    icon: '🔌',
    description: '外部 MCP 插件 tool 的调用结果（已包成可溯源实体）',
    schema: { fields: { plugin: 'text', tool: 'text', output: 'text' } },
  },
];
