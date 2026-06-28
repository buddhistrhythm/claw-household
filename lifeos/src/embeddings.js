'use strict';

/**
 * embeddings.js — deterministic, offline, dependency-free text embedder.
 *                 确定性、离线、零依赖的文本嵌入器。
 *
 * APPROACH / 思路
 * ----------------
 * We need *meaningful* cosine similarity for shared vocabulary without any API
 * key or model download, so dev/CI are fully reproducible. The local embedder is
 * a hashed bag-of-words ("feature hashing" / the hashing trick):
 *   1. tokenize: lowercase, split on non-alphanumeric; CJK is split per-char so
 *      Chinese text yields per-character tokens (matches lifeos's `simple` FTS).
 *   2. hash each token (FNV-1a) into one of DIM=256 buckets, accumulate counts.
 *   3. L2-normalize → a unit vector. Cosine similarity then reflects how much
 *      vocabulary two texts share (shared tokens collide into the same buckets).
 * This is reproducible and gives real signal for retrieval, while staying a
 * drop-in shape (256 floats) for a real model later.
 *
 * 我们需要在无 API key / 无模型下载的前提下，对共享词汇给出「有意义」的余弦
 * 相似度，从而让开发/CI 完全可复现。本地嵌入器即「哈希词袋」（hashing trick）：
 * 分词（小写 + 非字母数字切分，CJK 按字切）→ 用 FNV-1a 把每个 token 散列进
 * 256 个桶并累加 → L2 归一化得到单位向量。共享 token 会落入相同的桶，故余弦
 * 相似度反映两段文本的词汇重叠程度。形状固定 256 维，便于日后替换真实模型。
 *
 * SWAPPING IN A REAL PROVIDER / 接入真实供应商
 * --------------------------------------------
 * `provider()` reads env `LIFEOS_EMBED_PROVIDER` (default 'local'). To add e.g.
 * OpenAI: branch in `embed()` on the provider, call the API, then project /
 * normalize the returned vector to DIM (256) via `projectTo256` so the column
 * type and HNSW index never change. Only the local provider is implemented now.
 * `provider()` 读取环境变量 `LIFEOS_EMBED_PROVIDER`（默认 'local'）。要接入如
 * OpenAI：在 `embed()` 内按 provider 分支调用 API，再用 `projectTo256` 把返回
 * 向量投影/归一化到 256 维，列类型与 HNSW 索引即可保持不变。当前仅实现 local。
 */

const DIM = 256;

/** Fixed embedding dimension. / 固定嵌入维度。 */
function dim() {
  return DIM;
}

/** Active provider name. / 当前供应商名。 */
function provider() {
  return process.env.LIFEOS_EMBED_PROVIDER || 'local';
}

/**
 * Tokenize: lowercase, split Latin runs on non-alphanumeric, split CJK per-char.
 * 分词：小写；拉丁按非字母数字切；CJK 按单字切。
 */
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const tokens = [];
  // Match either a run of [a-z0-9_] OR a single CJK-ish char.
  // 匹配「一段拉丁数字」或「单个 CJK 字符」。
  const re = /[a-z0-9_]+|[㐀-鿿豈-﫿぀-ヿ가-힯]/g;
  let m;
  while ((m = re.exec(s)) !== null) tokens.push(m[0]);
  return tokens;
}

/** FNV-1a 32-bit hash of a string. / 字符串的 FNV-1a 32 位哈希。 */
function fnv1a(str) {
  let h = 0x811c9dc5; // offset basis
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619, kept in 32-bit unsigned via Math.imul + >>> 0
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** L2-normalize a Float64Array in place; returns a plain Array. / L2 归一化。 */
function l2normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  const out = new Array(vec.length);
  if (norm === 0) {
    // Empty / no-vocab text → zero vector (cosine undefined; callers may skip).
    // 空文本 → 零向量（余弦无定义，调用方可跳过）。
    for (let i = 0; i < vec.length; i++) out[i] = 0;
    return out;
  }
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/**
 * Project an arbitrary-length numeric vector down to DIM via additive bucketing,
 * then L2-normalize. Used to keep a real provider's output at 256 dims.
 * 把任意长度向量按加性分桶投影到 DIM 维并归一化（用于真实供应商的输出对齐）。
 */
function projectTo256(arr) {
  const buckets = new Float64Array(DIM);
  for (let i = 0; i < arr.length; i++) buckets[i % DIM] += arr[i];
  return l2normalize(buckets);
}

/**
 * embed(text) -> Array<number> length 256 (a unit vector). Deterministic.
 * embed(text) -> 长度 256 的单位向量数组，确定性。
 */
function embed(text) {
  if (provider() !== 'local') {
    // Only the local provider is implemented; real providers slot in here.
    // 目前仅实现 local；真实供应商在此分支接入。
    throw new Error(`embeddings: provider "${provider()}" not implemented`);
  }
  const buckets = new Float64Array(DIM);
  for (const tok of tokenize(text)) {
    buckets[fnv1a(tok) % DIM] += 1;
  }
  return l2normalize(buckets);
}

/**
 * toSqlVector(arr) -> '[f1,f2,...]' literal accepted by pgvector's text input.
 * toSqlVector(arr) -> pgvector 文本输入接受的 '[f1,f2,...]' 字面量。
 */
function toSqlVector(arr) {
  return '[' + Array.from(arr, (x) => (Number.isFinite(x) ? x : 0)).join(',') + ']';
}

module.exports = { embed, dim, toSqlVector, provider, projectTo256, tokenize };
