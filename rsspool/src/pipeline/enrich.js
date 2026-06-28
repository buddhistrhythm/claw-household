'use strict';

/**
 * enrich.js — lightweight, offline tagging.
 *
 * Derives topic tags from title + content via a keyword map. This is the seam
 * where an LLM-based enricher (summaries, embeddings, richer topics) would slot
 * in later; keeping it deterministic means ingestion needs no API key.
 */

const KEYWORDS = {
  ai: [/\bai\b/i, /artificial intelligence/i, /\bml\b/i, /machine learning/i, /神经网络/],
  llm: [/\bllm\b/i, /large language model/i, /\bgpt\b/i, /claude/i, /transformer/i, /大模型/],
  rag: [/\brag\b/i, /retrieval[- ]augmented/i, /vector (db|database|search)/i, /embedding/i],
  agents: [/\bagent(s|ic)?\b/i, /tool use/i, /mcp\b/i],
  rust: [/\brust\b/i, /\bcargo\b/i],
  golang: [/\bgo(lang)?\b/i, /goroutine/i],
  python: [/\bpython\b/i, /\bpytorch\b/i, /\bnumpy\b/i],
  database: [/database/i, /postgres/i, /\bsql\b/i, /sqlite/i, /数据库/],
  distributed: [/distributed/i, /kafka/i, /consensus/i, /raft\b/i, /微服务/],
  infra: [/kubernetes/i, /\bk8s\b/i, /docker/i, /infrastructure/i, /devops/i],
  performance: [/performance/i, /latency/i, /throughput/i, /optimi[sz]e/i, /性能/],
  security: [/security/i, /\bcve\b/i, /vulnerab/i, /encryption/i, /安全/],
  startup: [/startup/i, /founder/i, /\byc\b/i, /fundrais/i, /创业/],
  design: [/design/i, /\bux\b/i, /\bui\b/i, /设计/],
  frontend: [/react|vue|svelte/i, /frontend/i, /css\b/i, /前端/],
};

function deriveTags(item) {
  const hay = `${item.title}\n${item.content}`;
  const tags = new Set(item.tags || []);
  for (const [tag, patterns] of Object.entries(KEYWORDS)) {
    if (patterns.some((re) => re.test(hay))) tags.add(tag);
  }
  return [...tags];
}

module.exports = { deriveTags, KEYWORDS };
