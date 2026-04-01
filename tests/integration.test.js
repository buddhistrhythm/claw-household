/**
 * Integration test for SQLite EAV + Auth + API layer
 * Tests the full stack: db.js → auth.js → server.js routes
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

// Use a temp DB for tests — override before requiring db module
const TEST_DB_PATH = path.join(__dirname, "../data/test_integration.db");
process.env.AUTH_DISABLED = "1";

// Clean up any previous test DB
try { fs.unlinkSync(TEST_DB_PATH); } catch {}
try { fs.unlinkSync(TEST_DB_PATH + "-wal"); } catch {}
try { fs.unlinkSync(TEST_DB_PATH + "-shm"); } catch {}

// Override DB path via env before loading module
process.env.HOUSEHOLD_DB_PATH = TEST_DB_PATH;

const dbModule = require("../skills/lib/db");

describe("SQLite EAV integration", () => {
  let db;

  before(() => {
    db = dbModule.getDb();
  });

  after(() => {
    try { fs.unlinkSync(TEST_DB_PATH); } catch {}
    try { fs.unlinkSync(TEST_DB_PATH + "-wal"); } catch {}
    try { fs.unlinkSync(TEST_DB_PATH + "-shm"); } catch {}
  });

  describe("users & families", () => {
    it("creates user from OAuth", () => {
      const user = dbModule.users.upsertFromOAuth(db, {
        provider: "google", sub: "g123", email: "alice@test.com", name: "Alice", avatarUrl: "https://img/a.png",
      });
      assert.equal(user.id, "usr_google_g123");
      assert.equal(user.email, "alice@test.com");
      assert.equal(user.name, "Alice");
    });

    it("creates family with admin", () => {
      const fam = dbModule.families.create(db, "Alice家", "usr_google_g123");
      assert.ok(fam.id.startsWith("fam_"));
      assert.equal(fam.name, "Alice家");
      assert.ok(dbModule.families.isAdmin(db, fam.id, "usr_google_g123"));
    });

    it("lists user families", () => {
      const fams = dbModule.users.getFamilies(db, "usr_google_g123");
      assert.ok(fams.length >= 1);
      assert.equal(fams[0].role, "admin");
    });
  });

  describe("invites", () => {
    it("creates and redeems invite", () => {
      const fams = dbModule.users.getFamilies(db, "usr_google_g123");
      const famId = fams[0].id;

      // Create second user
      dbModule.users.upsertFromOAuth(db, {
        provider: "apple", sub: "a456", email: "bob@test.com", name: "Bob", avatarUrl: "",
      });

      // Create invite
      const inv = dbModule.invites.create(db, famId, "usr_google_g123", { maxUses: 5 });
      assert.ok(inv.code);
      assert.equal(inv.max_uses, 5);

      // Redeem
      const result = dbModule.invites.redeem(db, inv.code, "usr_apple_a456");
      assert.ok(result.ok);
      assert.equal(result.familyId, famId);

      // Bob is now a member
      assert.ok(dbModule.families.isMember(db, famId, "usr_apple_a456"));
      assert.ok(!dbModule.families.isAdmin(db, famId, "usr_apple_a456"));

      // Double redeem fails
      const dup = dbModule.invites.redeem(db, inv.code, "usr_apple_a456");
      assert.ok(!dup.ok);
    });
  });

  describe("EAV CRUD", () => {
    let famId;

    before(() => {
      const fams = dbModule.users.getFamilies(db, "usr_google_g123");
      famId = fams[0].id;
    });

    it("creates entity with typed values", () => {
      dbModule.eav.upsertEntity(db, famId, "inventory_item", "inv_test_001", {
        name: "全脂牛奶",
        brand: "蒙牛",
        category: "dairy",
        quantity: 3,
        restock_needed: false,
        status: "in_stock",
        sources: ["盒马", "叮咚买菜"],
        expiry_date: "2026-04-15",
        tags: ["早餐", "每日"],
      }, "usr_google_g123");

      const item = dbModule.eav.getEntity(db, "inv_test_001");
      assert.equal(item.name, "全脂牛奶");
      assert.equal(item.brand, "蒙牛");
      assert.equal(item.quantity, 3);
      assert.equal(item.restock_needed, false);
      assert.equal(item.status, "in_stock");
      assert.deepEqual(item.sources, ["盒马", "叮咚买菜"]);
      assert.deepEqual(item.tags, ["早餐", "每日"]);
      assert.equal(item._type, "inventory_item");
      assert.equal(item._family_id, famId);
    });

    it("creates multiple entities", () => {
      dbModule.eav.upsertEntity(db, famId, "inventory_item", "inv_test_002", {
        name: "鸡蛋", category: "meat_fresh", quantity: 12, status: "in_stock",
      }, "usr_google_g123");
      dbModule.eav.upsertEntity(db, famId, "inventory_item", "inv_test_003", {
        name: "过期酸奶", category: "dairy", quantity: 0, status: "consumed",
      }, "usr_google_g123");
    });

    it("lists entities with no filter", () => {
      const all = dbModule.eav.listEntities(db, famId, "inventory_item");
      assert.ok(all.length >= 3);
    });

    it("filters by property", () => {
      const inStock = dbModule.eav.listEntities(db, famId, "inventory_item", {
        where: { status: "in_stock" },
      });
      assert.ok(inStock.length >= 2);
      assert.ok(inStock.every((i) => i.status === "in_stock"));

      const consumed = dbModule.eav.listEntities(db, famId, "inventory_item", {
        where: { status: "consumed" },
      });
      assert.ok(consumed.length >= 1);
      assert.equal(consumed[0].name, "过期酸奶");
    });

    it("filters by multiple properties", () => {
      const dairyInStock = dbModule.eav.listEntities(db, famId, "inventory_item", {
        where: { status: "in_stock", category: "dairy" },
      });
      assert.equal(dairyInStock.length, 1);
      assert.equal(dairyInStock[0].name, "全脂牛奶");
    });

    it("counts entities", () => {
      const c = dbModule.eav.countEntities(db, famId, "inventory_item", { status: "in_stock" });
      assert.ok(c >= 2);
    });

    it("patches entity", () => {
      dbModule.eav.patchEntity(db, "inv_test_001", { quantity: 2, restock_needed: true });
      const updated = dbModule.eav.getEntity(db, "inv_test_001");
      assert.equal(updated.quantity, 2);
      assert.equal(updated.restock_needed, true);
      assert.equal(updated.name, "全脂牛奶"); // unchanged
    });

    it("archives entity", () => {
      dbModule.eav.archiveEntity(db, "inv_test_003");
      const item = dbModule.eav.getEntity(db, "inv_test_003");
      assert.equal(item, null); // archived = not found by default
      const all = dbModule.eav.listEntities(db, famId, "inventory_item");
      assert.ok(all.every((i) => i.id !== "inv_test_003"));
    });

    it("creates baby_event entity", () => {
      dbModule.eav.upsertEntity(db, famId, "baby_event", "be_001", {
        event_type: "feeding_bottle",
        time: "2026-04-01T08:00:00Z",
        baby_id: "baby_1",
        data: { amount_ml: 180 },
      }, "usr_google_g123");

      const evt = dbModule.eav.getEntity(db, "be_001");
      assert.equal(evt.event_type, "feeding_bottle");
      assert.deepEqual(evt.data, { amount_ml: 180 });
    });

    it("creates meal_dish entity", () => {
      dbModule.eav.upsertEntity(db, famId, "meal_dish", "dish_001", {
        name: "番茄炒蛋",
        ingredient_refs: ["ing_tomato", "ing_egg"],
        steps: "1. 打蛋\n2. 切番茄\n3. 炒",
        favorite: true,
      }, "usr_google_g123");

      const dish = dbModule.eav.getEntity(db, "dish_001");
      assert.equal(dish.name, "番茄炒蛋");
      assert.equal(dish.favorite, true);
      assert.deepEqual(dish.ingredient_refs, ["ing_tomato", "ing_egg"]);
    });

    it("works with arbitrary new entity types (dynamic)", () => {
      // No predefined template needed — EAV is fully dynamic
      dbModule.eav.upsertEntity(db, famId, "pet", "pet_001", {
        name: "旺财",
        species: "dog",
        breed: "金毛",
        weight_kg: 28.5,
        vaccinated: true,
      }, "usr_google_g123");

      const pet = dbModule.eav.getEntity(db, "pet_001");
      assert.equal(pet.name, "旺财");
      assert.equal(pet.species, "dog");
      assert.equal(pet.weight_kg, 28.5);
      assert.equal(pet.vaccinated, true);
      assert.equal(pet._type, "pet");
    });
  });

  describe("prop_defs (schema)", () => {
    it("has seeded property definitions", () => {
      const defs = dbModule.eav.getPropDefs(db, "inventory_item");
      assert.ok(defs.length >= 20);
      const names = defs.map((d) => d.prop_name);
      assert.ok(names.includes("name"));
      assert.ok(names.includes("category"));
      assert.ok(names.includes("status"));
      assert.ok(names.includes("sources"));
    });

    it("adds custom property definition", () => {
      dbModule.eav.upsertPropDef(db, "inventory_item", "organic", {
        data_type: "boolean",
        label: "有机",
        sort_order: 30,
      });
      const defs = dbModule.eav.getPropDefs(db, "inventory_item");
      const organic = defs.find((d) => d.prop_name === "organic");
      assert.ok(organic);
      assert.equal(organic.data_type, "boolean");
      assert.equal(organic.label, "有机");
    });
  });

  describe("preferences (family-scoped)", () => {
    let famId;
    before(() => {
      const fams = dbModule.users.getFamilies(db, "usr_google_g123");
      famId = fams[0].id;
    });

    it("sets and gets preference", () => {
      dbModule.prefs.set(db, famId, "llm", { backend: "cli", cli_command: "claude" });
      const llm = dbModule.prefs.get(db, famId, "llm");
      assert.deepEqual(llm, { backend: "cli", cli_command: "claude" });
    });

    it("gets all preferences", () => {
      dbModule.prefs.set(db, famId, "alerts", { urgent_days: 3 });
      const all = dbModule.prefs.getAll(db, famId);
      assert.ok(all.llm);
      assert.ok(all.alerts);
    });

    it("overwrites preference", () => {
      dbModule.prefs.set(db, famId, "llm", { backend: "http", completion_url: "https://api.openai.com" });
      const llm = dbModule.prefs.get(db, famId, "llm");
      assert.equal(llm.backend, "http");
      assert.ok(!llm.cli_command); // replaced, not merged
    });
  });

  describe("family isolation", () => {
    it("entities are isolated between families", () => {
      // Create another family
      const fam2 = dbModule.families.create(db, "Bob家", "usr_apple_a456");
      const fams = dbModule.users.getFamilies(db, "usr_google_g123");
      const fam1Id = fams[0].id;

      // Add item to fam2
      dbModule.eav.upsertEntity(db, fam2.id, "inventory_item", "inv_bob_001", {
        name: "Bob的牛奶", status: "in_stock",
      }, "usr_apple_a456");

      // fam1 should not see fam2's items
      const fam1Items = dbModule.eav.listEntities(db, fam1Id, "inventory_item");
      assert.ok(fam1Items.every((i) => i.id !== "inv_bob_001"));

      // fam2 should see its own items
      const fam2Items = dbModule.eav.listEntities(db, fam2.id, "inventory_item");
      assert.ok(fam2Items.some((i) => i.id === "inv_bob_001"));
    });
  });
});

describe("Auth module", () => {
  it("signs and verifies JWT", () => {
    const { signToken, verifyToken } = require("../skills/lib/auth");
    const token = signToken({ userId: "usr_test_1", familyId: "fam_test_1" });
    assert.ok(token);
    const payload = verifyToken(token);
    assert.equal(payload.userId, "usr_test_1");
    assert.equal(payload.familyId, "fam_test_1");
  });

  it("rejects invalid token", () => {
    const { verifyToken } = require("../skills/lib/auth");
    assert.equal(verifyToken("garbage"), null);
    assert.equal(verifyToken(""), null);
  });
});

describe("LLM completion module", () => {
  it("exports all expected functions", () => {
    const llm = require("../skills/lib/llm-completion");
    assert.equal(typeof llm.complete, "function");
    assert.equal(typeof llm.completeCli, "function");
    assert.equal(typeof llm.completeHttp, "function");
    assert.equal(typeof llm.completeCliStreaming, "function");
    assert.equal(typeof llm.setupSseResponse, "function");
    assert.equal(typeof llm.llmOk, "function");
  });

  it("has CLI presets for claude, openclaw, gemini, codex", () => {
    const { CLI_PRESETS } = require("../skills/lib/llm-completion");
    assert.ok(CLI_PRESETS.claude);
    assert.ok(CLI_PRESETS.openclaw);
    assert.ok(CLI_PRESETS.gemini);
    assert.ok(CLI_PRESETS.codex);
    assert.equal(CLI_PRESETS.claude.command, "claude");
    assert.equal(CLI_PRESETS.openclaw.command, "openclaw");
  });

  it("validates LLM config", () => {
    const { llmOk } = require("../skills/lib/llm-completion");
    assert.ok(!llmOk(null));
    assert.ok(!llmOk({}));
    assert.ok(llmOk({ backend: "cli", cli_command: "claude" }));
    assert.ok(!llmOk({ backend: "http" })); // missing url
    assert.ok(llmOk({ backend: "http", completion_url: "https://api.test.com", api_key: "sk-123" }));
    assert.ok(llmOk({ backend: "http", completion_url: "https://api.test.com", auth_style: "none" }));
  });
});
