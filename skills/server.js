require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const https = require("https");
const { spawn } = require("child_process");
const Anthropic = require("@anthropic-ai/sdk");
const { predict } = require("./predict");
const { importBtcp } = require("./import-btcp");
const {
  encryptionEnabled,
  encryptSecret,
  decryptSecret,
  stripVaultForClient,
} = require("./crypto-vault");

// ─── Shared data layer ──────────────────────────────────────────────────────
const { PATHS, readJSON, writeJSON, today, formatLocalDate, daysUntil, generateId } = require("./lib/data");
const {
  mapCategory, inferCategory, CATEGORY_RULES,
  normalizeSources, itemSourcesRow, normalizeIcon, normalizePriority,
  normalizeComments, normalizeDiaperSpec, normalizeReadyToFeedSpec,
  normalizeUnitSpec, parseUnitSpecNL,
  normalizeIngredientToken, pushManualRecent,
  resolveBabyTrackItems, prefsWithBabyTrack, readBabyLog,
  BABY_AUTO_RESTOCK_CATEGORIES, isBabyAutoRestockCategory, shouldShowInRestockTab,
  listItems, addItem, patchItem, consumeItem, restockItem, deleteItem, getItem,
  restockList, inventoryStatus, fetchProductByBarcode,
} = require("./lib/inventory-ops");

// ─── Error helper ─────────────────────────────────────────────────────────────
function handleOpError(res, err) {
  if (err.code === "NOT_FOUND") return res.status(404).json({ error: err.message });
  if (err.code === "VALIDATION_ERROR") return res.status(400).json({ error: err.message });
  if (err.code === "NO_ENCRYPTION_KEY") return res.status(503).json({ error: err.message });
  return res.status(500).json({ error: err.message || "操作失败" });
}

const app = express();
const PORT = process.env.PORT || 3333;

const BASE_DIR = path.join(__dirname, "..");
// Path aliases (canonical paths live in lib/data.js PATHS)
const INVENTORY_PATH   = PATHS.INVENTORY;
const CONSUMPTION_PATH = PATHS.CONSUMPTION;
const CATEGORIES_PATH  = PATHS.CATEGORIES;
const PREFERENCES_PATH = PATHS.PREFERENCES;
const DIAPER_SEGMENTS_PATH = PATHS.DIAPER_SEGMENTS;
const DIAPER_BRAND_SEGMENTS_PATH = PATHS.DIAPER_BRAND_SEGMENTS;
const MANUAL_IMPORT_RECENT_PATH = PATHS.MANUAL_IMPORT_RECENT;
const PURCHASE_CHANNELS_PATH = PATHS.PURCHASE_CHANNELS;
const BABY_LOG_PATH    = PATHS.BABY_LOG;
const MEAL_DIARY_PATH  = PATHS.MEAL_DIARY;
const CARS_CONFIG_PATH = PATHS.CARS;
const TRANSIT_PATH = PATHS.TRANSIT;

/** 与 Notion「海淘入库」购买平台选项一致 */
const TRANSIT_PLATFORMS = [
  "Amazon", "eBay", "Rakuten", "Target", "Walmart", "Costco", "iHerb", "Shopbop", "6PM",
  "其他", "淘宝", "咸鱼", "xing", "抖音",
];



// 临时上传目录
const UPLOADS_DIR = path.join(BASE_DIR, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter(req, file, cb) {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("只支持图片文件"));
  },
});

app.use(express.json());
// 静态资源放在所有 /api 路由之后注册，避免与接口路径冲突

// ─── Utility functions imported from lib/data.js & lib/inventory-ops.js ────

/** 从菜谱用料行解析食材名（去掉开头数量+单位） */
function ingredientLabelFromLine(line) {
  let s = String(line).trim();
  if (!s) return "";
  s = s
    .replace(/^[\d０-９]+(\.[\d０-９]+)?\s*[个只颗根条盒瓶袋包克g斤两毫升升Lm]+\s*/i, "")
    .trim();
  if (!s) {
    const m = String(line).match(/[\u4e00-\u9fffA-Za-z]+/g);
    return m ? m.join("") : String(line).trim();
  }
  return s.split(/[、,，]/)[0].trim() || s;
}

function findMatchingInventoryItem(ingName, invItems) {
  const n = normalizeIngredientToken(ingName);
  if (!n) return null;
  const inStock = invItems.filter((i) => i.status === "in_stock" && Number(i.quantity) > 0);
  let hit = inStock.find((i) => normalizeIngredientToken(i.name) === n);
  if (hit) return hit;
  const sorted = [...inStock].sort((a, b) => String(b.name).length - String(a.name).length);
  hit = sorted.find((i) => {
    const nm = normalizeIngredientToken(i.name);
    return nm.includes(n) || n.includes(nm);
  });
  return hit || null;
}


// ─── API: 配置数据 ────────────────────────────────────────────────────────────

app.get("/api/categories", (req, res) => res.json(readJSON(CATEGORIES_PATH)));
app.get("/api/locations", (req, res) => res.json(readJSON(path.join(BASE_DIR, "config", "locations.json"))));

app.get("/api/purchase-channels", (req, res) => {
  try {
    const cfg = readJSON(PURCHASE_CHANNELS_PATH, { version: "1.0", channels: [] });
    const all = new Set(cfg.channels || []);
    const inv = readJSON(INVENTORY_PATH, { items: [] });
    for (const i of inv.items || []) {
      itemSourcesRow(i).forEach((c) => all.add(c));
    }
    res.json({ channels: [...all].sort((a, b) => a.localeCompare(b, "zh-CN")) });
  } catch (e) {
    res.json({ channels: [] });
  }
});

app.post("/api/purchase-channels", (req, res) => {
  const name = (req.body?.name || "").trim().slice(0, 64);
  if (!name) return res.status(400).json({ error: "名称不能为空" });
  let data = readJSON(PURCHASE_CHANNELS_PATH, { version: "1.0", channels: [] });
  if (!data.channels) data.channels = [];
  if (!data.channels.includes(name)) {
    data.channels.push(name);
    data.channels.sort((a, b) => a.localeCompare(b, "zh-CN"));
    writeJSON(PURCHASE_CHANNELS_PATH, data);
  }
  res.json({ success: true, channels: data.channels });
});

app.get("/api/category-stats", (req, res) => {
  const counts = {};
  const inv = readJSON(INVENTORY_PATH, { items: [] });
  for (const i of inv.items || []) {
    if (!i.category) continue;
    counts[i.category] = (counts[i.category] || 0) + 1;
  }
  const cons = readJSON(CONSUMPTION_PATH, { version: "1.0", records: [] });
  for (const r of cons.records || []) {
    if (!r.category) continue;
    counts[r.category] = (counts[r.category] || 0) + 1;
  }
  res.json({ counts });
});

app.get("/api/manual-import-recent", (req, res) => {
  if (!fs.existsSync(MANUAL_IMPORT_RECENT_PATH)) {
    return res.json({ version: "1.0", entries: [] });
  }
  res.json(readJSON(MANUAL_IMPORT_RECENT_PATH));
});

app.get("/api/diaper-segments", (req, res) => {
  try {
    const base = readJSON(DIAPER_SEGMENTS_PATH, { version: "1.0", segments: [] });
    const globalSegs = base.segments || [];
    const brand = (req.query.brand || "").trim();
    let brandSegs = [];
    if (brand && fs.existsSync(DIAPER_BRAND_SEGMENTS_PATH)) {
      const bd = readJSON(DIAPER_BRAND_SEGMENTS_PATH, { version: "1.0", brands: {} });
      const b = bd.brands?.[brand];
      if (b?.segments?.length) brandSegs = b.segments;
    }
    const brandCodes = new Set(brandSegs.map((s) => s.code));
    const merged = [...brandSegs, ...globalSegs.filter((s) => !brandCodes.has(s.code))];
    res.json({
      ...base,
      segments: globalSegs,
      global_segments: globalSegs,
      brand_segments: brandSegs,
      merged,
    });
  } catch (e) {
    res.json({ version: "1.0", segments: [], global_segments: [], brand_segments: [], merged: [] });
  }
});

app.post("/api/diaper-brand-segment", (req, res) => {
  const { brand, segment_code, segment_label, weight_min_kg, weight_max_kg } = req.body || {};
  const b = (brand || "").trim();
  const code = (segment_code || "").trim();
  if (!b || !code) return res.status(400).json({ error: "品牌与段位代码必填" });
  const wmin = parseFloat(weight_min_kg);
  const wmax = parseFloat(weight_max_kg);
  if (!Number.isFinite(wmin) || !Number.isFinite(wmax)) {
    return res.status(400).json({ error: "体重上下限需为有效数字 (kg)" });
  }
  let data = readJSON(DIAPER_BRAND_SEGMENTS_PATH, { version: "1.0", brands: {} });
  if (!data.brands) data.brands = {};
  if (!data.brands[b]) data.brands[b] = { segments: [] };
  const seg = {
    code,
    label: (segment_label || code).trim(),
    weight_min_kg: wmin,
    weight_max_kg: wmax,
  };
  const idx = data.brands[b].segments.findIndex((s) => s.code === code);
  if (idx >= 0) data.brands[b].segments[idx] = seg;
  else data.brands[b].segments.push(seg);
  writeJSON(DIAPER_BRAND_SEGMENTS_PATH, data);
  res.json({ success: true, segment: seg });
});

// ─── API: 条码查询 ────────────────────────────────────────────────────────────

app.get("/api/barcode/:code", async (req, res) => {
  const barcode = req.params.code.trim();

  try {
    const data = await new Promise((resolve, reject) => {
      const url = `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`;
      https
        .get(url, { headers: { "User-Agent": "HomeManagementSystem/1.0" } }, (r) => {
          let body = "";
          r.on("data", (c) => (body += c));
          r.on("end", () => resolve(JSON.parse(body)));
        })
        .on("error", reject);
    });

    if (data.status === 1 && data.product) {
      const p = data.product;
      const categories = readJSON(CATEGORIES_PATH);
      const category = mapCategory(p.categories_tags || []);
      const catConfig = categories[category] || categories["other"];
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + catConfig.default_shelf_days);

      return res.json({
        found: true,
        name: p.product_name_zh || p.product_name || p.product_name_en || "",
        brand: p.brands || "",
        category,
        category_label: catConfig.label,
        location: catConfig.location,
        expiry_date: formatLocalDate(expiryDate),
        image_url: p.image_front_url || p.image_url || null,
      });
    }

    res.json({ found: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: 图片分析（Claude Vision） ──────────────────────────────────────────

app.post("/api/analyze-image", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "未收到图片" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === "your_api_key_here") {
    fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: "未配置 ANTHROPIC_API_KEY，请编辑 .env 文件" });
  }

  try {
    const imageData = fs.readFileSync(req.file.path);
    const base64 = imageData.toString("base64");
    const mediaType = req.file.mimetype;

    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64 },
            },
            {
              type: "text",
              text: `请分析这张商品图片，提取以下信息并以 JSON 格式返回：

{
  "name": "商品完整名称（包含规格，如 全脂牛奶 1L）",
  "brand": "品牌名称",
  "category": "品类关键词（dairy/meat_fresh/vegetable/fruit/grain/snack/beverage/condiment/diaper/formula/rtf/baby_food/wipes/medicine/other 之一；水奶/液态奶用rtf）",
  "expiry_date": "有效期，格式 YYYY-MM-DD（如图片上有标注则提取，否则返回 null）",
  "quantity_hint": "包装数量提示（如 6盒装、1箱12瓶 等，没有则 null）",
  "confidence": "识别置信度 high/medium/low"
}

注意：
- 有效期优先识别 "保质期至"、"最佳食用日期"、"exp"、"bb"、"use by" 等字样后的日期
- 日期格式可能是 2026.03.22 或 26/03/22 或 20260322，请统一转换为 YYYY-MM-DD
- 如果看不到有效期日期，expiry_date 返回 null
- 只返回 JSON，不要其他文字`,
            },
          ],
        },
      ],
    });

    // 清理临时文件
    fs.unlinkSync(req.file.path);

    const text = response.content[0].text.trim();
    // 提取 JSON（去掉可能的 markdown code block）
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: "AI 返回格式异常", raw: text });

    const result = JSON.parse(jsonMatch[0]);

    // 补全 category 配置
    const categories = readJSON(CATEGORIES_PATH);
    const catConfig = categories[result.category] || categories["other"];

    // 如果 AI 没识别到有效期，用品类默认值
    if (!result.expiry_date) {
      const d = new Date();
      d.setDate(d.getDate() + catConfig.default_shelf_days);
      result.expiry_date = formatLocalDate(d);
      result.expiry_from_default = true;
    }

    result.category_label = catConfig.label;
    result.location = catConfig.location;

    res.json(result);
  } catch (e) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: e.message });
  }
});

// ─── API: 入库 ── delegates to lib/inventory-ops ─────────────────────────────

// 标准规格克重（1 oz = 29.5735 ml）
const RTF_FORMAT_GRAMS = { small_2oz: 59, large_32oz: 946 };

async function normalizeWaterMilkCapacity(item) {
  if (!item || (item.category !== "rtf" && item.category !== "ready_to_feed")) return;
  const rtf = item.ready_to_feed_spec || {};

  // 已有合法克重则不覆盖
  if (rtf.grams_per_bottle != null && parseFloat(rtf.grams_per_bottle) > 0) {
    item.ready_to_feed_spec = rtf;
    return;
  }

  const note = String(item.notes || "");

  // 1. notes 里有 oz → 换算
  const ozMatch = note.match(/(\d+(?:\.\d+)?)\s*(oz|盎司)/i);
  if (ozMatch) {
    rtf.grams_per_bottle = Math.round(parseFloat(ozMatch[1]) * 29.57);
    item.ready_to_feed_spec = rtf;
    return;
  }

  // 2. notes 里有 ml/g
  const mlMatch = note.match(/(\d+(?:\.\d+)?)\s*(ml|毫升|g|克)/i);
  if (mlMatch) {
    rtf.grams_per_bottle = Math.round(parseFloat(mlMatch[1]));
    item.ready_to_feed_spec = rtf;
    return;
  }

  // 3. 从 bottle_format 标准推算（SPU/SKU 导入场景：用户选了 2oz/32oz 格式）
  const fmtGrams = RTF_FORMAT_GRAMS[rtf.bottle_format];
  if (fmtGrams) {
    rtf.grams_per_bottle = fmtGrams;
    item.ready_to_feed_spec = rtf;
    return;
  }

  // 4. notes 有其他文字 → 走 LLM 推算
  if (note.trim().length > 0) {
    const prefs = readJSON(PREFS_PATH);
    const llm = prefs?.ui?.llm;
    if (llm && (llm.mode === "cli" || llm.mode === "http")) {
      const prompt = `水奶备注："${note}"。推测单瓶容量（ml 或 g，1oz≈30ml）。只输出整数，无法判断则输出0。`;
      try {
        let ans = "";
        if (llm.mode === "cli") {
          ans = await runLlmCliCompletion(llm, prompt, "");
        } else {
          ans = await runLlmHttpCompletion(llm, prompt, 10);
        }
        const parsed = parseInt(ans.trim().replace(/\D/g, ""), 10);
        if (parsed > 0 && !isNaN(parsed)) {
          rtf.grams_per_bottle = parsed;
          item.ready_to_feed_spec = rtf;
        }
      } catch (e) {
        console.error("LLM water milk capacity parsing error:", e.message);
      }
    }
  }
}

// ─── 自然语言包装规格解析 ────────────────────────────────────────────────────────
app.post("/api/parse-unit-spec", async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.json({ unit_spec: null });
  // 1. 正则快速解析
  const regexResult = parseUnitSpecNL(text);
  if (regexResult) return res.json({ unit_spec: regexResult, source: "regex" });
  // 2. LLM 兜底
  try {
    const prefs = readJSON(PREFS_PATH);
    const llm = prefs?.ui?.llm;
    if (llm) {
      const prompt = `包装描述："${text}"，请提取 SKU 和 SPU 信息，只输出 JSON，格式：{"sku_unit":"瓶","spu_unit":"箱","spu_qty":24}。无法识别则输出 null。`;
      let ans = "";
      if (llm.mode === "cli") ans = await runLlmCliCompletion(llm, prompt, "");
      else ans = await runLlmHttpCompletion(llm, prompt, 100);
      const jsonMatch = ans.trim().match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const norm = normalizeUnitSpec(parsed);
        if (norm) return res.json({ unit_spec: norm, source: "llm" });
      }
    }
  } catch (e) { /* LLM unavailable */ }
  res.json({ unit_spec: null, source: "none" });
});

app.post("/api/items", async (req, res) => {
  try {
    await normalizeWaterMilkCapacity(req.body);
    const result = addItem(req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    handleOpError(res, err);
  }
});

app.patch("/api/items/:id", async (req, res) => {
  try {
    await normalizeWaterMilkCapacity(req.body);
    const result = patchItem(req.params.id, req.body || {});
    res.json({ success: true, ...result });
  } catch (err) {
    handleOpError(res, err);
  }
});

app.post("/api/items/:id/comments", (req, res) => {
  const text = (req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "评论不能为空" });
  const inv = readJSON(INVENTORY_PATH);
  const idx = inv.items.findIndex((i) => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "物品不存在" });
  const cur = inv.items[idx];
  const comments = Array.isArray(cur.comments) ? [...cur.comments] : [];
  comments.push({ at: new Date().toISOString(), text: text.slice(0, 2000) });
  const next = { ...cur, comments: normalizeComments(comments) };
  inv.items[idx] = next;
  inv.last_updated = today();
  writeJSON(INVENTORY_PATH, inv);
  res.json({ success: true, item: next });
});

// ─── API: 查询库存 ────────────────────────────────────────────────────────────

app.get("/api/crypto-status", (req, res) => {
  res.json({ encryption_enabled: encryptionEnabled() });
});

app.get("/api/items/:id/secret", (req, res) => {
  if (!encryptionEnabled()) {
    return res.status(503).json({ error: "未配置 HOUSEHOLD_ENCRYPTION_KEY" });
  }
  const inv = readJSON(INVENTORY_PATH);
  const item = inv.items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: "物品不存在" });
  if (!item.encrypted_vault) return res.json({ plaintext: null });
  const pt = decryptSecret(item.encrypted_vault);
  if (pt == null) return res.status(500).json({ error: "解密失败" });
  res.json({ plaintext: pt });
});

app.get("/api/items/:id", (req, res) => {
  try {
    res.json(getItem(req.params.id));
  } catch (err) {
    handleOpError(res, err);
  }
});

app.get("/api/items", (req, res) => {
  try {
    res.json(listItems(req.query));
  } catch (err) {
    handleOpError(res, err);
  }
});

// ─── API: 补货清单（只含有预测且需要补货的） ──────────────────────────────────

app.get("/api/restock", (req, res) => {
  try {
    res.json(restockList());
  } catch (err) {
    handleOpError(res, err);
  }
});

// ─── API: 消耗记录 ────────────────────────────────────────────────────────────

app.post("/api/items/:id/consume", (req, res) => {
  try {
    const { qty, note } = req.body;
    const result = consumeItem(req.params.id, qty, note);
    res.json({ success: true, ...result });
  } catch (err) {
    handleOpError(res, err);
  }
});

// ─── API: 补货（新增批次）────────────────────────────────────────────────────────

app.post("/api/items/:id/restock", (req, res) => {
  try {
    const { qty, expiry_date, purchase_date } = req.body || {};
    const result = restockItem(req.params.id, qty, expiry_date || null, purchase_date || null);
    res.json({ success: true, ...result });
  } catch (err) {
    handleOpError(res, err);
  }
});

// ─── API: LLM 商品名解析 ───────────────────────────────────────────────────────

app.post("/api/parse-item-nl", async (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "text 不能为空" });

  const prefs = readJSON(PREFS_PATH);
  const llm = prefs?.llm || prefs?.ui?.llm;
  if (!llm) return res.status(503).json({ error: "未配置大语言模型，请先在设置中配置 LLM" });

  const prompt = `用户描述一件家用商品：「${text}」
请从中提取信息，输出 JSON，字段：
{
  "name": "商品名（简洁，去掉数量包装）",
  "brand": "品牌或 null",
  "category": "品类 key（dairy/meat_fresh/meat_frozen/vegetable/fruit/fast_food/grain/condiment/snack/beverage/formula/rtf/diaper/baby_food/baby_snack/wipes/cleaning/paper_goods/personal_care/medicine/other）",
  "quantity": 数字（SKU 数量）或 null,
  "unit": "单位（盒/瓶/罐/片/包/袋等）或 null",
  "expiry_date": "YYYY-MM-DD 或 null",
  "notes": "其他备注或 null"
}
只输出 JSON，不要解释。`;

  try {
    let ans = "";
    if (llm.mode === "cli") ans = await runLlmCliCompletion(llm, prompt, "");
    else ans = await runLlmHttpCompletion(llm, prompt, 300);
    const jsonMatch = ans.trim().match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return res.json({ parsed: null, raw: ans });
    const parsed = JSON.parse(jsonMatch[0]);
    return res.json({ parsed, source: llm.mode || "http" });
  } catch (e) {
    return res.status(500).json({ error: "LLM 解析失败: " + e.message });
  }
});

// ─── API: 删除物品 ────────────────────────────────────────────────────────────

app.delete("/api/items/:id", (req, res) => {
  try {
    res.json(deleteItem(req.params.id));
  } catch (err) {
    handleOpError(res, err);
  }
});

// ─── API: 导入 .btcp 文件 ─────────────────────────────────────────────────────

const btcpUpload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter(req, file, cb) {
    if (file.originalname.endsWith(".btcp") || file.mimetype === "application/zip" || file.mimetype === "application/octet-stream") {
      cb(null, true);
    } else {
      cb(new Error("只支持 .btcp 文件"));
    }
  },
});

app.post("/api/import/btcp", btcpUpload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "未收到文件" });

  const tz = parseInt(req.query.tz ?? "8");
  const tmpPath = req.file.path + ".btcp";

  try {
    fs.renameSync(req.file.path, tmpPath);
    const result = importBtcp(tmpPath, { dryRun: false, tz });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
});

function nowISO() {
  return new Date().toISOString();
}

/** ISO 字符串 → Unix 秒（下发给客户端用） */
function toUnixSec(isoStr) {
  if (!isoStr) return null;
  const t = new Date(isoStr).getTime();
  return isNaN(t) ? null : Math.floor(t / 1000);
}

/** ISO 字符串 → 本地日期 YYYY-MM-DD（'sv' locale 保证格式） */
function localDateStr(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  return isNaN(d) ? null : d.toLocaleDateString('sv');
}

app.get("/api/baby-log", (req, res) => {
  const log = readBabyLog();
  const { type, date, limit = 50 } = req.query;

  let events = log.events;
  if (type)  events = events.filter(e => e.type === type);
  if (date)  events = events.filter(e => e.time.startsWith(date));

  events = events.slice().reverse().slice(0, parseInt(limit));
  const eventsOut = events.map(e => ({ ...e, time: toUnixSec(e.time) }));
  res.json({ baby: log.baby || null, events: eventsOut, total: log.events.length });
});

app.get("/api/baby-log/stats", (req, res) => {
  const log = readBabyLog();
  const todayStr = today();
  const todayEvents = log.events.filter(e => e.time.startsWith(todayStr));

  const feedings = todayEvents.filter(e => e.type === "feeding_bottle");
  const diapers  = todayEvents.filter(e => e.type === "diaper");
  const sleeps   = todayEvents.filter(e => e.type === "sleep");

  const totalMl = feedings.reduce((s, e) => s + (e.data?.amount_ml || 0), 0);
  const diaperWet   = diapers.filter(e => e.data?.status === "wet" || e.data?.status === "wet_and_dirty").length;
  const diaperDirty = diapers.filter(e => e.data?.status === "dirty" || e.data?.status === "wet_and_dirty").length;
  const totalSleepMin = sleeps.reduce((s, e) => s + (e.data?.duration_min || 0), 0);

  const latestGrowth = [...log.events].reverse().find(e => e.type === "growth");

  res.json({
    baby: log.baby,
    today: {
      feeding_count: feedings.length,
      feeding_total_ml: totalMl,
      diaper_count: diapers.length,
      diaper_wet: diaperWet,
      diaper_dirty: diaperDirty,
      sleep_count: sleeps.length,
      sleep_total_min: totalSleepMin,
    },
    latest_growth: latestGrowth?.data || null,
    total_events: log.events.length,
  });
});

app.post("/api/baby-log", (req, res) => {
  const { type, time, data } = req.body;
  const validTypes = ["feeding_bottle", "feeding_nursing", "feeding_solid", "diaper", "sleep", "growth", "milestone", "bath", "medicine", "doctor_visit"];
  if (!validTypes.includes(type)) return res.status(400).json({ error: `不支持的事件类型: ${type}` });

  // 接受 Unix 秒或 ISO 字符串；存储统一用 ISO
  let eventTimeISO;
  if (typeof time === 'number' || (typeof time === 'string' && /^\d{10,13}$/.test(time))) {
    eventTimeISO = new Date(Number(time) * (String(time).length <= 10 ? 1000 : 1)).toISOString();
  } else {
    eventTimeISO = time || nowISO();
  }
  const id = `manual_${type}_${Date.now()}`;

  const event = { id, type, time: eventTimeISO, data: data || {} };
  if (req.body.baby_id) event.baby_id = req.body.baby_id;

  const log = readBabyLog();
  log.events.push(event);
  log.events.sort((a, b) => a.time.localeCompare(b.time));
  writeJSON(BABY_LOG_PATH, log);

  res.json({ success: true, event: { ...event, time: toUnixSec(event.time) } });
});

app.delete("/api/baby-log/:id", (req, res) => {
  const log = readBabyLog();
  const idx = log.events.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "事件不存在" });
  log.events.splice(idx, 1);
  writeJSON(BABY_LOG_PATH, log);
  res.json({ success: true });
});

// ─── 偏好设置（含多宝宝） ───────────────────────────────────────────────────

function readCarsConfigDoc() {
  const candidates = [CARS_CONFIG_PATH];
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    candidates.push(path.join(home, "家庭管理", "config", "cars.json"));
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return readJSON(p, { version: "1.0", vehicles: [] });
    }
  }
  return { version: "1.0", vehicles: [] };
}

function normalizeScheduleItem(s) {
  if (!s || typeof s !== "object") return null;
  return {
    id: s.id && String(s.id).trim() ? String(s.id).trim() : `sch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: s.name != null ? String(s.name).slice(0, 120) : "",
    interval_months: s.interval_months != null && s.interval_months !== "" ? Number(s.interval_months) : null,
    interval_km: s.interval_km != null && s.interval_km !== "" ? Number(s.interval_km) : null,
    last_date: s.last_date != null && String(s.last_date).trim() ? String(s.last_date).slice(0, 10) : null,
    last_km: s.last_km != null && s.last_km !== "" ? Number(s.last_km) : null,
    next_date: s.next_date != null && String(s.next_date).trim() ? String(s.next_date).slice(0, 10) : null,
    next_km: s.next_km != null && s.next_km !== "" ? Number(s.next_km) : null,
    note: s.note != null ? String(s.note).slice(0, 500) : "",
  };
}

function normalizeVehicle(v) {
  if (!v || typeof v !== "object") return null;
  const id = v.id && String(v.id).trim() ? String(v.id).trim() : `car_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const sched = Array.isArray(v.schedule) ? v.schedule.map(normalizeScheduleItem).filter(Boolean) : [];
  return {
    id,
    name: v.name != null ? String(v.name).slice(0, 120) : "未命名",
    plate: v.plate != null ? String(v.plate).slice(0, 32) : "",
    schedule: sched,
  };
}

function normalizeVehiclesList(vehicles) {
  if (!Array.isArray(vehicles)) return [];
  return vehicles.map(normalizeVehicle).filter(Boolean);
}

/** 与前端做菜页「可做菜食材」一致：排除尿裤/清洁等非食材 */
const NON_COOKING_INGREDIENT_CATEGORIES = new Set([
  "diaper",
  "wipes",
  "medicine",
  "cleaning",
  "personal_care",
  "clothing",
  "home_misc",
  "digital_voucher",
]);

function isCookingInventoryCategory(cat) {
  return cat && !NON_COOKING_INGREDIENT_CATEGORIES.has(cat);
}

function llmCookingOk(llm) {
  if (!llm || typeof llm !== "object") return false;
  const backend = String(llm.backend || "http").toLowerCase();
  if (backend === "cli") return !!String(llm.cli_command || "").trim();
  const url = String(llm.completion_url || "").trim();
  if (!url) return false;
  const authStyle = llm.auth_style || "bearer";
  const key = String(llm.api_key || "").trim();
  if (authStyle !== "none" && !key) return false;
  return true;
}

function mergePreferencesDisplay() {
  const prefs = readJSON(PREFERENCES_PATH);
  const family = prefs.family || {};
  const babiesExplicit = Array.isArray(family.babies);
  let babies = babiesExplicit ? [...family.babies] : [];
  if (!babiesExplicit && babies.length === 0 && family.baby_name) {
    babies.push({ id: "baby_1", name: family.baby_name });
  }
  const blog = readBabyLog();
  if (!babiesExplicit && babies.length === 0 && blog.baby?.name) {
    babies.push({
      id: "baby_1",
      name: blog.baby.name,
      dob: blog.baby.dob || null,
      gender: blog.baby.gender || null,
    });
  }
  const cfg = readCarsConfigDoc();
  const cars = normalizeVehiclesList(cfg.vehicles || []);
  const ui = {
    show_transit_tab: false,
    inventory_subtitle_mode: "default",
    inventory_subtitle_template: "共 {count} 条 · 食品/衣物/杂物/位置",
    inventory_subtitle_urgent_template: "⚠️ {urgent} 件即将过期",
    ...(prefs.ui || {}),
  };
  const rawLlm = prefs.llm && typeof prefs.llm === "object" ? prefs.llm : {};
  const llm = {
    backend: "http",
    cli_args: [],
    cli_timeout_ms: 120000,
    ...rawLlm,
  };
  if (llm.api_key) {
    llm.api_key_set = true;
    delete llm.api_key;
  } else {
    llm.api_key_set = false;
  }
  const rawLlmForReady = prefs.llm && typeof prefs.llm === "object" ? prefs.llm : {};
  return {
    ...prefs,
    ui,
    llm,
    llm_cooking_ready: llmCookingOk(rawLlmForReady),
    family: { ...family, babies, cars },
  };
}

function urgentDaysFromPrefs(prefs) {
  const n = prefs?.alerts?.urgent_days;
  return typeof n === "number" && n >= 0 ? n : 3;
}

function inventorySubtitleStats(prefs) {
  const inv = readJSON(INVENTORY_PATH, { items: [] });
  const urg = urgentDaysFromPrefs(prefs);
  const items = (inv.items || []).filter((i) => i.status === "in_stock");
  let urgent = 0;
  for (const i of items) {
    if (daysUntil(i.expiry_date) <= urg) urgent += 1;
  }
  return { count: items.length, urgent, urgent_threshold_days: urg };
}

function escapeForJsonStringContent(s) {
  return JSON.stringify(String(s)).slice(1, -1);
}

function extractCompletionText(json) {
  if (json == null) return "";
  if (typeof json === "string") return json.trim();
  const c0 = json.choices && json.choices[0];
  if (c0?.message?.content != null) return String(c0.message.content).trim();
  if (c0?.text != null) return String(c0.text).trim();
  const cand = json.candidates && json.candidates[0];
  if (cand?.content?.parts?.[0]?.text != null) return String(cand.content.parts[0].text).trim();
  if (json.content != null) return String(json.content).trim();
  if (json.output_text != null) return String(json.output_text).trim();
  return "";
}

function buildLlmInventoryPrompt(llm, stats) {
  const custom = llm.user_prompt_template != null ? String(llm.user_prompt_template).trim() : "";
  if (custom) {
    return custom
      .replace(/\{count\}/g, String(stats.count))
      .replace(/\{urgent\}/g, String(stats.urgent))
      .replace(/\{urgent_days\}/g, String(stats.urgent_threshold_days));
  }
  return (
    `你是家庭库存助手。当前在库共 ${stats.count} 条，其中 ${stats.urgent} 件剩余保质期在 ${stats.urgent_threshold_days} 天以内（即将过期）。` +
    `请只输出一句中文副标题（不超过 24 字），不要引号或前缀。`
  );
}

function applyLlmAuthHeaders(headers, llm, key) {
  const style = llm.auth_style || "bearer";
  if (style === "none") return;
  if (style === "x_api_key") {
    headers["x-api-key"] = key;
    return;
  }
  headers.Authorization = `Bearer ${key}`;
}

function expandCliArgPlaceholders(s, llm, prompt, stats) {
  const model = String(llm.model || "").trim();
  return String(s)
    .replace(/<<<PROMPT>>>/g, prompt)
    .replace(/<<<MODEL>>>/g, model)
    .replace(/<<<COUNT>>>/g, String(stats.count))
    .replace(/<<<URGENT>>>/g, String(stats.urgent))
    .replace(/<<<URGENT_DAYS>>>/g, String(stats.urgent_threshold_days));
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function normalizeCliArgs(llm, prompt, stats) {
  const raw = llm.cli_args;
  let arr;
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return { ok: false, error: "cli_args 须为 JSON 数组" };
      arr = parsed;
    } catch (e) {
      return { ok: false, error: `cli_args JSON 无效：${e.message || e}` };
    }
  } else {
    return { ok: false, error: "请配置 cli_args（JSON 数组），例如 [\"-p\",\"<<<PROMPT>>>\"]" };
  }
  const args = arr.map((a) => expandCliArgPlaceholders(a, llm, prompt, stats));
  return { ok: true, args };
}

function runSpawned(command, args, opts) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    const proc = spawn(command, args, {
      shell: false,
      env: { ...process.env },
      cwd: opts.cwd || undefined,
    });
    let out = "";
    let err = "";
    const timeoutMs = opts.timeoutMs || 120000;
    const t = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch (_) {}
      finish(reject, new Error(`CLI 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    proc.stdout.on("data", (d) => {
      out += d.toString();
      if (out.length > 2_000_000) {
        try {
          proc.kill("SIGKILL");
        } catch (_) {}
      }
    });
    proc.stderr.on("data", (d) => {
      err += d.toString();
    });
    proc.on("error", (e) => {
      clearTimeout(t);
      finish(reject, e);
    });
    proc.on("close", (code) => {
      clearTimeout(t);
      if (settled) return;
      if (code !== 0 && !out.trim()) {
        finish(reject, new Error((err || `退出码 ${code}`).slice(0, 1200)));
        return;
      }
      finish(resolve, { stdout: out, stderr: err, code: code || 0 });
    });
  });
}

async function runLlmCliCompletion(llm, prompt, stats) {
  const cmd = String(llm.cli_command || "").trim();
  if (!cmd) return { ok: false, error: "请配置本地 CLI 命令（cli_command）" };
  const norm = normalizeCliArgs(llm, prompt, stats);
  if (!norm.ok) return norm;
  const timeoutRaw = llm.cli_timeout_ms;
  const timeoutMs = Math.min(
    Math.max(parseInt(timeoutRaw, 10) || 120000, 5000),
    600000
  );
  const cwdRaw = llm.cli_cwd != null ? String(llm.cli_cwd).trim() : "";
  let cwd;
  if (cwdRaw) {
    if (!fs.existsSync(cwdRaw)) return { ok: false, error: `cli_cwd 不存在：${cwdRaw}` };
    cwd = cwdRaw;
  }
  try {
    const { stdout, stderr, code } = await runSpawned(cmd, norm.args, { timeoutMs, cwd });
    let text = stripAnsi(stdout).trim();
    if (!text && stderr.trim()) text = stripAnsi(stderr).trim();
    if (!text) return { ok: false, error: code !== 0 ? (stderr || `CLI 退出码 ${code}`).slice(0, 800) : "CLI 无输出" };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function postInventorySubtitleCli(llm, prompt, stats) {
  const r = await runLlmCliCompletion(llm, prompt, stats);
  if (!r.ok) return r;
  const line = r.text.split(/\r?\n/).find((l) => l.trim()) || r.text;
  const subtitle = line.trim().slice(0, 500);
  if (!subtitle) return { ok: false, error: "CLI 输出为空" };
  return { ok: true, subtitle, stats };
}

async function runLlmHttpCompletion(llm, prompt, maxTokens) {
  const url = String(llm.completion_url || "").trim();
  const key = String(llm.api_key || "").trim();
  const authStyle = llm.auth_style || "bearer";
  if (!url) return { ok: false, error: "请先配置 completion URL，或改用「本地 CLI」" };
  if (authStyle !== "none" && !key) return { ok: false, error: "请先配置 API Key，或将鉴权改为「无」" };

  const model = String(llm.model || "gpt-4o-mini").trim() || "gpt-4o-mini";
  const mt = Math.min(Math.max(parseInt(maxTokens, 10) || 2000, 50), 8000);

  let bodyObj;
  const tpl = llm.body_template != null ? String(llm.body_template).trim() : "";
  if (tpl) {
    try {
      const raw = tpl
        .replace(/<<<MODEL>>>/g, model)
        .replace(/<<<PROMPT>>>/g, escapeForJsonStringContent(prompt));
      bodyObj = JSON.parse(raw);
    } catch (e) {
      return { ok: false, error: `body_template 解析失败：${e.message || e}` };
    }
  } else {
    bodyObj = {
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: mt,
    };
  }

  const headers = { "Content-Type": "application/json" };
  applyLlmAuthHeaders(headers, llm, key);

  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(bodyObj) });
  const text = await r.text();
  if (!r.ok) {
    return { ok: false, error: text.slice(0, 800) || `HTTP ${r.status}` };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "响应不是 JSON" };
  }
  const out = extractCompletionText(json);
  if (!out) return { ok: false, error: "模型未返回可用文本" };
  return { ok: true, text: out };
}

async function postInventorySubtitleLlm(prefs) {
  const mode = prefs.ui?.inventory_subtitle_mode;
  if (mode !== "llm") return { ok: false, error: "未启用大模型副标题" };
  const llm = prefs.llm || {};
  const backend = String(llm.backend || "http").toLowerCase();
  const stats = inventorySubtitleStats(prefs);
  const prompt = buildLlmInventoryPrompt(llm, stats);

  if (backend === "cli") {
    return postInventorySubtitleCli(llm, prompt, stats);
  }

  const httpOut = await runLlmHttpCompletion(llm, prompt, 120);
  if (!httpOut.ok) return httpOut;
  return { ok: true, subtitle: httpOut.text, stats };
}

function stripJsonFences(s) {
  const t = String(s).trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) return m[1].trim();
  return t;
}

function parseCookingRecommendationsArray(text) {
  const raw = stripJsonFences(text);
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `JSON 解析失败：${e.message || e}` };
  }
  const arr = Array.isArray(data) ? data : data.dishes || data.items || data.recommendations;
  if (!Array.isArray(arr)) return { ok: false, error: "模型未返回 JSON 数组" };
  const dishes = [];
  for (const x of arr.slice(0, 12)) {
    if (!x || typeof x !== "object") continue;
    const name = String(x.name || "").trim().slice(0, 120);
    if (!name) continue;
    const ingredients = Array.isArray(x.ingredients)
      ? x.ingredients.map((s) => String(s).trim()).filter(Boolean).slice(0, 40)
      : [];
    let steps = "";
    if (Array.isArray(x.steps)) {
      steps = x.steps
        .map((s, i) => `${i + 1}. ${String(s).trim()}`)
        .filter((line) => line.length > 3)
        .join("\n");
    } else {
      steps = String(x.steps || "").trim();
    }
    dishes.push({ name, ingredients, steps: steps.slice(0, 8000) });
  }
  if (!dishes.length) return { ok: false, error: "模型未返回有效菜谱" };
  return { ok: true, dishes };
}

function collectCookingLlmContext(prefs) {
  const inv = readJSON(INVENTORY_PATH, { items: [] });
  const items = (inv.items || []).filter(
    (i) => i.status === "in_stock" && isCookingInventoryCategory(i.category)
  );
  const invNames = [
    ...new Set(items.map((i) => String(i.name || "").trim()).filter(Boolean)),
  ].slice(0, 120);
  const meal = readMealDiary();
  const dishes = meal.dishes || [];
  const favoriteNames = dishes
    .filter((d) => d.favorite)
    .map((d) => String(d.name || "").trim())
    .filter(Boolean)
    .slice(0, 40);
  const otherDishNames = dishes
    .filter((d) => !d.favorite)
    .map((d) => String(d.name || "").trim())
    .filter(Boolean)
    .slice(0, 40);
  const family = prefs.family || {};
  const diet = Array.isArray(family.dietary_restrictions)
    ? family.dietary_restrictions.map(String).join("、")
    : "";
  const allergens = Array.isArray(family.allergens_to_watch)
    ? family.allergens_to_watch.map(String).join("、")
    : "";
  const cook = prefs.cooking || {};
  const cookHint = [
    cook.workday_max_minutes != null ? `工作日希望烹饪时间约 ${cook.workday_max_minutes} 分钟内` : "",
    cook.weekend_max_minutes != null ? `周末可接受约 ${cook.weekend_max_minutes} 分钟` : "",
    cook.thermomix_available ? "有美善品/料理机" : "",
  ]
    .filter(Boolean)
    .join("；");
  return {
    invNames,
    favoriteNames,
    otherDishNames,
    diet,
    allergens,
    cookHint,
  };
}

function buildCookingRecommendPrompt(prefs, count, hint) {
  const ctx = collectCookingLlmContext(prefs);
  const cookingExtra = prefs.cooking && typeof prefs.cooking === "object" ? prefs.cooking : {};
  const llmHint = String(cookingExtra.llm_hint || "").trim().slice(0, 800);
  const userHint = String(hint || "").trim().slice(0, 500);
  const lines = [
    `你是家庭烹饪助手。请根据下列「当前库存食材」和「家庭偏好」推荐 ${count} 道家常中餐，尽量利用已有食材（可少量补充常见辅料如葱姜蒜/酱油）。`,
    "",
    "【当前库存可做菜食材】",
    ctx.invNames.length ? ctx.invNames.join("、") : "（暂无，请仍建议易买、简单的菜）",
    "",
    "【收藏的菜】",
    ctx.favoriteNames.length ? ctx.favoriteNames.join("、") : "（无）",
    "",
    "【其它菜谱】",
    ctx.otherDishNames.length ? ctx.otherDishNames.join("、") : "（无）",
    "",
    "【饮食禁忌】",
    ctx.diet || "（无）",
    "",
    "【需注意过敏】",
    ctx.allergens || "（无）",
    "",
    "【烹饪习惯】",
    ctx.cookHint || "（未说明）",
  ];
  if (llmHint) {
    lines.push("", "【用户长期偏好】", llmHint);
  }
  if (userHint) {
    lines.push("", "【本次额外要求】", userHint);
  }
  lines.push(
    "",
    "请只输出一个 JSON 数组，不要 Markdown 或小标题。每项字段：",
    "name（菜名），ingredients（字符串数组，每项含用量如「鸡蛋 2 个」），steps（做菜步骤，多行用换行分隔或写成字符串数组）。",
    '示例：[{"name":"番茄炒蛋","ingredients":["鸡蛋 2","番茄 2"],"steps":"1. …\\n2. …"}]'
  );
  return lines.join("\n");
}

function buildExpandStepsPrompt(prefs, name, ingredients, stepsBrief) {
  const ctx = collectCookingLlmContext(prefs);
  const ing = Array.isArray(ingredients) ? ingredients.map(String).filter(Boolean).slice(0, 40) : [];
  const brief = String(stepsBrief || "").trim().slice(0, 4000);
  return [
    `请详细展开「${name}」的中文做法步骤（适合家庭厨房）。`,
    "可用食材参考：" + (ctx.invNames.length ? ctx.invNames.join("、") : "（不限）"),
    "菜谱用料：" + (ing.length ? ing.join("、") : "（未列出）"),
    brief ? `已有简要步骤：\n${brief}` : "",
    "",
    "请只输出步骤正文，用 1. 2. 3. 编号分步，不要 JSON。",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function postCookingRecommendationsLlm(prefs, body) {
  const llm = prefs.llm || {};
  if (!llmCookingOk(llm)) {
    return { ok: false, error: "请先在配置中填写 llm（completion URL + API Key，或本地 CLI）" };
  }
  const count = Math.min(Math.max(parseInt(body?.count, 10) || 5, 1), 8);
  const hint = body?.hint != null ? String(body.hint) : "";
  const prompt = buildCookingRecommendPrompt(prefs, count, hint);
  const backend = String(llm.backend || "http").toLowerCase();
  const stats = inventorySubtitleStats(prefs);
  let textOut;
  if (backend === "cli") {
    const r = await runLlmCliCompletion(llm, prompt, stats);
    if (!r.ok) return r;
    textOut = r.text;
  } else {
    const r = await runLlmHttpCompletion(llm, prompt, 3500);
    if (!r.ok) return r;
    textOut = r.text;
  }
  return parseCookingRecommendationsArray(textOut);
}

async function postCookingExpandStepsLlm(prefs, body) {
  const llm = prefs.llm || {};
  if (!llmCookingOk(llm)) {
    return { ok: false, error: "请先在配置中填写 llm（completion URL + API Key，或本地 CLI）" };
  }
  const name = String(body?.name || "").trim();
  if (!name) return { ok: false, error: "菜名必填" };
  const ingredients = Array.isArray(body?.ingredients) ? body.ingredients : [];
  const stepsBrief = body?.steps_brief != null ? String(body.steps_brief) : "";
  const prompt = buildExpandStepsPrompt(prefs, name, ingredients, stepsBrief);
  const backend = String(llm.backend || "http").toLowerCase();
  const stats = inventorySubtitleStats(prefs);
  let textOut;
  if (backend === "cli") {
    const r = await runLlmCliCompletion(llm, prompt, stats);
    if (!r.ok) return r;
    textOut = r.text;
  } else {
    const r = await runLlmHttpCompletion(llm, prompt, 2500);
    if (!r.ok) return r;
    textOut = r.text;
  }
  const steps = String(textOut || "").trim().slice(0, 12000);
  if (!steps) return { ok: false, error: "模型未返回步骤" };
  return { ok: true, steps };
}

app.get("/api/preferences", (req, res) => {
  res.json(mergePreferencesDisplay());
});

/** 储物 Tab 副标题：服务端代调用 completion（API Key 仅存服务端 preferences.json） */
app.post("/api/inventory-subtitle/llm", async (req, res) => {
  const prefs = readJSON(PREFERENCES_PATH);
  try {
    const out = await postInventorySubtitleLlm(prefs);
    if (!out.ok) return res.status(400).json({ error: out.error });
    res.json({ subtitle: out.subtitle, stats: out.stats });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("/api/cars", (req, res) => {
  res.json(readCarsConfigDoc());
});

app.put("/api/cars", (req, res) => {
  const body = req.body || {};
  const vehicles = normalizeVehiclesList(body.vehicles);
  const doc = {
    version: String(body.version || "1.0").slice(0, 8),
    vehicles,
  };
  writeJSON(CARS_CONFIG_PATH, doc);
  res.json({ success: true, ...doc });
});

// ─── 养车数据导入（Carfax / CarCare CSV）────────────────────────────────────

/** 解析简单 CSV（支持带引号字段） */
function parseCSV(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((l) => l.trim());
  if (!lines.length) return [];
  const parseRow = (line) => {
    const cells = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') {
        inQ = true;
      } else if (ch === ",") {
        cells.push(cur.trim()); cur = "";
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());
    return cells;
  };
  const headers = parseRow(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, "_"));
  return lines.slice(1).map((line) => {
    const vals = parseRow(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i] !== undefined ? vals[i] : ""; });
    return row;
  });
}

/** 标准化日期为 YYYY-MM-DD，支持 MM/DD/YYYY、YYYY-MM-DD、DD-MM-YYYY 等 */
function normalizeImportDate(raw) {
  if (!raw || !String(raw).trim()) return null;
  const s = String(raw).trim();
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // MM/DD/YYYY or M/D/YYYY
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) return `${mdy[3]}-${String(mdy[1]).padStart(2, "0")}-${String(mdy[2]).padStart(2, "0")}`;
  // DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (dmy) return `${dmy[3]}-${String(dmy[2]).padStart(2, "0")}-${String(dmy[1]).padStart(2, "0")}`;
  return null;
}

/** 服务类型关键词 → 保养项 id 候选（按 schedule.name 匹配） */
const SERVICE_KEYWORDS = [
  { keys: ["oil", "机油", "engine oil", "oil change", "oil filter", "lube"], schKeywords: ["机油", "小保养"] },
  { keys: ["brake fluid", "brake oil", "刹车油", "制动液", "dot"], schKeywords: ["刹车", "制动"] },
  { keys: ["tire", "rotation", "wheel", "tyre", "轮胎", "换位", "动平衡", "balance"], schKeywords: ["轮胎", "换位", "动平衡"] },
  { keys: ["inspect", "smog", "emission", "年检", "registration", "registration renewal"], schKeywords: ["年检", "inspection"] },
  { keys: ["transmission", "变速箱", "gearbox", "trans fluid", "atf"], schKeywords: ["变速箱"] },
  { keys: ["coolant", "冷却液", "antifreeze", "radiator flush"], schKeywords: ["冷却液"] },
  { keys: ["air filter", "engine air", "进气", "空气滤"], schKeywords: ["空气滤", "进气"] },
  { keys: ["cabin filter", "cabin air", "空调滤", "ac filter", "pollen"], schKeywords: ["空调滤"] },
  { keys: ["spark plug", "火花塞", "plug"], schKeywords: ["火花塞"] },
  { keys: ["battery", "电池", "12v battery", "car battery"], schKeywords: ["电池"] },
  { keys: ["wiper", "雨刷", "windshield wiper"], schKeywords: ["雨刷"] },
];

function matchServiceToSchedule(serviceStr, schedule) {
  const low = (serviceStr || "").toLowerCase();
  for (const rule of SERVICE_KEYWORDS) {
    if (rule.keys.some((k) => low.includes(k))) {
      const found = schedule.find((s) =>
        rule.schKeywords.some((kw) => (s.name || "").includes(kw))
      );
      if (found) return found.id;
    }
  }
  return null;
}

/** 自动检测列名 */
function detectColumns(row) {
  const keys = Object.keys(row);
  const find = (...candidates) =>
    keys.find((k) => candidates.some((c) => k === c || k.includes(c))) || null;
  return {
    date: find("date", "service_date", "日期", "serviced_on", "service_date"),
    mileage: find("mileage", "odometer", "miles", "km", "odo", "odometer_reading"),
    service: find("service", "type", "service_type", "service_name", "description", "name", "work_performed"),
    cost: find("cost", "price", "amount", "total", "charge"),
    notes: find("notes", "note", "comment", "comments", "description"),
    shop: find("shop", "dealer", "location", "facility", "mechanic"),
  };
}

app.post("/api/cars/import/preview", (req, res) => {
  try {
    const { vehicle_id, content } = req.body || {};
    if (!content) return res.status(400).json({ error: "缺少文件内容" });
    const doc = readCarsConfigDoc();
    const vehicle = (doc.vehicles || []).find((v) => v.id === vehicle_id);
    const schedule = vehicle ? (vehicle.schedule || []) : [];

    const rows = parseCSV(content);
    if (!rows.length) return res.status(400).json({ error: "未能解析到任何记录，请检查文件格式" });

    const cols = detectColumns(rows[0]);
    const records = rows
      .map((r) => {
        const dateRaw = cols.date ? r[cols.date] : "";
        const date = normalizeImportDate(dateRaw);
        const kmRaw = cols.mileage ? r[cols.mileage] : "";
        const kmParsed = kmRaw ? parseFloat(String(kmRaw).replace(/[^\d.]/g, "")) : NaN;
        const km = Number.isFinite(kmParsed) ? kmParsed : null;
        const serviceType = cols.service ? (r[cols.service] || "").trim() : "";
        const costRaw = cols.cost ? r[cols.cost] : "";
        const costParsed = costRaw ? parseFloat(String(costRaw).replace(/[^\d.]/g, "")) : NaN;
        const cost = Number.isFinite(costParsed) ? costParsed : null;
        const notes = cols.notes ? (r[cols.notes] || "").trim() : "";
        const shop = cols.shop ? (r[cols.shop] || "").trim() : "";
        if (!date && !serviceType) return null;
        const matched_schedule_id = matchServiceToSchedule(serviceType, schedule);
        return { date, km, service_type: serviceType, cost, notes, shop, matched_schedule_id };
      })
      .filter(Boolean);

    res.json({
      records,
      vehicle_id,
      columns_detected: cols,
      matched: records.filter((r) => r.matched_schedule_id).length,
      total: records.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/cars/import/apply", (req, res) => {
  try {
    const { vehicle_id, records } = req.body || {};
    if (!vehicle_id) return res.status(400).json({ error: "缺少 vehicle_id" });
    if (!Array.isArray(records) || !records.length) return res.status(400).json({ error: "无记录可导入" });

    const doc = readCarsConfigDoc();
    let vehicle = (doc.vehicles || []).find((v) => v.id === vehicle_id);
    if (!vehicle) return res.status(404).json({ error: "车辆不存在" });

    let updated = 0;
    let created = 0;

    for (const rec of records) {
      if (!rec.matched_schedule_id && !rec.service_type) continue;
      if (rec.matched_schedule_id) {
        const sch = vehicle.schedule.find((s) => s.id === rec.matched_schedule_id);
        if (sch) {
          // 只用比现有更新的记录更新 last_date / last_km
          const recDate = rec.date;
          const isNewer = !sch.last_date || (recDate && recDate > sch.last_date);
          if (isNewer) {
            if (recDate) sch.last_date = recDate;
            if (rec.km != null) sch.last_km = rec.km;
            updated++;
          }
        }
      } else if (rec.service_type) {
        // 新建保养项（未匹配到现有）
        vehicle.schedule.push({
          id: `sch_import_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
          name: rec.service_type.slice(0, 120),
          interval_months: null,
          interval_km: null,
          last_date: rec.date || null,
          last_km: rec.km || null,
          next_date: null,
          next_km: null,
          note: [rec.shop, rec.notes].filter(Boolean).join(" · ").slice(0, 500),
        });
        created++;
      }
    }

    writeJSON(CARS_CONFIG_PATH, doc);
    res.json({ success: true, updated, created });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/preferences", (req, res) => {
  const cur = readJSON(PREFERENCES_PATH);
  const patch = req.body || {};
  if (patch.family) {
    cur.family = { ...(cur.family || {}), ...patch.family };
    if (Array.isArray(patch.family.babies)) {
      cur.family.babies = patch.family.babies;
    }
  }
  if (patch.ui) {
    cur.ui = { ...(cur.ui || {}), ...patch.ui };
  }
  if (patch.shopping) cur.shopping = { ...(cur.shopping || {}), ...patch.shopping };
  if (patch.baby) cur.baby = { ...(cur.baby || {}), ...patch.baby };
  if (patch.cooking) cur.cooking = { ...(cur.cooking || {}), ...patch.cooking };
  if (patch.notifications) cur.notifications = { ...(cur.notifications || {}), ...patch.notifications };
  if (patch.alerts) cur.alerts = { ...(cur.alerts || {}), ...patch.alerts };
  if (patch.llm && typeof patch.llm === "object") {
    cur.llm = { ...(cur.llm || {}) };
    for (const [k, v] of Object.entries(patch.llm)) {
      if (k === "api_key") {
        if (v === undefined || v === null) continue;
        if (typeof v === "string" && (v.trim() === "" || v === "***")) continue;
        cur.llm.api_key = String(v);
      } else {
        cur.llm[k] = v;
      }
    }
  }
  writeJSON(PREFERENCES_PATH, cur);
  res.json({ success: true, preferences: mergePreferencesDisplay() });
});

// ─── 餐食日记：食材 → 菜 → 餐 ────────────────────────────────────────────────

function readMealDiary() {
  return readJSON(MEAL_DIARY_PATH, { version: "1.0", ingredients: [], dishes: [], meals: [] });
}
function writeMealDiary(d) {
  writeJSON(MEAL_DIARY_PATH, d);
}
function genMealId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

app.get("/api/meal-diary", (req, res) => {
  res.json(readMealDiary());
});

app.post("/api/meal-diary/ingredients", (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "名称必填" });
  const d = readMealDiary();
  const ing = { id: genMealId("ing"), name: String(name).trim().slice(0, 80), unit_default: null, tags: [] };
  d.ingredients.push(ing);
  writeMealDiary(d);
  res.json({ success: true, ingredient: ing });
});

app.post("/api/meal-diary/dishes", (req, res) => {
  const { name, ingredient_refs, steps, favorite, notes } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "菜名必填" });
  const d = readMealDiary();
  const dish = {
    id: genMealId("dish"),
    name: String(name).trim().slice(0, 120),
    ingredient_refs: Array.isArray(ingredient_refs) ? ingredient_refs : [],
    steps: steps != null ? String(steps).slice(0, 8000) : "",
    favorite: !!favorite,
    notes: notes != null ? String(notes).slice(0, 2000) : "",
  };
  d.dishes.push(dish);
  writeMealDiary(d);
  res.json({ success: true, dish });
});

app.patch("/api/meal-diary/dishes/:id", (req, res) => {
  const d = readMealDiary();
  const idx = d.dishes.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "菜谱不存在" });
  const patch = req.body || {};
  Object.assign(d.dishes[idx], patch);
  writeMealDiary(d);
  res.json({ success: true, dish: d.dishes[idx] });
});

app.delete("/api/meal-diary/dishes/:id", (req, res) => {
  const d = readMealDiary();
  const idx = d.dishes.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "菜谱不存在" });
  d.dishes.splice(idx, 1);
  writeMealDiary(d);
  res.json({ success: true });
});

app.post("/api/meal-diary/meals", (req, res) => {
  const { date, slot, dish_ids, notes, liked } = req.body || {};
  if (!date || !String(date).trim()) return res.status(400).json({ error: "日期必填" });
  const d = readMealDiary();
  const meal = {
    id: genMealId("meal"),
    date: String(date).trim().slice(0, 10),
    slot: slot || "lunch",
    dish_ids: Array.isArray(dish_ids) ? dish_ids : [],
    notes: notes != null ? String(notes).slice(0, 2000) : "",
    liked: liked !== false,
  };
  d.meals.push(meal);
  writeMealDiary(d);
  res.json({ success: true, meal });
});

app.delete("/api/meal-diary/meals/:id", (req, res) => {
  const d = readMealDiary();
  const idx = d.meals.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "记录不存在" });
  d.meals.splice(idx, 1);
  writeMealDiary(d);
  res.json({ success: true });
});

// ─── 做菜：智能推荐 / 待买食材 ─────────────────────────────────────────────────

app.get("/api/cooking-recommendations", (req, res) => {
  const inv = readJSON(INVENTORY_PATH, { items: [] });
  const invItems = Array.isArray(inv.items) ? inv.items : [];
  const d = readMealDiary();
  const dishes = d.dishes || [];
  const meals = d.meals || [];
  const counts = {};
  for (const m of meals) {
    for (const did of m.dish_ids || []) {
      counts[did] = (counts[did] || 0) + 1;
    }
  }
  const topPairs = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const top_dishes = topPairs.map(([id, count]) => {
    const dish = dishes.find((x) => x.id === id);
    return { dish_id: id, name: dish ? dish.name : id, count };
  });

  const dishPool = new Map();
  for (const [id, count] of topPairs) {
    const dish = dishes.find((x) => x.id === id);
    if (dish) dishPool.set(id, { dish, count });
  }
  for (const dish of dishes) {
    if (dish.favorite && !dishPool.has(dish.id)) {
      dishPool.set(dish.id, { dish, count: counts[dish.id] || 0 });
    }
  }

  const gap_one = [];
  for (const { dish, count } of dishPool.values()) {
    const refs = dish.ingredient_refs || [];
    const lines = refs
      .map((r) => (r && typeof r === "object" && r.text != null ? r.text : r))
      .filter((x) => x != null && String(x).trim());
    if (lines.length === 0) continue;
    const missing = [];
    for (const line of lines) {
      const label = ingredientLabelFromLine(String(line));
      if (!label) continue;
      if (!findMatchingInventoryItem(label, invItems)) missing.push(label);
    }
    if (missing.length === 1) {
      gap_one.push({
        dish_id: dish.id,
        name: dish.name,
        eat_count: count,
        missing: missing[0],
      });
    }
  }
  gap_one.sort((a, b) => b.eat_count - a.eat_count);

  res.json({ top_dishes, gap_one });
});

app.post("/api/cooking/add-restock", (req, res) => {
  const { ingredient_name } = req.body || {};
  if (!ingredient_name || !String(ingredient_name).trim()) {
    return res.status(400).json({ error: "名称必填" });
  }
  const name = String(ingredient_name).trim().slice(0, 80);
  const inv = readJSON(INVENTORY_PATH, { items: [] });
  if (!Array.isArray(inv.items)) inv.items = [];
  const hit = findMatchingInventoryItem(name, inv.items);
  if (hit) {
    const idx = inv.items.findIndex((i) => i.id === hit.id);
    inv.items[idx] = { ...inv.items[idx], restock_needed: true };
    inv.last_updated = today();
    writeJSON(INVENTORY_PATH, inv);
    return res.json({ success: true, mode: "inventory", item_id: hit.id });
  }
  const prefs = readJSON(PREFERENCES_PATH);
  const shop = prefs.shopping || {};
  const pending = Array.isArray(shop.pending_ingredients) ? [...shop.pending_ingredients] : [];
  if (!pending.some((p) => p && p.name === name)) {
    pending.push({ name, at: new Date().toISOString() });
  }
  prefs.shopping = { ...shop, pending_ingredients: pending };
  writeJSON(PREFERENCES_PATH, prefs);
  res.json({ success: true, mode: "pending" });
});

app.delete("/api/cooking/pending-ingredient", (req, res) => {
  const name = (req.query.name || "").trim();
  if (!name) return res.status(400).json({ error: "name 必填" });
  const prefs = readJSON(PREFERENCES_PATH);
  const shop = prefs.shopping || {};
  const pending = Array.isArray(shop.pending_ingredients) ? shop.pending_ingredients : [];
  const next = pending.filter((p) => !p || p.name !== name);
  prefs.shopping = { ...shop, pending_ingredients: next };
  writeJSON(PREFERENCES_PATH, prefs);
  res.json({ success: true });
});

app.post("/api/cooking/llm-recommendations", async (req, res) => {
  const prefs = readJSON(PREFERENCES_PATH);
  try {
    const out = await postCookingRecommendationsLlm(prefs, req.body || {});
    if (!out.ok) return res.status(400).json({ error: out.error });
    res.json({ dishes: out.dishes });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.post("/api/cooking/llm-expand-steps", async (req, res) => {
  const prefs = readJSON(PREFERENCES_PATH);
  try {
    const out = await postCookingExpandStepsLlm(prefs, req.body || {});
    if (!out.ok) return res.status(400).json({ error: out.error });
    res.json({ steps: out.steps });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ─── 日历聚合 ─────────────────────────────────────────────────────────────────

app.get("/api/calendar", (req, res) => {
  const from = (req.query.from || today()).slice(0, 10);
  const to = (req.query.to || today()).slice(0, 10);
  const inv = readJSON(INVENTORY_PATH, { items: [] });
  const babyLog = readBabyLog();
  const meal = readMealDiary();
  const days = {};

  function pushDay(day) {
    if (!days[day]) {
      days[day] = { inventory_adds: [], baby_events: [], meals: [] };
    }
  }

  for (const it of inv.items || []) {
    const pd = it.purchase_date;
    if (pd && pd >= from && pd <= to) {
      pushDay(pd);
      days[pd].inventory_adds.push({
        name: it.name,
        quantity: it.quantity,
        unit: it.unit,
        sources: itemSourcesRow(it),
      });
    }
  }

  for (const ev of babyLog.events || []) {
    // 按本地时区分日（避免 UTC 跨夜归错天）
    const day = localDateStr(ev.time);
    if (day && day >= from && day <= to) {
      pushDay(day);
      days[day].baby_events.push({
        id: ev.id,
        type: ev.type,
        time: toUnixSec(ev.time),   // 下发秒级时间戳
        baby_id: ev.baby_id || null,
        data: ev.data || {},
      });
    }
  }

  for (const m of meal.meals || []) {
    if (m.date >= from && m.date <= to) {
      pushDay(m.date);
      days[m.date].meals.push(m);
    }
  }

  res.json({ from, to, days });
});

// ─── 转运：国内运单（商品）↔ 集运订单 ────────────────────────────────────────

function readTransit() {
  return readJSON(TRANSIT_PATH, { version: "1.0", consolidation_orders: [], domestic_parcels: [] });
}

function writeTransit(data) {
  data.last_updated = new Date().toISOString();
  writeJSON(TRANSIT_PATH, data);
}

function genTransitCoId(orders) {
  const d = today().replace(/-/g, "");
  const n = orders.filter((x) => x.id && String(x.id).startsWith(`co_${d}_`)).length;
  return `co_${d}_${String(n + 1).padStart(3, "0")}`;
}

function genTransitDpId(parcels) {
  const d = today().replace(/-/g, "");
  const n = parcels.filter((x) => x.id && String(x.id).startsWith(`dp_${d}_`)).length;
  return `dp_${d}_${String(n + 1).padStart(3, "0")}`;
}

function normalizeTransitPlatform(p) {
  const s = (p || "").trim();
  if (!s) return "";
  if (TRANSIT_PLATFORMS.includes(s)) return s;
  return s.slice(0, 32);
}

app.get("/api/transit", (req, res) => {
  try {
    const data = readTransit();
    res.json({
      version: data.version || "1.0",
      consolidation_orders: data.consolidation_orders || [],
      domestic_parcels: data.domestic_parcels || [],
      platforms: TRANSIT_PLATFORMS,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/transit/consolidation", (req, res) => {
  try {
    const body = req.body || {};
    const name = (body.name || "").trim();
    if (!name) return res.status(400).json({ error: "集运订单名称必填" });
    const data = readTransit();
    if (!Array.isArray(data.consolidation_orders)) data.consolidation_orders = [];
    const eta = body.eta != null && String(body.eta).trim() ? String(body.eta).trim().slice(0, 32) : null;
    const picked_up = Boolean(body.picked_up);
    const tw = body.total_weight_kg;
    const total_weight_kg = tw === "" || tw == null ? null : Number(tw);
    const us_tracking = (body.us_tracking != null ? String(body.us_tracking) : "").trim().slice(0, 256);
    const fee = body.shipping_fee_cny;
    const shipping_fee_cny = fee === "" || fee == null ? null : Number(fee);
    const row = {
      id: genTransitCoId(data.consolidation_orders),
      name,
      eta,
      picked_up,
      total_weight_kg: Number.isFinite(total_weight_kg) ? total_weight_kg : null,
      us_tracking,
      shipping_fee_cny: Number.isFinite(shipping_fee_cny) ? shipping_fee_cny : null,
      updated_at: new Date().toISOString(),
    };
    data.consolidation_orders.push(row);
    writeTransit(data);
    res.json({ success: true, order: row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/transit/consolidation/:id", (req, res) => {
  try {
    const id = (req.params.id || "").trim();
    const data = readTransit();
    const arr = data.consolidation_orders || [];
    const idx = arr.findIndex((x) => x.id === id);
    if (idx < 0) return res.status(404).json({ error: "集运订单不存在" });
    const body = req.body || {};
    const cur = { ...arr[idx] };
    if (body.name != null) {
      const nm = String(body.name).trim().slice(0, 200);
      if (!nm) return res.status(400).json({ error: "名称不能为空" });
      cur.name = nm;
    }
    if (body.eta !== undefined) {
      const eta = body.eta != null && String(body.eta).trim() ? String(body.eta).trim().slice(0, 32) : null;
      cur.eta = eta;
    }
    if (body.picked_up !== undefined) cur.picked_up = Boolean(body.picked_up);
    if (body.total_weight_kg !== undefined) {
      const tw = body.total_weight_kg;
      cur.total_weight_kg = tw === "" || tw == null ? null : Number(tw);
      if (!Number.isFinite(cur.total_weight_kg)) cur.total_weight_kg = null;
    }
    if (body.us_tracking !== undefined) cur.us_tracking = String(body.us_tracking || "").trim().slice(0, 256);
    if (body.shipping_fee_cny !== undefined) {
      const fee = body.shipping_fee_cny;
      cur.shipping_fee_cny = fee === "" || fee == null ? null : Number(fee);
      if (!Number.isFinite(cur.shipping_fee_cny)) cur.shipping_fee_cny = null;
    }
    cur.updated_at = new Date().toISOString();
    arr[idx] = cur;
    data.consolidation_orders = arr;
    writeTransit(data);
    res.json({ success: true, order: cur });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/transit/consolidation/:id", (req, res) => {
  try {
    const id = (req.params.id || "").trim();
    const data = readTransit();
    const arr = data.consolidation_orders || [];
    const idx = arr.findIndex((x) => x.id === id);
    if (idx < 0) return res.status(404).json({ error: "集运订单不存在" });
    for (const p of data.domestic_parcels || []) {
      if (p.consolidation_id === id) p.consolidation_id = null;
    }
    arr.splice(idx, 1);
    data.consolidation_orders = arr;
    writeTransit(data);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/transit/parcel", (req, res) => {
  try {
    const body = req.body || {};
    const product_title = (body.product_title || "").trim();
    if (!product_title) return res.status(400).json({ error: "商品名称必填（对应 Notion 海淘入库 · 商品）" });
    const data = readTransit();
    if (!Array.isArray(data.domestic_parcels)) data.domestic_parcels = [];
    const cid = (body.consolidation_id || "").trim() || null;
    if (cid) {
      const exists = (data.consolidation_orders || []).some((c) => c.id === cid);
      if (!exists) return res.status(400).json({ error: "所选海运批次不存在" });
    }
    const w = body.weight_kg;
    const weight_kg = w === "" || w == null ? null : Number(w);
    const row = {
      id: genTransitDpId(data.domestic_parcels),
      product_title: product_title.slice(0, 300),
      domestic_tracking: (body.domestic_tracking != null ? String(body.domestic_tracking) : "").trim().slice(0, 128),
      boarded_at: (body.boarded_at != null ? String(body.boarded_at) : "").trim().slice(0, 128),
      consolidation_id: cid,
      platform: normalizeTransitPlatform(body.platform),
      weight_kg: Number.isFinite(weight_kg) ? weight_kg : null,
      updated_at: new Date().toISOString(),
    };
    data.domestic_parcels.push(row);
    writeTransit(data);
    res.json({ success: true, parcel: row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/transit/parcel/:id", (req, res) => {
  try {
    const id = (req.params.id || "").trim();
    const data = readTransit();
    const arr = data.domestic_parcels || [];
    const idx = arr.findIndex((x) => x.id === id);
    if (idx < 0) return res.status(404).json({ error: "国内运单不存在" });
    const body = req.body || {};
    const cur = { ...arr[idx] };
    if (body.product_title != null) {
      const pt = String(body.product_title).trim().slice(0, 300);
      if (!pt) return res.status(400).json({ error: "商品名称不能为空" });
      cur.product_title = pt;
    }
    if (body.domestic_tracking !== undefined) {
      cur.domestic_tracking = String(body.domestic_tracking || "").trim().slice(0, 128);
    }
    if (body.boarded_at !== undefined) cur.boarded_at = String(body.boarded_at || "").trim().slice(0, 128);
    if (body.consolidation_id !== undefined) {
      const cid = String(body.consolidation_id || "").trim() || null;
      if (cid) {
        const exists = (data.consolidation_orders || []).some((c) => c.id === cid);
        if (!exists) return res.status(400).json({ error: "所选海运批次不存在" });
      }
      cur.consolidation_id = cid;
    }
    if (body.platform !== undefined) cur.platform = normalizeTransitPlatform(body.platform);
    if (body.weight_kg !== undefined) {
      const w = body.weight_kg;
      cur.weight_kg = w === "" || w == null ? null : Number(w);
      if (!Number.isFinite(cur.weight_kg)) cur.weight_kg = null;
    }
    cur.updated_at = new Date().toISOString();
    arr[idx] = cur;
    data.domestic_parcels = arr;
    writeTransit(data);
    res.json({ success: true, parcel: cur });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/transit/parcel/:id", (req, res) => {
  try {
    const id = (req.params.id || "").trim();
    const data = readTransit();
    const arr = data.domestic_parcels || [];
    const idx = arr.findIndex((x) => x.id === id);
    if (idx < 0) return res.status(404).json({ error: "国内运单不存在" });
    arr.splice(idx, 1);
    data.domestic_parcels = arr;
    writeTransit(data);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 静态页（必须在 API 之后）────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, "public")));

// 未匹配的 /api 请求返回 JSON，避免前端 r.json() 解析到 HTML 报错
app.use((req, res, next) => {
  if (req.path.startsWith("/api")) {
    return res.status(404).json({ error: "接口不存在", path: req.path, method: req.method });
  }
  next();
});

// API 异常统一 JSON（避免 Express 默认 HTML 错误页）
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (req.path.startsWith("/api") || (req.originalUrl && req.originalUrl.startsWith("/api"))) {
    const msg = err && err.message ? err.message : String(err);
    return res.status(err.status || 500).json({ error: msg });
  }
  res.status(500).send("Server error");
});

// ─── 启动 ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🏠 家庭管理系统已启动`);
  console.log(`   本地访问：http://localhost:${PORT}`);
  console.log(`   手机访问：http://<本机IP>:${PORT}`);
  console.log(`\n   获取本机IP：ifconfig | grep "inet " | grep -v 127`);
});
