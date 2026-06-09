'use strict';

/**
 * feed-parser.js — a small, dependency-free RSS 2.0 / Atom parser.
 *
 * Not a full XML parser — it pulls the fields tech-blog feeds actually use.
 * Exported separately so it can be unit-tested without network access.
 */

function decodeEntities(s) {
  if (s == null) return '';
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function firstTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1] : null;
}

function tagAttr(block, tag, name) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*\\b${name}=["']([^"']*)["']`, 'i'));
  return m ? m[1] : null;
}

function toISO(s) {
  if (!s) return null;
  const d = new Date(decodeEntities(s));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Parse a feed XML string into raw items (RSS <item> or Atom <entry>).
 * @param {string} xml
 * @param {string} feedName  human label for the source
 * @returns {Array} raw items
 */
function parseFeed(xml, feedName) {
  const text = String(xml || '');
  const isAtom = /<feed[\s>]/i.test(text) && /<entry[\s>]/i.test(text);
  const blocks = isAtom
    ? text.match(/<entry[\s\S]*?<\/entry>/gi) || []
    : text.match(/<item[\s\S]*?<\/item>/gi) || [];

  return blocks.map((b) => {
    let link;
    if (isAtom) {
      link = tagAttr(b, 'link', 'href') || decodeEntities(firstTag(b, 'link') || '');
    } else {
      link = decodeEntities(firstTag(b, 'link') || '') || tagAttr(b, 'link', 'href');
    }
    const title = stripTags(firstTag(b, 'title') || '');
    const guid = decodeEntities(firstTag(b, 'guid') || firstTag(b, 'id') || link || title);
    const published = firstTag(b, 'pubDate') || firstTag(b, 'published') ||
      firstTag(b, 'updated') || firstTag(b, 'dc:date');
    const rawContent = firstTag(b, 'content:encoded') || firstTag(b, 'content') ||
      firstTag(b, 'summary') || firstTag(b, 'description') || '';
    const author = stripTags(firstTag(b, 'dc:creator') || firstTag(b, 'author') || '') || null;

    return {
      source: 'rss',
      source_name: feedName || 'RSS',
      type: 'article',
      source_id: guid,
      title,
      url: link || null,
      author,
      content: stripTags(rawContent),
      published_at: toISO(published),
      liked_at: null,
      metadata: { feed: feedName },
    };
  });
}

module.exports = { parseFeed, stripTags, decodeEntities };
