'use strict';

/**
 * finance.js — 账户 + 交易流水 (accounts + transactions).
 *
 * 每个账户是一个 entity (type=finance_account)；每笔交易是一个 entity
 * (type=finance_txn)，occurred_at = posted_on (入账日)。交易通过关系
 * `txn -[from_account]-> account` 接入知识图谱。
 *
 * 加密策略 / encryption (见 src/crypto.js)：可检索的财务字段保持 **明文** 留在
 * `data`（金额/币种/品类/方向/商户/入账日 — 全文检索与 SQL 聚合照常工作）；
 * 敏感字段（账号 last4/account_number、交易 memo、银行原始描述 raw_descriptor）
 * 加密进单个不透明 blob `data.enc`。reveal() / revealAccount() 是唯一解密出口。
 * 丢失密钥只丢失 `data.enc`，其余数据与图谱完好 —— 设计如此。
 */

const cryptoUtil = require('../crypto');

const ACCOUNT_KINDS = ['checking', 'savings', 'credit', 'cash', 'investment'];
const DIRECTIONS = ['debit', 'credit'];
const PRED_FROM_ACCOUNT = 'from_account'; // txn -> account

module.exports = function financeDomain(store) {
  const { entities, relations } = store;

  return {
    ACCOUNT_KINDS,
    DIRECTIONS,

    /**
     * 新建账户。明文 data: {kind,institution,currency}；
     * 敏感 {last4,account_number} 加密进 data.enc。
     */
    async createAccount({ name, kind, institution, currency = 'USD', last4, account_number, family_id } = {}) {
      if (!name) throw new Error('finance.createAccount: `name` is required');
      if (kind && !ACCOUNT_KINDS.includes(kind)) throw new Error(`invalid account kind: ${kind}`);
      return entities.create({
        type: 'finance_account',
        title: name,
        status: 'open',
        family_id,
        tags: ['finance', 'account'],
        data: {
          kind: kind || null,
          institution: institution || null,
          currency,
          enc: cryptoUtil.encrypt({ last4: last4 || null, account_number: account_number || null }),
        },
      });
    },

    /**
     * 记一笔交易。明文 data 保留可检索字段；敏感 {memo,raw_descriptor} 进 data.enc。
     * 同时建立 txn -[from_account]-> account（单值，replace）。
     */
    async addTxn({ account_id, amount_cents, direction, category, merchant, posted_on, memo,
      raw_descriptor, currency = 'USD', family_id } = {}) {
      if (!account_id) throw new Error('finance.addTxn: `account_id` is required');
      if (!DIRECTIONS.includes(direction)) throw new Error(`invalid direction: ${direction} (debit|credit)`);
      if (!Number.isFinite(amount_cents)) throw new Error('finance.addTxn: `amount_cents` must be a number');

      const txn = await entities.create({
        type: 'finance_txn',
        title: merchant || category || '(txn)',
        status: 'posted',
        family_id,
        occurred_at: posted_on || null,
        tags: ['finance', 'txn', ...(category ? [String(category).toLowerCase()] : [])],
        data: {
          account_id,
          amount_cents,
          currency,
          category: category || null,
          direction,
          merchant: merchant || null,
          posted_on: posted_on || null,
          enc: cryptoUtil.encrypt({ memo: memo || null, raw_descriptor: raw_descriptor || null }),
        },
      });

      // 接入图谱：单值边（一笔交易只属于一个账户）。
      await relations.replace(txn.id, PRED_FROM_ACCOUNT, account_id, { family_id });
      return txn;
    },

    /** 按账户/品类/日期范围过滤交易，新→旧。 */
    async listTxns({ account_id, category, from, to, limit = 200 } = {}) {
      const where = [`type = 'finance_txn'`, 'archived = false'];
      const vals = [];
      if (account_id) { vals.push(account_id); where.push(`data->>'account_id' = $${vals.length}`); }
      if (category) { vals.push(category); where.push(`data->>'category' = $${vals.length}`); }
      if (from) { vals.push(from); where.push(`(data->>'posted_on')::date >= $${vals.length}::date`); }
      if (to) { vals.push(to); where.push(`(data->>'posted_on')::date <= $${vals.length}::date`); }
      vals.push(limit);
      const r = await store.db.query(
        `SELECT * FROM entities
         WHERE ${where.join(' AND ')}
         ORDER BY (data->>'posted_on')::date DESC NULLS LAST, created_at DESC
         LIMIT $${vals.length}`,
        vals
      );
      return r.rows.map(entities.row);
    },

    /**
     * 账户余额：SUM(credits) - SUM(debits)。
     * 约定：credit 为入账(+)，debit 为支出(-)。
     */
    async balance(account_id) {
      const r = await store.db.query(
        `SELECT
           COALESCE(SUM((data->>'amount_cents')::bigint) FILTER (WHERE data->>'direction' = 'credit'), 0)::bigint AS credit_cents,
           COALESCE(SUM((data->>'amount_cents')::bigint) FILTER (WHERE data->>'direction' = 'debit'), 0)::bigint  AS debit_cents
         FROM entities
         WHERE type = 'finance_txn' AND archived = false AND data->>'account_id' = $1`,
        [account_id]
      );
      const credit_cents = Number(r.rows[0].credit_cents);
      const debit_cents = Number(r.rows[0].debit_cents);
      return { account_id, credit_cents, debit_cents, balance_cents: credit_cents - debit_cents };
    },

    /** 按品类汇总区间内支出（仅 debit），金额降序。 */
    async spendByCategory({ from, to, family_id } = {}) {
      const where = [`type = 'finance_txn'`, 'archived = false', `data->>'direction' = 'debit'`];
      const vals = [];
      if (family_id) { vals.push(family_id); where.push(`family_id = $${vals.length}`); }
      if (from) { vals.push(from); where.push(`(data->>'posted_on')::date >= $${vals.length}::date`); }
      if (to) { vals.push(to); where.push(`(data->>'posted_on')::date <= $${vals.length}::date`); }
      const r = await store.db.query(
        `SELECT COALESCE(data->>'category', '(uncategorized)') AS category,
                COALESCE(SUM((data->>'amount_cents')::bigint), 0)::bigint AS spent_cents
         FROM entities
         WHERE ${where.join(' AND ')}
         GROUP BY COALESCE(data->>'category', '(uncategorized)')
         ORDER BY spent_cents DESC`,
        vals
      );
      return r.rows.map((row) => ({ category: row.category, spent_cents: Number(row.spent_cents) }));
    },

    /** 解密一笔交易的敏感字段（唯一暴露 memo/raw_descriptor 的出口）。 */
    async reveal(txnId) {
      const e = await entities.get(txnId);
      if (!e) throw new Error(`finance.reveal: txn not found: ${txnId}`);
      return cryptoUtil.decrypt(e.data.enc);
    },

    /** 解密账户的敏感字段（唯一暴露 last4/account_number 的出口）。 */
    async revealAccount(id) {
      const e = await entities.get(id);
      if (!e) throw new Error(`finance.revealAccount: account not found: ${id}`);
      return cryptoUtil.decrypt(e.data.enc);
    },
  };
};

// 新类型注册 (NEW entity types)：finance_account / finance_txn。
module.exports.types = [
  { type: 'finance_account', domain: 'finance', label: '账户', icon: '🏦',
    description: '银行 / 现金 / 投资账户（敏感账号加密存 data.enc）',
    schema: { fields: {
      kind: 'text', institution: 'text', currency: 'text', last4: 'text',
    } } },
  { type: 'finance_txn', domain: 'finance', label: '交易', icon: '💵',
    description: '交易流水：金额/方向/品类/商户明文可检索，备注加密存 data.enc',
    schema: { fields: {
      amount_cents: 'number', currency: 'text', category: 'text', direction: 'text',
      merchant: 'text', account_id: 'text', posted_on: 'date',
    } } },
];
