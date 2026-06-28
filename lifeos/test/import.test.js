'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { freshStore } = require('./helpers');
const { importHousehold } = require('../src/import/household');
const { importRsspool } = require('../src/import/rsspool');

// ─── fixtures：按旧应用 skills/lib/*-ops.js 的运行时形状内联构造 ───────────────
// Inline fixtures matching the legacy app's runtime shapes (data/*.json are
// runtime-only and absent from the repo).

function writeHouseholdFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'household-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'data', 'inventory.json'), JSON.stringify({
    version: '1.0',
    last_updated: '2026-06-10',
    items: [
      {
        id: 'inv_20260322_001',
        barcode: '6901234567890',
        name: '全脂牛奶',
        brand: '蒙牛',
        category: 'dairy',
        location: '冰箱冷藏',
        purchase_date: '2026-03-22',
        expiry_date: '2026-04-05',
        quantity: 2,
        unit: '盒',
        unit_price: 12.5,
        source: '盒马', // 旧单字段写法 → 应包成 sources 数组
        icon: '🥛',
        restock_needed: false,
        priority: 'high',
        notes: '早餐用',
        comments: [{ at: '2026-03-22T12:00:00.000Z', text: '比上次便宜' }],
        tags: ['早餐'],
        status: 'in_stock',
        consumption_log: [{ date: '2026-06-01', qty: 1, note: '早餐' }],
      },
      {
        id: 'inv_20260322_002',
        barcode: null,
        name: '气泡水',
        brand: null,
        category: 'beverage',
        purchase_date: '2026-03-22',
        expiry_date: '2026-09-01',
        quantity: 6,
        unit: '瓶',
        unit_price: null,
        sources: ['Costco', '山姆'],
        tags: [],
        status: 'in_stock',
        consumption_log: [],
      },
    ],
  }, null, 2));

  fs.writeFileSync(path.join(dir, 'data', 'consumption_history.json'), JSON.stringify({
    version: '1.0',
    records: [
      { item_id: 'inv_20260322_002', item_name: '气泡水', category: 'beverage',
        date: '2026-06-02', qty: 2, unit: '瓶', note: '' },
    ],
  }, null, 2));

  fs.writeFileSync(path.join(dir, 'data', 'baby_log.json'), JSON.stringify({
    version: '1.0',
    baby: { name: '小宝' },
    events: [
      { id: 'manual_diaper_1', type: 'diaper', time: '2026-06-01T08:00:00',
        data: { status: 'wet' } },
      { id: 'manual_feeding_bottle_1', type: 'feeding_bottle', time: '2026-06-01T09:00:00',
        data: { amount_ml: 120, milk_type: 'formula' } },
    ],
  }, null, 2));

  fs.writeFileSync(path.join(dir, 'data', 'meal_diary.json'), JSON.stringify({
    version: '1.0',
    ingredients: [
      { id: 'ing_1717000000_tomato', name: '番茄', unit_default: null, tags: [] },
    ],
    dishes: [
      { id: 'dish_1717000001_aaaaaa', name: '番茄炒蛋',
        ingredient_refs: ['ing_1717000000_tomato'],
        steps: '1. 打蛋 2. 切番茄 3. 炒', favorite: true, notes: '家常' },
    ],
    meals: [
      { id: 'meal_1717000002_bbbbbb', date: '2026-06-02', slot: 'dinner',
        dish_ids: ['dish_1717000001_aaaaaa'], notes: '', liked: true },
    ],
  }, null, 2));

  return dir;
}

const TOTAL = 10; // 2 items + 1 location + 4 events + 1 ingredient + 1 dish + 1 meal

test('importHousehold: maps inventory/consumption/baby/meals; re-run is idempotent', async () => {
  const store = await freshStore();
  const dir = writeHouseholdFixtures();
  try {
    const first = await importHousehold({ store, dir });
    assert.deepEqual(first.errors, []);
    assert.equal(first.items, 2);
    assert.equal(first.locations, 1);
    assert.equal(first.events, 4); // 1 consumption_log + 1 history + 2 baby
    assert.equal(first.ingredients, 1);
    assert.equal(first.dishes, 1);
    assert.equal(first.meals, 1);
    assert.equal(first.created, TOTAL);
    assert.equal(first.skipped, 0);

    // a. item 保留原 id，字段映射正确（含旧单字段 source → sources 数组）。
    const milk = await store.entities.get('inv_20260322_001');
    assert.ok(milk, 'item keeps its inv_* id');
    assert.equal(milk.type, 'item');
    assert.equal(milk.title, '全脂牛奶');
    assert.equal(milk.body, '早餐用');
    assert.equal(milk.status, 'in_stock');
    assert.deepEqual(milk.tags, ['早餐']);
    assert.equal(milk.source, 'household-import');
    assert.deepEqual(milk.data.sources, ['盒马'], 'legacy single source wrapped');
    assert.equal(milk.data.brand, '蒙牛');
    assert.equal(milk.data.expiry_date, '2026-04-05');
    assert.equal(milk.data.comments.length, 1);
    assert.equal(milk.data.restock_needed, false);
    const soda = await store.entities.get('inv_20260322_002');
    assert.ok(!('barcode' in soda.data), 'null fields omitted from data');
    assert.ok(!('unit_price' in soda.data), 'null fields omitted from data');
    assert.deepEqual(soda.data.sources, ['Costco', '山姆']);

    // b. 位置链：item -[stored_in]-> 冰箱冷藏（确定性 loc_ id）。
    const placed = await store.relations.from('inv_20260322_001', 'stored_in');
    assert.equal(placed.length, 1, 'stored_in edge exists');
    const loc = await store.entities.get(placed[0].object_id);
    assert.equal(loc.type, 'storage_location');
    assert.equal(loc.title, '冰箱冷藏');
    assert.ok(loc.id.startsWith('loc_'));

    // c. 消耗事件：evt_ 确定性 id + on 边指向库存。
    const events = await store.entities.list({ type: 'life_event', limit: 50 });
    assert.equal(events.length, 4);
    const consumes = events.filter((e) => e.data.verb === 'consume');
    assert.equal(consumes.length, 2);
    for (const ev of consumes) {
      assert.ok(/^evt_[0-9a-f]{16}$/.test(ev.id), 'deterministic evt_ id');
      const on = await store.relations.from(ev.id, 'on');
      assert.equal(on.length, 1, 'consume event links to its item');
      assert.ok(on[0].object_id.startsWith('inv_'));
    }

    // d. 宝宝事件：verb 映射 + 原始字段保留（milk_type / amount_ml）。
    const diaper = events.find((e) => e.data.verb === 'diaper_change');
    assert.ok(diaper, 'diaper -> diaper_change');
    assert.equal(diaper.data.status, 'wet');
    const feed = events.find((e) => e.data.verb === 'feed');
    assert.ok(feed, 'feeding_bottle -> feed');
    assert.equal(feed.data.milk_type, 'formula');
    assert.equal(feed.data.amount_ml, 120);
    assert.equal((await store.relations.from(feed.id, 'on')).length, 0, 'no on edge without inv ref');

    // e. 餐食图谱：dish -[uses]-> ingredient, meal -[serves]-> dish。
    const uses = await store.relations.from('dish_1717000001_aaaaaa', 'uses');
    assert.deepEqual(uses.map((r) => r.object_id), ['ing_1717000000_tomato']);
    const serves = await store.relations.from('meal_1717000002_bbbbbb', 'serves');
    assert.deepEqual(serves.map((r) => r.object_id), ['dish_1717000001_aaaaaa']);
    const dish = await store.entities.get('dish_1717000001_aaaaaa');
    assert.equal(dish.data.favorite, true);
    const meal = await store.entities.get('meal_1717000002_bbbbbb');
    assert.equal(meal.data.meal_type, 'dinner');
    assert.equal(meal.data.eaten_on, '2026-06-02');

    // 幂等：重复导入不新建、不重边。Re-run: nothing created, no dup edges.
    const statsBefore = await store.stats();
    const second = await importHousehold({ store, dir });
    assert.equal(second.created, 0, 're-run creates nothing');
    assert.equal(second.skipped, TOTAL, 're-run skips everything');
    assert.equal(second.items + second.locations + second.events
      + second.ingredients + second.dishes + second.meals, 0);
    const statsAfter = await store.stats();
    assert.equal(statsAfter.total, statsBefore.total, 'no duplicate entities');
    assert.equal(statsAfter.relations, statsBefore.relations, 'no duplicate relations');
    assert.equal((await store.relations.from('inv_20260322_001', 'stored_in')).length, 1);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('importHousehold: dryRun counts but writes nothing; missing files skipped', async () => {
  const store = await freshStore();
  const dir = writeHouseholdFixtures();
  try {
    const dry = await importHousehold({ store, dir, dryRun: true });
    assert.equal(dry.created, TOTAL, 'dry-run reports would-be creations');
    assert.deepEqual(dry.errors, []);
    const stats = await store.stats();
    assert.equal(stats.total, 0, 'dry-run wrote no entities');
    assert.equal(stats.relations, 0, 'dry-run wrote no relations');

    // 空目录（所有源文件缺失）也能跑：全部跳过、零计数。
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'household-empty-'));
    try {
      const none = await importHousehold({ store, dir: empty });
      assert.equal(none.created, 0);
      assert.deepEqual(none.errors, []);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('importRsspool: JSONL items become knowledge_items; re-import unchanged', async () => {
  const store = await freshStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsspool-'));
  const file = path.join(dir, 'items.jsonl');
  try {
    const items = [
      { id: 'ki_aaaaaaaaaaaa0001', source: 'rss', source_id: 'guid-1', source_name: 'Sample Blog',
        type: 'article', title: 'Postgres as a document store', url: 'https://blog.example/pg',
        author: 'alice', content: 'Long-form content about JSONB.', excerpt: 'JSONB tricks',
        tags: ['postgres', 'db'], topics: ['tech'], liked_at: null,
        published_at: '2026-05-01T00:00:00Z', fetched_at: '2026-05-02T00:00:00Z',
        metadata: { feed: 'Sample Blog' }, content_hash: 'hash-aaa' },
      { id: 'ki_bbbbbbbbbbbb0002', source: 'rss', source_id: 'guid-2', source_name: '小红书样例',
        type: 'note', title: '辅食食谱合集', url: 'https://xhs.example/2',
        author: null, content: '宝宝辅食做法……', excerpt: '辅食',
        tags: ['辅食'], topics: ['life'], liked_at: '2026-05-03T00:00:00Z',
        published_at: '2026-05-02T00:00:00Z', fetched_at: '2026-05-03T00:00:00Z',
        metadata: {}, content_hash: 'hash-bbb' },
    ];
    fs.writeFileSync(file, items.map((i) => JSON.stringify(i)).join('\n') + '\n');

    const first = await importRsspool({ store, file });
    assert.deepEqual(first, { total: 2, inserted: 2, updated: 0, unchanged: 0, errors: [] });

    const stored = await store.entities.list({ type: 'knowledge_item', limit: 10 });
    assert.equal(stored.length, 2);
    const pg = await store.entities.get('ki_aaaaaaaaaaaa0001');
    assert.equal(pg.title, 'Postgres as a document store');
    assert.equal(pg.data.content_hash, 'hash-aaa');
    assert.deepEqual(pg.tags, ['postgres', 'db']);

    // 重复导入：content_hash 未变 → 全部 unchanged。
    const second = await importRsspool({ store, file });
    assert.deepEqual(second, { total: 2, inserted: 0, updated: 0, unchanged: 2, errors: [] });
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
