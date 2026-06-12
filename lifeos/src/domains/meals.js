'use strict';

/**
 * meals.js — 餐食日记（食材 → 菜 → 一餐）。Meal diary domain.
 *
 * 三层结构，每层都是实体；关系是一等公民：
 * Three entity layers; the graph edges are first-class relations:
 *   dish -[uses]->   food_ingredient   （一道菜用到哪些食材 / which ingredients a dish uses）
 *   meal -[serves]-> dish              （一餐上了哪些菜 / which dishes a meal served）
 *
 * 「收藏」存在 dish 的 data.favorite；一餐的时间存在顶层 occurred_at
 * （= 吃的日期），便于按日历聚合。
 * `favorite` lives in dish data; a meal's eaten date doubles as occurred_at
 * so calendar-style queries stay cheap.
 */

const USES = 'uses';
const SERVES = 'serves';

module.exports = function mealsDomain(store) {
  const { entities, relations } = store;

  return {
    USES,
    SERVES,

    /** 菜谱列表，可按收藏过滤。List dishes, optionally only favorites. */
    async listDishes({ favorite, limit = 500 } = {}) {
      const dishes = await entities.list({ type: 'dish', limit });
      if (favorite === undefined) return dishes;
      return dishes.filter((d) => Boolean(d.data && d.data.favorite) === Boolean(favorite));
    },

    /** 某段时间内的「每餐」记录（按吃的日期 occurred_at）。Meals within [from, to]. */
    async listMeals({ from, to, limit = 500 } = {}) {
      const where = ["type = 'meal'", 'archived = false'];
      const vals = [];
      if (from) { vals.push(from); where.push(`occurred_at >= $${vals.length}`); }
      if (to) { vals.push(to); where.push(`occurred_at <= $${vals.length}`); }
      vals.push(limit);
      const r = await store.db.query(
        `SELECT * FROM entities WHERE ${where.join(' AND ')}
         ORDER BY occurred_at ASC LIMIT $${vals.length}`,
        vals
      );
      return r.rows.map(entities.row);
    },

    /** 用到某食材的所有菜（沿 uses 反向边）。Dishes that use an ingredient. */
    async dishesUsing(ingredientId) {
      const rels = await relations.toward(ingredientId, USES);
      const out = [];
      for (const rel of rels) {
        const dish = await entities.get(rel.subject_id);
        if (dish) out.push(dish);
      }
      return out;
    },
  };
};

module.exports.types = [
  { type: 'food_ingredient', domain: 'meals', label: '食材', icon: '🥬',
    description: '餐食日记的食材库（菜谱的原料）',
    schema: { fields: { unit_default: 'text' } } },
  { type: 'dish', domain: 'meals', label: '菜', icon: '🍲',
    description: '菜谱：用到的食材 + 简要做法，可收藏',
    schema: { fields: { favorite: 'boolean', steps_brief: 'text' } } },
  { type: 'meal', domain: 'meals', label: '一餐', icon: '🍽️',
    description: '具体的一餐：哪天 / 哪一顿 / 上了哪些菜',
    schema: { fields: { meal_type: 'text', eaten_on: 'date' } } },
];

// ─── manifest: CLI commands ───────────────────────────────────────────────────
module.exports.commands = (d) => ({
  dishes: { desc: '菜谱（--favorite 只看收藏）', usage: 'dishes [--favorite]', run: ({ flags }) => d.listDishes({ favorite: !!flags.favorite }) },
  'meals-list': { desc: '每餐记录', usage: 'meals-list [--from DATE] [--to DATE]', run: ({ flags }) => d.listMeals({ from: flags.from, to: flags.to }) },
  'dishes-using': { desc: '用到某食材的菜', usage: 'dishes-using <ingredient id>', run: ({ positional }) => d.dishesUsing(positional[0]) },
});
