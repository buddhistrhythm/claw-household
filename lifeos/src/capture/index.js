'use strict';

/**
 * capture/index.js — 捕获管线门面 (Capture pipeline facade).
 *
 * 一条管线，两端插件（SPEC-plugins.md）：
 *   Source → Capture(归一化, append-only inbox, 可溯源) → Router → Intent → entity
 *
 * 设计要点：
 *  - capture 自身是实体（type=capture），id 由 channel+source_ref 确定 → 天然幂等去重。
 *  - 确定性规则优先；LLM 仅兜底（注入式客户端，测试可离线 stub）。
 *  - 钱/库存不许瞎猜：低置信或 confirm:'always' 的捕获停在 `pending` 等人工确认。
 *  - 落库实体回连 entity -[captured_from]-> capture，全程可追溯。
 */

const crypto = require('crypto');
const buildIntents = require('./intents');
const buildRouter = require('./router');

const CAPTURED_FROM = 'captured_from';
const AUTO_COMMIT_LLM_CONFIDENCE = 0.8; // LLM 路由自动落库的最低置信度

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

module.exports = function capture(store, { llm } = {}) {
  const { entities, relations } = store;
  const intents = buildIntents(store);
  // 未显式注入 llm 时，按环境自动启用 Anthropic 路由（无 key = 纯规则 + pending）。
  // Default LLM from env when not injected; without a key we degrade to rules-only.
  if (llm === undefined && process.env.ANTHROPIC_API_KEY) {
    llm = require('./router').anthropicLLM({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  const router = buildRouter(store, intents, { llm });
  const byName = new Map(intents.map((i) => [i.name, i]));

  /** 校验参数(zod) → 执行 Intent → 回连 captured_from 边。 */
  async function runIntent(intent, args, captureEntity) {
    const parsed = intent.schema.parse(args || {});
    const result = await intent.run(parsed, { store, capture: captureEntity });
    if (result && result.id) {
      await relations.link(result.id, CAPTURED_FROM, captureEntity.id, {
        family_id: captureEntity.family_id || null,
      });
    }
    return result;
  }

  return {
    /** 已注册的 Intent 列表（同一批工具也可暴露给 MCP/外部 Agent）。 */
    intents: () => intents,

    /**
     * 入站：归一化 → 去重 → 路由 → 自动落库或挂起。
     * 必填：channel + source_ref（稳定外部 ID，幂等键）。
     * 返回 { status: 'committed'|'pending'|'duplicate', id, route, result_id? }。
     */
    async ingest(raw = {}) {
      // ── (1) 归一化 Capture / normalize ────────────────────────────────
      if (!raw.channel || !raw.source_ref) {
        throw new Error('capture.ingest: `channel` and `source_ref` are required');
      }
      const channel = String(raw.channel);
      const source_ref = String(raw.source_ref);
      const kind = raw.kind || 'text';
      const text = raw.text || '';
      const id = 'cap_' + sha1(`${channel}:${source_ref}`).slice(0, 16); // 确定性 id = 去重键

      // ── (2) 去重 / dedup：同 channel+source_ref 只入一次 ──────────────
      const existing = await entities.get(id);
      if (existing) {
        return { status: 'duplicate', id, route: (existing.data || {}).route || null };
      }

      // ── (3) 建 capture 实体（append-only inbox） ──────────────────────
      const captureEntity = await entities.create({
        id,
        type: 'capture',
        title: (text || kind).slice(0, 80),
        body: text,
        status: 'new',
        source: channel,
        source_ref,
        occurred_at: raw.occurred_at || new Date().toISOString(),
        data: {
          kind,
          channel,
          media: raw.media || [],
          author: raw.author || null,
          hints: raw.hints || {},
          raw: raw.raw === undefined ? null : raw.raw,
        },
      });

      // ── (4) 路由 / route ──────────────────────────────────────────────
      let route = null;
      let routeError = null;
      try {
        route = await router.route(captureEntity);
      } catch (e) {
        routeError = e.message; // 路由失败 ≠ 丢数据：留在 pending，可人工处理
      }

      // ── (5) 决策：自动落库 or pending ─────────────────────────────────
      if (route && byName.has(route.intent)) {
        const intent = byName.get(route.intent);
        const confirm = intent.confirm || 'low';
        const autoCommit =
          confirm !== 'always' &&
          ((route.by === 'rule' && route.confidence >= 1) ||
            (route.by === 'llm' && confirm === 'never' && route.confidence >= AUTO_COMMIT_LLM_CONFIDENCE));

        if (autoCommit) {
          try {
            const result = await runIntent(intent, route.args, captureEntity);
            await entities.mergeData(id, { route, result_id: result.id });
            await entities.patch(id, { status: 'committed' });
            return { status: 'committed', id, route, result_id: result.id };
          } catch (e) {
            // 执行失败（如位置/账户解析不了）→ 诚实地停下，挂 pending 等人工。
            await entities.mergeData(id, { route, error: e.message });
            await entities.patch(id, { status: 'pending' });
            return { status: 'pending', id, route, error: e.message };
          }
        }
        // confirm:'always' / 歧义规则 / 低置信 LLM → pending（带建议）
        await entities.mergeData(id, { route });
        await entities.patch(id, { status: 'pending' });
        return { status: 'pending', id, route };
      }

      // 无路由（无规则命中且无 LLM）→ pending，等人工指定 Intent。
      await entities.mergeData(id, { route: null, ...(routeError ? { error: routeError } : {}) });
      await entities.patch(id, { status: 'pending' });
      return { status: 'pending', id, route: null, ...(routeError ? { error: routeError } : {}) };
    },

    /** 待确认队列：status='pending' 的捕获 + 其 data.route 建议。 */
    async pending({ limit = 50 } = {}) {
      const list = await entities.list({ type: 'capture', status: 'pending', limit });
      return list.map((e) => ({ ...e, suggestion: (e.data || {}).route || null }));
    },

    /**
     * 人工确认：执行（可覆盖的）intent+args，落库并回连。
     * - 不传 intent/args 时用 data.route 的建议；
     * - 传 args 且 intent 与建议一致时，与建议 args 合并（覆盖优先）。
     */
    async confirm(captureId, { intent: intentName, args } = {}) {
      const cap = await entities.get(captureId);
      if (!cap || cap.type !== 'capture') throw new Error(`capture.confirm: capture not found: ${captureId}`);
      if (cap.status === 'committed') throw new Error(`capture.confirm: ${captureId} is already committed`);

      const suggestion = (cap.data || {}).route || null;
      const name = intentName || (suggestion && suggestion.intent);
      if (!name) throw new Error('capture.confirm: no intent suggested — pass { intent, args }');
      const intent = byName.get(name);
      if (!intent) throw new Error(`capture.confirm: unknown intent: ${name}`);

      // intent 与建议一致 → 合并建议参数（人工覆盖优先）；否则只用传入的 args。
      const finalArgs = (suggestion && suggestion.intent === name)
        ? { ...(suggestion.args || {}), ...(args || {}) }
        : (args || {});

      const result = await runIntent(intent, finalArgs, cap);
      const route = {
        intent: name,
        args: finalArgs,
        confidence: suggestion ? suggestion.confidence : null,
        by: suggestion ? suggestion.by : 'human',
        confirmed_by: 'human',
      };
      await entities.mergeData(captureId, { route, result_id: result.id, error: null });
      await entities.patch(captureId, { status: 'committed' });
      return { status: 'committed', id: captureId, route, result_id: result.id };
    },

    /** 人工驳回：不落库，仅标记 dismissed（审计带保留）。 */
    async dismiss(captureId) {
      const cap = await entities.get(captureId);
      if (!cap || cap.type !== 'capture') throw new Error(`capture.dismiss: capture not found: ${captureId}`);
      await entities.patch(captureId, { status: 'dismissed' });
      return { status: 'dismissed', id: captureId };
    },
  };
};

// 新类型注册 / NEW entity type：capture（inbox 域，append-only）。
module.exports.types = [
  { type: 'capture', domain: 'inbox', label: '捕获', icon: '📥',
    description: '入站事件收件箱（append-only，可溯源）',
    schema: { fields: { kind: 'text', channel: 'text', confidence: 'number' } } },
];

module.exports.CAPTURED_FROM = CAPTURED_FROM;

// ─── manifest: CLI commands ───────────────────────────────────────────────────
module.exports.commands = (d, { num }) => ({
  'capture-text': {
    desc: '捕获一句话（走 Router）', usage: 'capture-text "<msg>" [--channel C] [--hint-domain D]',
    run: ({ positional, flags }) => d.ingest({
      channel: flags.channel || 'cli', kind: 'text',
      source_ref: 'cli:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text: positional.join(' '),
      hints: flags['hint-domain'] ? { domain: flags['hint-domain'] } : undefined,
    }),
  },
  captures: {
    desc: '待确认的捕获队列', usage: 'captures [--limit N]',
    run: ({ flags }) => d.pending({ limit: num(flags.limit) }),
  },
  'capture-confirm': {
    desc: '确认并落库（可覆写 intent/args）', usage: 'capture-confirm <id> [--intent I] [--args JSON]',
    run: ({ positional, flags }) => d.confirm(positional[0], {
      intent: flags.intent, args: typeof flags.args === 'string' ? JSON.parse(flags.args) : undefined,
    }),
  },
  'capture-dismiss': { desc: '忽略一条捕获', usage: 'capture-dismiss <id>', run: ({ positional }) => d.dismiss(positional[0]) },
  'capture-serve': {
    desc: '起 webhook 捕获源（常驻）', usage: 'capture-serve [--port N] [--host H] [--secret S]',
    run: async ({ flags }) => {
      const { startWebhookSource } = require('./sources/webhook');
      const { port } = await startWebhookSource({
        captureApi: d, port: num(flags.port) || 8849,
        host: typeof flags.host === 'string' ? flags.host : '127.0.0.1',
        secret: flags.secret || process.env.LIFEOS_CAPTURE_SECRET,
      });
      console.error(`capture webhook listening on :${port} (POST /ingest/webhook)`);
      return new Promise(() => {}); // 常驻 / stay alive
    },
  },
  'capture-watch': {
    desc: '监听目录（照片/文本 → 捕获）', usage: 'capture-watch <dir> [--interval MS]',
    run: async ({ positional, flags }) => {
      const { watchFolder } = require('./sources/watchfolder');
      const w = watchFolder({ captureApi: d, dir: positional[0], intervalMs: num(flags.interval) || 5000 });
      w.start();
      console.error(`watching ${positional[0]} …`);
      return new Promise(() => {}); // 常驻 / stay alive
    },
  },
});
