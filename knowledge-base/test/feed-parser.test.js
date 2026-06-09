'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseFeed } = require('../src/connectors/feed-parser');

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Example Eng Blog</title>
  <item>
    <title>Scaling Postgres to 1M writes/sec</title>
    <link>https://example.com/postgres</link>
    <guid>https://example.com/postgres</guid>
    <pubDate>Mon, 12 May 2026 09:00:00 GMT</pubDate>
    <dc:creator>Jane Dev</dc:creator>
    <description><![CDATA[<p>We sharded our <b>database</b> and learned a lot.</p>]]></description>
  </item>
  <item>
    <title>Our move to Rust</title>
    <link>https://example.com/rust</link>
    <description>Why we rewrote the hot path in Rust.</description>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Blog</title>
  <entry>
    <title>Agentic RAG in production</title>
    <link href="https://atom.example/rag"/>
    <id>tag:atom.example,2026:rag</id>
    <published>2026-04-01T12:00:00Z</published>
    <author><name>Sam Researcher</name></author>
    <summary>Retrieval as a tool call inside the agent loop.</summary>
  </entry>
</feed>`;

test('parses RSS 2.0 items', () => {
  const items = parseFeed(RSS, 'Example');
  assert.equal(items.length, 2);
  const first = items[0];
  assert.equal(first.title, 'Scaling Postgres to 1M writes/sec');
  assert.equal(first.url, 'https://example.com/postgres');
  assert.equal(first.author, 'Jane Dev');
  assert.equal(first.source, 'rss');
  assert.equal(first.source_name, 'Example');
  assert.match(first.content, /sharded our database/);
  assert.ok(first.published_at.startsWith('2026-05-12'));
});

test('parses Atom entries with href link + nested author', () => {
  const items = parseFeed(ATOM, 'Atom Blog');
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://atom.example/rag');
  assert.equal(items[0].author, 'Sam Researcher');
  assert.match(items[0].content, /tool call/);
  assert.ok(items[0].published_at.startsWith('2026-04-01'));
});

test('empty / junk feed yields no items', () => {
  assert.deepEqual(parseFeed('', 'x'), []);
  assert.deepEqual(parseFeed('<html>not a feed</html>', 'x'), []);
});
