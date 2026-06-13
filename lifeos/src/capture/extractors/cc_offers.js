'use strict';

/**
 * capture/extractors/cc_offers.js — 信用卡 offer 批量抽取器.
 *
 * 输入：DoC / FrequentMiler / 发卡行页面的可见文本（已去 HTML 标签）。
 * 输出：Offer[] —— 启发式解析，目标 70% 覆盖率（DoC 列表页常见格式）。
 *
 * 设计原则：
 *  - 纯正则、零依赖（pure JS, node:builtins only）。
 *  - 抽不全没关系：source_url 永远写进 note，可溯源；剩下的字段用户在 inbox 改。
 *  - 不调 LLM、不发网络请求 —— LLM 兜底在 router 层（intent.run 可选）。
 *
 * Offer shape:
 *   { card_name, issuer?, network?,
 *     signup_bonus_text?, signup_bonus_value?,
 *     bonus_requirement_text?, spend_required?, time_window_days?,
 *     annual_fee?, bonus_deadline?, source_url, note? }
 */

// ── 发卡行 / 卡网络字典（用于从卡名推断 issuer/network） ──────────────────
const ISSUERS = [
  'Chase', 'American Express', 'Amex', 'Citi', 'Capital One', 'Bank of America',
  'BofA', 'Wells Fargo', 'US Bank', 'Barclays', 'Discover', 'Synchrony',
  'Bilt', 'HSBC', 'PNC', 'TD Bank',
];
const NETWORKS = ['Visa', 'Mastercard', 'Amex', 'American Express', 'Discover'];

/** 卡名常见后缀，用于在文本里抓「Xxx Yyy Card / Reserve / Preferred ...」。 */
const CARD_SUFFIX = '(?:Card|Cards|Reserve|Preferred|Premier|Plus|Gold|Platinum|Business|Cash|Rewards|Signature|Elite|World|Infinite)';

/** 把 "60,000" / "$1,500" → 整数。 */
function toInt(s) {
  if (s === undefined || s === null) return undefined;
  const n = Number(String(s).replace(/[,$\s]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/** 推断 issuer：在卡名 / 上下文里找已知发卡行。 */
function inferIssuer(cardName, ctx = '') {
  const hay = `${cardName} ${ctx}`;
  for (const iss of ISSUERS) {
    const re = new RegExp(`\\b${iss.replace(/\s+/g, '\\s+')}\\b`, 'i');
    if (re.test(hay)) {
      // Amex 归一 / canonicalize
      if (/^Amex$/i.test(iss)) return 'American Express';
      if (/^BofA$/i.test(iss)) return 'Bank of America';
      return iss;
    }
  }
  return undefined;
}

/** 推断 network：从卡名 / 上下文里找 Visa/MC/Amex/Discover。 */
function inferNetwork(cardName, ctx = '') {
  const hay = `${cardName} ${ctx}`;
  for (const net of NETWORKS) {
    if (new RegExp(`\\b${net.replace(/\s+/g, '\\s+')}\\b`, 'i').test(hay)) {
      if (/^Amex$/i.test(net)) return 'American Express';
      return net;
    }
  }
  return undefined;
}

/**
 * normalizeOffer — 把原始抽取对象补全默认字段并清掉空值。
 * - 永远写 source_url 进 note，保证可溯源（即使其他字段全空也行）。
 */
function normalizeOffer(raw = {}) {
  const o = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null || v === '') continue;
    o[k] = v;
  }
  if (!o.card_name) return null;
  if (o.source_url && !o.note) {
    o.note = `Source: ${o.source_url}`;
  }
  return o;
}

/**
 * splitIntoOfferBlocks — 按卡名标题切分文本块.
 *
 * DoC / FrequentMiler 列表页通常每张卡有一个块：以「卡名」开头，下面跟着
 * 「Earn N points after spending $X in Y months」「$Z annual fee」等行。
 * 这里用「以一行 *只包含* 卡名候选格式的行」作为切分锚。
 */
function splitIntoOfferBlocks(text) {
  const lines = String(text).split(/\r?\n/);
  // 卡名行：以大写开头、≤ 12 词、以 Card/Reserve/Preferred/... 结尾。
  // Card-name line: title-cased, ≤ 12 words, ends in a recognizable suffix.
  const cardLineRe = new RegExp(
    `^\\s*([A-Z][A-Za-z0-9'&\\- ]{2,80}?\\s+${CARD_SUFFIX})\\s*$`,
  );
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(cardLineRe);
    if (m) {
      if (current) blocks.push(current);
      current = { card_name: m[1].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/**
 * extractFromBlock — 对一个 offer 文本块运行启发式抽取.
 * 返回 raw offer 对象（未 normalize）。
 */
function extractFromBlock(block, source_url) {
  const body = block.lines.join('\n');
  const o = { card_name: block.card_name, source_url };

  // ── signup bonus value: "Earn 60,000 points/miles/cash" ─────────────────
  const bonusM = body.match(/Earn\s+\$?(\d[\d,]*)\s*(points?|miles?|cash|cashback|cash\s*back|dollars?|\$|%\s*back)/i);
  if (bonusM) {
    o.signup_bonus_value = toInt(bonusM[1]);
    o.signup_bonus_text = bonusM[0].trim();
  }

  // ── spend requirement + time window: "after spending $4,000 in 3 months" ──
  const spendM = body.match(/after\s+(?:spending\s+)?\$?(\d[\d,]*)\s*(?:in|within)\s*(\d+)\s*months?/i);
  if (spendM) {
    o.spend_required = toInt(spendM[1]);
    o.time_window_days = Number(spendM[2]) * 30;
    o.bonus_requirement_text = spendM[0].trim();
  }

  // ── annual fee: "$95 annual fee" or "$0/yr" or "annual fee: $550" ──────
  const feeM = body.match(/\$(\d[\d,]*)\s*(?:annual fee|\/yr|\/year|per year)/i)
    || body.match(/annual\s+fee[:\s]+\$(\d[\d,]*)/i)
    || body.match(/\bAF[:\s]+\$(\d[\d,]*)/i);
  if (feeM) o.annual_fee = toInt(feeM[1]);

  // ── bonus deadline: "expires YYYY-MM-DD" or "by Jan 31, 2027" ───────────
  const dlIso = body.match(/(?:expires?|deadline|by)\s+(\d{4}-\d{2}-\d{2})/i);
  if (dlIso) o.bonus_deadline = dlIso[1];

  // ── issuer / network — 从卡名 + 整块上下文推断 ──────────────────────────
  const ctx = body;
  const issuer = inferIssuer(block.card_name, ctx);
  if (issuer) o.issuer = issuer;
  const network = inferNetwork(block.card_name, ctx);
  if (network) o.network = network;

  return o;
}

/**
 * parseOffers — 主入口：从一段网页文本里抽出 N 个 offer.
 *
 * 启发式而非严格解析：不保证 100%；目标是 DoC 列表页 70% 覆盖。
 * 总是返回数组（可能为空）。每个 offer 的 note 字段含 source_url，保留溯源。
 */
function parseOffers(text, source_url) {
  if (!text || typeof text !== 'string') return [];
  const blocks = splitIntoOfferBlocks(text);
  const offers = [];
  for (const block of blocks) {
    const raw = extractFromBlock(block, source_url);
    const norm = normalizeOffer(raw);
    if (norm) offers.push(norm);
  }
  return offers;
}

// ── LLM 兜底（可选，由调用方按 env 决定是否启用） ───────────────────────────
//
// 仅当 ANTHROPIC_API_KEY 存在 + 调用方显式启用时调用。**测试绝不调用此函数**。
// Mirror style of capture/router.js anthropicLLM: zero-dep, lazy fetch, no SDK.
async function extractOffersWithLLM(text, source_url, { apiKey, model = 'claude-sonnet-4-6' } = {}) {
  apiKey = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('extractOffersWithLLM: ANTHROPIC_API_KEY required');

  const tool = {
    name: 'record_offers',
    description: 'Record the list of credit card sign-up offers found on the page.',
    input_schema: {
      type: 'object',
      properties: {
        offers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              card_name: { type: 'string' },
              issuer: { type: 'string' },
              network: { type: 'string' },
              signup_bonus_text: { type: 'string' },
              signup_bonus_value: { type: 'number' },
              bonus_requirement_text: { type: 'string' },
              spend_required: { type: 'number' },
              time_window_days: { type: 'number' },
              annual_fee: { type: 'number' },
              bonus_deadline: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['card_name'],
            additionalProperties: false,
          },
        },
      },
      required: ['offers'],
      additionalProperties: false,
    },
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system:
        'You extract credit card sign-up bonus offers from a web page. ' +
        'Return ONE call to record_offers with every distinct card offer you find. ' +
        'Be conservative: skip cards without a clear bonus.',
      tools: [tool],
      tool_choice: { type: 'tool', name: 'record_offers' },
      messages: [{
        role: 'user',
        content: `Page URL: ${source_url || '(unknown)'}\n\n${String(text).slice(0, 100000)}`,
      }],
    }),
  });
  if (!res.ok) throw new Error(`extractOffersWithLLM: HTTP ${res.status} ${await res.text()}`);
  const msg = await res.json();
  const use = (msg.content || []).find((b) => b.type === 'tool_use' && b.name === 'record_offers');
  if (!use) return [];
  const raw = (use.input && Array.isArray(use.input.offers)) ? use.input.offers : [];
  return raw.map((o) => normalizeOffer({ ...o, source_url })).filter(Boolean);
}

// ── Intent factory — credit_card.bulk_offers ───────────────────────────────
//
// 该 Intent 仅在 capture.data.hints.kind === 'cc_offers' 时由规则确定性命中
// （Chrome 扩展会显式打这个 hint），不让 LLM 自己决定 intent；LLM 只在 run()
// 里做「offer 列表抽取」，不做路由。
function creditCardBulkOffersIntent(store) {
  const { z } = require('zod');
  const creditCardDomain = require('../../domains/credit_card');
  const cc = creditCardDomain(store);

  const offerSchema = z.object({
    card_name: z.string().min(1),
    issuer: z.string().optional(),
    network: z.string().optional(),
    signup_bonus_text: z.string().optional(),
    signup_bonus_value: z.number().optional(),
    bonus_requirement_text: z.string().optional(),
    spend_required: z.number().optional(),
    time_window_days: z.number().optional(),
    annual_fee: z.number().optional(),
    bonus_deadline: z.string().optional(),
    source_url: z.string().optional(),
    note: z.string().optional(),
  });

  return {
    name: 'credit_card.bulk_offers',
    description:
      'Bulk-add credit card sign-up offers extracted from a web page (e.g. ' +
      'doctorofcredit.com, frequentmiler.com, issuer pages, churning subreddits). ' +
      'Each offer becomes a planned credit_card_application entity.',
    confirm: 'low',
    schema: z.object({
      text: z.string().describe('raw page text / 网页可见文本'),
      source_url: z.string().optional().describe('page URL / 来源 URL'),
      offers: z.array(offerSchema).optional().describe('pre-extracted offers (扩展可选)'),
    }),
    rules(c) {
      // 仅当上游 Source 明确打了 hints.kind='cc_offers' 才命中 —— 不抢其它路由。
      // Only fires when the source explicitly tags hints.kind='cc_offers'.
      const hints = (c.hints || {});
      if (hints.kind !== 'cc_offers') return null;
      return {
        args: {
          text: c.text || '',
          source_url: hints.url || hints.source_url || undefined,
        },
      };
    },
    async run(args, ctx) {
      const source_url = args.source_url || '';
      let offers = Array.isArray(args.offers) && args.offers.length ? args.offers : null;

      // 1) 扩展未预抽 → 用确定性正则解析。
      if (!offers) offers = parseOffers(args.text || '', source_url);

      // 2) 正则没抓到 → 可选 LLM 兜底（默认关，需 ANTHROPIC_API_KEY 或显式强制）。
      //    LIFEOS_FORCE_LLM_OFFERS=1 强制启用（即使正则有结果）。
      const forceLLM = process.env.LIFEOS_FORCE_LLM_OFFERS === '1';
      if ((offers.length === 0 || forceLLM) && process.env.ANTHROPIC_API_KEY) {
        try {
          const llmOffers = await extractOffersWithLLM(args.text || '', source_url);
          if (llmOffers.length) offers = llmOffers;
        } catch (e) {
          // LLM 失败不致命 —— 走空数组也行（capture 仍可被人工 confirm）。
          // LLM failure is non-fatal; we still commit zero offers with the source noted.
        }
      }

      // 3) 每个 offer → planned credit_card_application 实体。
      const created = [];
      for (const o of offers) {
        try {
          const ent = await cc.create({
            card: o.card_name,
            issuer: o.issuer,
            status: 'planned',
            annual_fee: o.annual_fee,
            signup_bonus: o.signup_bonus_text || (o.signup_bonus_value ? String(o.signup_bonus_value) : undefined),
            bonus_requirement: o.bonus_requirement_text,
            bonus_deadline: o.bonus_deadline,
            notes: o.note || (source_url ? `Source: ${source_url}` : ''),
          });
          created.push(ent);
        } catch (_e) {
          // 跳过单条失败 —— 不让一个坏 offer 拖垮整批。
          // Skip a single bad offer; don't sink the batch.
        }
      }

      // 4) 把全部 result_ids + 元信息 merge 进 capture.data；并为非首条 result
      //    手动回连 captured_from 边 —— capture/index.js 框架只给 primary 自动加边。
      //    Merge metadata onto capture; framework auto-links the primary entity,
      //    so we manually link the rest to keep traceability symmetric.
      if (ctx && ctx.capture && ctx.store) {
        const { entities, relations } = ctx.store;
        await entities.mergeData(ctx.capture.id, {
          result_ids: created.map((e) => e.id),
          offer_count: created.length,
          source_url,
        });
        // primary (created[0]) 由 capture/index.js 自动加边；其余补上。
        for (let i = 1; i < created.length; i++) {
          await relations.link(created[i].id, 'captured_from', ctx.capture.id, {
            family_id: ctx.capture.family_id || null,
          });
        }
      }

      // 5) Intent 契约要求返回单实体 —— 用首条作为 "primary"（拿到 captured_from 边）。
      //    若一条都没抽到，抛错让上层把 capture 留在 pending 等人工。
      if (!created.length) {
        throw new Error('credit_card.bulk_offers: no offers extracted from page');
      }
      return created[0];
    },
  };
}

module.exports = {
  parseOffers,
  normalizeOffer,
  extractOffersWithLLM,
  creditCardBulkOffersIntent,
};
