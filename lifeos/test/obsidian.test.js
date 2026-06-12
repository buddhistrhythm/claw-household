'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { renderEntityNote, noteBasename } = require('../src/obsidian');

test('renders frontmatter, body, flattened data, and relation wikilinks', () => {
  const entity = {
    id: 'ent_abc', type: 'credit_card_application', title: 'Amex Gold',
    status: 'applied', tags: ['finance', 'credit-card'], topics: [],
    occurred_at: '2026-05-01T00:00:00.000Z', body: 'apply notes',
    data: { issuer: 'Amex', annual_fee: 250, bonus_earned: false, empty: '' },
  };
  const edges = [{ predicate: 'issued_by', target: { id: 'ent_org1', title: 'American Express' } }];
  const md = renderEntityNote(entity, edges);

  assert.match(md, /^---\n/);
  assert.match(md, /type: credit_card_application/);
  assert.match(md, /status: applied/);
  assert.match(md, /issuer: Amex/);
  assert.match(md, /annual_fee: 250/);
  assert.doesNotMatch(md, /empty:/); // empty values skipped
  assert.match(md, /# Amex Gold/);
  assert.match(md, /apply notes/);
  assert.match(md, /- issued_by → \[\[ent_org1__american-express\]\]/);
});

test('noteBasename is stable id + slug', () => {
  assert.equal(noteBasename({ id: 'ent_x', title: '第二抽屉' }), 'ent_x__第二抽屉');
});

test('never mirrors the sensitive data.enc blob into frontmatter', () => {
  const entity = {
    id: 'ent_txn1', type: 'finance_txn', title: 'Clinic', tags: ['finance'], topics: [],
    data: { amount_cents: 12000, category: 'health', enc: 'plain:v1:eyJsYXN0NCI6Ijc3NzcifQ==' },
  };
  const md = renderEntityNote(entity, []);
  assert.doesNotMatch(md, /enc:/);          // the blob key is excluded
  assert.doesNotMatch(md, /plain:v1:/);     // and its (dev-mode decodable) value
  assert.match(md, /amount_cents: 12000/);  // non-sensitive fields still mirrored
});
