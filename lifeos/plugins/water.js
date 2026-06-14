'use strict';

/**
 * water.js — 喝水/补水追踪（hydration tracker）.
 *
 * 这是插件示例，复制本文件即可创建你自己的领域插件。
 * This is the reference plugin; copy it to author your own.
 *
 * 一个插件就是一个领域模块，导出与核心 domains/* 完全相同的契约：
 *   module.exports          factory(store) -> domain instance（方法在这里）
 *   module.exports.types    本插件引入的新 entity types（自动注册）
 *   module.exports.commands (instance, util) -> CLI 命令表（自动接入 cli）
 *   module.exports.intents  (store) -> Intent[]（自动接入捕获 Router / MCP）
 * 在 `config/plugins.json` 里把它 enabled:true，registry 就会派生出 CLI/类型/路由，
 * 无需改任何核心代码。详见 plugins/README.md。
 *
 * A plugin is just a domain module exporting the SAME contract as the built-in
 * domains. Enable it in config/plugins.json and the registry derives CLI
 * commands, entity types and capture intents from it for free.
 */

const { z } = require('zod');

const TODAY = () => new Date().toISOString().slice(0, 10);

// ─── domain factory ───────────────────────────────────────────────────────────
module.exports = function waterDomain(store) {
  const { entities } = store;

  return {
    /** 记一次喝水 / log one drink. occurred_at = at || now; data:{ml}. */
    async log({ ml, at } = {}) {
      const amount = Number(ml);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('water.log: `ml` must be a positive number');
      }
      return entities.create({
        type: 'hydration_log',
        title: `喝水 ${amount}ml`,
        occurred_at: at || new Date().toISOString(),
        tags: ['hydration'],
        data: { ml: amount },
      });
    },

    /**
     * 某天的饮水合计 / total ml on a calendar day (default today).
     * @returns {{ date, total_ml, count }}
     */
    async today({ date } = {}) {
      const day = date || TODAY();
      const r = await store.db.query(
        `SELECT
           COALESCE(SUM((data->>'ml')::numeric), 0)::int AS total_ml,
           COUNT(*)::int AS count
         FROM entities
         WHERE type = 'hydration_log' AND archived = false
           AND (COALESCE(occurred_at, created_at))::date = $1::date`,
        [day]
      );
      const row = r.rows[0] || { total_ml: 0, count: 0 };
      return { date: day, total_ml: Number(row.total_ml) || 0, count: Number(row.count) || 0 };
    },
  };
};

// ─── entity type registration ────────────────────────────────────────────────
module.exports.types = [
  { type: 'hydration_log', domain: 'health', label: '喝水', icon: '💧',
    description: '每次饮水量（ml），插件示例',
    schema: { fields: { ml: 'number' } } },
];

// ─── manifest: CLI commands ──────────────────────────────────────────────────
module.exports.commands = (d, { num }) => ({
  water: {
    desc: '记一次喝水(ml)', usage: 'water <ml>',
    run: ({ positional }) => d.log({ ml: Number(positional[0]) }),
  },
  'water-today': {
    desc: '今日饮水合计', usage: 'water-today [--date YYYY-MM-DD]',
    run: ({ flags }) => d.today({ date: flags.date }),
  },
});

// ─── manifest: capture-router intents ────────────────────────────────────────
module.exports.intents = (store) => [
  {
    name: 'health.log_water',
    description: '记录一次喝水，单位 ml / record one drink of water in ml',
    confirm: 'low',
    schema: z.object({ ml: z.number().int().positive() }),
    rules(c) {
      const m = /(喝(?:了)?水?|drink|water)\s*(\d+)\s*(ml|毫升)?/i.exec(c.body || c.title || c.text || '');
      return m ? { args: { ml: Number(m[2]) } } : null;
    },
    // 接同一个领域 factory，落库逻辑只写一处。 Wire to the same factory.
    run: async ({ ml }, { store: s }) => module.exports(s).log({ ml }),
  },
];
