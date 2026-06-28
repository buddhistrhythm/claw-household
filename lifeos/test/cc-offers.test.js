'use strict';

/**
 * cc-offers.test.js — 信用卡 offer 批量入库（Chrome 扩展 → capture → planned 实体）.
 *
 * 覆盖：
 *  1) parseOffers 启发式抽取 ≥3 张卡的关键字段；
 *  2) 走 capture 管线（hints.kind='cc_offers' 规则命中）→ 3 张 planned 应用实体；
 *  3) 每个 result 都带 captured_from 边；capture.data.offer_count === 3；
 *  4) 同一 source_ref 第二次入站 → duplicate（不重复落库）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { freshStore } = require('./helpers');
const capture = require('../src/capture');
const { parseOffers } = require('../src/capture/extractors/cc_offers');

// 仿 DoC 列表页：三张卡，每张一段。卡名行单独成行 + 后续 bonus/spend/fee。
// Synthetic DoC-style page text (HTML stripped). Three cards, one block each.
const FIXTURE_TEXT = [
  'Best Current Credit Card Offers (Updated June 2026)',
  '',
  'Chase Sapphire Preferred Card',
  'Earn 60,000 points after spending $4,000 in 3 months.',
  'This Visa card has a $95 annual fee.',
  'Bonus deadline: expires 2026-12-31.',
  '',
  'American Express Gold Card',
  'Earn 90,000 points after spending $6,000 in 6 months.',
  '$250 annual fee, no foreign transaction fees.',
  '',
  'Capital One Venture Rewards Card',
  'Earn 75,000 miles after spending $4,000 in 3 months.',
  '$95/yr. Visa Signature.',
  '',
  'Some unrelated footer text that should not become a card.',
].join('\n');

const SOURCE_URL = 'https://www.doctorofcredit.com/best-credit-card-bonuses/';

test('cc-offers: parseOffers extracts three offers with key fields populated', () => {
  const offers = parseOffers(FIXTURE_TEXT, SOURCE_URL);
  assert.equal(offers.length, 3, `expected 3 offers, got ${offers.length}: ${JSON.stringify(offers.map((o) => o.card_name))}`);

  const byName = new Map(offers.map((o) => [o.card_name, o]));

  const csp = byName.get('Chase Sapphire Preferred Card');
  assert.ok(csp, 'Chase Sapphire Preferred Card not extracted');
  assert.equal(csp.signup_bonus_value, 60000);
  assert.equal(csp.spend_required, 4000);
  assert.equal(csp.time_window_days, 90);
  assert.equal(csp.annual_fee, 95);
  assert.equal(csp.bonus_deadline, '2026-12-31');
  assert.equal(csp.issuer, 'Chase');
  assert.equal(csp.network, 'Visa');
  // 永远保留来源（即使其它字段空）
  assert.match(csp.note, /doctorofcredit\.com/);

  const amex = byName.get('American Express Gold Card');
  assert.ok(amex);
  assert.equal(amex.signup_bonus_value, 90000);
  assert.equal(amex.spend_required, 6000);
  assert.equal(amex.time_window_days, 180);
  assert.equal(amex.annual_fee, 250);
  assert.equal(amex.issuer, 'American Express');

  const venture = byName.get('Capital One Venture Rewards Card');
  assert.ok(venture);
  assert.equal(venture.signup_bonus_value, 75000);
  assert.equal(venture.spend_required, 4000);
  assert.equal(venture.time_window_days, 90);
  assert.equal(venture.annual_fee, 95);
  assert.equal(venture.issuer, 'Capital One');
});

test('cc-offers: capture with hints.kind=cc_offers routes to credit_card.bulk_offers and creates 3 planned apps', async () => {
  const store = await freshStore();
  // NO llm injected — 测试离线，确保规则路由生效。
  const api = capture(store);
  try {
    const out = await api.ingest({
      channel: 'chrome-cc-offers',
      source_ref: 'page-1',
      text: FIXTURE_TEXT,
      hints: { domain: 'finance', kind: 'cc_offers', url: SOURCE_URL, title: 'DoC Best Offers' },
    });

    assert.equal(out.status, 'committed', `expected committed, got ${out.status} ${JSON.stringify(out.error || '')}`);
    assert.equal(out.route.intent, 'credit_card.bulk_offers');
    assert.equal(out.route.by, 'rule');
    assert.equal(out.route.confidence, 1);

    // capture 实体记录了 offer_count、result_ids、source_url。
    const cap = await store.entities.get(out.id);
    assert.equal(cap.data.offer_count, 3);
    assert.ok(Array.isArray(cap.data.result_ids));
    assert.equal(cap.data.result_ids.length, 3);
    assert.equal(cap.data.source_url, SOURCE_URL);

    // 三张卡都建成了 planned 应用。
    const apps = await store.entities.list({ type: 'credit_card_application', limit: 50 });
    assert.equal(apps.length, 3);
    for (const app of apps) {
      assert.equal(app.status, 'planned');
      assert.match(app.body, /doctorofcredit\.com/, `app ${app.title} should mention source url`);
    }

    // 每条应用都回连 captured_from 边到 capture。
    for (const appId of cap.data.result_ids) {
      const edges = await store.relations.from(appId, 'captured_from');
      assert.equal(edges.length, 1, `app ${appId} missing captured_from edge`);
      assert.equal(edges[0].object_id, out.id);
    }

    // 验证「primary」result_id 也在 result_ids 里。
    assert.ok(cap.data.result_ids.includes(out.result_id));

    // 同 source_ref 再来一次 → duplicate；不重复落库。
    const dup = await api.ingest({
      channel: 'chrome-cc-offers',
      source_ref: 'page-1',
      text: FIXTURE_TEXT,
      hints: { domain: 'finance', kind: 'cc_offers', url: SOURCE_URL },
    });
    assert.equal(dup.status, 'duplicate');
    assert.equal(dup.id, out.id);
    const appsAfter = await store.entities.list({ type: 'credit_card_application', limit: 50 });
    assert.equal(appsAfter.length, 3, 'duplicate ingest should NOT create extra applications');
  } finally {
    await store.close();
  }
});

test('cc-offers: pre-extracted offers in capture args skip the regex extractor', async () => {
  const store = await freshStore();
  const api = capture(store);
  try {
    // 走人工 confirm 路径，绕开 rules 把 offers 直接塞 args（模拟扩展在客户端预抽取）。
    const cap = await api.ingest({
      channel: 'chrome-cc-offers',
      source_ref: 'page-2',
      // 关键：不带 hints.kind，规则不命中 → pending
      text: 'irrelevant body',
    });
    assert.equal(cap.status, 'pending');

    const confirmed = await api.confirm(cap.id, {
      intent: 'credit_card.bulk_offers',
      args: {
        text: '',
        source_url: 'https://example.com/promo',
        offers: [
          { card_name: 'Bilt Mastercard', annual_fee: 0, signup_bonus_text: 'no SUB' },
          { card_name: 'Wells Fargo Active Cash', annual_fee: 0, signup_bonus_value: 20000 },
        ],
      },
    });
    assert.equal(confirmed.status, 'committed');

    const apps = await store.entities.list({ type: 'credit_card_application', limit: 50 });
    assert.equal(apps.length, 2);
    const titles = apps.map((a) => a.title).sort();
    assert.deepEqual(titles, ['Bilt Mastercard', 'Wells Fargo Active Cash']);
    for (const app of apps) assert.equal(app.status, 'planned');
  } finally {
    await store.close();
  }
});
