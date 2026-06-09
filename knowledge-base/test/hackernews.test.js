'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseFavorites, mapItem } = require('../src/connectors/hackernews');

const HTML = `
<table>
  <tr class='athing' id='38000001'>
    <td><a href="vote?id=38000001&how=up">▲</a></td>
    <td><a href="https://blog.example/post">A great post</a></td>
  </tr>
  <tr><td><a href="item?id=38000001">120 comments</a></td></tr>
  <tr class='athing' id='38000002'>
    <td><a href="item?id=38000002">Another favorite</a></td>
  </tr>
</table>`;

test('parseFavorites extracts ordered, de-duplicated ids', () => {
  const ids = parseFavorites(HTML);
  assert.deepEqual(ids, ['38000001', '38000002']);
});

test('mapItem maps a Firebase story', () => {
  const item = mapItem({
    id: 38000001, type: 'story', by: 'pg', time: 1746000000,
    title: 'A great post', url: 'https://blog.example/post', score: 256, descendants: 120,
  });
  assert.equal(item.source, 'hackernews');
  assert.equal(item.title, 'A great post');
  assert.equal(item.url, 'https://blog.example/post');
  assert.equal(item.author, 'pg');
  assert.equal(item.metadata.score, 256);
  assert.ok(item.tags.includes('hackernews'));
});

test('mapItem skips dead/deleted items', () => {
  assert.equal(mapItem({ id: 1, dead: true }), null);
  assert.equal(mapItem({ id: 2, deleted: true }), null);
  assert.equal(mapItem(null), null);
});
