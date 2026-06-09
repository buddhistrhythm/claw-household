'use strict';

/**
 * generate.js — build "A Tour of Go"-style quiz levels from stored knowledge.
 *
 * Each level = a short lesson (one captured item) + a multiple-choice question
 * generated deterministically from the data (no LLM required). This is the seam
 * where an LLM question-writer would plug in for richer prompts.
 */

function pickDistractors(pool, correct, key, n = 3) {
  const options = uniqueBy(pool.map((p) => p[key]).filter((v) => v && v !== correct));
  shuffle(options);
  return options.slice(0, n);
}

function buildSourceQuestion(item, pool) {
  const distractors = pickDistractors(pool, item.source_name, 'source_name', 3);
  if (distractors.length < 2) return null;
  const choices = shuffle([item.source_name, ...distractors]);
  return {
    prompt: `Which source did this come from?\n\n“${item.title}”`,
    choices,
    answer: choices.indexOf(item.source_name),
    explanation: `“${item.title}” was captured from ${item.source_name}.`,
  };
}

function buildTagQuestion(item, pool) {
  const realTag = (item.tags || []).find((t) => !['hackernews', 'x', 'xiaohongshu', 'rss'].includes(t));
  if (!realTag) return null;
  const allTags = uniqueBy(pool.flatMap((p) => p.tags || []))
    .filter((t) => !['hackernews', 'x', 'xiaohongshu', 'rss'].includes(t) && t !== realTag);
  shuffle(allTags);
  const distractors = allTags.slice(0, 3);
  if (distractors.length < 2) return null;
  const choices = shuffle([realTag, ...distractors]);
  return {
    prompt: `Which topic best matches this item?\n\n“${item.title}” — ${item.excerpt}`,
    choices,
    answer: choices.indexOf(realTag),
    explanation: `This item is tagged “${realTag}”.`,
  };
}

/**
 * @param {object} store  storage backend
 * @param {object} [opts] { topic, count }
 * @returns {Promise<{topic, levels}>}
 */
async function generateQuiz(store, { topic, count = 5 } = {}) {
  let pool = [];
  if (topic) {
    pool = await store.listItems({ tag: topic, limit: 200 });
    if (!pool.length) pool = await store.searchItems(topic, { limit: 200 });
  }
  if (!pool.length) pool = await store.listItems({ limit: 200 });

  pool = pool.filter((i) => i.title && i.title !== '(untitled)');
  shuffle(pool);

  const levels = [];
  // Alternate question styles, but fall back to whichever builder can produce
  // a valid question for this item (e.g. source questions need ≥3 sources).
  const builders = [buildTagQuestion, buildSourceQuestion];
  for (const item of pool) {
    if (levels.length >= count) break;
    const ordered = levels.length % 2 === 0 ? builders : [...builders].reverse();
    let question = null;
    for (const build of ordered) {
      question = build(item, pool);
      if (question) break;
    }
    if (!question) continue;
    levels.push({
      index: levels.length + 1,
      title: item.title,
      lesson: item.excerpt || item.title,
      reference: { id: item.id, url: item.url, source: item.source_name },
      question,
    });
  }

  return { topic: topic || 'all', count: levels.length, levels };
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function uniqueBy(arr) {
  return [...new Set(arr)];
}

module.exports = { generateQuiz };
