'use strict';

/**
 * events.js — 生活事件流（event sourcing for lifeos）.
 *
 * Life is a stream of events: bought, consumed, moved, paid, fed… Each event
 * is an entity (type=life_event, id `evt_…`) whose `title` is the verb and
 * whose JSONB data carries { verb, qty, unit, note, …extra }. An event points
 * at the thing it happened to via a first-class edge:
 *
 *   event -[on]-> target            （事件作用于某个实体）
 *
 * State is derived, not stored: the target's `data.quantity` acts as a
 * baseline/cache（基线/缓存）, and `foldQuantity` folds consume/restock events
 * over it — events are the truth going forward; the fold derives "current".
 * `applyFold` materializes the derived value into `data.quantity_current`
 * without ever clobbering the baseline.
 */

const ON = 'on';

module.exports = function eventsDomain(store) {
  const { entities, relations } = store;
  const { newId } = require('../ids');

  return {
    ON,

    /**
     * Record a life event（记录一条生活事件）.
     * Matches the importer shape exactly:
     *   { type:'life_event', title:<verb>, occurred_at, source,
     *     data:{ verb, qty, unit, note, ...extra } }
     * If `target_id` is given, links event -[on]-> target.
     */
    async record({ verb, target_id, qty, unit, note, occurred_at, source, data, family_id } = {}) {
      if (!verb) throw new Error('events.record: `verb` is required');
      const event = await entities.create({
        id: newId('evt'),
        type: 'life_event',
        title: verb,
        family_id,
        occurred_at: occurred_at || new Date().toISOString(),
        source: source || null,
        tags: ['event'],
        data: {
          verb,
          qty: qty ?? null,
          unit: unit ?? null,
          note: note ?? null,
          ...(data || {}),
        },
      });
      if (target_id) await relations.link(event.id, ON, target_id, { family_id });
      return event;
    },

    /** 消耗：sugar for record({ verb:'consume' }). */
    async consume(targetId, qty = 1, opts = {}) {
      return this.record({ verb: 'consume', target_id: targetId, qty, ...opts });
    },

    /** 补货：sugar for record({ verb:'restock' }). */
    async restock(targetId, qty = 1, opts = {}) {
      return this.record({ verb: 'restock', target_id: targetId, qty, ...opts });
    },

    /**
     * 某个实体的事件时间线：events with an `on` edge to the target,
     * newest first, optionally filtered by verb.
     */
    async timeline(targetId, { verb, limit = 100 } = {}) {
      const rels = await relations.toward(targetId, ON);
      const events = [];
      for (const r of rels) {
        const e = await entities.get(r.subject_id);
        if (!e) continue;
        if (verb && e.data.verb !== verb) continue;
        events.push(e);
      }
      events.sort((a, b) => String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')));
      return events.slice(0, limit);
    },

    /** 最近事件（全局流）, optionally filtered by verb — SQL for correct limit. */
    async recent({ verb, limit = 50 } = {}) {
      const vals = [];
      let where = `type = 'life_event' AND archived = false`;
      if (verb) { vals.push(verb); where += ` AND data->>'verb' = $${vals.length}`; }
      vals.push(limit);
      const r = await store.db.query(
        `SELECT * FROM entities WHERE ${where}
         ORDER BY COALESCE(occurred_at, created_at) DESC
         LIMIT $${vals.length}`,
        vals
      );
      return r.rows.map(entities.row);
    },

    /**
     * Fold the event stream over the target's baseline quantity（事件折叠）.
     * `data.quantity` (or explicit `data.quantity_baseline`) is a cache/baseline;
     * events are the truth going forward — the fold derives current:
     *   current = baseline + Σ restock.qty − Σ consume.qty
     */
    async foldQuantity(targetId) {
      const target = await entities.get(targetId);
      if (!target) throw new Error(`events.foldQuantity: no such entity ${targetId}`);
      const baseline = Number(target.data.quantity_baseline ?? target.data.quantity ?? 0);
      const sum = (events) => events.reduce((s, e) => s + (Number(e.data.qty) || 0), 0);
      const consumed = sum(await this.timeline(targetId, { verb: 'consume', limit: Number.MAX_SAFE_INTEGER }));
      const restocked = sum(await this.timeline(targetId, { verb: 'restock', limit: Number.MAX_SAFE_INTEGER }));
      return { target_id: targetId, baseline, consumed, restocked, current: baseline + restocked - consumed };
    },

    /**
     * Materialize the fold into `data.quantity_current`（缓存导出值）—
     * never touches `data.quantity`, which remains the baseline.
     */
    async applyFold(targetId) {
      const fold = await this.foldQuantity(targetId);
      await entities.mergeData(targetId, { quantity_current: fold.current });
      return fold;
    },
  };
};

module.exports.types = [
  { type: 'life_event', domain: 'events', label: '事件', icon: '⚡',
    description: '生活事件流（消耗/补货/喂养/支付…），状态由事件折叠导出',
    schema: { fields: { verb: 'text', qty: 'number', unit: 'text', note: 'text' } } },
];

// ─── manifest: CLI commands ───────────────────────────────────────────────────
module.exports.commands = (d, { num }) => ({
  'ev-record': {
    desc: '记一个事件', usage: 'ev-record --verb V [--on ID] [--qty N] [--unit U] [--note S]',
    run: ({ flags }) => d.record({ verb: flags.verb, target_id: flags.on, qty: num(flags.qty), unit: flags.unit, note: flags.note, occurred_at: flags.at }),
  },
  consume: {
    desc: '消耗（事件溯源）', usage: 'consume <id> [qty] [--note S]',
    run: ({ positional, flags }) => d.consume(positional[0], positional[1] ? Number(positional[1]) : 1, { note: flags.note }),
  },
  restock: {
    desc: '补货（事件溯源）', usage: 'restock <id> [qty] [--note S]',
    run: ({ positional, flags }) => d.restock(positional[0], positional[1] ? Number(positional[1]) : 1, { note: flags.note }),
  },
  timeline: {
    desc: '实体的事件时间线', usage: 'timeline <id> [--verb V] [--limit N]',
    run: ({ positional, flags }) => d.timeline(positional[0], { verb: flags.verb, limit: num(flags.limit) }),
  },
  qty: {
    desc: '折叠出当前数量（--apply 物化）', usage: 'qty <id> [--apply]',
    run: ({ positional, flags }) => (flags.apply ? d.applyFold(positional[0]) : d.foldQuantity(positional[0])),
  },
});
