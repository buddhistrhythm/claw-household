'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { freshStore } = require('./helpers');
const creditCardDomain = require('../src/domains/credit_card');

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

test('credit card: create, status lifecycle, list by status', async () => {
  const store = await freshStore();
  const cc = creditCardDomain(store);
  try {
    const app = await cc.create({
      card: 'Chase Sapphire Preferred', issuer: 'Chase', applied_on: '2026-05-01',
      annual_fee: 95, signup_bonus: '60k pts', bonus_deadline: daysFromNow(60),
    });
    assert.equal(app.status, 'applied');
    assert.equal(app.data.issuer, 'Chase');
    assert.ok(app.tags.includes('credit-card'));
    assert.ok(app.tags.includes('chase'));

    const approved = await cc.setStatus(app.id, 'approved', { credit_line: 12000 });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.data.credit_line, 12000);
    assert.ok(approved.data.decided_on);

    const open = await cc.list({ status: 'approved' });
    assert.equal(open.length, 1);
    assert.equal((await cc.list({ status: 'denied' })).length, 0);
  } finally { await store.close(); }
});

test('credit card: upcoming bonus deadlines excludes earned + out-of-window', async () => {
  const store = await freshStore();
  const cc = creditCardDomain(store);
  try {
    const soon = await cc.create({ card: 'Amex Gold', bonus_deadline: daysFromNow(20) });
    await cc.create({ card: 'Citi Premier', bonus_deadline: daysFromNow(200) }); // out of window
    const earned = await cc.create({ card: 'Capital One Venture', bonus_deadline: daysFromNow(10) });
    await cc.markBonusEarned(earned.id, true);

    const due = await cc.upcomingBonusDeadlines({ days: 30 });
    assert.equal(due.length, 1);
    assert.equal(due[0].id, soon.id);
  } finally { await store.close(); }
});

test('credit card: annual fee total ignores closed/denied', async () => {
  const store = await freshStore();
  const cc = creditCardDomain(store);
  try {
    const a = await cc.create({ card: 'Card A', annual_fee: 95 });
    await cc.create({ card: 'Card B', annual_fee: 250 });
    const denied = await cc.create({ card: 'Card C', annual_fee: 550 });
    await cc.setStatus(denied.id, 'denied');
    await cc.setStatus(a.id, 'approved');

    assert.equal(await cc.annualFeeTotal(), 345); // 95 + 250, not 550
  } finally { await store.close(); }
});
