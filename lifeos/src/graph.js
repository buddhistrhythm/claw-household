'use strict';

/**
 * graph.js — knowledge-graph layer over the entities + relations tables.
 *            实体 + 关系表之上的「知识图谱」查询层。
 *
 * The graph isn't a separate store — it's just traversal over the existing
 * first-class `relations` edges ("direct edges = strongest signal"). This module
 * adds: brief node projection, neighbor lookup, bounded BFS expansion, and a
 * similarity-edge builder that materializes shared tag/topic overlaps as edges.
 *
 * 图谱并非独立存储，而是对既有 `relations` 边的遍历（「直接边 = 最强信号」）。
 * 本模块提供：节点精简投影、邻居查询、有界 BFS 扩展，以及把标签/话题重叠
 * 物化成边的相似度构建器。
 */

module.exports = function graph(store) {
  const { entities, relations } = store;

  /** Project an entity down to the fields worth shipping to an LLM client. */
  /** 把实体精简成适合发给 LLM 客户端的字段。 */
  function briefNode(e) {
    if (!e) return null;
    return {
      id: e.id,
      type: e.type,
      title: e.title,
      summary: e.summary,
      status: e.status,
      tags: e.tags || [],
      url: (e.data && e.data.url) || e.source_ref || null,
    };
  }

  /**
   * Neighbors of an entity: out = relations.from (subject side),
   * in = relations.toward (object side), 'both' merges the two.
   * 实体的邻居：out = 出边（作为 subject），in = 入边（作为 object），both 合并。
   */
  async function neighbors(id, { predicate, direction = 'both', limit = 50 } = {}) {
    const out = [];

    if (direction === 'out' || direction === 'both') {
      const edges = await relations.from(id, predicate);
      for (const r of edges) {
        const node = briefNode(await entities.get(r.object_id));
        if (node) out.push({ edge: { predicate: r.predicate, weight: r.weight, dir: 'out' }, node });
      }
    }
    if (direction === 'in' || direction === 'both') {
      const edges = await relations.toward(id, predicate);
      for (const r of edges) {
        const node = briefNode(await entities.get(r.subject_id));
        if (node) out.push({ edge: { predicate: r.predicate, weight: r.weight, dir: 'in' }, node });
      }
    }
    return out.slice(0, limit);
  }

  /**
   * BFS from `id` up to `depth` hops over relations (both directions).
   * Dedups nodes + edges; caps total nodes at `limit`.
   * 从 `id` 出发做 `depth` 跳的双向 BFS；去重节点与边；节点总数封顶 `limit`。
   */
  async function expand(id, { depth = 1, limit = 100 } = {}) {
    const nodes = new Map();      // id -> briefNode
    const edges = new Map();      // "subj|pred|obj" -> edge
    const visited = new Set();    // ids whose edges we've already walked

    const root = await entities.get(id);
    if (root) nodes.set(root.id, briefNode(root));

    let frontier = [id];
    for (let hop = 0; hop < depth; hop++) {
      const next = [];
      for (const cur of frontier) {
        if (visited.has(cur)) continue;
        visited.add(cur);
        const touching = await relations.neighbors(cur);
        for (const r of touching) {
          const key = `${r.subject_id}|${r.predicate}|${r.object_id}`;
          if (!edges.has(key)) {
            edges.set(key, {
              subject_id: r.subject_id,
              predicate: r.predicate,
              object_id: r.object_id,
              weight: r.weight,
            });
          }
          for (const other of [r.subject_id, r.object_id]) {
            if (other === cur) continue;
            if (!nodes.has(other)) {
              if (nodes.size >= limit) continue; // cap total nodes / 节点封顶
              const e = await entities.get(other);
              if (e) nodes.set(other, briefNode(e));
            }
            if (nodes.has(other) && !visited.has(other)) next.push(other);
          }
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }

    // Drop edges whose endpoints were excluded by the node cap, so the returned
    // subgraph is consistent (no edges to nodes that aren't present).
    // 丢弃因节点封顶而缺失端点的边，保证子图自洽（不出现指向缺失节点的边）。
    const present = nodes;
    const edgeList = Array.from(edges.values()).filter(
      (e) => present.has(e.subject_id) && present.has(e.object_id)
    );

    return {
      root: id,
      nodes: Array.from(nodes.values()),
      edges: edgeList,
    };
  }

  /**
   * Materialize similarity edges between entities of `type` that share
   * tags ∪ topics. For each pair with sharedCount >= minShared, upsert ONE
   * canonical edge (subject = min(id), object = max(id)) carrying weight =
   * sharedCount and data:{ shared:[...] }. neighbors/expand already treat it as
   * bidirectional (via from + toward).
   *
   * 在共享 标签∪话题 的同类实体间物化相似度边。对每个 sharedCount >= minShared 的
   * 配对，按规范方向（subject=较小 id，object=较大 id）upsert 一条边，
   * weight = sharedCount，data.shared 记录共享项。
   */
  async function buildSimilarityEdges({
    type = 'knowledge_item',
    predicate = 'related_to',
    minShared = 2,
    family_id,
  } = {}) {
    const list = await entities.list({ type, family_id, limit: 1000 });
    let pairs = 0;
    let created = 0;

    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const aSet = new Set([...(a.tags || []), ...(a.topics || [])]);
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        const shared = [];
        const bSet = new Set([...(b.tags || []), ...(b.topics || [])]);
        for (const t of aSet) if (bSet.has(t)) shared.push(t);
        if (shared.length < minShared) continue;
        pairs++;
        // canonical direction so the edge is stable regardless of list order
        // 规范方向，确保边与遍历顺序无关
        const subj = a.id < b.id ? a.id : b.id;
        const obj = a.id < b.id ? b.id : a.id;
        await relations.link(subj, predicate, obj, {
          weight: shared.length,
          data: { shared },
          family_id: family_id || null,
        });
        created++;
      }
    }
    return { pairs, created };
  }

  /**
   * Optional helper: a tag-scoped subgraph — nodes are entities carrying `tag`,
   * edges are the relations that run among those nodes.
   * 可选辅助：按标签取子图 — 节点为带该 `tag` 的实体，边为这些节点之间的关系。
   */
  async function subgraphByTag(tag, { limit = 100 } = {}) {
    const list = await entities.list({ tag, limit });
    const ids = new Set(list.map((e) => e.id));
    const nodes = list.map(briefNode);
    const edges = new Map();
    for (const e of list) {
      const touching = await relations.from(e.id);
      for (const r of touching) {
        if (!ids.has(r.object_id)) continue;
        const key = `${r.subject_id}|${r.predicate}|${r.object_id}`;
        edges.set(key, {
          subject_id: r.subject_id,
          predicate: r.predicate,
          object_id: r.object_id,
          weight: r.weight,
        });
      }
    }
    return { tag, nodes, edges: Array.from(edges.values()) };
  }

  return { briefNode, neighbors, expand, buildSimilarityEdges, subgraphByTag };
};
