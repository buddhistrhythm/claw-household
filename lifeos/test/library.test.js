'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { freshStore } = require('./helpers');
const readingDomain = require('../src/domains/library');

const TODAY = new Date().toISOString().slice(0, 10);

test('library: addBook defaults + author tag + invalid status', async () => {
  const store = await freshStore();
  try {
    const lib = readingDomain(store);

    const b = await lib.addBook({ title: 'Dune', author: 'Frank Herbert', year: 1965, total_pages: 412 });
    assert.equal(b.type, 'book');
    assert.equal(b.status, 'want');
    assert.deepEqual(b.tags, ['book', 'frank herbert']);
    assert.equal(b.data.year, 1965);
    assert.equal(b.data.total_pages, 412);
    assert.equal(b.occurred_at, null);

    await assert.rejects(() => lib.addBook({ title: 'X', status: 'bogus' }), /invalid status/);
    await assert.rejects(() => lib.addBook({}), /title.*required/);
  } finally { await store.close(); }
});

test('library: lifecycle stamps started_on / finished_on + currentlyReading', async () => {
  const store = await freshStore();
  try {
    const lib = readingDomain(store);

    const b = await lib.addBook({ title: 'Dune' });

    // enter reading → started_on + occurred_at stamped
    const reading = await lib.setStatus(b.id, 'reading');
    assert.equal(reading.status, 'reading');
    assert.equal(reading.data.started_on, TODAY);
    assert.equal(reading.occurred_at.slice(0, 10), TODAY);
    assert.equal(reading.data.finished_on, null);

    // currentlyReading sees it
    const cur = await lib.currentlyReading();
    assert.equal(cur.length, 1);
    assert.equal(cur[0].id, b.id);

    // finish → finished_on default today + rating merged
    const done = await lib.setStatus(b.id, 'finished', { rating: 5 });
    assert.equal(done.status, 'finished');
    assert.equal(done.data.finished_on, TODAY);
    assert.equal(done.data.rating, 5);
    assert.equal(done.data.started_on, TODAY); // preserved

    // no longer currently reading
    assert.equal((await lib.currentlyReading()).length, 0);

    // explicit started_on / finished_on honored
    const b2 = await lib.addBook({ title: 'Other' });
    const r2 = await lib.setStatus(b2.id, 'reading', { started_on: '2026-01-02' });
    assert.equal(r2.data.started_on, '2026-01-02');
    const f2 = await lib.setStatus(b2.id, 'finished', { finished_on: '2026-03-04' });
    assert.equal(f2.data.finished_on, '2026-03-04');

    await assert.rejects(() => lib.setStatus(b.id, 'bogus'), /invalid status/);
  } finally { await store.close(); }
});

test('library: updateProgress / rate / finishedInYear', async () => {
  const store = await freshStore();
  try {
    const lib = readingDomain(store);

    const b = await lib.addBook({ title: 'Progress book' });
    const prog = await lib.updateProgress(b.id, 42);
    assert.equal(prog.data.progress_pct, 42);

    const rated = await lib.rate(b.id, 4);
    assert.equal(rated.data.rating, 4);

    // finishedInYear filters by finished_on calendar year
    const a = await lib.addBook({ title: 'A' });
    await lib.setStatus(a.id, 'reading');
    await lib.setStatus(a.id, 'finished', { finished_on: '2026-05-10' });

    const c = await lib.addBook({ title: 'C' });
    await lib.setStatus(c.id, 'reading');
    await lib.setStatus(c.id, 'finished', { finished_on: '2025-12-31' });

    const in2026 = await lib.finishedInYear(2026);
    assert.equal(in2026.length, 1);
    assert.equal(in2026[0].title, 'A');

    const in2025 = await lib.finishedInYear(2025);
    assert.equal(in2025.length, 1);
    assert.equal(in2025[0].title, 'C');

    // list by status
    assert.equal((await lib.list({ status: 'finished' })).length, 2);
  } finally { await store.close(); }
});
