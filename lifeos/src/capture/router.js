'use strict';

/**
 * capture/router.js — 通用路由器：Capture → {intent, args, confidence, by}.
 *
 * 两段式（SPEC-plugins.md §3.4，「确定性优先，LLM 兜底」）：
 *   Phase 1 规则：跑所有 Intent 的 rules()。唯一命中 → confidence 1（可审计、
 *     离线、免费）。多个命中 → 取第一个但置信封顶 0.6（歧义不许自动落库）。
 *   Phase 2 LLM：仅在规则未命中且注入了 llm 客户端时，把全部 Intent 当
 *     tool-use 工具集交给模型选 1 个并抽参。无 llm → 返回 null，capture 入 pending。
 *
 * llm 客户端契约（可注入，测试用 stub，离线）：
 *   { routeCapture({ capture, tools }) → Promise<{intent,args,confidence}|null> }
 */

const AMBIGUOUS_CONFIDENCE = 0.6;

/**
 * 极简 zod → JSON Schema 转换（zod v3）。只覆盖本管线 Intent 用到的类型：
 * object / string / number(int) / boolean / enum / optional / nullable / default。
 * 不引第三方依赖（NO new npm deps）。
 */
function zodToJsonSchema(schema) {
  const def = schema && schema._def;
  if (!def) return {};
  const out = (o) => (schema.description ? { ...o, description: schema.description } : o);
  switch (def.typeName) {
    case 'ZodOptional':
    case 'ZodNullable':
      return out(zodToJsonSchema(def.innerType));
    case 'ZodDefault':
      return out(zodToJsonSchema(def.innerType));
    case 'ZodObject': {
      const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
      const properties = {};
      const required = [];
      for (const [key, sub] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(sub);
        if (!sub.isOptional()) required.push(key);
      }
      const o = { type: 'object', properties, additionalProperties: false };
      if (required.length) o.required = required;
      return out(o);
    }
    case 'ZodString':
      return out({ type: 'string' });
    case 'ZodNumber':
      return out({ type: (def.checks || []).some((c) => c.kind === 'int') ? 'integer' : 'number' });
    case 'ZodBoolean':
      return out({ type: 'boolean' });
    case 'ZodEnum':
      return out({ type: 'string', enum: def.values });
    default:
      return out({}); // 未知类型：宽松放过（LLM 路由是兜底，不是验证器）
  }
}

/** 把 capture 实体还原成规则/LLM 看的 Capture 视图（契约见 SPEC §3.1）。 */
function captureView(entity) {
  const d = entity.data || {};
  return {
    id: entity.id,
    channel: d.channel || entity.source,
    kind: d.kind || 'text',
    source_ref: entity.source_ref,
    text: entity.body || '',
    media: d.media || [],
    author: d.author || null,
    occurred_at: entity.occurred_at || null,
    hints: d.hints || {},
    raw: d.raw,
  };
}

module.exports = function router(store, intents, { llm } = {}) {
  const byName = new Map(intents.map((i) => [i.name, i]));

  return {
    zodToJsonSchema, // 暴露给测试/集成方

    /** capture 实体 → 路由结果 {intent,args,confidence,by} | null（null = 入 pending）。 */
    async route(captureEntity) {
      const c = captureView(captureEntity);

      // ── Phase 1：确定性规则（能不调模型就不调） ──────────────────────
      const hits = [];
      for (const intent of intents) {
        if (typeof intent.rules !== 'function') continue;
        let r = null;
        try { r = intent.rules(c); } catch { r = null; } // 规则崩了≠管线崩了
        if (r && r.args) hits.push({ intent: intent.name, args: r.args });
      }
      if (hits.length === 1) {
        return { intent: hits[0].intent, args: hits[0].args, confidence: 1, by: 'rule' };
      }
      if (hits.length > 1) {
        // 多规则命中 = 歧义：取第一个建议但封顶置信，逼它走人工确认。
        return { intent: hits[0].intent, args: hits[0].args, confidence: AMBIGUOUS_CONFIDENCE, by: 'rule' };
      }

      // ── Phase 2：LLM tool-use 兜底（仅当注入了客户端） ────────────────
      if (!llm) return null;
      const tools = intents.map((i) => ({
        name: i.name,
        description: i.description,
        input_schema: zodToJsonSchema(i.schema),
      }));
      const out = await llm.routeCapture({ capture: c, tools });
      if (!out || !out.intent || !byName.has(out.intent)) return null;
      return {
        intent: out.intent,
        args: out.args || {},
        confidence: typeof out.confidence === 'number' ? out.confidence : 0.5,
        by: 'llm',
      };
    },
  };
};

/**
 * anthropicLLM — 真·Anthropic 适配器（生产路径）。
 *
 * **仅当设置了 ANTHROPIC_API_KEY 时由集成方启用**，例如：
 *   const llm = process.env.ANTHROPIC_API_KEY
 *     ? anthropicLLM({ apiKey: process.env.ANTHROPIC_API_KEY })
 *     : undefined;
 *   capture(store, { llm })
 *
 * 测试**绝不**调它（NO network in tests）——测试注入 stub 客户端。
 * 用全局 fetch 直连 /v1/messages（零依赖），tool_choice:any 强制模型从已注册
 * Intent 中选一个并抽参。照片走 media 注记（vision 的 image block 留给 P2）。
 */
function anthropicLLM({ apiKey, model = 'claude-sonnet-4-6' } = {}) {
  if (!apiKey) throw new Error('anthropicLLM: `apiKey` is required (set ANTHROPIC_API_KEY)');
  return {
    async routeCapture({ capture, tools }) {
      const mediaNote = (capture.media || []).length
        ? `\n[attached media: ${capture.media.map((m) => `${m.mime || 'file'} ${m.ref}`).join(', ')}]`
        : '';
      const hintNote = capture.hints && Object.keys(capture.hints).length
        ? `\n[source hints: ${JSON.stringify(capture.hints)}]`
        : '';
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system:
            'You route a single captured household message into exactly one domain intent. ' +
            'Pick the best tool and extract its arguments faithfully from the message. ' +
            'Messages may be Chinese or English.',
          tools,
          tool_choice: { type: 'any' },
          messages: [{
            role: 'user',
            content: `channel=${capture.channel} kind=${capture.kind}\n${capture.text || '(no text)'}${mediaNote}${hintNote}`,
          }],
        }),
      });
      if (!res.ok) throw new Error(`anthropic route failed: HTTP ${res.status} ${await res.text()}`);
      const msg = await res.json();
      const toolUse = (msg.content || []).find((b) => b.type === 'tool_use');
      if (!toolUse) return null;
      // API 不返回置信度；这里给保守固定值 0.7 —— 低于自动落库阈值(0.8)，
      // 即真实 LLM 路由默认全部走人工确认（「钱和库存不许瞎猜」的 P1 姿态）。
      return { intent: toolUse.name, args: toolUse.input || {}, confidence: 0.7 };
    },
  };
}

module.exports.anthropicLLM = anthropicLLM;
module.exports.zodToJsonSchema = zodToJsonSchema;
