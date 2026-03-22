'use strict';

const https = require('https');
const { PATHS, readJSON, writeJSON, today, formatLocalDate, daysUntil, generateId } = require('./data');
const { predict } = require('../predict');
const { encryptSecret, decryptSecret, encryptionEnabled, stripVaultForClient } = require('../crypto-vault');

// ─── Constants ────────────────────────────────────────────────────────────────

/** 宝宝相关品类：预测补货时始终进入补货 Tab（无需勾选「常买」） */
const BABY_AUTO_RESTOCK_CATEGORIES = new Set([
  "diaper", "formula", "rtf", "ready_to_feed", "baby_food", "baby_snack", "wipes",
]);

// ─── Category / Restock helpers ───────────────────────────────────────────────

function isBabyAutoRestockCategory(cat) {
  return BABY_AUTO_RESTOCK_CATEGORIES.has(cat);
}

/**
 * 补货 Tab 展示规则：
 *  - 手动「需补货」始终出现；
 *  - 预测类：仅「常买食材」或宝宝品类才自动出现；其余需右滑标记需补货或从做菜待买加入。
 */
function shouldShowInRestockTab(item, prediction) {
  if (item.restock_needed) return true;
  if (!prediction || prediction.mode === "none") return false;
  if (isBabyAutoRestockCategory(item.category)) return true;
  
  if (item.frequent_restock === true) {
    if (item.quantity <= 0) return true;
    const lead = item.restock_lead_days || 7;
    if (prediction.days_until_empty != null && prediction.days_until_empty <= lead) {
      return true;
    }
  }
  
  if (prediction.restock_urgency === "normal") return false;
  return false;
}

/** 将 Open Food Facts categories_tags 映射为内部品类 key */
/** Keyword rules for category inference — used by both mapCategory (barcode tags) and inferCategory (item name). */
const CATEGORY_RULES = [
  { cat: "dairy",         en: ["dairy", "milk", "cheese", "yogurt", "butter", "cream"],
                          zh: ["乳", "牛奶", "酸奶", "奶酪", "黄油", "芝士", "鲜奶", "纯奶"] },
  { cat: "meat_fresh",    en: ["meat", "beef", "pork", "chicken", "lamb", "steak", "sausage"],
                          zh: ["肉", "牛排", "猪", "鸡", "羊", "香肠", "培根"] },
  { cat: "meat_frozen",   en: ["frozen meat", "frozen beef", "frozen pork", "frozen chicken"],
                          zh: ["冻肉", "冷冻肉", "冻鸡", "冻虾", "冻鱼"] },
  { cat: "vegetable",     en: ["vegetable", "lettuce", "tomato", "potato", "onion", "carrot", "broccoli", "spinach", "celery", "cabbage"],
                          zh: ["蔬菜", "菜", "番茄", "西红柿", "土豆", "洋葱", "胡萝卜", "西兰花", "菠菜", "芹菜", "白菜", "生菜", "黄瓜", "茄子", "青椒", "豆角", "豆芽", "蘑菇", "葱", "姜", "蒜"] },
  { cat: "fruit",         en: ["fruit", "apple", "banana", "orange", "grape", "strawberry", "blueberry", "mango", "watermelon", "pear", "peach", "cherry", "lemon", "avocado", "kiwi"],
                          zh: ["水果", "苹果", "香蕉", "橙", "葡萄", "草莓", "蓝莓", "芒果", "西瓜", "梨", "桃", "樱桃", "柠檬", "牛油果", "猕猴桃", "哈密瓜", "荔枝", "龙眼"] },
  { cat: "grain",         en: ["cereal", "grain", "rice", "flour", "pasta", "noodle", "oat", "bread"],
                          zh: ["粮", "米", "面", "面粉", "面条", "意面", "燕麦", "面包", "馒头", "饺子皮", "年糕"] },
  { cat: "snack",         en: ["snack", "chips", "cookie", "cracker", "candy", "chocolate", "popcorn", "nuts"],
                          zh: ["零食", "薯片", "饼干", "糖", "巧克力", "坚果", "爆米花", "果冻", "瓜子", "话梅"] },
  { cat: "beverage",      en: ["beverage", "drink", "juice", "soda", "water", "tea", "coffee", "beer", "wine", "sparkling"],
                          zh: ["饮料", "果汁", "可乐", "茶", "咖啡", "矿泉水", "气泡水", "啤酒", "葡萄酒", "豆浆"] },
  { cat: "condiment",     en: ["condiment", "sauce", "oil", "vinegar", "salt", "sugar", "pepper", "ketchup", "mayonnaise", "mustard", "soy sauce", "sesame oil"],
                          zh: ["调味", "酱油", "醋", "盐", "糖", "胡椒", "番茄酱", "蚝油", "料酒", "香油", "花椒", "辣椒", "味精", "鸡精", "豆瓣酱", "老干妈", "橄榄油", "食用油"] },
  { cat: "diaper",        en: ["diaper", "nappy"],
                          zh: ["尿", "纸尿裤", "尿不湿", "拉拉裤"] },
  { cat: "formula",       en: ["formula", "baby formula"],
                          zh: ["奶粉", "配方奶"] },
  { cat: "rtf",           en: ["rtf", "ready-to-feed", "ready to feed"],
                          zh: ["水奶", "液态奶", "即饮奶"] },
  { cat: "baby_food",     en: ["baby food", "puree"],
                          zh: ["辅食", "米糊", "果泥", "肉泥"] },
  { cat: "baby_snack",    en: ["baby snack", "baby puff", "teething"],
                          zh: ["宝宝零食", "溶豆", "磨牙棒", "米饼"] },
  { cat: "wipes",         en: ["wipes", "wet wipes"],
                          zh: ["湿巾", "棉柔巾", "干巾"] },
  { cat: "personal_care", en: ["shampoo", "soap", "toothpaste", "lotion", "sunscreen", "deodorant"],
                          zh: ["洗发水", "沐浴露", "牙膏", "护肤", "防晒", "洗面奶", "面膜"] },
  { cat: "cleaning",      en: ["cleaner", "detergent", "bleach", "disinfectant", "trash bag"],
                          zh: ["清洁", "洗衣液", "洗洁精", "消毒", "垃圾袋", "抹布", "拖把"] },
  { cat: "medicine",      en: ["medicine", "vitamin", "supplement", "tylenol", "ibuprofen", "bandage"],
                          zh: ["药", "维生素", "保健品", "创可贴", "退烧", "感冒", "止痛"] },
];

/**
 * Infer category from item name (local keyword matching).
 * Returns category code or null if no match.
 */
function inferCategory(name) {
  if (!name) return null;
  const s = String(name).toLowerCase();
  for (const rule of CATEGORY_RULES) {
    for (const kw of rule.zh) {
      if (s.includes(kw)) return rule.cat;
    }
    for (const kw of rule.en) {
      if (s.includes(kw)) return rule.cat;
    }
  }
  return null;
}

function mapCategory(tags = []) {
  const s = tags.join(",").toLowerCase();
  for (const rule of CATEGORY_RULES) {
    for (const kw of rule.en) {
      if (s.includes(kw)) return rule.cat;
    }
    for (const kw of rule.zh) {
      if (s.includes(kw)) return rule.cat;
    }
  }
  if (s.includes("medicine") || s.includes("药")) return "medicine";
  return "other";
}

// ─── Normalize helpers ────────────────────────────────────────────────────────

function normalizeSources(input) {
  if (input == null) return [];
  const arr = Array.isArray(input) ? input : typeof input === "string" ? [input] : [];
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const s = String(raw ?? "").trim().slice(0, 64);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function itemSourcesRow(item) {
  const fromArr = normalizeSources(item?.sources);
  if (fromArr.length) return fromArr;
  if (item?.source != null && String(item.source).trim()) {
    return [String(item.source).trim().slice(0, 64)];
  }
  return [];
}

function normalizeIcon(v) {
  if (v == null || v === "") return null;
  const t = String(v).trim();
  if (!t) return null;
  return [...t].slice(0, 8).join("");
}

function normalizePriority(v) {
  if (v == null || v === "") return null;
  const s = String(v).toLowerCase();
  if (["low", "medium", "high"].includes(s)) return s;
  return null;
}

function normalizeComments(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((c) => c && typeof c.text === "string" && String(c.text).trim())
    .map((c) => ({
      at: typeof c.at === "string" && c.at ? c.at : new Date().toISOString(),
      text: String(c.text).trim().slice(0, 2000),
    }))
    .slice(0, 200);
}

function normalizeDiaperSpec(body) {
  if (!body || body.category !== "diaper") return null;
  const ds = body.diaper_spec;
  if (!ds || typeof ds !== "object") return null;
  const spec = {
    segment_code: ds.segment_code || null,
    segment_label: ds.segment_label || ds.segment_code || null,
    weight_min_kg: ds.weight_min_kg != null ? parseFloat(ds.weight_min_kg) : null,
    weight_max_kg: ds.weight_max_kg != null ? parseFloat(ds.weight_max_kg) : null,
    sales_unit: ds.sales_unit || "箱",
    pieces_per_box: ds.pieces_per_box != null ? parseInt(ds.pieces_per_box, 10) : null,
    spec_label: ds.spec_label || null,
  };
  if (spec.weight_min_kg == null || spec.weight_max_kg == null) return null;
  return spec;
}

const RTF_FORMAT_GRAMS = { small_2oz: 59, large_32oz: 946 };

function normalizeReadyToFeedSpec(body) {
  const cat = body?.category;
  if (!body || (cat !== "rtf" && cat !== "ready_to_feed" && cat !== "water_milk")) return null;
  const ws = body.ready_to_feed_spec || body.water_milk_spec;
  if (!ws || typeof ws !== "object") return null;
  const fmt = ws.bottle_format === "large_32oz" ? "large_32oz" : "small_2oz";
  const stageN = ws.stage != null ? parseInt(ws.stage, 10) : 1;
  const stage = stageN === 2 ? 2 : 1;
  const bpc = ws.bottles_per_case != null ? parseInt(ws.bottles_per_case, 10) : null;

  // grams_per_bottle：用户填 > 0 则用，否则从标准格式推算（2oz≈59g, 32oz≈946g）
  let grams = ws.grams_per_bottle != null ? parseFloat(ws.grams_per_bottle) : NaN;
  if (!Number.isFinite(grams) || grams <= 0) {
    grams = RTF_FORMAT_GRAMS[fmt] ?? null;
  }
  if (!grams) return null;   // 格式也没有则拒绝

  const mlRaw = ws.ml_per_bottle != null ? parseFloat(ws.ml_per_bottle) : NaN;
  const mlPerBottle = Number.isFinite(mlRaw) && mlRaw > 0 ? mlRaw : grams;
  const specLabel =
    ws.spec_label != null && String(ws.spec_label).trim()
      ? String(ws.spec_label).trim().slice(0, 200)
      : `${stage}段 · ${fmt === "large_32oz" ? "32oz" : "2oz"} · ${grams}g/瓶`;
  return {
    stage,
    grams_per_bottle: grams,
    ml_per_bottle: mlPerBottle,
    bottles_per_case: Number.isFinite(bpc) && bpc > 0 ? bpc : null,
    bottle_format: fmt,
    spec_label: specLabel,
  };
}

// ─── unit_spec (SKU/SPU) ──────────────────────────────────────────────────────

/**
 * Normalize a unit_spec from user input.
 * @param {object|null|undefined} raw - { sku_unit, spu_unit, spu_qty, spu_label }
 * @returns {object|null}
 */
function normalizeUnitSpec(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const skuUnit = raw.sku_unit != null ? String(raw.sku_unit).trim().slice(0, 20) : null;
  const spuUnit = raw.spu_unit != null ? String(raw.spu_unit).trim().slice(0, 20) : null;
  const spuQty  = raw.spu_qty != null ? parseInt(raw.spu_qty, 10) : null;
  if (!skuUnit || !spuUnit) return null;  // at minimum need units
  const spec = { sku_unit: skuUnit, spu_unit: spuUnit };
  if (Number.isFinite(spuQty) && spuQty > 0) {
    spec.spu_qty = spuQty;
    spec.spu_label = raw.spu_label
      ? String(raw.spu_label).trim().slice(0, 60)
      : `${spuQty}${skuUnit}/${spuUnit}`;
  } else {
    spec.spu_qty = null;
    spec.spu_label = null;
  }
  return spec;
}

/**
 * Parse natural language packaging description into unit_spec.
 * Handles: "一箱24瓶" "每包48片" "24瓶/箱" "12罐一提" etc.
 * Returns null if no pattern matched (caller can fallback to LLM).
 * @param {string} text
 * @returns {{ sku_unit:string, spu_unit:string, spu_qty:number }|null}
 */
function parseUnitSpecNL(text) {
  if (!text || !text.trim()) return null;
  const t = text.trim();
  const skus = ['瓶', '罐', '片', '包', '盒', '袋', '个', '粒', '支', '条', '块', '抽', '只', '枚', '件', '张', '本', '卷', '套'];
  const spus = ['箱', '提', '桶', '组', '套', '包', '盒', '袋', '排'];
  const uP = skus.join('|');
  const cP = spus.join('|');
  // "24瓶/箱"  "24瓶每箱"  "24瓶一箱"
  let m = t.match(new RegExp(`(\\d+)(${uP})[/／每一]?(${cP})`));
  if (m) return normalizeUnitSpec({ spu_unit: m[3], spu_qty: parseInt(m[1]), sku_unit: m[2] });
  // "一箱24瓶"  "每箱24瓶"  "箱装24瓶"
  m = t.match(new RegExp(`(?:一|每|每个)?(${cP})\\s*(\\d+)(${uP})`));
  if (m) return normalizeUnitSpec({ spu_unit: m[1], spu_qty: parseInt(m[2]), sku_unit: m[3] });
  // "1箱=24瓶"
  m = t.match(new RegExp(`1(${cP})\\s*[=＝]\\s*(\\d+)(${uP})`));
  if (m) return normalizeUnitSpec({ spu_unit: m[1], spu_qty: parseInt(m[2]), sku_unit: m[3] });
  return null;
}

/**
 * Resolve unit_spec for an item, with backward-compat fallback from
 * diaper_spec.pieces_per_box and ready_to_feed_spec.bottles_per_case.
 * @param {object} item - inventory item
 * @returns {object|null} - { sku_unit, spu_unit, spu_qty, spu_label } or null
 */
function resolveUnitSpec(item) {
  // 1. Prefer explicit unit_spec
  if (item.unit_spec && typeof item.unit_spec === 'object' && item.unit_spec.sku_unit) {
    return item.unit_spec;
  }
  // 2. Fallback: diaper_spec
  const ds = item.diaper_spec;
  if (ds && ds.pieces_per_box && ds.pieces_per_box > 0) {
    return {
      sku_unit: '片',
      spu_unit: ds.sales_unit || '箱',
      spu_qty: ds.pieces_per_box,
      spu_label: `${ds.pieces_per_box}片/${ds.sales_unit || '箱'}`,
    };
  }
  // 3. Fallback: ready_to_feed_spec
  const ws = item.ready_to_feed_spec || item.water_milk_spec;
  if (ws && ws.bottles_per_case && ws.bottles_per_case > 0) {
    return {
      sku_unit: '瓶',
      spu_unit: '箱',
      spu_qty: ws.bottles_per_case,
      spu_label: `${ws.bottles_per_case}瓶/箱`,
    };
  }
  return null;
}

/**
 * Compute SPU info for display (how many SPU-equivalent from current quantity).
 * @param {object} item
 * @returns {object|null} - { sku_unit, spu_unit, spu_qty, spu_label, spu_count, spu_display }
 */
function computeSpuInfo(item) {
  const spec = resolveUnitSpec(item);
  if (!spec || !spec.spu_qty || spec.spu_qty <= 0) return spec ? { ...spec, spu_count: null, spu_display: null } : null;
  const qty = item.quantity || 0;
  const spuCount = parseFloat((qty / spec.spu_qty).toFixed(2));
  return {
    ...spec,
    spu_count: spuCount,
    spu_display: `${qty}${spec.sku_unit} ≈ ${spuCount}${spec.spu_unit}`,
  };
}

function normalizeIngredientToken(s) {
  return String(s || "").replace(/\s+/g, "").toLowerCase();
}

// ─── Manual import recent ─────────────────────────────────────────────────────

function pushManualRecent(snapshot) {
  let data = { version: "1.0", entries: [] };
  try { data = readJSON(PATHS.MANUAL_IMPORT_RECENT); } catch {}
  const entry = {
    id: `mr_${Date.now()}`,
    at: new Date().toISOString(),
    ...snapshot,
  };
  const key = `${entry.name}|${entry.brand || ""}|${entry.category}|${entry.barcode || ""}`;
  data.entries = (data.entries || []).filter(
    (e) => `${e.name}|${e.brand || ""}|${e.category}|${e.barcode || ""}` !== key
  );
  data.entries.unshift(entry);
  data.entries = data.entries.slice(0, 10);
  writeJSON(PATHS.MANUAL_IMPORT_RECENT, data);
}

// ─── Baby track helpers ───────────────────────────────────────────────────────

function readBabyLog() {
  return readJSON(PATHS.BABY_LOG, { version: "1.0", events: [], baby: null });
}

/** 将宝宝日志与纸尿裤/奶粉库存项关联（多 SKU 时需在 preferences.baby.track_item_ids 指定） */
function resolveBabyTrackItems(inv, prefs) {
  const cfg = prefs.baby?.track_item_ids || {};
  const diapers = inv.items.filter((i) => i.category === "diaper" && i.status === "in_stock");
  const formulas = inv.items.filter((i) => i.category === "formula" && i.status === "in_stock");
  const readyToFeedItems = inv.items.filter(
    (i) => (i.category === "rtf" || i.category === "ready_to_feed" || i.category === "water_milk") && i.status === "in_stock"
  );
  return {
    diaper: cfg.diaper || (diapers.length === 1 ? diapers[0].id : null),
    formula: cfg.formula || (formulas.length === 1 ? formulas[0].id : null),
    ready_to_feed:
      cfg.rtf ||
      cfg.ready_to_feed ||
      cfg.water_milk ||
      (readyToFeedItems.length === 1 ? readyToFeedItems[0].id : null),
  };
}

function prefsWithBabyTrack(inv, prefs) {
  const resolved = resolveBabyTrackItems(inv, prefs);
  return {
    ...prefs,
    baby: {
      ...(prefs.baby || {}),
      _resolved_track: resolved,
    },
  };
}

// ─── CRUD operations ──────────────────────────────────────────────────────────

/**
 * List inventory items with optional filters.
 * @param {{ location?: string, status?: string, expiring?: string|number }} opts
 * @returns {Array}
 */
function listItems({ location, status, expiring } = {}) {
  const inv        = readJSON(PATHS.INVENTORY);
  const categories = readJSON(PATHS.CATEGORIES);
  const prefs      = readJSON(PATHS.PREFERENCES);
  const consumption = readJSON(PATHS.CONSUMPTION, { version: "1.0", records: [] });
  const babyLog    = readBabyLog();
  const babyEvents = babyLog.events || [];
  const prefsTracked = prefsWithBabyTrack(inv, prefs);

  let items = inv.items;
  if (status)   items = items.filter((i) => i.status === status);
  if (location) items = items.filter((i) => i.location.includes(location));
  if (expiring) {
    const days = parseInt(expiring);
    items = items.filter((i) => i.status === "in_stock" && daysUntil(i.expiry_date) <= days);
  }

  return items.map((i) => {
    const row = {
      ...stripVaultForClient(i),
      sources:        itemSourcesRow(i),
      days_left:      daysUntil(i.expiry_date),
      category_label: categories[i.category]?.label || i.category,
      prediction:     predict(i, consumption.records, prefsTracked, babyEvents),
    };
    const spuInfo = computeSpuInfo(i);
    if (spuInfo) row.spu_info = spuInfo;
    return row;
  });
}

/**
 * Add a new inventory item.
 * @param {object} body - POST body fields
 * @returns {{ item: object }}
 */
function addItem(body) {
  const {
    name,
    brand,
    barcode,
    category,
    location,
    expiry_date,
    quantity,
    unit,
    unit_price,
    source,
    sources,
    tags,
    diaper_spec,
    ready_to_feed_spec,
    water_milk_spec,
    icon,
    restock_needed,
    frequent_restock,
    restock_lead_days,
    priority,
    notes,
    comments,
    secret_plaintext,
  } = body;

  if (!name) {
    const err = new Error("商品名称不能为空");
    err.code = "VALIDATION_ERROR";
    throw err;
  }

  const categories = readJSON(PATHS.CATEGORIES);
  let catKey = category || inferCategory(name) || "other";
  if (catKey === "water_milk" || catKey === "ready_to_feed") catKey = "rtf";
  const catConfig = categories[catKey] || categories["other"];

  let srcList = normalizeSources(sources);
  if (srcList.length === 0) srcList = normalizeSources(source ? [source] : []);

  const item = {
    id: generateId(),
    barcode: barcode || null,
    name: name.trim(),
    brand: brand || null,
    category: catKey,
    location: location || catConfig.location,
    purchase_date: today(),
    expiry_date: expiry_date || (() => {
      const d = new Date();
      d.setDate(d.getDate() + catConfig.default_shelf_days);
      return formatLocalDate(d);
    })(),
    quantity: parseFloat(quantity) || 1,
    unit: unit || "个",
    unit_price: unit_price ? parseFloat(unit_price) : null,
    sources: srcList,
    tags: tags || [],
    icon: normalizeIcon(icon),
    restock_needed: restock_needed === true || restock_needed === "true",
    frequent_restock: frequent_restock === true || frequent_restock === "true",
    restock_lead_days: parseInt(restock_lead_days) || 0,
    priority: normalizePriority(priority),
    notes: notes != null && String(notes).trim() ? String(notes).trim().slice(0, 4000) : null,
    comments: normalizeComments(comments),
    status: "in_stock",
    consumption_log: [],
  };

  const norm = normalizeDiaperSpec({ category: catKey, diaper_spec });
  if (norm) item.diaper_spec = norm;

  const specInput = ready_to_feed_spec != null ? ready_to_feed_spec : water_milk_spec;
  const rtfNorm = normalizeReadyToFeedSpec({ category: catKey, ready_to_feed_spec: specInput });
  if (rtfNorm) item.ready_to_feed_spec = rtfNorm;
  if (catKey === "rtf" && !rtfNorm) {
    const err = new Error("水奶需填写规格：请选择 2oz/32oz 格式（系统自动推算克重），或手动填写一瓶多少 g");
    err.code = "VALIDATION_ERROR";
    throw err;
  }

  // unit_spec (SKU/SPU)
  const usRaw = body.unit_spec;
  const usNorm = normalizeUnitSpec(usRaw);
  if (usNorm) {
    item.unit_spec = usNorm;
  } else if (!usRaw && catConfig.unit_spec_template) {
    // Auto-populate sku_unit/spu_unit from category template (spu_qty left for user)
    item.unit_spec = { ...catConfig.unit_spec_template, spu_qty: null, spu_label: null };
  }

  if (catKey === "digital_voucher" && secret_plaintext != null && String(secret_plaintext).trim()) {
    item.encrypted_vault = encryptSecret(String(secret_plaintext));
  }

  const inv = readJSON(PATHS.INVENTORY);
  inv.items.push(item);
  inv.last_updated = today();
  writeJSON(PATHS.INVENTORY, inv);

  try {
    pushManualRecent({
      name: item.name,
      brand: item.brand,
      barcode: item.barcode,
      category: item.category,
      location: item.location,
      quantity: item.quantity,
      unit: item.unit,
      expiry_date: item.expiry_date,
      sources: item.sources || [],
      unit_price: item.unit_price,
      diaper_spec: item.diaper_spec || null,
      ready_to_feed_spec: item.ready_to_feed_spec || item.water_milk_spec || null,
      icon: item.icon,
      restock_needed: item.restock_needed,
      frequent_restock: item.frequent_restock,
      restock_lead_days: item.restock_lead_days,
      priority: item.priority,
      notes: item.notes,
    });
  } catch (e) {
    console.error("pushManualRecent", e);
  }

  return { item: stripVaultForClient(item) };
}

/**
 * Patch an existing inventory item.
 * @param {string} id
 * @param {object} patch
 * @returns {{ item: object }}
 */
function patchItem(id, patch) {
  const inv = readJSON(PATHS.INVENTORY);
  const idx = inv.items.findIndex((i) => i.id === id);
  if (idx === -1) {
    const err = new Error("物品不存在");
    err.code = "NOT_FOUND";
    throw err;
  }

  const cur = inv.items[idx];
  const next = { ...cur };

  const strFields = ["name", "brand", "location", "status", "unit"];
  for (const k of strFields) {
    if (patch[k] !== undefined) next[k] = patch[k];
  }
  if (patch.sources !== undefined) {
    next.sources = normalizeSources(patch.sources);
    delete next.source;
  } else if (patch.source !== undefined) {
    next.sources = normalizeSources([patch.source]);
    delete next.source;
  }
  if (patch.category !== undefined) {
    const categories = readJSON(PATHS.CATEGORIES);
    const ck = patch.category;
    if (categories[ck]) {
      next.category = ck;
      if (ck !== "digital_voucher") delete next.encrypted_vault;
    }
  }
  if (patch.quantity !== undefined) next.quantity = Math.max(0, parseFloat(patch.quantity) || 0);
  if (patch.unit_price !== undefined) next.unit_price = patch.unit_price === null ? null : parseFloat(patch.unit_price);
  if (patch.expiry_date !== undefined) next.expiry_date = patch.expiry_date;
  if (patch.tags !== undefined) next.tags = patch.tags;
  if (patch.barcode !== undefined) next.barcode = patch.barcode;
  if (patch.icon !== undefined) next.icon = normalizeIcon(patch.icon);
  if (patch.restock_needed !== undefined) {
    next.restock_needed = patch.restock_needed === true || patch.restock_needed === "true";
  }
  if (patch.frequent_restock !== undefined) {
    next.frequent_restock = patch.frequent_restock === true || patch.frequent_restock === "true";
  }
  if (patch.restock_lead_days !== undefined) {
    next.restock_lead_days = parseInt(patch.restock_lead_days) || 0;
  }
  if (patch.priority !== undefined) next.priority = normalizePriority(patch.priority);
  if (patch.notes !== undefined) {
    next.notes =
      patch.notes != null && String(patch.notes).trim()
        ? String(patch.notes).trim().slice(0, 4000)
        : null;
  }
  if (patch.comments !== undefined) next.comments = normalizeComments(patch.comments);

  if (patch.clear_encrypted_secret === true) {
    delete next.encrypted_vault;
  }
  if (patch.secret_plaintext !== undefined && String(patch.secret_plaintext).trim()) {
    const sp = String(patch.secret_plaintext).trim();
    if (next.category !== "digital_voucher") {
      const err = new Error("仅「礼品卡/券码」品类可保存加密内容");
      err.code = "VALIDATION_ERROR";
      throw err;
    }
    next.encrypted_vault = encryptSecret(sp);
  }

  if (patch.diaper_spec !== undefined) {
    if (patch.diaper_spec === null) {
      delete next.diaper_spec;
    } else if (next.category === "diaper") {
      const norm = normalizeDiaperSpec({ category: "diaper", diaper_spec: patch.diaper_spec });
      if (norm) next.diaper_spec = norm;
    }
  }

  if (patch.ready_to_feed_spec !== undefined || patch.water_milk_spec !== undefined) {
    const raw = patch.ready_to_feed_spec !== undefined ? patch.ready_to_feed_spec : patch.water_milk_spec;
    const catOk = next.category === "rtf" || next.category === "ready_to_feed" || next.category === "water_milk";
    if (raw === null) {
      delete next.ready_to_feed_spec;
      delete next.water_milk_spec;
    } else if (catOk) {
      const norm = normalizeReadyToFeedSpec({ category: "rtf", ready_to_feed_spec: raw });
      if (norm) {
        next.ready_to_feed_spec = norm;
        delete next.water_milk_spec;
      }
    }
  }

  // unit_spec (SKU/SPU)
  if (patch.unit_spec !== undefined) {
    if (patch.unit_spec === null) {
      delete next.unit_spec;
    } else {
      const norm = normalizeUnitSpec(patch.unit_spec);
      if (norm) next.unit_spec = norm;
    }
  }

  inv.items[idx] = next;
  inv.last_updated = today();
  writeJSON(PATHS.INVENTORY, inv);
  return { item: stripVaultForClient(next) };
}

/**
 * Record consumption of an item, decrementing its quantity.
 * @param {string} id
 * @param {number} qty
 * @param {string} [note]
 * @returns {{ item: object }}
 */
function consumeItem(id, qty, note) {
  const inv = readJSON(PATHS.INVENTORY);
  const consumption = readJSON(PATHS.CONSUMPTION, { version: "1.0", records: [] });

  const item = inv.items.find((i) => i.id === id);
  if (!item) {
    const err = new Error("物品不存在");
    err.code = "NOT_FOUND";
    throw err;
  }

  const amount = parseFloat(qty) || 1;

  // Batch-aware deduction: earliest-expiry batch first
  if (Array.isArray(item.batches) && item.batches.length > 0) {
    const sorted = [...item.batches].sort((a, b) => {
      if (!a.expiry_date) return 1;
      if (!b.expiry_date) return -1;
      return a.expiry_date.localeCompare(b.expiry_date);
    });
    let remaining = amount;
    for (const batch of sorted) {
      if (remaining <= 0) break;
      const take = Math.min(batch.qty, remaining);
      batch.qty -= take;
      remaining -= take;
    }
    // Remove empty batches
    item.batches = item.batches.filter(b => b.qty > 0);
    item.quantity = item.batches.reduce((s, b) => s + b.qty, 0);
    // Update top-level expiry to earliest remaining batch
    const withExpiry = item.batches.filter(b => b.expiry_date);
    item.expiry_date = withExpiry.length > 0
      ? withExpiry.sort((a, b) => a.expiry_date.localeCompare(b.expiry_date))[0].expiry_date
      : null;
  } else {
    item.quantity = Math.max(0, item.quantity - amount);
  }

  if (item.quantity === 0) item.status = "consumed";
  item.consumption_log.push({ date: today(), qty: amount, note: note || "" });

  consumption.records.push({
    item_id: item.id,
    item_name: item.name,
    category: item.category,
    date: today(),
    qty: amount,
    unit: item.unit,
    note: note || "",
  });

  inv.last_updated = today();
  writeJSON(PATHS.INVENTORY, inv);
  writeJSON(PATHS.CONSUMPTION, consumption);

  return { item };
}

/**
 * Add a restock batch to an existing item.
 * Migrates legacy items (no batches array) on first call.
 * @param {string} id
 * @param {number} qty
 * @param {string|null} expiryDate  YYYY-MM-DD or null
 * @param {string|null} purchaseDate  YYYY-MM-DD or null (defaults to today)
 * @returns {{ item: object }}
 */
function restockItem(id, qty, expiryDate, purchaseDate) {
  const inv = readJSON(PATHS.INVENTORY);
  const item = inv.items.find((i) => i.id === id);
  if (!item) {
    const err = new Error("物品不存在");
    err.code = "NOT_FOUND";
    throw err;
  }
  const amount = parseFloat(qty);
  if (!amount || amount <= 0) {
    const err = new Error("补货数量必须大于 0");
    err.code = "VALIDATION_ERROR";
    throw err;
  }

  // Migrate legacy item into batch model
  if (!Array.isArray(item.batches)) {
    item.batches = item.quantity > 0
      ? [{ id: generateId('batch'), qty: item.quantity, expiry_date: item.expiry_date || null, purchase_date: item.purchase_date || null }]
      : [];
  }

  const batch = {
    id: generateId('batch'),
    qty: amount,
    expiry_date: expiryDate || null,
    purchase_date: purchaseDate || today(),
  };
  item.batches.push(batch);
  item.quantity = item.batches.reduce((s, b) => s + b.qty, 0);

  // Update top-level expiry to earliest batch
  const withExpiry = item.batches.filter(b => b.expiry_date);
  if (withExpiry.length > 0) {
    item.expiry_date = withExpiry.sort((a, b) => a.expiry_date.localeCompare(b.expiry_date))[0].expiry_date;
  }
  item.status = "in_stock";

  inv.last_updated = today();
  writeJSON(PATHS.INVENTORY, inv);
  return { item: stripVaultForClient({ ...item }) };
}

/**
 * Delete an item by id.
 * @param {string} id
 * @returns {{ success: true }}
 */
function deleteItem(id) {
  const inv = readJSON(PATHS.INVENTORY);
  const idx = inv.items.findIndex((i) => i.id === id);
  if (idx === -1) {
    const err = new Error("物品不存在");
    err.code = "NOT_FOUND";
    throw err;
  }
  inv.items.splice(idx, 1);
  inv.last_updated = today();
  writeJSON(PATHS.INVENTORY, inv);
  return { success: true };
}

/**
 * Get a single enriched item.
 * @param {string} id
 * @returns {object}
 */
function getItem(id) {
  const inv = readJSON(PATHS.INVENTORY);
  const item = inv.items.find((i) => i.id === id);
  if (!item) {
    const err = new Error("物品不存在");
    err.code = "NOT_FOUND";
    throw err;
  }
  const categories = readJSON(PATHS.CATEGORIES);
  const consumption = readJSON(PATHS.CONSUMPTION, { version: "1.0", records: [] });
  const prefs = readJSON(PATHS.PREFERENCES);
  const babyLog = readBabyLog();
  const prefsTracked = prefsWithBabyTrack(inv, prefs);
  const row = stripVaultForClient({ ...item });
  const result = {
    ...row,
    sources:        itemSourcesRow(item),
    days_left:      daysUntil(item.expiry_date),
    category_label: categories[item.category]?.label || item.category,
    prediction:     predict(item, consumption.records, prefsTracked, babyLog.events || []),
  };
  const spuInfo = computeSpuInfo(item);
  if (spuInfo) result.spu_info = spuInfo;
  return result;
}

/**
 * Find purchase channels for a pending cooking ingredient by mapping it to an existing in-stock inventory item
 */
function findSourcesForPendingIngredient(inv, name) {
  if (!name || !inv || !inv.items) return [];
  const target = normalizeIngredientToken(name);
  if (!target) return [];
  
  for (const item of inv.items) {
    if (item.status === 'in_stock' && normalizeIngredientToken(item.name) === target) {
      const src = itemSourcesRow(item);
      if (src.length > 0) return src;
    }
  }
  return [];
}

/**
 * Build the restock list (in_stock items needing restock, plus pending_ingredients).
 * @returns {Array}
 */
function restockList() {
  const inv        = readJSON(PATHS.INVENTORY);
  const categories = readJSON(PATHS.CATEGORIES);
  const prefs      = readJSON(PATHS.PREFERENCES);
  const consumption = readJSON(PATHS.CONSUMPTION, { version: "1.0", records: [] });
  const babyLog    = readBabyLog();
  const babyEvents = babyLog.events || [];
  const prefsTracked = prefsWithBabyTrack(inv, prefs);

  const withPred = inv.items
    .filter((i) => i.status === "in_stock")
    .map((i) => {
      const row = {
        ...stripVaultForClient(i),
        sources:        itemSourcesRow(i),
        days_left:      daysUntil(i.expiry_date),
        category_label: categories[i.category]?.label || i.category,
        prediction:     predict(i, consumption.records, prefsTracked, babyEvents),
      };
      const spuInfo = computeSpuInfo(i);
      if (spuInfo) row.spu_info = spuInfo;
      return row;
    });

  let needRestock = withPred.filter((i) => shouldShowInRestockTab(i, i.prediction));

  const pendingRaw = prefs.shopping?.pending_ingredients;
  const pendingList = Array.isArray(pendingRaw) ? pendingRaw : [];
  for (let pi = 0; pi < pendingList.length; pi++) {
    const p = pendingList[pi];
    if (!p || !p.name) continue;
    needRestock.push({
      id: `pending_ing_${pi}_${normalizeIngredientToken(p.name).slice(0, 12) || "x"}`,
      name: String(p.name).trim(),
      pending_only: true,
      pending_at: p.at || null,
      brand: null,
      category: "other",
      location: "",
      quantity: 0,
      unit: "项",
      status: "in_stock",
      sources: findSourcesForPendingIngredient(inv, p.name),
      days_left: 999,
      category_label: "做菜待买",
      prediction: {
        mode: "none",
        restock_urgency: "urgent",
        restock_date: null,
        avg_daily: 0,
        avg_weekly: 0,
        days_until_empty: null,
        confidence: "low",
        history_days: 0,
        num_weeks: 0,
        breakdown: [],
        sources: {},
      },
    });
  }

  const order = { overdue: 0, urgent: 1, soon: 2, normal: 3 };
  needRestock.sort((a, b) => {
    if (a.pending_only && !b.pending_only) return -1;
    if (!a.pending_only && b.pending_only) return 1;
    return order[a.prediction.restock_urgency] - order[b.prediction.restock_urgency];
  });

  return needRestock;
}

/**
 * Compute summary statistics for the inventory.
 * @returns {{ total_items: number, by_location: object, by_category: object, expiring_soon: Array }}
 */
function inventoryStatus() {
  const inv = readJSON(PATHS.INVENTORY);
  const items = inv.items || [];

  const total_items = items.length;
  const by_location = {};
  const by_category = {};
  const expiring_soon = [];

  for (const item of items) {
    // by_location: all items
    const loc = item.location || "unknown";
    by_location[loc] = (by_location[loc] || 0) + 1;

    // by_category: only in_stock
    if (item.status === "in_stock") {
      const cat = item.category || "other";
      by_category[cat] = (by_category[cat] || 0) + 1;
    }

    // expiring_soon: in_stock items expiring within 7 days
    if (item.status === "in_stock" && item.expiry_date) {
      const dl = daysUntil(item.expiry_date);
      if (dl <= 7) {
        expiring_soon.push({ id: item.id, name: item.name, expiry_date: item.expiry_date, days_left: dl });
      }
    }
  }

  expiring_soon.sort((a, b) => a.days_left - b.days_left);

  return { total_items, by_location, by_category, expiring_soon };
}

// ─── Barcode lookup ───────────────────────────────────────────────────────────

/**
 * Fetch product info from Open Food Facts by barcode.
 * @param {string} barcode
 * @returns {Promise<object>}
 */
function fetchProductByBarcode(barcode) {
  return new Promise((resolve, reject) => {
    const url = `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`;
    https
      .get(url, { headers: { "User-Agent": "HomeManagementSystem/1.0" } }, (r) => {
        let body = "";
        r.on("data", (c) => (body += c));
        r.on("end", () => {
          try {
            const data = JSON.parse(body);
            if (data.status === 1 && data.product) {
              const p = data.product;
              const categories = readJSON(PATHS.CATEGORIES);
              const category = mapCategory(p.categories_tags || []);
              const catConfig = categories[category] || categories["other"];
              const expiryDate = new Date();
              expiryDate.setDate(expiryDate.getDate() + catConfig.default_shelf_days);
              resolve({
                found: true,
                name: p.product_name_zh || p.product_name || p.product_name_en || "",
                brand: p.brands || "",
                category,
                category_label: catConfig.label,
                location: catConfig.location,
                expiry_date: formatLocalDate(expiryDate),
                image_url: p.image_front_url || p.image_url || null,
              });
            } else {
              resolve({ found: false });
            }
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  BABY_AUTO_RESTOCK_CATEGORIES,
  isBabyAutoRestockCategory,
  shouldShowInRestockTab,
  mapCategory,
  inferCategory,
  CATEGORY_RULES,
  normalizeSources,
  itemSourcesRow,
  normalizeIcon,
  normalizePriority,
  normalizeComments,
  normalizeDiaperSpec,
  normalizeReadyToFeedSpec,
  normalizeUnitSpec,
  parseUnitSpecNL,
  resolveUnitSpec,
  computeSpuInfo,
  normalizeIngredientToken,
  pushManualRecent,
  resolveBabyTrackItems,
  prefsWithBabyTrack,
  readBabyLog,
  listItems,
  addItem,
  patchItem,
  consumeItem,
  restockItem,
  deleteItem,
  getItem,
  restockList,
  inventoryStatus,
  fetchProductByBarcode,
};
