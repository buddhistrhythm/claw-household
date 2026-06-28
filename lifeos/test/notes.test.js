'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { freshStore } = require('./helpers');
const notesDomain = require('../src/domains/notes');

test('notes: create with about edge + forEntity', async () => {
  const store = await freshStore();
  try {
    const notes = notesDomain(store);

    const card = await store.entities.create({ type: 'item', title: 'Cast iron pan' });
    const note = await notes.create({
      title: 'Seasoning log', body: 'first pass', tags: ['kitchen'], about: card.id,
    });
    assert.equal(note.type, 'note');
    assert.deepEqual(note.tags, ['kitchen']);

    // the about edge exists
    const edges = await store.relations.toward(card.id, notes.ABOUT);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].subject_id, note.id);

    // forEntity resolves the note objects
    const found = await notes.forEntity(card.id);
    assert.equal(found.length, 1);
    assert.equal(found[0].id, note.id);
    assert.equal(found[0].title, 'Seasoning log');
  } finally { await store.close(); }
});

test('notes: append concatenates body, link, list', async () => {
  const store = await freshStore();
  try {
    const notes = notesDomain(store);

    const note = await notes.create({ title: 'Ideas', body: 'one', tags: ['x'] });
    const appended = await notes.append(note.id, 'two');
    assert.equal(appended.body, 'one\n\ntwo');

    // append onto empty body
    const empty = await notes.create({ title: 'Empty' });
    const filled = await notes.append(empty.id, 'first line');
    assert.equal(filled.body, 'first line');

    // explicit link to another entity
    const target = await store.entities.create({ type: 'item', title: 'Thing' });
    await notes.link(note.id, target.id);
    const linked = await notes.forEntity(target.id);
    assert.equal(linked.length, 1);
    assert.equal(linked[0].id, note.id);

    // list by tag
    const tagged = await notes.list({ tag: 'x' });
    assert.equal(tagged.length, 1);
    assert.equal(tagged[0].id, note.id);
  } finally { await store.close(); }
});
