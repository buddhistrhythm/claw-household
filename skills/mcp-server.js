#!/usr/bin/env node
'use strict';

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const {
  listItems,
  addItem,
  patchItem,
  consumeItem,
  deleteItem,
  getItem,
  restockList,
  inventoryStatus,
  fetchProductByBarcode,
  inferCategory,
} = require("./lib/inventory-ops");

const {
  listBabyEvents,
  babyStats,
  logBabyEvent,
  deleteBabyEvent,
} = require("./lib/baby-ops");

const {
  cookingRecommendations,
  addRestockFromCooking,
  deletePendingIngredient,
  addDish,
  patchDish,
  deleteDish,
  addMeal,
  deleteMeal,
  addIngredient,
} = require("./lib/meal-ops");

const { PATHS, readJSON, writeJSON } = require("./lib/data");

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "household-agent",
  version: "1.0.0",
});

// ─── 库存类 Tools ─────────────────────────────────────────────────────────────

server.tool(
  "inventory_list",
  "查看库存列表，支持按位置/品类/状态筛选",
  {
    location: z.string().optional().describe("按位置筛选，如 冷藏、冷冻、常温"),
    category: z.string().optional().describe("按品类筛选，如 dairy、meat_fresh"),
    status: z.enum(["in_stock", "consumed", "expired"]).optional().describe("按状态筛选"),
  },
  async ({ location, category, status }) => {
    const items = listItems({ location, status });
    let result = items;
    if (category) {
      result = result.filter((i) => i.category === category);
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ items: result, count: result.length }, null, 2) }],
    };
  }
);

server.tool(
  "inventory_suggest",
  "根据商品名称推荐入库配置（分类、保质期、存放位置）。入库前先调用此 tool 获取推荐，再用 inventory_add 入库。支持条码查询和名称关键词推断。",
  {
    name: z.string().describe("商品名称，如 牛奶、纸尿裤、西红柿"),
    barcode: z.string().optional().describe("商品条码（可选，查询 Open Food Facts 获取更精确信息）"),
  },
  async ({ name, barcode }) => {
    const categories = readJSON(PATHS.CATEGORIES);

    // 1. Try barcode lookup first
    if (barcode) {
      try {
        const data = await fetchProductByBarcode(barcode);
        if (data && data.found !== false) {
          const cat = data.category || "other";
          const catConfig = categories[cat] || categories["other"];
          const expiryDate = new Date();
          expiryDate.setDate(expiryDate.getDate() + catConfig.default_shelf_days);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                source: "barcode_lookup",
                name: data.name || name,
                brand: data.brand || null,
                category: cat,
                category_label: catConfig.label,
                location: data.location || catConfig.location,
                default_shelf_days: catConfig.default_shelf_days,
                suggested_expiry_date: expiryDate.toISOString().split("T")[0],
                image_url: data.image_url || null,
              }, null, 2),
            }],
          };
        }
      } catch {}
    }

    // 2. Local keyword inference from name
    const inferred = inferCategory(name);
    const cat = inferred || "other";
    const catConfig = categories[cat] || categories["other"];
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + catConfig.default_shelf_days);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          source: inferred ? "name_inference" : "default",
          name,
          category: cat,
          category_label: catConfig.label,
          location: catConfig.location,
          default_shelf_days: catConfig.default_shelf_days,
          suggested_expiry_date: expiryDate.toISOString().split("T")[0],
          note: inferred
            ? `根据名称「${name}」推断为「${catConfig.label}」`
            : `未能识别品类，使用默认配置。建议指定 category 参数。`,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  "inventory_add",
  "入库新商品，支持条码自动查询或手动录入。建议先调用 inventory_suggest 获取推荐配置。",
  {
    name: z.string().describe("商品名称"),
    barcode: z.string().optional().describe("商品条码（可选，自动查询 Open Food Facts）"),
    category: z.string().optional().describe("品类代码，如 dairy, meat_fresh, vegetable"),
    location: z.string().optional().describe("存放位置，如 冷藏、冷冻、常温"),
    quantity: z.number().optional().describe("数量，默认 1"),
    unit: z.string().optional().describe("单位，默认 个"),
    expiry_date: z.string().optional().describe("过期日期 YYYY-MM-DD"),
    sources: z.array(z.string()).optional().describe("购买渠道"),
  },
  async (args) => {
    let barcodeData = null;
    if (args.barcode) {
      try {
        barcodeData = await fetchProductByBarcode(args.barcode);
      } catch {}
    }
    const body = { ...args };
    if (barcodeData && barcodeData.found !== false) {
      if (!body.name || body.name === args.barcode) body.name = barcodeData.name || body.name;
      if (!body.category) body.category = barcodeData.category;
      if (!body.location) body.location = barcodeData.location;
    }
    const result = addItem(body);
    return {
      content: [{ type: "text", text: JSON.stringify({ id: result.item.id, item: result.item }, null, 2) }],
    };
  }
);

server.tool(
  "inventory_consume",
  "记录消耗，按 ID 或名称查找商品",
  {
    id_or_name: z.string().describe("商品 ID 或名称"),
    quantity: z.number().optional().describe("消耗数量，默认 1"),
    note: z.string().optional().describe("备注"),
  },
  async ({ id_or_name, quantity, note }) => {
    // Try by ID first
    try {
      const result = consumeItem(id_or_name, quantity || 1, note);
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, remaining: result.item.quantity }, null, 2) }],
      };
    } catch {
      // Not found by ID, try by name
    }

    // Search by name
    const items = listItems({ status: "in_stock" });
    const matches = items.filter((i) =>
      i.name.toLowerCase().includes(id_or_name.toLowerCase()) ||
      id_or_name.toLowerCase().includes(i.name.toLowerCase())
    );

    if (matches.length === 0) {
      throw new Error(`未找到匹配「${id_or_name}」的商品`);
    }
    if (matches.length > 1) {
      const names = matches.map((m) => `${m.id}: ${m.name}`).join(", ");
      throw new Error(`名称「${id_or_name}」匹配到多个商品，请指定 ID: ${names}`);
    }

    const result = consumeItem(matches[0].id, quantity || 1, note);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: true, remaining: result.item.quantity }, null, 2) }],
    };
  }
);

server.tool(
  "inventory_expiring",
  "查看即将过期的商品",
  {
    days: z.number().optional().describe("天数阈值，默认 7"),
  },
  async ({ days }) => {
    const threshold = days || 7;
    const items = listItems({ status: "in_stock" });
    const expiring = items.filter((i) => i.days_left <= threshold);
    expiring.sort((a, b) => a.days_left - b.days_left);
    return {
      content: [{ type: "text", text: JSON.stringify({ items: expiring, count: expiring.length }, null, 2) }],
    };
  }
);

server.tool(
  "inventory_status",
  "库存总览看板：总数、按位置/品类统计、即将过期数",
  {},
  async () => {
    const stats = inventoryStatus();
    return {
      content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
    };
  }
);

// ─── 决策类 Tools ─────────────────────────────────────────────────────────────

server.tool(
  "restock_recommendations",
  "补货推荐：基于消耗速度+库存余量+宝宝消耗预测",
  {
    include_baby: z.boolean().optional().describe("是否包含宝宝用品，默认 true"),
  },
  async ({ include_baby }) => {
    let items = restockList();
    if (include_baby === false) {
      const babyCats = new Set(["diaper", "formula", "ready_to_feed", "baby_food", "baby_snack", "wipes"]);
      items = items.filter((i) => !babyCats.has(i.category));
    }
    const result = items.map((i) => ({
      name: i.name,
      days_remaining: i.prediction?.days_until_empty ?? null,
      urgency: i.prediction?.restock_urgency || "unknown",
      suggested_quantity: i.quantity || 1,
      source: (i.sources || [])[0] || "未知",
    }));
    return {
      content: [{ type: "text", text: JSON.stringify({ items: result }, null, 2) }],
    };
  }
);

server.tool(
  "meal_suggestions",
  "今天吃什么：基于现有库存食材和收藏菜谱推荐",
  {
    count: z.number().optional().describe("推荐数量，默认 5"),
    hint: z.string().optional().describe("口味偏好提示，如 清淡、辣"),
  },
  async ({ count, hint }) => {
    const recs = cookingRecommendations();
    const suggestions = [
      ...recs.top_dishes.slice(0, count || 5).map((d) => ({
        dish_name: d.name,
        reason: `常做菜（做过 ${d.count} 次）`,
        ingredients_missing: [],
      })),
      ...recs.gap_one.slice(0, 3).map((d) => ({
        dish_name: d.name,
        reason: `只差一样：${d.missing}`,
        ingredients_missing: [d.missing],
      })),
    ];
    return {
      content: [{ type: "text", text: JSON.stringify({ suggestions: suggestions.slice(0, count || 5) }, null, 2) }],
    };
  }
);

server.tool(
  "shopping_list",
  "生成购物清单：综合补货推荐+过期+菜谱缺料",
  {
    group_by: z.enum(["source", "category"]).optional().describe("分组方式，默认 source"),
  },
  async ({ group_by }) => {
    const restock = restockList();
    const groupKey = group_by || "source";
    const groups = {};

    for (const item of restock) {
      let key;
      if (groupKey === "source") {
        key = (item.sources || [])[0] || "未分类";
      } else {
        key = item.category_label || item.category || "其他";
      }
      if (!groups[key]) groups[key] = [];
      groups[key].push({
        name: item.name,
        quantity: `${item.quantity || 1} ${item.unit || "个"}`,
        reason: item.pending_only
          ? "做菜待买"
          : item.prediction?.restock_urgency === "overdue"
            ? "已耗尽"
            : item.prediction?.restock_urgency === "urgent"
              ? "即将用完"
              : "补货推荐",
      });
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ groups, total_items: restock.length }, null, 2),
      }],
    };
  }
);

// ─── 宝宝类 Tools ─────────────────────────────────────────────────────────────

server.tool(
  "baby_log_event",
  "记录宝宝事件（喂奶、换尿布、睡眠等）",
  {
    type: z.enum([
      "feeding_bottle", "feeding_nursing", "feeding_solid",
      "diaper", "sleep", "growth", "milestone", "bath", "medicine", "doctor_visit",
    ]).describe("事件类型"),
    baby_id: z.string().optional().describe("宝宝 ID（多宝宝时使用）"),
    data: z.record(z.unknown()).optional().describe("事件数据，如 { amount_ml: 120 }"),
    note: z.string().optional().describe("备注"),
  },
  async ({ type, baby_id, data, note }) => {
    const eventData = { ...(data || {}) };
    if (note) eventData.note = note;
    const event = logBabyEvent({ type, data: eventData, baby_id });
    return {
      content: [{ type: "text", text: JSON.stringify({ event_id: event.id, logged_at: event.time }, null, 2) }],
    };
  }
);

server.tool(
  "baby_supply_status",
  "宝宝用品消耗状态和预测（水奶/尿布剩余天数）",
  {
    baby_id: z.string().optional().describe("宝宝 ID"),
  },
  async () => {
    // Get baby-related inventory items with predictions
    const items = listItems({ status: "in_stock" });
    const babyCats = new Set(["diaper", "formula", "ready_to_feed", "baby_food", "baby_snack", "wipes"]);
    const babyItems = items.filter((i) => babyCats.has(i.category));
    const supplies = babyItems.map((i) => ({
      name: i.name,
      remaining: i.quantity,
      unit: i.unit || "个",
      daily_rate: i.prediction?.avg_daily || 0,
      days_until_empty: i.prediction?.days_until_empty ?? null,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify({ supplies }, null, 2) }],
    };
  }
);

// ─── 配置类 Tools ─────────────────────────────────────────────────────────────

server.tool(
  "preferences_get",
  "读取偏好设置",
  {},
  async () => {
    const prefs = readJSON(PATHS.PREFERENCES);
    // Mask API key for safety
    if (prefs.llm?.api_key) {
      prefs.llm.api_key = "***";
    }
    return {
      content: [{ type: "text", text: JSON.stringify(prefs, null, 2) }],
    };
  }
);

server.tool(
  "preferences_update",
  "更新偏好设置（浅合并顶层字段）",
  {
    key: z.string().describe("顶层字段名，如 family、shopping、baby"),
    value: z.unknown().describe("新值，整体替换该字段"),
  },
  async ({ key, value }) => {
    if (key === "llm") {
      throw new Error("安全限制：不能通过 MCP 修改 LLM 配置，请通过 Web 界面操作");
    }
    const prefs = readJSON(PATHS.PREFERENCES);
    prefs[key] = value;
    writeJSON(PATHS.PREFERENCES, prefs);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: true }, null, 2) }],
    };
  }
);

// ─── 启动 ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("household-agent MCP server failed to start:", err);
  process.exit(1);
});
