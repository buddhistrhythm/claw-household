# Household Agent（家庭智能管理系统）

## Cursor：Notion MCP

本仓库已配置官方 Notion MCP（`.cursor/mcp.json`）。重载 Cursor 后在 **Settings → MCP** 完成 OAuth；详见 `.cursor/README.md`。

## 数据位置
- 库存：`~/家庭管理/data/inventory.json`
- 最近手动录入快捷块：`~/家庭管理/data/manual_import_recent.json`（最多 10 条）
- 按品牌的尿裤段位：`~/家庭管理/config/diaper_brand_segments.json`
- 消耗记录：`~/家庭管理/data/consumption_history.json`
- 餐食日记（食材→菜→餐）：`~/家庭管理/data/meal_diary.json`
- 宝宝日志：`~/家庭管理/data/baby_log.json`
- 品类配置：`~/家庭管理/config/categories.json`
- 购买渠道候选项：`~/家庭管理/config/purchase_channels.json`（网页可追加新渠道）
- 偏好设置：`~/家庭管理/config/preferences.json`（含 `family.babies` 多宝宝列表；未配置 `babies` 时由 `baby_name` / `baby_log.json` 的 `baby` 合并展示）

## Web 底部导航

- **库存** · **补货** · **做菜** · **日历** · **设置** · **宝宝**（仅当存在宝宝时显示；Tab 文案为宝宝名字，多个用 `·` 连接）
- **做菜**：按 Notion 式餐食 log 记录「每餐」；数据结构为 **食材库 → 菜谱（菜）→ 具体一餐**；菜谱可「收藏」
- **日历**：按月查看每日聚合：**入库**（`purchase_date` + 购买渠道）、**宝宝事件**、**三餐记录**
- **设置**：维护多宝宝（保存空列表可关闭宝宝 Tab，不再自动从档案合并）

### API 摘要

- `GET/PATCH /api/preferences`（含 `llm_cooking_ready`：是否已配置大模型，做菜页可用）
- `GET /api/meal-diary`，`POST /api/meal-diary/ingredients|dishes|meals`，`PATCH /api/meal-diary/dishes/:id`（收藏）
- `GET /api/cooking-recommendations`（常吃 Top、只差 1 样食材）
- `POST /api/cooking/llm-recommendations`（`{ count?, hint? }`，需 `preferences.json` 的 `llm`）
- `POST /api/cooking/llm-expand-steps`（`{ name, ingredients[], steps_brief? }`，展开更详细做法）
- `GET /api/calendar?from=&to=` 日聚合

## 库存管理（核心命令）

```bash
# 入库（条码自动查 Open Food Facts）
node ~/家庭管理/skills/inventory.js add <条码或商品名>

# 记录消耗
node ~/家庭管理/skills/inventory.js consume <ID或名称> [数量] [备注]

# 查看所有库存
node ~/家庭管理/skills/inventory.js list

# 查看指定位置库存（如：冰箱冷藏）
node ~/家庭管理/skills/inventory.js list 冰箱冷藏

# 即将过期清单（默认7天）
node ~/家庭管理/skills/inventory.js expiring

# 总览看板
node ~/家庭管理/skills/inventory.js status

# 搜索
node ~/家庭管理/skills/inventory.js search 牛奶
```

## 常用交互场景

| 用户说 | Claude 操作 |
|--------|------------|
| 扫码入库 / 发送条码 | 运行 `add <条码>` 入库 |
| 家里还有什么快过期的 | 运行 `expiring 7` |
| 今晚吃什么 | 查库存 → 查菜谱 → 推荐 |
| 做好了 / 用掉了XX | 运行 `consume <名称> <数量>` |
| 看看家里有什么 | 运行 `status` 或 `list` |
| 生成购物清单 | 查 expiring + 库存不足 + 当前菜谱缺料 |

## 入库数据结构

```json
{
  "id": "inv_YYYYMMDD_001",
  "barcode": "690...",
  "name": "商品名",
  "brand": "品牌",
  "category": "dairy",
  "location": "冰箱冷藏",
  "purchase_date": "2026-03-22",
  "expiry_date": "2026-04-05",
  "quantity": 1,
  "unit": "盒",
  "unit_price": null,
  "sources": ["盒马", "叮咚买菜"],
  "icon": "🥬",
  "restock_needed": false,
  "priority": null,
  "notes": "备注（Notes）",
  "comments": [{ "at": "2026-03-22T12:00:00.000Z", "text": "留言记录（Comments）" }],
  "tags": [],
  "status": "in_stock",
  "consumption_log": []
}
```

- **icon**：可选 emoji；未填时 Web 按品类显示默认图标。
- **restock_needed**：手动「需补货」标记（与预测补货独立）。
- **priority**：`low` / `medium` / `high` 或空。
- **sources**：购买渠道字符串数组，可多选；旧数据里的单字段 `source` 会自动当作单元素兼容。
- **notes**：长备注；**comments** 为带时间戳的留言列表（可在网页物品详情里追加）。
- 补货页按 **购买渠道** 分组，可勾选只看部分渠道，并 **导出 Markdown 勾选清单**（按渠道分节）。

## 保质期预警规则
- 🔴 紧急：剩余 ≤ 3天 → 立即提醒
- 🟡 注意：剩余 ≤ 7天 → 每日摘要提醒
- 🟢 正常：剩余 > 7天

## 即将实现（Phase 2）
- 买菜备菜做菜 Agent（Cookidoo 菜谱集成）
- 购物清单自动生成

## 宝宝消耗与补货预测

- `baby_log.json` 中的 **换尿布**、**奶瓶喂奶** 会合并进纸尿裤 / 奶粉 / **水奶（品类键 `ready_to_feed`，英文 ready-to-feed formula）** 库存的消耗预测（与 `consumption_history.json` 叠加）。
- **纸尿裤（段位）**：库存项可设 `diaper_spec`（段位、体重 kg 区间、`pieces_per_box`+`sales_unit` 箱/包规格）。系统按生长记录 **carry-forward 体重**，仅当某日体重落在该 SKU 的 `[weight_min_kg, weight_max_kg]` 内时，才把当日的换尿布次数计入该条库存的预测。无 `diaper_spec` 时回退为单 SKU 模式（`baby.track_item_ids.diaper` 或库内唯一尿裤）。
- 尿布：每次换尿布计 `diaper_qty_per_change` 片（默认 1）。
- 奶粉：按冲调量估算用粉量：`克/天 ≈ Σ(ml) / formula_ml_per_gram`（默认每克约 7ml 冲调，可按奶粉说明改）。仅统计喂奶记录里类型为「奶粉冲调」或未标 `milk_type` 的条目。
- **水奶 / RTF**（品类键 **`ready_to_feed`**）：库存按 **瓶**；每条库存可设 **`ready_to_feed_spec`**：`stage`（1/2 段）、`grams_per_bottle`、`bottles_per_case`、`bottle_format`（`small_2oz` 按次向上取整瓶；`large_32oz` 可有零整）。宝宝页喂奶选「水奶」时 `data.milk_type: "ready_to_feed"`（旧数据可能仍为 `water_milk`，预测兼容）。
- 段位模板见 `config/diaper_segments.json`，可在 Web 入库表单选用。
- 多 SKU 时可在 `config/preferences.json` → `baby.track_item_ids` 指定 `diaper` / `formula` / `ready_to_feed` 对应的 `inv_` 库存 ID（旧键 `water_milk` 仍可读）；若某品类在库仅 1 条，会自动关联。

## Web 界面

- **库存** Tab：右上角 **+** 展开三种入库方式（手动录入 / 扫码 / 拍照）；手动表单在选中后展开。下方为库存列表与 EasyLog `.btcp` 导入（与预测联动）。

## 即将实现（Phase 3）
- 宝宝记录 Agent（扩展）
- 购物清单与补货自动化
