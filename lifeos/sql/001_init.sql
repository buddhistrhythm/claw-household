-- lifeos canonical schema (Postgres) — "document + relations" core.
-- Run with search_path already pointing at the target schema (see src/db.js).
-- All statements are idempotent so migrate() can run repeatedly.

-- ─── entity_types: template registry (Notion-like, per-domain) ────────────────
CREATE TABLE IF NOT EXISTS entity_types (
  type        TEXT PRIMARY KEY,
  domain      TEXT NOT NULL DEFAULT 'general',
  label       TEXT NOT NULL DEFAULT '',
  icon        TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  schema      JSONB NOT NULL DEFAULT '{}',     -- field definitions for UI/validation
  builtin     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── entities: the polymorphic node (one row per "thing") ─────────────────────
CREATE TABLE IF NOT EXISTS entities (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  family_id   TEXT,
  created_by  TEXT,
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  summary     TEXT NOT NULL DEFAULT '',
  status      TEXT,
  tags        TEXT[] NOT NULL DEFAULT '{}',
  topics      TEXT[] NOT NULL DEFAULT '{}',
  data        JSONB NOT NULL DEFAULT '{}',      -- domain-specific fields
  source      TEXT,                             -- 'manual' | 'rss' | 'barcode' | ...
  source_ref  TEXT,                             -- external id / url
  occurred_at TIMESTAMPTZ,                      -- domain event time (txn/applied date)
  archived    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  search      tsvector GENERATED ALWAYS AS (
                to_tsvector('simple',
                  coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(body,''))
              ) STORED
);
CREATE INDEX IF NOT EXISTS idx_entities_type     ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_family   ON entities(family_id);
CREATE INDEX IF NOT EXISTS idx_entities_status   ON entities(type, status);
CREATE INDEX IF NOT EXISTS idx_entities_occurred ON entities(occurred_at);
CREATE INDEX IF NOT EXISTS idx_entities_tags     ON entities USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_entities_data     ON entities USING GIN(data jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_entities_search   ON entities USING GIN(search);

-- ─── relations: first-class edges (subject -predicate-> object) ───────────────
CREATE TABLE IF NOT EXISTS relations (
  id          TEXT PRIMARY KEY,
  family_id   TEXT,
  subject_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate   TEXT NOT NULL,
  object_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  weight      REAL NOT NULL DEFAULT 1,
  data        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subject_id, predicate, object_id)
);
CREATE INDEX IF NOT EXISTS idx_rel_subject   ON relations(subject_id, predicate);
CREATE INDEX IF NOT EXISTS idx_rel_object    ON relations(object_id, predicate);
CREATE INDEX IF NOT EXISTS idx_rel_predicate ON relations(predicate);
