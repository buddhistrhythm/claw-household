'use strict';

/**
 * baby.test.js — coverage for the baby domain and the cry inferer.
 *
 * 关键场景（main scenario）：
 *   t = now
 *   - 上次喂奶 t-160min, 100ml；最近 5 次喂奶均值 150ml（→ 触发 small-feed 加分）
 *   - 上次换尿布 wet at t-100min
 *   - 上一觉 start=t-200min, duration=30min → 醒来于 t-170min → minutes_since_wake=170
 *   - 月龄 ~4.2 → wake-window 90 → ratio 1.89 → sleepy 强势第一
 *   推断：sleepy 第一、hungry 第二（小份 + 接近间隔）、wet 较低、play 0。
 *
 * Last feed is small (100 < 0.8 * 150 = 120) on purpose so the hungry
 * candidate exercises BOTH the time-since signal AND the small-feed bonus.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { freshStore } = require('./helpers');
const babyDomain = require('../src/domains/baby');
const { ageMonths, wakeWindowMin } = require('../src/domains/baby');

const DAY = 86400000;
const MIN = 60000;

/** 直接构造 life_event + for_baby 边，绕开 baby.feed/sleep，避免依赖系统时钟。
 *  Build a life_event directly with the for_baby edge so the test is
 *  insensitive to wall-clock drift. */
async function makeEvent(store, { baby_id, verb, occurred_at, data, family_id }) {
  const ev = await store.entities.create({
    type: 'life_event',
    title: verb,
    occurred_at: occurred_at instanceof Date ? occurred_at.toISOString() : occurred_at,
    family_id: family_id || null,
    tags: ['event'],
    data: { verb, baby_id, ...(data || {}) },
  });
  await store.relations.replace(ev.id, 'for_baby', baby_id);
  return ev;
}

test('baby: wakeWindowMin table at representative ages', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  // 0.5mo → 50
  assert.equal(wakeWindowMin(new Date(now.getTime() - 15 * DAY), now), 50);
  // 1.5mo → 60
  assert.equal(wakeWindowMin(new Date(now.getTime() - 45 * DAY), now), 60);
  // 3mo → 75
  assert.equal(wakeWindowMin(new Date(now.getTime() - 91 * DAY), now), 75);
  // 5mo → 90
  assert.equal(wakeWindowMin(new Date(now.getTime() - 152 * DAY), now), 90);
  // 8mo → 120
  assert.equal(wakeWindowMin(new Date(now.getTime() - 243 * DAY), now), 120);
  // 11mo → 150
  assert.equal(wakeWindowMin(new Date(now.getTime() - 335 * DAY), now), 150);
  // 15mo → 180
  assert.equal(wakeWindowMin(new Date(now.getTime() - 456 * DAY), now), 180);
  // 24mo → 240 (default)
  assert.equal(wakeWindowMin(new Date(now.getTime() - 730 * DAY), now), 240);

  // ageMonths is a float
  const m = ageMonths(new Date(now.getTime() - 91 * DAY), now);
  assert.ok(m > 2.9 && m < 3.1, `expected ~3 months, got ${m}`);
});

test('baby: createBaby + feed/diaper/sleep wire for_baby edge AND data.baby_id', async () => {
  const store = await freshStore();
  const baby = babyDomain(store);
  try {
    const a = await baby.createBaby({ name: 'Alice', birth_date: '2026-02-01' });
    assert.equal(a.type, 'baby');
    assert.deepEqual(a.tags, ['baby']);

    const feed = await baby.feed({ baby_id: a.id, amount_ml: 120, occurred_at: '2026-06-01T08:00:00Z' });
    assert.equal(feed.data.verb, 'feed');
    assert.equal(feed.data.baby_id, a.id);
    assert.equal(feed.data.amount_ml, 120);
    assert.equal(feed.data.milk_type, 'formula');
    const edges = await store.relations.from(feed.id, 'for_baby');
    assert.equal(edges.length, 1);
    assert.equal(edges[0].object_id, a.id);

    const dia = await baby.diaper({ baby_id: a.id, kind: 'wet', occurred_at: '2026-06-01T09:00:00Z' });
    assert.equal(dia.data.verb, 'diaper_change');
    assert.equal(dia.data.kind, 'wet');

    const slp = await baby.sleep({ baby_id: a.id, duration_min: 45, occurred_at: '2026-06-01T10:00:00Z' });
    assert.equal(slp.data.verb, 'sleep');
    assert.equal(slp.data.duration_min, 45);
  } finally { await store.close(); }
});

test('baby: inferCryReason ranks sleepy > hungry > wet > play with explicit signals', async () => {
  const store = await freshStore();
  const baby = babyDomain(store);
  try {
    const at = new Date('2026-06-13T18:00:00Z');
    // 4.2 months → table lookup falls to <6 bracket → wake-window 90.
    const birth_date = new Date(at.getTime() - 4.2 * 30.4375 * DAY).toISOString().slice(0, 10);
    const a = await baby.createBaby({ name: 'Bao', birth_date });

    // Feeds: last at t-160min, 100ml. Four prior feeds at 150/160/150/160 (avg = (100+150+160+150+160)/5 = 144).
    // 100 < 0.8 * 144 = 115.2 → small-feed bonus triggers.
    await makeEvent(store, { baby_id: a.id, verb: 'feed', occurred_at: new Date(at - 160 * MIN), data: { amount_ml: 100 } });
    await makeEvent(store, { baby_id: a.id, verb: 'feed', occurred_at: new Date(at - 4 * 60 * MIN), data: { amount_ml: 150 } });
    await makeEvent(store, { baby_id: a.id, verb: 'feed', occurred_at: new Date(at - 7 * 60 * MIN), data: { amount_ml: 160 } });
    await makeEvent(store, { baby_id: a.id, verb: 'feed', occurred_at: new Date(at - 10 * 60 * MIN), data: { amount_ml: 150 } });
    await makeEvent(store, { baby_id: a.id, verb: 'feed', occurred_at: new Date(at - 13 * 60 * MIN), data: { amount_ml: 160 } });

    // Diaper: last wet 100min ago.
    await makeEvent(store, { baby_id: a.id, verb: 'diaper_change', occurred_at: new Date(at - 100 * MIN), data: { kind: 'wet' } });

    // Sleep: started 200min ago, lasted 30min → woke at t-170min.
    await makeEvent(store, { baby_id: a.id, verb: 'sleep', occurred_at: new Date(at - 200 * MIN), data: { duration_min: 30 } });

    const out = await baby.inferCryReason({ baby_id: a.id, at: at.toISOString(), lookback_hours: 24 });

    assert.equal(out.baby_id, a.id);
    assert.equal(out.at, at.toISOString());
    assert.equal(out.candidates.length, 4);

    const order = out.candidates.map((c) => c.reason);
    assert.equal(order[0], 'sleepy', `expected sleepy first, got ${order.join(' > ')}`);
    assert.ok(order.indexOf('hungry') === 1 || order.indexOf('hungry') === 2,
      `hungry should be 2nd or 3rd, got ${order.join(' > ')}`);
    // hungry should out-rank wet given the numbers chosen.
    assert.ok(order.indexOf('hungry') < order.indexOf('wet'),
      `hungry should beat wet, got ${order.join(' > ')}`);

    // Every candidate has signals; each signal has value/text/weight.
    for (const c of out.candidates) {
      assert.ok(c.signals.length >= 1, `${c.reason}: has signals`);
      for (const s of c.signals) {
        assert.ok('value' in s, `${c.reason} signal missing value`);
        assert.equal(typeof s.text, 'string');
        assert.equal(typeof s.weight, 'number');
      }
      assert.equal(typeof c.reasoning, 'string');
      assert.ok(c.reasoning.length > 0);
    }

    // Scores sum to ~1 (softmax-light normalization).
    const sum = out.candidates.reduce((s, c) => s + c.score, 0);
    assert.ok(Math.abs(sum - 1) < 0.01, `scores should sum to ~1, got ${sum}`);

    // facts.minutes_since_wake ≈ 170 (NOT 105 — wake = sleep.start + duration_min).
    assert.ok(Math.abs(out.facts.minutes_since_wake - 170) < 1,
      `expected minutes_since_wake ~170, got ${out.facts.minutes_since_wake}`);
    assert.ok(Math.abs(out.facts.minutes_since_last_feed - 160) < 1);
    assert.ok(Math.abs(out.facts.minutes_since_last_diaper - 100) < 1);
    assert.equal(out.facts.last_feed_amount_ml, 100);
    assert.equal(out.facts.last_sleep_duration_min, 30);

    // The hungry candidate should expose the small-feed bonus signal.
    const hungry = out.candidates.find((c) => c.reason === 'hungry');
    assert.ok(hungry.signals.some((s) => s.kind === 'feed_volume_below_avg'),
      'hungry should carry the feed_volume_below_avg signal');
  } finally { await store.close(); }
});

test('baby: a recent dirty diaper change suppresses the wet candidate', async () => {
  const store = await freshStore();
  const baby = babyDomain(store);
  try {
    const at = new Date('2026-06-13T18:00:00Z');
    const birth_date = new Date(at.getTime() - 90 * DAY).toISOString().slice(0, 10); // ~3mo
    const a = await baby.createBaby({ name: 'Cici', birth_date });

    // Dirty change 10 minutes ago → wet should be near zero.
    await makeEvent(store, { baby_id: a.id, verb: 'diaper_change', occurred_at: new Date(at - 10 * MIN), data: { kind: 'dirty' } });
    // A long-ago feed/sleep so other candidates aren't zero (we want to see relative ranking).
    await makeEvent(store, { baby_id: a.id, verb: 'feed', occurred_at: new Date(at - 30 * MIN), data: { amount_ml: 120 } });
    await makeEvent(store, { baby_id: a.id, verb: 'sleep', occurred_at: new Date(at - 40 * MIN), data: { duration_min: 5 } });

    const out = await baby.inferCryReason({ baby_id: a.id, at: at.toISOString() });
    const wet = out.candidates.find((c) => c.reason === 'wet');
    assert.equal(wet.score, 0, `wet should be 0 right after a dirty change, got ${wet.score}`);
    assert.ok(wet.signals.some((s) => s.kind === 'recently_changed_dirty'));
  } finally { await store.close(); }
});

test('baby: multi-baby — inferCryReason isolates events by baby_id', async () => {
  const store = await freshStore();
  const baby = babyDomain(store);
  try {
    const at = new Date('2026-06-13T18:00:00Z');
    const birth_date = new Date(at.getTime() - 100 * DAY).toISOString().slice(0, 10);
    const a = await baby.createBaby({ name: 'Twin-A', birth_date });
    const b = await baby.createBaby({ name: 'Twin-B', birth_date });

    // Loud history for A: just ate, just changed → nothing pressing.
    await makeEvent(store, { baby_id: a.id, verb: 'feed', occurred_at: new Date(at - 5 * MIN), data: { amount_ml: 180 } });
    await makeEvent(store, { baby_id: a.id, verb: 'diaper_change', occurred_at: new Date(at - 5 * MIN), data: { kind: 'wet' } });

    // B has nothing except a very long awake stretch (woke 300min ago).
    await makeEvent(store, { baby_id: b.id, verb: 'sleep', occurred_at: new Date(at - 330 * MIN), data: { duration_min: 30 } });

    const outB = await baby.inferCryReason({ baby_id: b.id, at: at.toISOString() });
    assert.equal(outB.candidates[0].reason, 'sleepy', 'B should rank sleepy first');
    assert.equal(outB.facts.minutes_since_last_feed, null,
      'B has no feeds → null minutes_since_last_feed (A’s feeds must not leak in)');
    assert.equal(outB.facts.minutes_since_last_diaper, null,
      'B has no diapers → null (A’s wet change must not leak in)');

    const outA = await baby.inferCryReason({ baby_id: a.id, at: at.toISOString() });
    assert.ok(outA.facts.minutes_since_last_feed != null && outA.facts.minutes_since_last_feed < 10);
    assert.ok(outA.facts.minutes_since_last_diaper != null && outA.facts.minutes_since_last_diaper < 10);
  } finally { await store.close(); }
});

test('baby: recentEvents honors the lookback window', async () => {
  const store = await freshStore();
  const baby = babyDomain(store);
  try {
    const at = new Date('2026-06-13T18:00:00Z');
    const a = await baby.createBaby({ name: 'Dud', birth_date: '2026-04-01' });

    // Inside the window
    await makeEvent(store, { baby_id: a.id, verb: 'feed', occurred_at: new Date(at - 2 * 60 * MIN), data: { amount_ml: 150 } });
    // Outside the 6-hour window
    await makeEvent(store, { baby_id: a.id, verb: 'feed', occurred_at: new Date(at - 8 * 60 * MIN), data: { amount_ml: 99 } });

    const since6h = new Date(at.getTime() - 6 * 60 * MIN);
    const got = await baby.recentEvents({ baby_id: a.id, since: since6h.toISOString(), verbs: ['feed'] });
    assert.equal(got.length, 1, 'only the in-window feed should return');
    assert.equal(got[0].data.amount_ml, 150);

    // Wider window catches both.
    const wider = await baby.recentEvents({ baby_id: a.id, since: new Date(at.getTime() - 12 * 60 * MIN).toISOString(), verbs: ['feed'] });
    assert.equal(wider.length, 2);
    // Newest first
    assert.equal(wider[0].data.amount_ml, 150);
    assert.equal(wider[1].data.amount_ml, 99);
  } finally { await store.close(); }
});
