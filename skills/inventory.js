#!/usr/bin/env node
/**
 * 家庭智能管理系统 — 库存管理引擎
 * 用法:
 *   node inventory.js add <条码或名称>   # 入库（自动调用 Open Food Facts）
 *   node inventory.js consume <id> <数量>  # 消耗记录
 *   node inventory.js list [位置]          # 查看库存
 *   node inventory.js expiring [天数]       # 查看即将过期（默认7天）
 *   node inventory.js search <关键词>       # 搜索库存
 *   node inventory.js status               # 库存总览看板
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const BASE_DIR = path.join(__dirname, "..");
const INVENTORY_PATH = path.join(BASE_DIR, "data", "inventory.json");
const CONSUMPTION_PATH = path.join(BASE_DIR, "data", "consumption_history.json");
const CATEGORIES_PATH = path.join(BASE_DIR, "config", "categories.json");
const PREFERENCES_PATH = path.join(BASE_DIR, "config", "preferences.json");

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function today() {
  return new Date().toISOString().split("T")[0];
}

function daysUntil(dateStr) {
  const target = new Date(dateStr);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.ceil((target - now) / (1000 * 60 * 60 * 24));
}

function generateId() {
  const d = today().replace(/-/g, "");
  const inv = readJSON(INVENTORY_PATH);
  const seq = String(inv.items.length + 1).padStart(3, "0");
  return `inv_${d}_${seq}`;
}

function expiryAlert(days) {
  const prefs = readJSON(PREFERENCES_PATH);
  if (days <= 0) return "🔴 已过期";
  if (days <= prefs.alerts.urgent_days) return "🔴 紧急";
  if (days <= prefs.alerts.warning_days) return "🟡 注意";
  return "🟢 正常";
}

// ─── Open Food Facts 条码查询 ─────────────────────────────────────────────────

function fetchProductByBarcode(barcode) {
  return new Promise((resolve, reject) => {
    const url = `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`;
    https
      .get(url, { headers: { "User-Agent": "HomeManagementSystem/1.0" } }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            if (data.status === 1 && data.product) {
              const p = data.product;
              resolve({
                name:
                  p.product_name_zh ||
                  p.product_name ||
                  p.product_name_en ||
                  "未知商品",
                brand: p.brands || "",
                category: mapCategory(p.categories_tags || []),
                barcode,
              });
            } else {
              resolve(null); // 未找到
            }
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

function mapCategory(tags) {
  const tagStr = tags.join(",").toLowerCase();
  if (tagStr.includes("dairy") || tagStr.includes("milk")) return "dairy";
  if (tagStr.includes("meat") || tagStr.includes("beef") || tagStr.includes("pork")) return "meat_fresh";
  if (tagStr.includes("vegetable") || tagStr.includes("légumes")) return "vegetable";
  if (tagStr.includes("fruit")) return "fruit";
  if (tagStr.includes("cereal") || tagStr.includes("grain") || tagStr.includes("rice")) return "grain";
  if (tagStr.includes("snack") || tagStr.includes("chips")) return "snack";
  if (tagStr.includes("beverage") || tagStr.includes("drink")) return "beverage";
  if (tagStr.includes("condiment") || tagStr.includes("sauce") || tagStr.includes("oil")) return "condiment";
  return "other";
}

// ─── 命令：入库 ───────────────────────────────────────────────────────────────

async function cmdAdd(input) {
  const categories = readJSON(CATEGORIES_PATH);
  let productInfo = null;
  let isBarcode = /^\d{8,14}$/.test(input.trim());

  if (isBarcode) {
    console.log(`🔍 查询条码 ${input}...`);
    productInfo = await fetchProductByBarcode(input.trim());
    if (productInfo) {
      console.log(`✅ 找到商品：${productInfo.name}${productInfo.brand ? ` (${productInfo.brand})` : ""}`);
    } else {
      console.log(`⚠️  Open Food Facts 未收录此条码，将以手动模式录入`);
    }
  }

  // 构建库存记录（需要用户补充信息时，此处打印提示）
  const category = productInfo?.category || "other";
  const catConfig = categories[category] || categories["other"];
  const purchaseDate = today();
  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() + catConfig.default_shelf_days);

  const item = {
    id: generateId(),
    barcode: isBarcode ? input.trim() : null,
    name: productInfo?.name || input,
    brand: productInfo?.brand || null,
    category,
    location: catConfig.location,
    purchase_date: purchaseDate,
    expiry_date: expiryDate.toISOString().split("T")[0],
    quantity: 1,
    unit: "个",
    unit_price: null,
    sources: [],
    tags: [],
    icon: null,
    restock_needed: false,
    priority: null,
    notes: null,
    comments: [],
    status: "in_stock",
    consumption_log: [],
  };

  const inv = readJSON(INVENTORY_PATH);
  inv.items.push(item);
  inv.last_updated = today();
  writeJSON(INVENTORY_PATH, inv);

  console.log(`\n📦 入库成功！`);
  console.log(`   ID：${item.id}`);
  console.log(`   名称：${item.name}`);
  console.log(`   品类：${catConfig.label}`);
  console.log(`   存放：${item.location}`);
  console.log(`   保质期至：${item.expiry_date}（剩余 ${daysUntil(item.expiry_date)} 天）`);
  console.log(`\n💡 可用 "node inventory.js edit ${item.id}" 补充数量、价格等信息`);
}

// ─── 命令：消耗记录 ───────────────────────────────────────────────────────────

function cmdConsume(idOrName, qty, note) {
  const inv = readJSON(INVENTORY_PATH);
  const consumption = readJSON(CONSUMPTION_PATH);
  const amount = parseFloat(qty) || 1;

  // 支持 ID 或名称模糊匹配
  let item = inv.items.find(
    (i) => i.id === idOrName || i.name.includes(idOrName)
  );

  if (!item) {
    console.log(`❌ 找不到物品：${idOrName}`);
    return;
  }

  item.quantity = Math.max(0, item.quantity - amount);
  if (item.quantity === 0) item.status = "consumed";

  item.consumption_log.push({
    date: today(),
    qty: amount,
    note: note || "",
  });

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
  writeJSON(INVENTORY_PATH, inv);
  writeJSON(CONSUMPTION_PATH, consumption);

  console.log(`✅ 已记录：${item.name} 消耗 ${amount} ${item.unit}`);
  console.log(`   剩余库存：${item.quantity} ${item.unit}`);
  if (item.quantity === 0) {
    console.log(`   ⚠️  已清零，记得补货！`);
  }
}

// ─── 命令：查看库存 ───────────────────────────────────────────────────────────

function cmdList(filter) {
  const inv = readJSON(INVENTORY_PATH);
  const categories = readJSON(CATEGORIES_PATH);

  let items = inv.items.filter((i) => i.status === "in_stock");
  if (filter) {
    items = items.filter(
      (i) =>
        i.location.includes(filter) ||
        i.category === filter ||
        (categories[i.category]?.label || "").includes(filter)
    );
  }

  if (items.length === 0) {
    console.log(`📭 库存为空${filter ? `（筛选：${filter}）` : ""}`);
    return;
  }

  // 按位置分组
  const grouped = {};
  items.forEach((item) => {
    const loc = item.location || "未分类";
    if (!grouped[loc]) grouped[loc] = [];
    grouped[loc].push(item);
  });

  console.log(`\n📦 当前库存${filter ? `（${filter}）` : ""}：\n`);
  for (const [location, locItems] of Object.entries(grouped)) {
    console.log(`📍 ${location}`);
    locItems.forEach((item) => {
      const days = daysUntil(item.expiry_date);
      const alert = expiryAlert(days);
      console.log(
        `  ${alert} ${item.name} × ${item.quantity}${item.unit}  ` +
          `（到期：${item.expiry_date}，剩 ${days} 天）`
      );
    });
    console.log();
  }
  console.log(`共 ${items.length} 种物品`);
}

// ─── 命令：即将过期 ───────────────────────────────────────────────────────────

function cmdExpiring(days) {
  const threshold = parseInt(days) || 7;
  const inv = readJSON(INVENTORY_PATH);

  const expiring = inv.items
    .filter((i) => i.status === "in_stock")
    .map((i) => ({ ...i, daysLeft: daysUntil(i.expiry_date) }))
    .filter((i) => i.daysLeft <= threshold)
    .sort((a, b) => a.daysLeft - b.daysLeft);

  if (expiring.length === 0) {
    console.log(`✅ 未来 ${threshold} 天内没有过期物品`);
    return;
  }

  console.log(`\n⚠️  即将过期（${threshold}天内）：\n`);
  expiring.forEach((item) => {
    const alert = expiryAlert(item.daysLeft);
    console.log(
      `${alert} ${item.name}  ` +
        `剩余：${item.quantity}${item.unit}  ` +
        `到期：${item.expiry_date}（${item.daysLeft <= 0 ? "已过期" : `还剩 ${item.daysLeft} 天`}）`
    );
  });
}

// ─── 命令：搜索 ───────────────────────────────────────────────────────────────

function cmdSearch(keyword) {
  const inv = readJSON(INVENTORY_PATH);
  const categories = readJSON(CATEGORIES_PATH);

  const results = inv.items.filter(
    (i) =>
      i.name.includes(keyword) ||
      (i.brand && i.brand.includes(keyword)) ||
      (categories[i.category]?.label || "").includes(keyword) ||
      i.tags.some((t) => t.includes(keyword))
  );

  if (results.length === 0) {
    console.log(`🔍 未找到：${keyword}`);
    return;
  }

  console.log(`\n🔍 搜索「${keyword}」结果：\n`);
  results.forEach((item) => {
    const days = daysUntil(item.expiry_date);
    const alert = expiryAlert(days);
    const status = item.status === "in_stock" ? "" : `[${item.status}]`;
    console.log(
      `${alert} ${item.name} ${status}  ` +
        `${item.quantity}${item.unit} @ ${item.location}  ` +
        `(ID: ${item.id})`
    );
  });
}

// ─── 命令：总览看板 ───────────────────────────────────────────────────────────

function cmdStatus() {
  const inv = readJSON(INVENTORY_PATH);
  const categories = readJSON(CATEGORIES_PATH);
  const prefs = readJSON(PREFERENCES_PATH);

  const inStock = inv.items.filter((i) => i.status === "in_stock");
  const urgent = inStock.filter((i) => daysUntil(i.expiry_date) <= prefs.alerts.urgent_days);
  const warning = inStock.filter(
    (i) =>
      daysUntil(i.expiry_date) > prefs.alerts.urgent_days &&
      daysUntil(i.expiry_date) <= prefs.alerts.warning_days
  );

  console.log(`\n🏠 家庭库存总览 — ${today()}`);
  console.log(`${"─".repeat(50)}`);
  console.log(`📦 总库存：${inStock.length} 种物品`);
  console.log(`🔴 紧急过期（≤${prefs.alerts.urgent_days}天）：${urgent.length} 种`);
  console.log(`🟡 注意过期（≤${prefs.alerts.warning_days}天）：${warning.length} 种`);
  console.log();

  // 按品类统计
  const byCat = {};
  inStock.forEach((i) => {
    const label = categories[i.category]?.label || i.category;
    byCat[label] = (byCat[label] || 0) + 1;
  });
  console.log(`📊 按品类：`);
  Object.entries(byCat)
    .sort((a, b) => b[1] - a[1])
    .forEach(([cat, count]) => console.log(`   ${cat}：${count} 种`));

  if (urgent.length > 0) {
    console.log(`\n🚨 需立即处理：`);
    urgent.forEach((item) => {
      const days = daysUntil(item.expiry_date);
      console.log(
        `   ${item.name}（${item.quantity}${item.unit}，` +
          `${days <= 0 ? "已过期" : `还剩 ${days} 天`}）`
      );
    });
  }

  console.log(`\n最后更新：${inv.last_updated}`);
}

// ─── 主入口 ───────────────────────────────────────────────────────────────────

const [, , cmd, ...args] = process.argv;

(async () => {
  switch (cmd) {
    case "add":
      if (!args[0]) { console.log("用法：node inventory.js add <条码或商品名>"); break; }
      await cmdAdd(args[0]);
      break;
    case "consume":
      if (!args[0]) { console.log("用法：node inventory.js consume <ID或名称> [数量] [备注]"); break; }
      cmdConsume(args[0], args[1], args[2]);
      break;
    case "list":
      cmdList(args[0]);
      break;
    case "expiring":
      cmdExpiring(args[0]);
      break;
    case "search":
      if (!args[0]) { console.log("用法：node inventory.js search <关键词>"); break; }
      cmdSearch(args[0]);
      break;
    case "status":
      cmdStatus();
      break;
    default:
      console.log(`
🏠 家庭智能管理系统 — 库存引擎 v1.0

命令：
  add <条码/名称>          入库（条码自动查 Open Food Facts）
  consume <ID/名称> [数量]  记录消耗
  list [位置/品类]          查看库存
  expiring [天数]           即将过期清单（默认7天）
  search <关键词>           搜索库存
  status                   总览看板
      `);
  }
})();
