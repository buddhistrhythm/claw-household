'use strict';

/**
 * capture/intents.js — Domain Intent 注册表（捕获管线的「出站端」）.
 *
 * 每个 Intent 自描述：name + description（给 LLM 路由读）+ zod schema（抽参 +
 * 生成 tool-use JSON Schema）+ 可选 rules（确定性命中，命中即跳过 LLM）+
 * run（落库）。confirm 策略决定是否需要人工确认：
 *   - 'never'  : 随便记（笔记），自动落库
 *   - 'low'    : 低置信才挂 pending（库存默认）
 *   - 'always' : 永远人工确认（钱不许瞎猜 / money NEVER auto-commits）
 *
 * 按 SPEC-plugins.md §3.3：领域模块未来可自带 `module.exports.intents`，
 * 这里先集中实现 P0/P1 的四个 Intent，不改任何 domains/* 文件。
 */

const { z } = require('zod');
const storageDomain = require('../domains/storage');
const notesDomain = require('../domains/notes');
const financeDomain = require('../domains/finance');
const { creditCardBulkOffersIntent } = require('./extractors/cc_offers');

/** 去掉 undefined 字段，让 args 干净可序列化。 */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

/**
 * 解析「<数量> <单位?> <名称> [到 <位置>]」/ "<qty> <unit?> <name> [到 <loc>]".
 * 故意保持简单（don't over-engineer）：覆盖 "3 盒 牛奶 到 冰箱"、"2 milk"、"牛奶"。
 */
function parseItemPhrase(s) {
  let rest = String(s || '').trim();
  if (!rest) return null;
  let location;
  const locM = rest.match(/^(.*?)\s*(?:到|去|->)\s*(.+)$/);
  if (locM && locM[1].trim()) { rest = locM[1].trim(); location = locM[2].trim(); }
  let quantity, unit, name = rest;
  const qm = rest.match(/^(\d+(?:\.\d+)?)\s*([\p{L}]{1,7})?\s+(.+)$/u);
  if (qm) { quantity = Number(qm[1]); unit = qm[2]; name = qm[3].trim(); }
  if (!name) return null;
  return compact({ name, quantity, unit, location });
}

module.exports = function buildIntents(store) {
  const { entities } = store;
  const storage = storageDomain(store);
  const notes = notesDomain(store);
  const finance = financeDomain(store);

  /** 按 type + 精确 title 找实体；返回所有命中（供唯一性判断）。 */
  async function byTitle(type, title) {
    const all = await entities.list({ type, limit: 500 });
    return all.filter((e) => e.title === title);
  }

  /** find-or-create 存放位置 / storage_location by exact title. */
  async function resolveLocationId(name) {
    const hits = await byTitle('storage_location', name);
    if (hits.length) return hits[0].id;
    const loc = await storage.createLocation({ name });
    return loc.id;
  }

  return [
    // ── storage.add_item — 入库一件东西 ─────────────────────────────────
    {
      name: 'storage.add_item',
      description:
        'Add a household item to storage inventory (家里添置/入库一件东西). ' +
        'Extract the item name, optional quantity + unit, and optional location name.',
      confirm: 'low',
      schema: z.object({
        name: z.string().min(1).describe('item name / 物品名'),
        quantity: z.number().optional().describe('how many / 数量'),
        unit: z.string().optional().describe('unit, e.g. 盒/瓶/box'),
        location: z.string().optional().describe('location name / 存放位置'),
      }),
      rules(c) {
        const text = (c.text || '').trim();
        const m = text.match(/^(?:加|添加|入库|add)\s+(.+)/i);
        const phrase = m ? m[1] : (c.hints && c.hints.domain === 'storage' ? text : null);
        if (!phrase) return null;
        const args = parseItemPhrase(phrase);
        return args ? { args } : null;
      },
      async run(args) {
        let locationId;
        if (args.location) locationId = await resolveLocationId(args.location);
        return storage.createItem({
          name: args.name, quantity: args.quantity, unit: args.unit, locationId,
        });
      },
    },

    // ── storage.place — 把已有物品归到某个位置 ──────────────────────────
    {
      name: 'storage.place',
      description:
        'Move/place an EXISTING item into an EXISTING storage location ' +
        '(把已有物品放到某个位置). Both must already exist by exact name.',
      confirm: 'low',
      schema: z.object({
        item: z.string().min(1).describe('existing item name / 物品名'),
        location: z.string().min(1).describe('existing location name / 位置名'),
      }),
      rules(c) {
        const m = (c.text || '').trim().match(/^(?:把)?(.+?)(?:放到|放进|放在|移到)(.+)$/);
        if (!m) return null;
        return { args: { item: m[1].trim(), location: m[2].trim() } };
      },
      async run(args) {
        // 只接受精确解析；解析不了就 throw —— 上层会把 capture 留在 pending 等人工。
        const items = await byTitle('item', args.item);
        if (items.length !== 1) {
          throw new Error(`storage.place: item "${args.item}" ${items.length ? 'is ambiguous' : 'not found'}`);
        }
        const locs = await byTitle('storage_location', args.location);
        if (locs.length !== 1) {
          throw new Error(`storage.place: location "${args.location}" ${locs.length ? 'is ambiguous' : 'not found'}`);
        }
        await storage.place(items[0].id, locs[0].id);
        return entities.get(items[0].id); // 返回被归置的物品实体（result entity）
      },
    },

    // ── notes.add_note — 记一条笔记（无风险，自动落库） ─────────────────
    {
      name: 'notes.add_note',
      description:
        'Capture a free-form note / memo (记一条备忘/笔记). ' +
        'Title = short first line; body = the rest, if any.',
      confirm: 'never',
      schema: z.object({
        title: z.string().min(1).describe('note title / 标题'),
        body: z.string().optional().describe('note body / 正文'),
      }),
      rules(c) {
        const m = (c.text || '').match(/^(?:记|note|备忘)[:：\s]+(.+)/is);
        if (!m) return null;
        const lines = m[1].trim().split('\n');
        const title = lines[0].trim();
        const body = lines.slice(1).join('\n').trim();
        if (!title) return null;
        return { args: compact({ title, body }) };
      },
      async run(args) {
        return notes.create({ title: args.title, body: args.body || '' });
      },
    },

    // ── finance.add_txn — 记一笔交易（钱 NEVER 自动落库） ───────────────
    {
      name: 'finance.add_txn',
      description:
        'Record a money transaction (记一笔收支). amount_cents is an INTEGER in cents; ' +
        "direction is 'debit' (spend/支出) or 'credit' (income/入账). " +
        'account is the account name; merchant/category optional.',
      confirm: 'always', // 钱不许瞎猜：规则命中也要人工确认。
      schema: z.object({
        amount_cents: z.number().int().describe('amount in integer cents / 金额（分）'),
        direction: z.enum(['debit', 'credit']).describe('debit=支出, credit=入账'),
        merchant: z.string().optional().describe('merchant / 商户'),
        category: z.string().optional().describe('category / 品类'),
        account: z.string().optional().describe('account name / 账户名'),
        posted_on: z.string().optional().describe('posted date YYYY-MM-DD / 入账日'),
      }),
      rules(c) {
        const m = (c.text || '').match(/(?:花了|支出|spent)\s*\$?([\d.]+)\s*(?:元|块|刀|usd|dollars?)?\s*(.*)$/i);
        if (!m) return null;
        const amount = parseFloat(m[1]);
        if (!Number.isFinite(amount)) return null;
        return {
          args: compact({
            amount_cents: Math.round(amount * 100),
            direction: 'debit',
            merchant: m[2] ? m[2].trim() : undefined,
          }),
        };
      },
      async run(args) {
        // 解析账户：按名字精确匹配；不给名字时仅当全库唯一账户才敢用。
        const accounts = await entities.list({ type: 'finance_account', limit: 500 });
        let account;
        if (args.account) {
          const hits = accounts.filter((a) => a.title === args.account);
          if (hits.length !== 1) {
            throw new Error(`finance.add_txn: account "${args.account}" ${hits.length ? 'is ambiguous' : 'not found'} — specify an exact account name`);
          }
          account = hits[0];
        } else if (accounts.length === 1) {
          account = accounts[0];
        } else {
          throw new Error(
            `finance.add_txn: ${accounts.length ? 'multiple accounts exist' : 'no finance account exists'} — pass args.account with the exact account name`
          );
        }
        return finance.addTxn({
          account_id: account.id,
          amount_cents: args.amount_cents,
          direction: args.direction,
          merchant: args.merchant,
          category: args.category,
          posted_on: args.posted_on,
        });
      },
    },

    // ── credit_card.bulk_offers — 批量入库 CC offer（Chrome 扩展驱动） ──
    creditCardBulkOffersIntent(store),
  ];
};
