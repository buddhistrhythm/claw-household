'use strict';

/**
 * credit_card.js — 信用卡申请追踪.
 *
 * Each application is an entity (type=credit_card_application). The lifecycle
 * status lives in the top-level `status` column (fast filtering); finance
 * fields live in JSONB `data`. occurred_at = applied_on.
 */

const STATUSES = ['planned', 'applied', 'approved', 'denied', 'cancelled', 'closed'];

module.exports = function creditCardDomain(store) {
  const { entities } = store;

  return {
    STATUSES,

    async create({ card, issuer, network, status, applied_on, credit_line, annual_fee,
      signup_bonus, bonus_requirement, bonus_deadline, notes, family_id } = {}) {
      if (!card) throw new Error('credit_card.create: `card` (card name) is required');
      const st = status || (applied_on ? 'applied' : 'planned');
      if (!STATUSES.includes(st)) throw new Error(`invalid status: ${st}`);
      return entities.create({
        type: 'credit_card_application',
        title: card,
        status: st,
        family_id,
        body: notes || '',
        occurred_at: applied_on || null,
        tags: ['finance', 'credit-card', ...(issuer ? [String(issuer).toLowerCase()] : [])],
        data: {
          issuer: issuer || null,
          network: network || null,
          applied_on: applied_on || null,
          credit_line: credit_line ?? null,
          annual_fee: annual_fee ?? null,
          signup_bonus: signup_bonus || null,
          bonus_requirement: bonus_requirement || null,
          bonus_deadline: bonus_deadline || null,
          bonus_earned: false,
        },
      });
    },

    /** Advance lifecycle; optionally stamp decision date / credit line. */
    async setStatus(id, status, extra = {}) {
      if (!STATUSES.includes(status)) throw new Error(`invalid status: ${status}`);
      const patch = { status };
      const dataPatch = {};
      if (status === 'approved' || status === 'denied') {
        dataPatch.decided_on = extra.decided_on || new Date().toISOString().slice(0, 10);
      }
      if (extra.credit_line !== undefined) dataPatch.credit_line = extra.credit_line;
      await entities.patch(id, patch);
      if (Object.keys(dataPatch).length) await entities.mergeData(id, dataPatch);
      return entities.get(id);
    },

    async markBonusEarned(id, earned = true) {
      await entities.mergeData(id, { bonus_earned: !!earned });
      return entities.get(id);
    },

    async list({ status, family_id } = {}) {
      return entities.list({ type: 'credit_card_application', status, family_id, limit: 500 });
    },

    /**
     * Applications whose signup-bonus deadline is within `days` and not yet
     * earned — the "don't miss the spend requirement" report.
     */
    async upcomingBonusDeadlines({ days = 30 } = {}) {
      const r = await store.db.query(
        `SELECT * FROM entities
         WHERE type = 'credit_card_application' AND archived = false
           AND (data->>'bonus_earned') IS DISTINCT FROM 'true'
           AND (data->>'bonus_deadline') IS NOT NULL
           AND (data->>'bonus_deadline')::date >= CURRENT_DATE
           AND (data->>'bonus_deadline')::date <= CURRENT_DATE + ($1 || ' days')::interval
         ORDER BY (data->>'bonus_deadline')::date ASC`,
        [String(days)]
      );
      return r.rows.map(entities.row);
    },

    /** Total annual fees across non-closed cards, grouped for a yearly view. */
    async annualFeeTotal() {
      const r = await store.db.query(
        `SELECT COALESCE(SUM((data->>'annual_fee')::numeric), 0)::float AS total
         FROM entities
         WHERE type = 'credit_card_application' AND archived = false
           AND status NOT IN ('denied','cancelled','closed')
           AND data->>'annual_fee' IS NOT NULL`
      );
      return r.rows[0].total;
    },
  };
};
