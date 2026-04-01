/**
 * db.js — SQLite database layer with hybrid EAV model
 *
 * Hybrid design:
 *   - Relational tables for users / families / invites (fixed schema, fast auth)
 *   - EAV tables for domain data (inventory, baby, meals, etc.) — Notion-like flexibility
 *
 * Usage:
 *   const { getDb, eav } = require('./lib/db');
 *   const db = getDb();
 *   eav.upsertEntity(db, familyId, 'inventory_item', id, { name: '牛奶', category: 'dairy' });
 *   const items = eav.listEntities(db, familyId, 'inventory_item', { where: { status: 'in_stock' } });
 */

const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.env.HOUSEHOLD_DB_PATH || path.join(__dirname, "../../data/household.db");

let _db = null;

function getDb() {
  if (_db) return _db;
  const fs = require("fs");
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  migrate(_db);
  return _db;
}

/* ─── Schema migration ────────────────────────────────────────────────────── */

function migrate(db) {
  db.exec(`
    -- ═══ Auth & multi-user ═══════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      name          TEXT NOT NULL DEFAULT '',
      avatar_url    TEXT DEFAULT '',
      provider      TEXT NOT NULL DEFAULT 'google',   -- 'google' | 'apple'
      provider_sub  TEXT NOT NULL DEFAULT '',          -- provider user id
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS families (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL DEFAULT '我的家庭',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS family_members (
      family_id     TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role          TEXT NOT NULL DEFAULT 'member',    -- 'admin' | 'member'
      joined_at     TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (family_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS invites (
      id            TEXT PRIMARY KEY,
      family_id     TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      created_by    TEXT NOT NULL REFERENCES users(id),
      code          TEXT UNIQUE NOT NULL,
      max_uses      INTEGER NOT NULL DEFAULT 1,
      used_count    INTEGER NOT NULL DEFAULT 0,
      expires_at    TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token         TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      family_id     TEXT REFERENCES families(id),
      expires_at    TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══ EAV core (Notion-like flexible schema) ═════════════════════════════

    -- Property definitions — defines available "columns" per entity type
    CREATE TABLE IF NOT EXISTS prop_defs (
      id            TEXT PRIMARY KEY,                -- e.g. 'inventory_item.name'
      entity_type   TEXT NOT NULL,
      prop_name     TEXT NOT NULL,
      data_type     TEXT NOT NULL DEFAULT 'text',    -- text, number, boolean, date, json, relation
      label         TEXT NOT NULL DEFAULT '',         -- display label (Chinese)
      sort_order    INTEGER NOT NULL DEFAULT 0,
      config        TEXT DEFAULT '{}',               -- JSON: options, constraints, etc.
      UNIQUE(entity_type, prop_name)
    );

    -- Entities — one row per "page" (Notion analogy)
    CREATE TABLE IF NOT EXISTS entities (
      id            TEXT PRIMARY KEY,
      entity_type   TEXT NOT NULL,
      family_id     TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      created_by    TEXT REFERENCES users(id),
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      archived      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_entities_family_type
      ON entities(family_id, entity_type, archived);

    -- Values — the EAV "cells"
    CREATE TABLE IF NOT EXISTS entity_values (
      entity_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      prop_name     TEXT NOT NULL,
      val_text      TEXT,
      val_number    REAL,
      PRIMARY KEY (entity_id, prop_name)
    );
    CREATE INDEX IF NOT EXISTS idx_ev_prop ON entity_values(prop_name, val_text);
    CREATE INDEX IF NOT EXISTS idx_ev_num  ON entity_values(prop_name, val_number);

    -- ═══ Preferences (family-scoped key-value) ══════════════════════════════

    CREATE TABLE IF NOT EXISTS preferences (
      family_id     TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      key           TEXT NOT NULL,
      value         TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (family_id, key)
    );
  `);

  // Seed default prop_defs if empty
  const count = db.prepare("SELECT COUNT(*) as c FROM prop_defs").get().c;
  if (count === 0) seedPropDefs(db);
}

/* ─── Seed property definitions ───────────────────────────────────────────── */

function seedPropDefs(db) {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO prop_defs(id, entity_type, prop_name, data_type, label, sort_order, config) VALUES(?,?,?,?,?,?,?)"
  );
  const seed = db.transaction((defs) => {
    for (const d of defs) {
      insert.run(
        `${d.entity_type}.${d.prop_name}`,
        d.entity_type, d.prop_name, d.data_type || "text",
        d.label || d.prop_name, d.sort_order || 0, JSON.stringify(d.config || {})
      );
    }
  });

  seed([
    // ─── Inventory item ───
    { entity_type: "inventory_item", prop_name: "barcode", data_type: "text", label: "条码", sort_order: 1 },
    { entity_type: "inventory_item", prop_name: "name", data_type: "text", label: "名称", sort_order: 2 },
    { entity_type: "inventory_item", prop_name: "brand", data_type: "text", label: "品牌", sort_order: 3 },
    { entity_type: "inventory_item", prop_name: "category", data_type: "text", label: "品类", sort_order: 4 },
    { entity_type: "inventory_item", prop_name: "location", data_type: "text", label: "存放位置", sort_order: 5 },
    { entity_type: "inventory_item", prop_name: "purchase_date", data_type: "date", label: "购入日期", sort_order: 6 },
    { entity_type: "inventory_item", prop_name: "expiry_date", data_type: "date", label: "过期日期", sort_order: 7 },
    { entity_type: "inventory_item", prop_name: "quantity", data_type: "number", label: "数量", sort_order: 8 },
    { entity_type: "inventory_item", prop_name: "unit", data_type: "text", label: "单位", sort_order: 9 },
    { entity_type: "inventory_item", prop_name: "unit_price", data_type: "number", label: "单价", sort_order: 10 },
    { entity_type: "inventory_item", prop_name: "sources", data_type: "json", label: "购买渠道", sort_order: 11 },
    { entity_type: "inventory_item", prop_name: "tags", data_type: "json", label: "标签", sort_order: 12 },
    { entity_type: "inventory_item", prop_name: "icon", data_type: "text", label: "图标", sort_order: 13 },
    { entity_type: "inventory_item", prop_name: "restock_needed", data_type: "boolean", label: "需补货", sort_order: 14 },
    { entity_type: "inventory_item", prop_name: "frequent_restock", data_type: "boolean", label: "常购", sort_order: 15 },
    { entity_type: "inventory_item", prop_name: "restock_lead_days", data_type: "number", label: "提前补货天数", sort_order: 16 },
    { entity_type: "inventory_item", prop_name: "priority", data_type: "text", label: "优先级", sort_order: 17 },
    { entity_type: "inventory_item", prop_name: "notes", data_type: "text", label: "备注", sort_order: 18 },
    { entity_type: "inventory_item", prop_name: "comments", data_type: "json", label: "留言", sort_order: 19 },
    { entity_type: "inventory_item", prop_name: "status", data_type: "text", label: "状态", sort_order: 20, config: { options: ["in_stock", "consumed"] } },
    { entity_type: "inventory_item", prop_name: "consumption_log", data_type: "json", label: "消耗记录", sort_order: 21 },
    { entity_type: "inventory_item", prop_name: "batches", data_type: "json", label: "批次", sort_order: 22 },
    { entity_type: "inventory_item", prop_name: "diaper_spec", data_type: "json", label: "尿裤规格", sort_order: 23 },
    { entity_type: "inventory_item", prop_name: "ready_to_feed_spec", data_type: "json", label: "水奶规格", sort_order: 24 },
    { entity_type: "inventory_item", prop_name: "unit_spec", data_type: "json", label: "包装规格", sort_order: 25 },
    { entity_type: "inventory_item", prop_name: "encrypted_vault", data_type: "text", label: "加密", sort_order: 99 },

    // ─── Baby event ───
    { entity_type: "baby_event", prop_name: "event_type", data_type: "text", label: "类型", sort_order: 1, config: { options: ["feeding_bottle","feeding_nursing","feeding_solid","diaper","sleep","growth","milestone","bath","medicine","doctor_visit"] } },
    { entity_type: "baby_event", prop_name: "time", data_type: "date", label: "时间", sort_order: 2 },
    { entity_type: "baby_event", prop_name: "baby_id", data_type: "text", label: "宝宝", sort_order: 3 },
    { entity_type: "baby_event", prop_name: "data", data_type: "json", label: "详情", sort_order: 4 },

    // ─── Meal ingredient ───
    { entity_type: "meal_ingredient", prop_name: "name", data_type: "text", label: "食材名", sort_order: 1 },
    { entity_type: "meal_ingredient", prop_name: "unit_default", data_type: "text", label: "默认单位", sort_order: 2 },
    { entity_type: "meal_ingredient", prop_name: "tags", data_type: "json", label: "标签", sort_order: 3 },

    // ─── Meal dish (recipe) ───
    { entity_type: "meal_dish", prop_name: "name", data_type: "text", label: "菜名", sort_order: 1 },
    { entity_type: "meal_dish", prop_name: "ingredient_refs", data_type: "json", label: "用料", sort_order: 2 },
    { entity_type: "meal_dish", prop_name: "steps", data_type: "text", label: "做法", sort_order: 3 },
    { entity_type: "meal_dish", prop_name: "favorite", data_type: "boolean", label: "收藏", sort_order: 4 },
    { entity_type: "meal_dish", prop_name: "notes", data_type: "text", label: "备注", sort_order: 5 },

    // ─── Meal record ───
    { entity_type: "meal_record", prop_name: "date", data_type: "date", label: "日期", sort_order: 1 },
    { entity_type: "meal_record", prop_name: "slot", data_type: "text", label: "餐次", sort_order: 2, config: { options: ["breakfast","lunch","dinner","snack"] } },
    { entity_type: "meal_record", prop_name: "dish_ids", data_type: "json", label: "菜品", sort_order: 3 },
    { entity_type: "meal_record", prop_name: "notes", data_type: "text", label: "备注", sort_order: 4 },
    { entity_type: "meal_record", prop_name: "liked", data_type: "boolean", label: "好评", sort_order: 5 },

    // ─── Consumption history ───
    { entity_type: "consumption_record", prop_name: "item_id", data_type: "relation", label: "库存项", sort_order: 1 },
    { entity_type: "consumption_record", prop_name: "item_name", data_type: "text", label: "名称", sort_order: 2 },
    { entity_type: "consumption_record", prop_name: "category", data_type: "text", label: "品类", sort_order: 3 },
    { entity_type: "consumption_record", prop_name: "date", data_type: "date", label: "日期", sort_order: 4 },
    { entity_type: "consumption_record", prop_name: "qty", data_type: "number", label: "数量", sort_order: 5 },
    { entity_type: "consumption_record", prop_name: "unit", data_type: "text", label: "单位", sort_order: 6 },
    { entity_type: "consumption_record", prop_name: "note", data_type: "text", label: "备注", sort_order: 7 },

    // ─── Vehicle ───
    { entity_type: "vehicle", prop_name: "name", data_type: "text", label: "名称", sort_order: 1 },
    { entity_type: "vehicle", prop_name: "plate", data_type: "text", label: "车牌", sort_order: 2 },
    { entity_type: "vehicle", prop_name: "schedule", data_type: "json", label: "保养计划", sort_order: 3 },
  ]);
}

/* ─── EAV query helpers ───────────────────────────────────────────────────── */

const eav = {
  /**
   * Upsert an entity with its property values.
   * @param {Database} db
   * @param {string} familyId
   * @param {string} entityType
   * @param {string} id
   * @param {object} props - { propName: value, ... }
   * @param {string} [createdBy] - user id
   * @returns {string} entity id
   */
  upsertEntity(db, familyId, entityType, id, props, createdBy) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO entities(id, entity_type, family_id, created_by, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
    `).run(id, entityType, familyId, createdBy || null, now, now);

    const upsertVal = db.prepare(`
      INSERT INTO entity_values(entity_id, prop_name, val_text, val_number)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(entity_id, prop_name) DO UPDATE SET
        val_text = excluded.val_text,
        val_number = excluded.val_number
    `);

    const batch = db.transaction((entries) => {
      for (const [k, v] of entries) {
        if (v === undefined) continue;
        const { text, num } = encodeValue(v);
        upsertVal.run(id, k, text, num);
      }
    });
    batch(Object.entries(props));
    return id;
  },

  /**
   * Get a single entity with all its properties as a flat object.
   */
  getEntity(db, id) {
    const ent = db.prepare("SELECT * FROM entities WHERE id = ? AND archived = 0").get(id);
    if (!ent) return null;
    const rows = db.prepare("SELECT prop_name, val_text, val_number FROM entity_values WHERE entity_id = ?").all(id);
    const obj = { id: ent.id, _type: ent.entity_type, _family_id: ent.family_id, _created_at: ent.created_at, _updated_at: ent.updated_at };
    for (const r of rows) {
      obj[r.prop_name] = decodeValue(r);
    }
    return obj;
  },

  /**
   * List entities of a type within a family.
   * @param {object} opts - { where: { prop: val }, orderBy: 'prop', desc: true, limit: N, archived: false }
   */
  listEntities(db, familyId, entityType, opts = {}) {
    const archived = opts.archived ? 1 : 0;

    // Build SQL parts with params in correct positional order
    // JOIN params come first in SQL, then WHERE params, then ORDER params
    const joinParts = [];  // SQL fragments
    const joinParams = []; // params for JOINs (prop_name placeholders)
    const whereParts = ["e.family_id = ?", "e.entity_type = ?", "e.archived = ?"];
    const whereParams = [familyId, entityType, archived];

    if (opts.where) {
      let i = 0;
      for (const [prop, val] of Object.entries(opts.where)) {
        if (val === undefined) continue;
        const a = `v${i++}`;
        joinParts.push(`JOIN entity_values ${a} ON ${a}.entity_id = e.id AND ${a}.prop_name = ?`);
        joinParams.push(prop);
        if (typeof val === "number") {
          whereParts.push(`${a}.val_number = ?`);
          whereParams.push(val);
        } else {
          whereParts.push(`${a}.val_text = ?`);
          whereParams.push(String(val));
        }
      }
    }

    let orderJoin = "";
    const orderJoinParams = [];
    let orderClause = "ORDER BY e.created_at DESC";
    if (opts.orderBy) {
      const oa = "v_order";
      orderJoin = ` LEFT JOIN entity_values ${oa} ON ${oa}.entity_id = e.id AND ${oa}.prop_name = ?`;
      orderJoinParams.push(opts.orderBy);
      const col = opts.orderByType === "number" ? `${oa}.val_number` : `${oa}.val_text`;
      orderClause = `ORDER BY ${col} ${opts.desc ? "DESC" : "ASC"}`;
    }

    let sql = "SELECT DISTINCT e.id FROM entities e";
    sql += " " + joinParts.join(" ");
    sql += orderJoin;
    sql += " WHERE " + whereParts.join(" AND ");
    sql += " " + orderClause;

    // Params order must match SQL ? order: joinParams, orderJoinParams, whereParams
    const params = [...joinParams, ...orderJoinParams, ...whereParams];

    if (opts.limit) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }

    const ids = db.prepare(sql).all(...params).map((r) => r.id);
    return ids.map((id) => eav.getEntity(db, id)).filter(Boolean);
  },

  /**
   * Delete (archive) an entity.
   */
  archiveEntity(db, id) {
    db.prepare("UPDATE entities SET archived = 1, updated_at = datetime('now') WHERE id = ?").run(id);
  },

  /**
   * Hard delete an entity and all its values.
   */
  deleteEntity(db, id) {
    db.prepare("DELETE FROM entity_values WHERE entity_id = ?").run(id);
    db.prepare("DELETE FROM entities WHERE id = ?").run(id);
  },

  /**
   * Update specific properties of an entity.
   */
  patchEntity(db, id, props) {
    db.prepare("UPDATE entities SET updated_at = datetime('now') WHERE id = ?").run(id);
    const upsertVal = db.prepare(`
      INSERT INTO entity_values(entity_id, prop_name, val_text, val_number)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(entity_id, prop_name) DO UPDATE SET
        val_text = excluded.val_text,
        val_number = excluded.val_number
    `);
    const batch = db.transaction((entries) => {
      for (const [k, v] of entries) {
        if (v === undefined) continue;
        const { text, num } = encodeValue(v);
        upsertVal.run(id, k, text, num);
      }
    });
    batch(Object.entries(props));
  },

  /**
   * Count entities of a type in a family.
   */
  countEntities(db, familyId, entityType, where) {
    const joinParts = [];
    const joinParams = [];
    const whereParts = ["e.family_id = ?", "e.entity_type = ?", "e.archived = 0"];
    const whereParams = [familyId, entityType];
    if (where) {
      let i = 0;
      for (const [prop, val] of Object.entries(where)) {
        if (val === undefined) continue;
        const a = `v${i++}`;
        joinParts.push(`JOIN entity_values ${a} ON ${a}.entity_id = e.id AND ${a}.prop_name = ?`);
        joinParams.push(prop);
        if (typeof val === "number") { whereParts.push(`${a}.val_number = ?`); whereParams.push(val); }
        else { whereParts.push(`${a}.val_text = ?`); whereParams.push(String(val)); }
      }
    }
    const sql = "SELECT COUNT(DISTINCT e.id) as c FROM entities e " + joinParts.join(" ") + " WHERE " + whereParts.join(" AND ");
    return db.prepare(sql).get(...joinParams, ...whereParams).c;
  },

  /**
   * List prop_defs for an entity type (Notion-like "database columns").
   */
  getPropDefs(db, entityType) {
    return db.prepare(
      "SELECT * FROM prop_defs WHERE entity_type = ? ORDER BY sort_order"
    ).all(entityType);
  },

  /**
   * Add/update a property definition.
   */
  upsertPropDef(db, entityType, propName, opts = {}) {
    const id = `${entityType}.${propName}`;
    db.prepare(`
      INSERT INTO prop_defs(id, entity_type, prop_name, data_type, label, sort_order, config)
      VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        data_type = excluded.data_type,
        label = excluded.label,
        sort_order = excluded.sort_order,
        config = excluded.config
    `).run(id, entityType, propName, opts.data_type || "text", opts.label || propName, opts.sort_order || 0, JSON.stringify(opts.config || {}));
  },
};

/* ─── EAV value encoding ──────────────────────────────────────────────────── */

function encodeValue(v) {
  if (v === null || v === undefined) return { text: null, num: null };
  if (typeof v === "number") return { text: String(v), num: v };
  if (typeof v === "boolean") return encodeBoolean(v);
  if (typeof v === "object") return { text: JSON.stringify(v), num: null };
  // String "true"/"false" → keep as-is (will decode as string)
  return { text: String(v), num: parseFloat(v) || null };
}

function decodeValue(row) {
  const t = row.val_text;
  if (t === null) return null;
  // Boolean (encoded as "true"/"false")
  if (t === "true") return true;
  if (t === "false") return false;
  // JSON (arrays, objects)
  if ((t.startsWith("[") || t.startsWith("{")) && t.length > 1) {
    try { return JSON.parse(t); } catch {}
  }
  // Number (if val_number is set and text representation matches)
  if (row.val_number !== null && String(row.val_number) === t) return row.val_number;
  return t;
}

/** Encode a boolean explicitly as JSON so it round-trips correctly */
function encodeBoolean(v) {
  // Stored as val_text "true"/"false" so they don't collide with numbers 0/1
  return { text: v ? "true" : "false", num: v ? 1 : 0 };
}

/* ─── Preference helpers (family-scoped) ──────────────────────────────────── */

const prefs = {
  get(db, familyId, key) {
    const row = db.prepare("SELECT value FROM preferences WHERE family_id = ? AND key = ?").get(familyId, key);
    if (!row) return undefined;
    try { return JSON.parse(row.value); } catch { return row.value; }
  },

  set(db, familyId, key, value) {
    const v = typeof value === "string" ? value : JSON.stringify(value);
    db.prepare(`
      INSERT INTO preferences(family_id, key, value) VALUES(?, ?, ?)
      ON CONFLICT(family_id, key) DO UPDATE SET value = excluded.value
    `).run(familyId, key, v);
  },

  getAll(db, familyId) {
    const rows = db.prepare("SELECT key, value FROM preferences WHERE family_id = ?").all(familyId);
    const obj = {};
    for (const r of rows) {
      try { obj[r.key] = JSON.parse(r.value); } catch { obj[r.key] = r.value; }
    }
    return obj;
  },

  setMany(db, familyId, kvPairs) {
    const stmt = db.prepare(`
      INSERT INTO preferences(family_id, key, value) VALUES(?, ?, ?)
      ON CONFLICT(family_id, key) DO UPDATE SET value = excluded.value
    `);
    const batch = db.transaction((pairs) => {
      for (const [k, v] of pairs) {
        const val = typeof v === "string" ? v : JSON.stringify(v);
        stmt.run(familyId, k, val);
      }
    });
    batch(kvPairs);
  },
};

/* ─── User / family helpers ───────────────────────────────────────────────── */

const users = {
  findByProviderSub(db, provider, sub) {
    return db.prepare("SELECT * FROM users WHERE provider = ? AND provider_sub = ?").get(provider, sub);
  },

  findByEmail(db, email) {
    return db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  },

  findById(db, id) {
    return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  },

  upsertFromOAuth(db, { provider, sub, email, name, avatarUrl }) {
    const id = `usr_${provider}_${sub}`;
    db.prepare(`
      INSERT INTO users(id, email, name, avatar_url, provider, provider_sub)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        name = excluded.name,
        avatar_url = excluded.avatar_url,
        updated_at = datetime('now')
    `).run(id, email, name || "", avatarUrl || "", provider, sub);
    return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  },

  getFamilies(db, userId) {
    return db.prepare(`
      SELECT f.*, fm.role FROM families f
      JOIN family_members fm ON fm.family_id = f.id
      WHERE fm.user_id = ?
      ORDER BY f.created_at
    `).all(userId);
  },
};

const families = {
  create(db, name, adminUserId) {
    const crypto = require("crypto");
    const id = `fam_${crypto.randomBytes(6).toString("hex")}`;
    db.prepare("INSERT INTO families(id, name) VALUES(?, ?)").run(id, name || "我的家庭");
    db.prepare("INSERT INTO family_members(family_id, user_id, role) VALUES(?, ?, 'admin')").run(id, adminUserId);
    return db.prepare("SELECT * FROM families WHERE id = ?").get(id);
  },

  getMembers(db, familyId) {
    return db.prepare(`
      SELECT u.id, u.email, u.name, u.avatar_url, fm.role, fm.joined_at
      FROM users u JOIN family_members fm ON fm.user_id = u.id
      WHERE fm.family_id = ?
      ORDER BY fm.joined_at
    `).all(familyId);
  },

  isAdmin(db, familyId, userId) {
    const row = db.prepare(
      "SELECT role FROM family_members WHERE family_id = ? AND user_id = ?"
    ).get(familyId, userId);
    return row?.role === "admin";
  },

  isMember(db, familyId, userId) {
    return !!db.prepare(
      "SELECT 1 FROM family_members WHERE family_id = ? AND user_id = ?"
    ).get(familyId, userId);
  },

  removeMember(db, familyId, userId) {
    db.prepare("DELETE FROM family_members WHERE family_id = ? AND user_id = ?").run(familyId, userId);
  },

  setRole(db, familyId, userId, role) {
    db.prepare("UPDATE family_members SET role = ? WHERE family_id = ? AND user_id = ?").run(role, familyId, userId);
  },
};

const invites = {
  create(db, familyId, createdBy, { maxUses = 1, expiresInHours = 72 } = {}) {
    const crypto = require("crypto");
    const id = `inv_${crypto.randomBytes(6).toString("hex")}`;
    const code = crypto.randomBytes(4).toString("hex").toUpperCase();
    const expiresAt = new Date(Date.now() + expiresInHours * 3600_000).toISOString();
    db.prepare(`
      INSERT INTO invites(id, family_id, created_by, code, max_uses, expires_at)
      VALUES(?, ?, ?, ?, ?, ?)
    `).run(id, familyId, createdBy, code, maxUses, expiresAt);
    return db.prepare("SELECT * FROM invites WHERE id = ?").get(id);
  },

  redeem(db, code, userId) {
    const inv = db.prepare("SELECT * FROM invites WHERE code = ?").get(code);
    if (!inv) return { ok: false, error: "邀请码无效" };
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) return { ok: false, error: "邀请码已过期" };
    if (inv.used_count >= inv.max_uses) return { ok: false, error: "邀请码已用完" };
    const already = db.prepare(
      "SELECT 1 FROM family_members WHERE family_id = ? AND user_id = ?"
    ).get(inv.family_id, userId);
    if (already) return { ok: false, error: "你已是该家庭成员" };
    db.prepare("INSERT INTO family_members(family_id, user_id, role) VALUES(?, ?, 'member')").run(inv.family_id, userId);
    db.prepare("UPDATE invites SET used_count = used_count + 1 WHERE id = ?").run(inv.id);
    return { ok: true, familyId: inv.family_id };
  },
};

module.exports = { getDb, eav, prefs, users, families, invites, DB_PATH };
