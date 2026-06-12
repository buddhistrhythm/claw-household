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

-- Resilient: if pgvector can't be installed (no superuser / not packaged), the
-- core schema (001) still migrates and the semantic layer self-disables via
-- semantic.isEnabled(). The embedding column/index are only added when the
-- `vector` type actually exists.
-- 健壮性：若无法安装 pgvector（非超级用户/未打包），核心表(001)照样迁移，语义层
-- 经 semantic.isEnabled() 自动关闭；仅当 vector 类型存在时才加嵌入列与索引。
DO $$
BEGIN
  BEGIN
    -- WITH SCHEMA public 是必须的：否则扩展会装进 search_path 首位的（测试）schema，
    -- 并在 DROP SCHEMA ... CASCADE 时被连带删除。
    -- WITH SCHEMA public is load-bearing: without it the extension installs into
    -- the first schema on search_path (a throwaway test schema) and gets dropped
    -- with it on DROP SCHEMA ... CASCADE.
    CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'lifeos: pgvector unavailable (%); semantic layer disabled', SQLERRM;
  END;

  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') THEN
    EXECUTE 'ALTER TABLE entities ADD COLUMN IF NOT EXISTS embedding public.vector(256)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_entities_embedding ON entities USING hnsw (embedding public.vector_cosine_ops)';
  END IF;
END $$;
