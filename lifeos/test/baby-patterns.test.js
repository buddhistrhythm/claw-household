'use strict';

/**
 * baby-patterns.test.js — covers the three "beyond last-event" layers added
 * on top of inferCryReason v1:
 *   A) personal baselines (override age table when sample_size sufficient)
 *   B) time-of-day circadian patterns (same clock-time across prior days)
 *   C) trend / pre-cry build-up (fussy episodes, decreasing feed amounts,
 *      blown-past wake window)
 *
 * 与 baby.test.js 互不重叠：本文件构造的「历史」要么是 24h 内单事件（v1 信号）
 * 与 ≥4 天的同一时刻历史共存，要么是有意挑选的趋势特征。每个测试都断言信号
 * 数组里出现了对应 kind，避免变成黑盒分数测试。
 *
 * The assertions target the `signals[]` array directly — not the final score —
 * so that future scoring re-tuning doesn't make these tests flap.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { freshStore } = require('./helpers');
const babyDomain = require('../src/domains/baby');

const DAY = 86400000;
const MIN = 60000;

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

// ─── Layer B: circadian pattern ────────────────────────────────────────────
test('baby/patterns: 7 days of sleep at same clock-time → SLEEPY gains time_of_day_pattern', async () => {
  const store = await freshStore();
  const baby = babyDomain(store);
  try {
    const at = new Date('2026-06-13T18:00:00Z');
    const birth_date = new Date(at.getTime() - 4 * 30.4375 * DAY).toISOString().slice(0, 10);
    const a = await baby.createBaby({ name: 'Pat', birth_date });

    // For each of the prior 7 days, drop a sleep event within ±15 min of 18:00.
    for (let d = 1; d <= 7; d += 1) {
      const drift = ((d % 3) - 1) * 10; // -10, 0, 10 alternating — within ±15
      await makeEvent(store, {
        baby_id: a.id,
        verb: 'sleep',
        occurred_at: new Date(at.getTime() - d * DAY + drift * MIN),
        data: { duration_min: 60 },
      });
    }
    // A single recent event so v1 facts aren't all null.
    await makeEvent(store, { baby_id: a.id, verb: 'feed', occurred_at: new Date(at - 30 * MIN), data: { amount_ml: 130 } });

    const out = await baby.inferCryReason({ baby_id: a.id, at: at.toISOString() });
    const sleepy = out.candidates.find((c) => c.reason === 'sleepy');
    const pat = sleepy.signals.find((s) => s.kind === 'time_of_day_pattern' && s.polarity !== 'negative');
    assert.ok(pat, `expected sleepy.signals to contain a positive time_of_day_pattern; got ${JSON.stringify(sleepy.signals.map((s) => s.kind))}`);
    assert.ok(pat.value >= 5, `expected pattern hits >= 5, got ${pat.value}`);
    assert.ok(pat.weight > 0, `expected positive weight, got ${pat.weight}`);

    // Symmetric: HUNGRY should also pick up the negative circadian signal
    // (this hour the baby is usually sleeping → less likely hungry).
    const hungry = out.candidates.find((c) => c.reason === 'hungry');
    const negOnHungry = hungry.signals.find((s) => s.kind === 'time_of_day_pattern' && s.polarity === 'negative');
    assert.ok(negOnHungry, 'hungry should carry negative circadian signal');
    assert.ok(negOnHungry.weight < 0);
  } finally { await store.close(); }
});

// ─── Layer A: personal baseline ────────────────────────────────────────────
test('baby/patterns: 12 feeds with median gap 165 min → facts.baselines.feed_interval is personal', async () => {
  const store = await freshStore();
  const baby = babyDomain(store);
  try {
    const at = new Date('2026-06-13T18:00:00Z');
    // 4mo baby → age table would say 180min. We're overriding via personal data.
    const birth_date = new Date(at.getTime() - 4 * 30.4375 * DAY).toISOString().slice(0, 10);
    const a = await baby.createBaby({ name: 'Bee', birth_date });

    // 13 feeds with successive gaps of 165 minutes each → 12 inter-arrival gaps.
    // The first feed is 13 * 165 = 2145 min back (well within 7d=10080).
    for (let i = 12; i >= 0; i -= 1) {
      await makeEvent(store, {
        baby_id: a.id,
        verb: 'feed',
        occurred_at: new Date(at.getTime() - (i + 1) * 165 * MIN),
        data: { amount_ml: 150 },
      });
    }

    const out = await baby.inferCryReason({ baby_id: a.id, at: at.toISOString() });
    const fb = out.facts.baselines.feed_interval;
    assert.equal(fb.source, 'personal', `expected source=personal, got ${fb.source}`);
    assert.ok(Math.abs(fb.value - 165) <= 5, `expected ~165, got ${fb.value}`);
    assert.equal(fb.sample, 12, `expected 12 gaps, got ${fb.sample}`);

    const hungry = out.candidates.find((c) => c.reason === 'hungry');
    const tsl = hungry.signals.find((s) => s.kind === 'time_since_last');
    assert.ok(tsl, 'hungry should still carry the v1 time_since_last signal');
    assert.match(tsl.benchmark, /个人均值|个人基线/,
      `expected benchmark to cite personal baseline, got "${tsl.benchmark}"`);

    // The personal_baseline transparency signal should also be present.
    assert.ok(hungry.signals.some((s) => s.kind === 'personal_baseline'),
      'hungry should carry a personal_baseline explanation signal');
  } finally { await store.close(); }
});

// ─── Layer A regression: small sample → falls back to age table ────────────
test('baby/patterns: only 3 feeds → falls back to age table source', async () => {
  const store = await freshStore();
  const baby = babyDomain(store);
  try {
    const at = new Date('2026-06-13T18:00:00Z');
    const birth_date = new Date(at.getTime() - 4 * 30.4375 * DAY).toISOString().slice(0, 10);
    const a = await baby.createBaby({ name: 'Nm', birth_date });

    // 3 feeds → 2 gaps → < MIN_FEED_SAMPLES (5) → fallback.
    await makeEvent(store, { baby_id: a.id, verb: 'feed', occurred_at: new Date(at - 5 * 60 * MIN), data: { amount_ml: 130 } });
    await makeEvent(store, { baby_id: a.id, verb: 'feed', occurred_at: new Date(at - 8 * 60 * MIN), data: { amount_ml: 130 } });
    await makeEvent(store, { baby_id: a.id, verb: 'feed', occurred_at: new Date(at - 11 * 60 * MIN), data: { amount_ml: 130 } });

    const out = await baby.inferCryReason({ baby_id: a.id, at: at.toISOString() });
    assert.equal(out.facts.baselines.feed_interval.source, 'age_table');
  } finally { await store.close(); }
});

// ─── Layer A regression: sparse sleeps must NOT yield a garbage wake window ──
// 漏记/夜觉造成的超长间隔不能被当成「清醒窗」，否则困了分数永远算不出（危险方向）。
test('baby/patterns: sparse sleeps (overnight holes) keep wake_window sane, not 1000+ min', async () => {
  const store = await freshStore();
  const baby = babyDomain(store);
  try {
    const at = new Date('2026-06-13T18:00:00Z');
    const birth_date = new Date(at.getTime() - 4 * 30.4375 * DAY).toISOString().slice(0, 10); // 4mo → table 90
    const a = await baby.createBaby({ name: 'Sparse', birth_date });

    // 6 sleep events over 7 days, ~once a day → consecutive gaps ≈ 1380 min each
    // (a full day apart). Naive median would be ~1380; the ceiling+clamp must
    // reject these and fall back to the age-table wake window (90).
    for (let d = 7; d >= 1; d -= 1) {
      await makeEvent(store, {
        baby_id: a.id, verb: 'sleep',
        occurred_at: new Date(at.getTime() - d * DAY),
        data: { duration_min: 60 },
      });
    }

    const out = await baby.inferCryReason({ baby_id: a.id, at: at.toISOString() });
    const wb = out.facts.baselines.wake_window;
    assert.equal(wb.source, 'age_table', `huge overnight gaps must fall back, got ${wb.source}=${wb.value}`);
    assert.ok(wb.value <= 240, `wake window must stay plausible, got ${wb.value}`);
  } finally { await store.close(); }
});

// ─── Layer C: trend — decreasing feed volumes ──────────────────────────────
test('baby/patterns: last 3 feeds decreasing → HUNGRY gets a negative trend signal', async () => {
  const store = await freshStore();
  const baby = babyDomain(store);
  try {
    const at = new Date('2026-06-13T18:00:00Z');
    const birth_date = new Date(at.getTime() - 4 * 30.4375 * DAY).toISOString().slice(0, 10);
    const a = await baby.createBaby({ name: 'Td', birth_date });

    // Most recent (DESC order in feeds[]): 80, 120, 160.
    // → newest 80 < mid 120 < oldest 160 → monotone decrease in time.
    await makeEvent(store, { baby_id: a.id, verb: 'feed', occurred_at: new Date(at - 60 * MIN), data: { amount_ml: 80 } });
    await makeEvent(store, { baby_id: a.id, verb: 'feed', occurred_at: new Date(at - 4 * 60 * MIN), data: { amount_ml: 120 } });
    await makeEvent(store, { baby_id: a.id, verb: 'feed', occurred_at: new Date(at - 7 * 60 * MIN), data: { amount_ml: 160 } });

    const out = await baby.inferCryReason({ baby_id: a.id, at: at.toISOString() });
    const hungry = out.candidates.find((c) => c.reason === 'hungry');
    const trend = hungry.signals.find((s) => s.kind === 'feed_amount_trend_down');
    assert.ok(trend, `expected feed_amount_trend_down signal on hungry; got ${JSON.stringify(hungry.signals.map((s) => s.kind))}`);
    assert.ok(trend.weight < 0, `expected negative weight, got ${trend.weight}`);
    assert.equal(trend.polarity, 'negative');
  } finally { await store.close(); }
});

// ─── Layer C: trend — fussy build-up ───────────────────────────────────────
test('baby/patterns: ≥2 fussy episodes in last 60min → SLEEPY gets fussy_buildup', async () => {
  const store = await freshStore();
  const baby = babyDomain(store);
  try {
    const at = new Date('2026-06-13T18:00:00Z');
    const birth_date = new Date(at.getTime() - 4 * 30.4375 * DAY).toISOString().slice(0, 10);
    const a = await baby.createBaby({ name: 'Fy', birth_date });

    await makeEvent(store, { baby_id: a.id, verb: 'fussy', occurred_at: new Date(at - 10 * MIN), data: {} });
    await makeEvent(store, { baby_id: a.id, verb: 'fussy', occurred_at: new Date(at - 30 * MIN), data: {} });
    // sleep so wake_window math is sensible
    await makeEvent(store, { baby_id: a.id, verb: 'sleep', occurred_at: new Date(at - 90 * MIN), data: { duration_min: 30 } });

    const out = await baby.inferCryReason({ baby_id: a.id, at: at.toISOString() });
    const sleepy = out.candidates.find((c) => c.reason === 'sleepy');
    const fussy = sleepy.signals.find((s) => s.kind === 'fussy_buildup');
    assert.ok(fussy, `expected fussy_buildup signal on sleepy; got ${JSON.stringify(sleepy.signals.map((s) => s.kind))}`);
    assert.ok(fussy.value >= 2);
    assert.ok(fussy.weight > 0);
  } finally { await store.close(); }
});

// ─── Layer C: trend — overtime wake window ─────────────────────────────────
test('baby/patterns: minutes_since_wake > 1.5× wake_window → SLEEPY gets wake_window_overtime', async () => {
  const store = await freshStore();
  const baby = babyDomain(store);
  try {
    const at = new Date('2026-06-13T18:00:00Z');
    // 4mo → wake_window 90; 90 * 1.5 = 135. Wake 200 min ago covers it.
    const birth_date = new Date(at.getTime() - 4 * 30.4375 * DAY).toISOString().slice(0, 10);
    const a = await baby.createBaby({ name: 'Ot', birth_date });

    // sleep started 230 min ago, lasted 30 → woke 200 min ago.
    await makeEvent(store, { baby_id: a.id, verb: 'sleep', occurred_at: new Date(at - 230 * MIN), data: { duration_min: 30 } });

    const out = await baby.inferCryReason({ baby_id: a.id, at: at.toISOString() });
    const sleepy = out.candidates.find((c) => c.reason === 'sleepy');
    const overtime = sleepy.signals.find((s) => s.kind === 'wake_window_overtime');
    assert.ok(overtime, `expected wake_window_overtime signal; got ${JSON.stringify(sleepy.signals.map((s) => s.kind))}`);
    assert.ok(overtime.weight > 0);
  } finally { await store.close(); }
});

// ─── v1 regression: dirty-diaper suppression still works alongside layers ─
test('baby/patterns: dirty diaper suppression survives the new pattern layers', async () => {
  const store = await freshStore();
  const baby = babyDomain(store);
  try {
    const at = new Date('2026-06-13T18:00:00Z');
    const birth_date = new Date(at.getTime() - 90 * DAY).toISOString().slice(0, 10);
    const a = await baby.createBaby({ name: 'Ds', birth_date });

    await makeEvent(store, { baby_id: a.id, verb: 'diaper_change', occurred_at: new Date(at - 10 * MIN), data: { kind: 'dirty' } });
    // Make sure circadian pattern WOULD have fired for diaper if not suppressed:
    // 7 prior days of diaper changes at the same clock-time.
    for (let d = 1; d <= 7; d += 1) {
      await makeEvent(store, {
        baby_id: a.id, verb: 'diaper_change',
        occurred_at: new Date(at.getTime() - d * DAY + 5 * MIN),
        data: { kind: 'wet' },
      });
    }
    // And some unrelated feed/sleep so other candidates aren't zero.
    await makeEvent(store, { baby_id: a.id, verb: 'feed', occurred_at: new Date(at - 30 * MIN), data: { amount_ml: 120 } });
    await makeEvent(store, { baby_id: a.id, verb: 'sleep', occurred_at: new Date(at - 40 * MIN), data: { duration_min: 5 } });

    const out = await baby.inferCryReason({ baby_id: a.id, at: at.toISOString() });
    const wet = out.candidates.find((c) => c.reason === 'wet');
    assert.equal(wet.score, 0, `wet must be 0 right after a dirty change, got ${wet.score}`);
    assert.ok(wet.signals.some((s) => s.kind === 'recently_changed_dirty'));
  } finally { await store.close(); }
});

// ─── Sanity: reasoning string honors the top-3 by |weight|, includes negs ─
test('baby/patterns: reasoning includes high |weight| signals (positive or negative)', async () => {
  const store = await freshStore();
  const baby = babyDomain(store);
  try {
    const at = new Date('2026-06-13T18:00:00Z');
    const birth_date = new Date(at.getTime() - 4 * 30.4375 * DAY).toISOString().slice(0, 10);
    const a = await baby.createBaby({ name: 'Rs', birth_date });

    // Decreasing feeds → strong negative trend signal that should make it
    // into reasoning by absolute weight.
    await makeEvent(store, { baby_id: a.id, verb: 'feed', occurred_at: new Date(at - 30 * MIN), data: { amount_ml: 60 } });
    await makeEvent(store, { baby_id: a.id, verb: 'feed', occurred_at: new Date(at - 3 * 60 * MIN), data: { amount_ml: 120 } });
    await makeEvent(store, { baby_id: a.id, verb: 'feed', occurred_at: new Date(at - 6 * 60 * MIN), data: { amount_ml: 180 } });

    const out = await baby.inferCryReason({ baby_id: a.id, at: at.toISOString() });
    const hungry = out.candidates.find((c) => c.reason === 'hungry');
    assert.match(hungry.reasoning, /喂量在下降|厌奶/, `expected decreasing-feed phrase in reasoning, got "${hungry.reasoning}"`);
  } finally { await store.close(); }
});
