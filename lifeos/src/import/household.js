'use strict';

/**
 * import/household.js — 把旧版家庭管理应用的 JSON 数据迁移进 lifeos。
 * Migrate the legacy household app's runtime JSON files into lifeos.
 *
 * 源文件（都可缺省，缺哪个跳过哪个 / each file optional, skipped if missing）：
 *   data/inventory.json            库存（item → entity type 'item'，保留原 inv_* id）
 *   data/consumption_history.json  消耗记录（→ life_event verb=consume）
 *   data/baby_log.json             宝宝日志（→ life_event verb=diaper_change/feed/…）
 *   data/meal_diary.json           餐食日记（食材/菜/餐 → meals 域三种实体 + 边）
 *
 * 幂等性 / Idempotency:
 *   - 实体 id 一律保留源 id（inv_* / ing_* / dish_* / meal_*），位置用
 *     `loc_<slug>`（按名称确定），事件用 `evt_<sha1(源记录)前16位>`。
 *     已存在的 id 直接跳过（create-if-missing），重复运行 created=0。
 *   - 关系层 link/replace 本身是 upsert，重复运行不会产生重复边。
 *   - 同一笔消耗会同时出现在 item.consumption_log 和 consumption_history.json，
 *     两边按同一组规范字段 {item_id,date,qty,note} 取哈希，因此天然去重。
 *     The same consumption appears in BOTH consumption_log and
 *     consumption_history; hashing the canonical fields dedups it naturally.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { slugify } = require('../ids');
const mealsDomain = require('../domains/meals');

const SOURCE = 'household-import';

// 宝宝日志事件类型 → life_event 动词。Baby-log event type -> life_event verb.
// （兼容英文 type 键与中文标签两种写法 / accepts both the English type keys
//   used by baby-ops.js and the Chinese labels shown in the UI.）
const BABY_VERBS = {
  diaper: 'diaper_change', '换尿布': 'diaper_change',
  feeding_bottle: 'feed', feeding_nursing: 'feed', feeding_solid: 'feed',
  '奶瓶喂奶': 'feed', '喂奶': 'feed',
};

// ─── helpers ──────────────────────────────────────────────────────────────────

/** 读 JSON，不存在返回 null。Read a JSON file; null if missing. */
function readMaybe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`read ${file}: ${err.message}`);
  }
}

/** 键序稳定的 JSON 序列化（哈希用）。Stable (sorted-key) JSON for hashing. */
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort()
    .map((k) => JSON.stringify(k) + ':' + stableStringify(v[k]))
    .join(',') + '}';
}

/** 确定性事件 id：evt_ + sha1(源记录) 前 16 位。Deterministic event id. */
function eventId(record) {
  return 'evt_' + crypto.createHash('sha1').update(stableStringify(record)).digest('hex').slice(0, 16);
}

/** 位置实体 id：按名称确定（slug，slug 不可用则哈希）。Deterministic location id. */
function locationId(name) {
  const slug = slugify(name);
  if (slug && slug !== 'untitled') return `loc_${slug}`;
  return 'loc_' + crypto.createHash('sha1').update(String(name)).digest('hex').slice(0, 12);
}

/** 去掉 null/undefined 字段。Drop null/undefined keys. */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/** 旧单字段 source 字符串 → sources 数组。Legacy single `source` -> array. */
function itemSources(item) {
  if (Array.isArray(item.sources) && item.sources.length) return item.sources;
  if (item.source != null && String(item.source).trim()) return [String(item.source).trim()];
  return null; // omitted by compact()
}

// ─── importer ─────────────────────────────────────────────────────────────────

/**
 * @param {{ store: object, dir: string, dryRun?: boolean, log?: Function }} opts
 *   dir = 旧应用根目录（含 data/ 与 config/）/ legacy app base dir.
 * @returns {Promise<{items:number, locations:number, events:number,
 *   ingredients:number, dishes:number, meals:number,
 *   created:number, skipped:number, errors:string[]}>}
 *   各分类计数 = 本次新建数量；重复运行应全为 0。Per-kind counts = newly
 *   created entities this run; a re-run reports zeros + everything skipped.
 */
async function importHousehold({ store, dir, dryRun = false, log = () => {} }) {
  if (!store) throw new Error('importHousehold: `store` is required');
  if (!dir) throw new Error('importHousehold: `dir` is required');

  const summary = {
    items: 0, locations: 0, events: 0,
    ingredients: 0, dishes: 0, meals: 0,
    created: 0, skipped: 0, errors: [],
  };

  // 本次运行已处理过的 id（dryRun 下没有数据库可查，靠它去重）。
  // Ids handled this run — needed for dedup when dryRun writes nothing.
  const seen = new Map(); // id -> true (exists or just created)

  /** create-if-missing；返回 'created' | 'skipped'。 */
  async function ensure(props) {
    if (seen.has(props.id)) { summary.skipped += 1; return 'skipped'; }
    const existing = await store.entities.get(props.id);
    if (existing) {
      seen.set(props.id, true);
      summary.skipped += 1;
      return 'skipped';
    }
    seen.set(props.id, true);
    summary.created += 1;
    if (!dryRun) await store.entities.create(props);
    return 'created';
  }

  /** 写边（dryRun 跳过；link/replace 本身幂等）。Edge writer, no-op in dryRun. */
  async function edge(kind, subj, pred, obj) {
    if (dryRun) return;
    if (kind === 'replace') await store.relations.replace(subj, pred, obj);
    else await store.relations.link(subj, pred, obj);
  }

  // 注册本导入器引入的实体类型（meals 三种 + life_event），幂等。
  // Register the entity types this importer introduces (idempotent).
  if (!dryRun) {
    const types = [
      ...mealsDomain.types,
      { type: 'life_event', domain: 'general', label: '生活事件', icon: '📅',
        description: '消耗 / 宝宝日志等带时间戳的事件',
        schema: { fields: { verb: 'text', qty: 'number', unit: 'text', note: 'text' } } },
    ];
    for (const t of types) {
      await store.db.query(
        `INSERT INTO entity_types (type, domain, label, icon, description, schema, builtin)
         VALUES ($1,$2,$3,$4,$5,$6,false)
         ON CONFLICT (type) DO NOTHING`,
        [t.type, t.domain, t.label, t.icon, t.description || '', JSON.stringify(t.schema || {})]
      );
    }
  }

  const inventory = readMaybe(path.join(dir, 'data', 'inventory.json'));
  const consumption = readMaybe(path.join(dir, 'data', 'consumption_history.json'));
  const babyLog = readMaybe(path.join(dir, 'data', 'baby_log.json'));
  const mealDiary = readMaybe(path.join(dir, 'data', 'meal_diary.json'));

  // ── a/b. 库存 → item 实体 + stored_in 位置 ─────────────────────────────────
  // 容错：legacy 标准形状是 {items:[...]}；也接受裸数组（手工导出常见）。
  const inventoryItems = Array.isArray(inventory) ? inventory : (inventory && inventory.items) || [];
  for (const item of inventoryItems) {
    try {
      const created = await ensure({
        id: item.id,
        type: 'item',
        title: item.name || '',
        body: item.notes || '',
        status: item.status || 'in_stock',
        tags: item.tags || [],
        source: SOURCE,
        occurred_at: item.purchase_date || null,
        data: compact({
          barcode: item.barcode,
          brand: item.brand,
          category: item.category,
          quantity: item.quantity,
          unit: item.unit,
          unit_price: item.unit_price,
          sources: itemSources(item),
          icon: item.icon,
          restock_needed: item.restock_needed,
          priority: item.priority,
          expiry_date: item.expiry_date,
          purchase_date: item.purchase_date,
          comments: item.comments,
          diaper_spec: item.diaper_spec,
          ready_to_feed_spec: item.ready_to_feed_spec,
        }),
      });
      if (created === 'created') summary.items += 1;

      // 位置字符串 → storage_location（find-or-create）+ stored_in（单值边）。
      if (item.location && String(item.location).trim()) {
        const name = String(item.location).trim();
        const locId = locationId(name);
        const locCreated = await ensure({
          id: locId, type: 'storage_location', title: name,
          tags: ['storage'], source: SOURCE, data: {},
        });
        if (locCreated === 'created') summary.locations += 1;
        await edge('replace', item.id, 'stored_in', locId);
      }

      // c-1. item 内嵌 consumption_log → life_event（verb=consume）。
      for (const entry of item.consumption_log || []) {
        const ok = await consumeEvent({
          item_id: item.id, date: entry.date,
          qty: entry.qty ?? entry.quantity, unit: item.unit, note: entry.note,
        });
        if (ok) log(`event consume ${item.id} @ ${entry.date}`);
      }
      log(`item ${item.id} ${created}`);
    } catch (err) {
      summary.errors.push(`inventory ${item && item.id}: ${err.message}`);
    }
  }

  /** 消耗事件公共路径（log 与 history 共用，规范字段哈希 → 自然去重）。 */
  async function consumeEvent({ item_id, date, qty, unit, note }) {
    const canonical = { kind: 'consume', item_id, date, qty, note: note || '' };
    const id = eventId(canonical);
    const created = await ensure({
      id, type: 'life_event', title: 'consume',
      occurred_at: date || null, source: SOURCE,
      data: compact({ verb: 'consume', qty, unit, note: note || null }),
    });
    if (created !== 'created') return false;
    summary.events += 1;
    if (item_id && (seen.has(item_id) || await store.entities.get(item_id))) {
      await edge('link', id, 'on', item_id);
    }
    return true;
  }

  // ── c-2. consumption_history.json → life_event ─────────────────────────────
  for (const rec of (consumption && consumption.records) || []) {
    try {
      await consumeEvent({
        item_id: rec.item_id, date: rec.date,
        qty: rec.qty ?? rec.quantity, unit: rec.unit, note: rec.note,
      });
    } catch (err) {
      summary.errors.push(`consumption ${rec && rec.item_id} @ ${rec && rec.date}: ${err.message}`);
    }
  }

  // ── d. baby_log.json → life_event（保留原始字段）──────────────────────────
  for (const entry of (babyLog && babyLog.events) || []) {
    try {
      const verb = BABY_VERBS[entry.type] || entry.type;
      const id = eventId({ kind: 'baby', ...entry });
      const created = await ensure({
        id, type: 'life_event', title: verb,
        occurred_at: entry.time || null,
        source: SOURCE, source_ref: entry.id || null,
        data: compact({
          verb,
          baby_event_type: entry.type,
          baby_id: entry.baby_id,
          ...(entry.data || {}), // milk_type / amount_ml / status / …全部保留
        }),
      });
      if (created !== 'created') continue;
      summary.events += 1;
      // 仅当条目引用了库存 id 时才挂 on 边。Only link when an inv id is referenced.
      const ref = entry.data && (entry.data.item_id || entry.data.inventory_id);
      if (ref && (seen.has(ref) || await store.entities.get(ref))) {
        await edge('link', id, 'on', ref);
      }
      log(`event ${verb} @ ${entry.time}`);
    } catch (err) {
      summary.errors.push(`baby_log ${entry && entry.id}: ${err.message}`);
    }
  }

  // ── e. meal_diary.json → 食材 / 菜 / 餐 + uses / serves 边 ─────────────────
  const diary = mealDiary || {};
  for (const ing of diary.ingredients || []) {
    try {
      const created = await ensure({
        id: ing.id, type: 'food_ingredient', title: ing.name || '',
        tags: ing.tags || [], source: SOURCE,
        data: compact({ unit_default: ing.unit_default }),
      });
      if (created === 'created') summary.ingredients += 1;
    } catch (err) {
      summary.errors.push(`ingredient ${ing && ing.id}: ${err.message}`);
    }
  }

  for (const dish of diary.dishes || []) {
    try {
      const created = await ensure({
        id: dish.id, type: 'dish', title: dish.name || '',
        body: dish.notes || '', status: null, source: SOURCE,
        data: compact({
          favorite: Boolean(dish.favorite),
          steps_brief: dish.steps || null,
          ingredient_refs: dish.ingredient_refs, // 原样保留（可能是自由文本）
        }),
      });
      if (created === 'created') summary.dishes += 1;
      // uses 边：仅当 ref 是已知食材实体 id（自由文本行跳过）。
      for (const ref of dish.ingredient_refs || []) {
        if (typeof ref !== 'string') continue;
        if (seen.has(ref) || await store.entities.get(ref)) {
          await edge('link', dish.id, 'uses', ref);
        }
      }
    } catch (err) {
      summary.errors.push(`dish ${dish && dish.id}: ${err.message}`);
    }
  }

  for (const meal of diary.meals || []) {
    try {
      const created = await ensure({
        id: meal.id, type: 'meal',
        title: `${meal.date || ''} ${meal.slot || ''}`.trim(),
        body: meal.notes || '', source: SOURCE,
        occurred_at: meal.date || null,
        data: compact({
          meal_type: meal.slot,
          eaten_on: meal.date,
          liked: meal.liked,
        }),
      });
      if (created === 'created') summary.meals += 1;
      for (const dishId of meal.dish_ids || []) {
        if (seen.has(dishId) || await store.entities.get(dishId)) {
          await edge('link', meal.id, 'serves', dishId);
        }
      }
    } catch (err) {
      summary.errors.push(`meal ${meal && meal.id}: ${err.message}`);
    }
  }

  log(`done: created=${summary.created} skipped=${summary.skipped} errors=${summary.errors.length}${dryRun ? ' (dry-run)' : ''}`);
  return summary;
}

module.exports = { importHousehold };
