const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  mapCategory,
  inferCategory,
  normalizeSources,
  itemSourcesRow,
  normalizeIcon,
  normalizePriority,
  normalizeComments,
  normalizeDiaperSpec,
  normalizeReadyToFeedSpec,
  normalizeUnitSpec,
  resolveUnitSpec,
  computeSpuInfo,
  normalizeIngredientToken,
  shouldShowInRestockTab,
  isBabyAutoRestockCategory,
} = require('../skills/lib/inventory-ops');

// ─── mapCategory ──────────────────────────────────────────────────────────────

describe('mapCategory', () => {
  it('maps dairy tags', () => {
    assert.equal(mapCategory(['dairy', 'milk']), 'dairy');
  });
  it('maps meat tags', () => {
    assert.equal(mapCategory(['meat', 'beef']), 'meat_fresh');
  });
  it('maps diaper tags', () => {
    assert.equal(mapCategory(['diaper']), 'diaper');
  });
  it('maps ready-to-feed tags', () => {
    assert.equal(mapCategory(['ready-to-feed']), "rtf");
  });
  it('maps Chinese tags', () => {
    assert.equal(mapCategory(['蔬菜']), 'vegetable');
    assert.equal(mapCategory(['水果']), 'fruit');
    assert.equal(mapCategory(['零食']), 'snack');
  });
  it('returns other for unknown', () => {
    assert.equal(mapCategory(['xyz']), 'other');
    assert.equal(mapCategory([]), 'other');
  });
});

// ─── inferCategory ────────────────────────────────────────────────────────────

describe('inferCategory', () => {
  it('infers dairy from name', () => {
    assert.equal(inferCategory('全脂牛奶'), 'dairy');
  });
  it('infers diaper from name', () => {
    assert.equal(inferCategory('花王纸尿裤'), 'diaper');
  });
  it('returns null for unknown', () => {
    assert.equal(inferCategory('xyz'), null);
  });
});

// ─── normalizeSources ─────────────────────────────────────────────────────────

describe('normalizeSources', () => {
  it('normalizes array', () => {
    assert.deepEqual(normalizeSources(['Amazon', 'eBay']), ['Amazon', 'eBay']);
  });
  it('deduplicates', () => {
    assert.deepEqual(normalizeSources(['A', 'A', 'B']), ['A', 'B']);
  });
  it('handles null', () => {
    assert.deepEqual(normalizeSources(null), []);
  });
  it('handles string', () => {
    assert.deepEqual(normalizeSources('Amazon'), ['Amazon']);
  });
  it('trims and limits length', () => {
    const long = 'x'.repeat(100);
    const result = normalizeSources([long]);
    assert.equal(result[0].length, 64);
  });
});

// ─── normalizeIcon / normalizePriority ────────────────────────────────────────

describe('normalizeIcon', () => {
  it('returns emoji', () => {
    assert.equal(normalizeIcon('🥬'), '🥬');
  });
  it('returns null for empty', () => {
    assert.equal(normalizeIcon(''), null);
    assert.equal(normalizeIcon(null), null);
  });
});

describe('normalizePriority', () => {
  it('accepts valid priorities', () => {
    assert.equal(normalizePriority('high'), 'high');
    assert.equal(normalizePriority('MEDIUM'), 'medium');
    assert.equal(normalizePriority('low'), 'low');
  });
  it('rejects invalid', () => {
    assert.equal(normalizePriority('urgent'), null);
    assert.equal(normalizePriority(''), null);
  });
});

// ─── normalizeComments ────────────────────────────────────────────────────────

describe('normalizeComments', () => {
  it('normalizes valid comments', () => {
    const result = normalizeComments([
      { at: '2025-01-01T00:00:00Z', text: 'hello' },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, 'hello');
  });
  it('filters empty comments', () => {
    const result = normalizeComments([{ text: '' }, { text: '  ' }]);
    assert.equal(result.length, 0);
  });
  it('handles non-array', () => {
    assert.deepEqual(normalizeComments(null), []);
    assert.deepEqual(normalizeComments('string'), []);
  });
});

// ─── normalizeDiaperSpec ──────────────────────────────────────────────────────

describe('normalizeDiaperSpec', () => {
  it('normalizes valid spec', () => {
    const result = normalizeDiaperSpec({
      category: 'diaper',
      diaper_spec: { segment_code: 'NB', weight_min_kg: 0, weight_max_kg: 5, pieces_per_box: 84 },
    });
    assert.equal(result.segment_code, 'NB');
    assert.equal(result.pieces_per_box, 84);
    assert.equal(result.sales_unit, '箱');
  });
  it('returns null for non-diaper category', () => {
    assert.equal(normalizeDiaperSpec({ category: 'dairy', diaper_spec: {} }), null);
  });
  it('returns null if weight missing', () => {
    assert.equal(normalizeDiaperSpec({ category: 'diaper', diaper_spec: { segment_code: 'NB' } }), null);
  });
});

// ─── normalizeReadyToFeedSpec ─────────────────────────────────────────────────

describe('normalizeReadyToFeedSpec', () => {
  it('normalizes valid spec', () => {
    const result = normalizeReadyToFeedSpec({
      category: 'ready_to_feed',
      ready_to_feed_spec: { grams_per_bottle: 59, stage: 1, bottle_format: 'small_2oz', bottles_per_case: 24 },
    });
    assert.equal(result.grams_per_bottle, 59);
    assert.equal(result.bottles_per_case, 24);
    assert.equal(result.stage, 1);
  });
  it('infers grams from bottle_format when grams missing', () => {
    assert.deepEqual(normalizeReadyToFeedSpec({
      category: "ready_to_feed",
      ready_to_feed_spec: { bottle_format: "small_2oz" },
    }), {
      stage: 1,
      grams_per_bottle: 59,
      ml_per_bottle: 59,
      bottles_per_case: null,
      bottle_format: "small_2oz",
      spec_label: "1段 · 2oz · 59g/瓶",
    });
  });
});

// ─── normalizeUnitSpec ────────────────────────────────────────────────────────

describe('normalizeUnitSpec', () => {
  it('normalizes full spec', () => {
    const result = normalizeUnitSpec({ sku_unit: '瓶', spu_unit: '箱', spu_qty: 24 });
    assert.deepEqual(result, { sku_unit: '瓶', spu_unit: '箱', spu_qty: 24, spu_label: '24瓶/箱' });
  });
  it('normalizes without spu_qty', () => {
    const result = normalizeUnitSpec({ sku_unit: '片', spu_unit: '箱' });
    assert.equal(result.sku_unit, '片');
    assert.equal(result.spu_qty, null);
  });
  it('returns null for missing units', () => {
    assert.equal(normalizeUnitSpec({ sku_unit: '瓶' }), null);
    assert.equal(normalizeUnitSpec(null), null);
    assert.equal(normalizeUnitSpec({}), null);
  });
  it('allows custom spu_label', () => {
    const result = normalizeUnitSpec({ sku_unit: '瓶', spu_unit: '箱', spu_qty: 24, spu_label: '一箱24瓶' });
    assert.equal(result.spu_label, '一箱24瓶');
  });
});

// ─── resolveUnitSpec ──────────────────────────────────────────────────────────

describe('resolveUnitSpec', () => {
  it('prefers explicit unit_spec', () => {
    const item = {
      unit_spec: { sku_unit: '瓶', spu_unit: '箱', spu_qty: 24, spu_label: '24瓶/箱' },
      diaper_spec: { pieces_per_box: 84 },
    };
    assert.equal(resolveUnitSpec(item).sku_unit, '瓶');
    assert.equal(resolveUnitSpec(item).spu_qty, 24);
  });
  it('falls back to diaper_spec', () => {
    const item = { diaper_spec: { pieces_per_box: 84, sales_unit: '箱' } };
    const result = resolveUnitSpec(item);
    assert.equal(result.sku_unit, '片');
    assert.equal(result.spu_qty, 84);
  });
  it('falls back to ready_to_feed_spec', () => {
    const item = { ready_to_feed_spec: { bottles_per_case: 24 } };
    const result = resolveUnitSpec(item);
    assert.equal(result.sku_unit, '瓶');
    assert.equal(result.spu_qty, 24);
  });
  it('returns null when no spec', () => {
    assert.equal(resolveUnitSpec({}), null);
  });
});

// ─── computeSpuInfo ───────────────────────────────────────────────────────────

describe('computeSpuInfo', () => {
  it('computes SPU count', () => {
    const item = { quantity: 540, unit_spec: { sku_unit: '瓶', spu_unit: '箱', spu_qty: 24, spu_label: '24瓶/箱' } };
    const result = computeSpuInfo(item);
    assert.equal(result.spu_count, 22.5);
    assert.equal(result.spu_display, '540瓶 ≈ 22.5箱');
  });
  it('handles zero quantity', () => {
    const item = { quantity: 0, unit_spec: { sku_unit: '瓶', spu_unit: '箱', spu_qty: 24, spu_label: '24瓶/箱' } };
    const result = computeSpuInfo(item);
    assert.equal(result.spu_count, 0);
  });
  it('returns null for no spec', () => {
    assert.equal(computeSpuInfo({}), null);
  });
});

// ─── normalizeIngredientToken ─────────────────────────────────────────────────

describe('normalizeIngredientToken', () => {
  it('normalizes Chinese with spaces', () => {
    assert.equal(normalizeIngredientToken(' 牛 奶 '), '牛奶');
  });
  it('lowercases', () => {
    assert.equal(normalizeIngredientToken('Milk'), 'milk');
  });
  it('handles null', () => {
    assert.equal(normalizeIngredientToken(null), '');
  });
});

// ─── shouldShowInRestockTab ───────────────────────────────────────────────────

describe('shouldShowInRestockTab', () => {
  it('shows manually marked items', () => {
    assert.equal(shouldShowInRestockTab({ restock_needed: true }, null), true);
  });
  it('hides items with no prediction', () => {
    assert.equal(shouldShowInRestockTab({}, null), false);
    assert.equal(shouldShowInRestockTab({}, { mode: 'none' }), false);
  });
  it('shows baby category items with urgency', () => {
    assert.equal(shouldShowInRestockTab({ category: 'diaper' }, { mode: 'daily', restock_urgency: 'urgent' }), true);
  });
  it('shows frequent_restock items', () => {
    assert.equal(shouldShowInRestockTab({ frequent_restock: true, category: "other", quantity: 0 }, { mode: "daily", restock_urgency: "soon" }), true);
  });
  it('hides normal urgency non-baby items', () => {
    assert.equal(shouldShowInRestockTab({ category: 'dairy' }, { mode: 'daily', restock_urgency: 'normal' }), false);
  });
});

// ─── isBabyAutoRestockCategory ────────────────────────────────────────────────

describe('isBabyAutoRestockCategory', () => {
  it('recognizes baby categories', () => {
    assert.equal(isBabyAutoRestockCategory('diaper'), true);
    assert.equal(isBabyAutoRestockCategory('formula'), true);
    assert.equal(isBabyAutoRestockCategory('ready_to_feed'), true);
    assert.equal(isBabyAutoRestockCategory('wipes'), true);
  });
  it('rejects non-baby categories', () => {
    assert.equal(isBabyAutoRestockCategory('dairy'), false);
    assert.equal(isBabyAutoRestockCategory('other'), false);
  });
});
