'use strict';

/**
 * graph/build.js — the 4-signal knowledge graph over pooled items.
 *
 * Adapted from the LLM Wiki relevance model (nashsu/llm_wiki) to RSS-item
 * reality. Edge weight between two items is the sum of:
 *
 *   tag overlap   ×3.0  — shared topical tags (excluding source/category tags)
 *   same author   ×4.0  — strongest signal, like llm_wiki's shared raw source
 *   Adamic-Adar   ×1.5  — shared tags weighted by rarity: Σ 1/log(items(tag))
 *   type affinity ×1.0  — same feed category (topics)
 *
 * Pure graph math — no LLM, no network. An LLM page-compile step can later
 * add real [[wikilink]] edges on top of this.
 */

const WEIGHTS = {
  tag_overlap: 3.0,
  author: 4.0,
  adamic_adar: 1.5,
  type_affinity: 1.0,
};

/** Tags that merely echo a feed's source/category aren't topical signals. */
function topicalTagsOf(item) {
  const skip = new Set([item.source, ...(item.topics || [])]);
  return (item.tags || []).filter((t) => !skip.has(t));
}

/**
 * Build the weighted graph from a list of items.
 * @param {Array} items pooled items
 * @returns {{ nodes, edges, adjacency }}
 *   nodes: [{ id, title, source, source_name, category, tags, degree, url }]
 *   edges: [{ a, b, weight, signals }]
 *   adjacency: Map(id → Map(id → weight))
 */
function buildGraph(items) {
  // Index: tag → Set(item ids), for overlap + Adamic-Adar.
  const tagIndex = new Map();
  const byId = new Map();
  for (const it of items) {
    byId.set(it.id, it);
    for (const t of topicalTagsOf(it)) {
      if (!tagIndex.has(t)) tagIndex.set(t, new Set());
      tagIndex.get(t).add(it.id);
    }
  }

  // Candidate pairs: items sharing ≥1 topical tag or an author. Avoids O(n²)
  // over unrelated items.
  const pairKeys = new Set();
  const pairs = [];
  function addPair(aId, bId) {
    if (aId === bId) return;
    const key = aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
    if (pairKeys.has(key)) return;
    pairKeys.add(key);
    pairs.push(aId < bId ? [aId, bId] : [bId, aId]);
  }
  for (const ids of tagIndex.values()) {
    const arr = [...ids];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) addPair(arr[i], arr[j]);
    }
  }
  const authorIndex = new Map();
  for (const it of items) {
    if (!it.author) continue;
    if (!authorIndex.has(it.author)) authorIndex.set(it.author, []);
    authorIndex.get(it.author).push(it.id);
  }
  for (const ids of authorIndex.values()) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) addPair(ids[i], ids[j]);
    }
  }

  // Score each candidate pair with the 4 signals.
  const edges = [];
  const adjacency = new Map();
  function connect(a, b, weight) {
    if (!adjacency.has(a)) adjacency.set(a, new Map());
    if (!adjacency.has(b)) adjacency.set(b, new Map());
    adjacency.get(a).set(b, weight);
    adjacency.get(b).set(a, weight);
  }

  for (const [aId, bId] of pairs) {
    const a = byId.get(aId);
    const b = byId.get(bId);
    const aTags = new Set(topicalTagsOf(a));
    const shared = topicalTagsOf(b).filter((t) => aTags.has(t));

    const signals = {};
    if (shared.length) signals.tag_overlap = shared.length * WEIGHTS.tag_overlap;
    if (a.author && a.author === b.author) signals.author = WEIGHTS.author;

    let aa = 0;
    for (const t of shared) {
      const n = tagIndex.get(t).size;
      if (n > 1) aa += 1 / Math.log(1 + n);
    }
    if (aa > 0) signals.adamic_adar = aa * WEIGHTS.adamic_adar;

    const aTopics = new Set(a.topics || []);
    if ((b.topics || []).some((t) => aTopics.has(t))) {
      signals.type_affinity = WEIGHTS.type_affinity;
    }

    const weight = Object.values(signals).reduce((s, v) => s + v, 0);
    if (weight <= 0) continue;
    edges.push({ a: aId, b: bId, weight: round2(weight), signals, shared_tags: shared });
    connect(aId, bId, weight);
  }

  const nodes = items.map((it) => ({
    id: it.id,
    title: it.title,
    source: it.source,
    source_name: it.source_name,
    category: (it.topics || [])[0] || null,
    tags: topicalTagsOf(it),
    url: it.url || null,
    degree: adjacency.get(it.id)?.size || 0,
  }));

  return { nodes, edges, adjacency };
}

/**
 * Rank items most relevant to one item, by direct edge weight.
 * @returns {Array<{ id, weight, signals }>}
 */
function relatedTo(graph, id, limit = 10) {
  const nbrs = graph.adjacency.get(id);
  if (!nbrs) return [];
  const edgeFor = (a, b) =>
    graph.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
  return [...nbrs.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, limit)
    .map(([nid, weight]) => ({
      id: nid,
      weight: round2(weight),
      signals: edgeFor(id, nid)?.signals || {},
      shared_tags: edgeFor(id, nid)?.shared_tags || [],
    }));
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

module.exports = { buildGraph, relatedTo, topicalTagsOf, WEIGHTS };
