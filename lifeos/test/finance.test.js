'use strict';

// Run with LIFEOS_SECRET_KEY set so the encryption path is exercised.

const { test } = require('node:test');
const assert = require('node:assert');
const { freshStore } = require('./helpers');
const financeDomain = require('../src/domains/finance');

test('finance: createAccount stores plaintext kind/institution, encrypts last4', async () => {
  const store = await freshStore();
  const fin = financeDomain(store);
  try {
    const acct = await fin.createAccount({
      name: 'Everyday Checking', kind: 'checking', institution: 'Chase',
      currency: 'USD', last4: '4242', account_number: '9876543210',
    });
    assert.equal(acct.type, 'finance_account');
    assert.equal(acct.status, 'open');
    assert.equal(acct.data.kind, 'checking');
    assert.equal(acct.data.institution, 'Chase');
    assert.equal(acct.data.currency, 'USD');
    assert.ok(acct.tags.includes('finance') && acct.tags.includes('account'));

    // sensitive fields are NOT in plaintext data, only the opaque blob
    assert.equal(acct.data.last4, undefined);
    assert.equal(acct.data.account_number, undefined);
    assert.ok(typeof acct.data.enc === 'string' && /^enc:/.test(acct.data.enc));
    assert.ok(!acct.data.enc.includes('4242'));

    // reveal is the only path that exposes them
    const revealed = await fin.revealAccount(acct.id);
    assert.equal(revealed.last4, '4242');
    assert.equal(revealed.account_number, '9876543210');
  } finally { await store.close(); }
});

test('finance: addTxn + balance math + from_account relation', async () => {
  const store = await freshStore();
  const fin = financeDomain(store);
  try {
    const acct = await fin.createAccount({ name: 'Checking', kind: 'checking' });

    await fin.addTxn({ account_id: acct.id, amount_cents: 500000, direction: 'credit',
      category: 'income', merchant: 'Employer', posted_on: '2026-06-01' });
    await fin.addTxn({ account_id: acct.id, amount_cents: 1299, direction: 'debit',
      category: 'coffee', merchant: 'Blue Bottle', posted_on: '2026-06-02' });
    const t3 = await fin.addTxn({ account_id: acct.id, amount_cents: 8800, direction: 'debit',
      category: 'groceries', merchant: 'Whole Foods', posted_on: '2026-06-03' });

    // relation txn -[from_account]-> account
    const edges = await store.relations.from(t3.id, 'from_account');
    assert.equal(edges.length, 1);
    assert.equal(edges[0].object_id, acct.id);

    const bal = await fin.balance(acct.id);
    assert.equal(bal.credit_cents, 500000);
    assert.equal(bal.debit_cents, 1299 + 8800);
    assert.equal(bal.balance_cents, 500000 - 1299 - 8800);

    // invalid direction rejected
    await assert.rejects(() => fin.addTxn({ account_id: acct.id, amount_cents: 1, direction: 'nope' }));
  } finally { await store.close(); }
});

test('finance: listTxns filters by account/category/date', async () => {
  const store = await freshStore();
  const fin = financeDomain(store);
  try {
    const acct = await fin.createAccount({ name: 'Checking' });
    await fin.addTxn({ account_id: acct.id, amount_cents: 100, direction: 'debit', category: 'coffee', posted_on: '2026-05-10' });
    await fin.addTxn({ account_id: acct.id, amount_cents: 200, direction: 'debit', category: 'coffee', posted_on: '2026-06-10' });
    await fin.addTxn({ account_id: acct.id, amount_cents: 300, direction: 'debit', category: 'groceries', posted_on: '2026-06-11' });

    assert.equal((await fin.listTxns({ account_id: acct.id })).length, 3);
    assert.equal((await fin.listTxns({ category: 'coffee' })).length, 2);
    const ranged = await fin.listTxns({ from: '2026-06-01', to: '2026-06-30' });
    assert.equal(ranged.length, 2);
    // newest first
    assert.equal(ranged[0].data.posted_on, '2026-06-11');
  } finally { await store.close(); }
});

test('finance: spendByCategory aggregates debits desc', async () => {
  const store = await freshStore();
  const fin = financeDomain(store);
  try {
    const acct = await fin.createAccount({ name: 'Checking' });
    await fin.addTxn({ account_id: acct.id, amount_cents: 5000, direction: 'debit', category: 'groceries', posted_on: '2026-06-01' });
    await fin.addTxn({ account_id: acct.id, amount_cents: 3000, direction: 'debit', category: 'groceries', posted_on: '2026-06-02' });
    await fin.addTxn({ account_id: acct.id, amount_cents: 1500, direction: 'debit', category: 'coffee', posted_on: '2026-06-03' });
    // a credit must be excluded from spend
    await fin.addTxn({ account_id: acct.id, amount_cents: 99999, direction: 'credit', category: 'income', posted_on: '2026-06-04' });

    const spend = await fin.spendByCategory({ from: '2026-06-01', to: '2026-06-30' });
    assert.equal(spend.length, 2);
    assert.deepEqual(spend[0], { category: 'groceries', spent_cents: 8000 });
    assert.deepEqual(spend[1], { category: 'coffee', spent_cents: 1500 });
  } finally { await store.close(); }
});

test('finance: memo/last4 never leak to title/body/summary/search; reveal works', async () => {
  const store = await freshStore();
  const fin = financeDomain(store);
  try {
    const acct = await fin.createAccount({ name: 'Checking', last4: '7777' });
    const SECRET_MEMO = 'therapyappointment9999';
    const txn = await fin.addTxn({
      account_id: acct.id, amount_cents: 12000, direction: 'debit',
      category: 'health', merchant: 'Clinic', posted_on: '2026-06-05',
      memo: SECRET_MEMO, raw_descriptor: 'POS DEBIT 7777 CLINIC',
    });

    const e = await store.entities.get(txn.id);
    // memo must not appear in any searchable text field or plaintext data
    for (const field of [e.title, e.body, e.summary]) {
      assert.ok(!String(field).includes(SECRET_MEMO));
      assert.ok(!String(field).includes('7777'));
    }
    assert.equal(e.data.memo, undefined);
    assert.equal(e.data.raw_descriptor, undefined);
    assert.ok(/^enc:/.test(e.data.enc));
    assert.ok(!e.data.enc.includes(SECRET_MEMO), 'enc blob must be opaque, not raw memo');

    // full-text search cannot surface the secret memo
    const hits = await store.search(SECRET_MEMO);
    assert.equal(hits.length, 0);

    // reveal is the sanctioned decryption path
    const revealed = await fin.reveal(txn.id);
    assert.equal(revealed.memo, SECRET_MEMO);
    assert.equal(revealed.raw_descriptor, 'POS DEBIT 7777 CLINIC');
  } finally { await store.close(); }
});
