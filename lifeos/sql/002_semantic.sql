-- lifeos semantic layer — pgvector embeddings for hybrid (FTS + vector) search.
-- lifeos 语义层 —— 为「全文 + 向量」混合检索增加 pgvector 嵌入列。
--
-- Idempotent: migrate() runs every sql/*.sql in order against the active schema,
-- including throwaway test schemas. The `vector` extension is database-global
-- (lives in `public`); we reference the type/opclass with the public-qualified
-- name so it resolves even when search_path is schema-only.
-- 幂等：migrate() 会按序对当前 schema（含测试用临时 schema）执行所有 sql。
-- `vector` 扩展是库级（建在 public）；用 public 限定名引用类型/算子类，
-- 这样即便 search_path 只含本 schema 也能解析。
--
-- NOTE (prod): CREATE EXTENSION requires superuser (or a role granted CREATE on
-- the database) the *first* time. Once installed it is a no-op. 生产注意：首次
-- 安装扩展需超级用户权限；已安装后此语句为空操作。

CREATE EXTENSION IF NOT EXISTS vector;

-- 256-dim embedding column (see src/embeddings.js for the fixed dimension).
-- 256 维嵌入列（固定维度，见 src/embeddings.js）。
ALTER TABLE entities ADD COLUMN IF NOT EXISTS embedding public.vector(256);

-- HNSW index for cosine distance — no training data needed (pgvector >= 0.5).
-- 余弦距离的 HNSW 索引 —— 无需训练数据。
CREATE INDEX IF NOT EXISTS idx_entities_embedding
  ON entities USING hnsw (embedding public.vector_cosine_ops);
