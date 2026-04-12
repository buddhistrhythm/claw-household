---
name: household
description: "Search and manage the user's household inventory, meal planning, baby tracking, and shopping lists. Use when the user asks about groceries, expiring items, what to cook, baby supplies, or restocking."
metadata: {"openclaw":{"homepage":"https://github.com/buddhistrhythm/claw-household","requires":{"bins":["node"]},"install":[{"id":"node","kind":"node","package":"claw-household","bins":["claw"],"label":"Install Claw Household (npm)"}]}}
---

# Claw — Household Agent Skill

家庭智能管理助手 — Claude Code companion.

## Install

```bash
npx claw-household skill install   # or:
npm install -g claw-household && claw skill install
```

## MCP Tools (stdio)

12 MCP tools via stdio transport:

### Inventory
- `inventory_list` — 查看库存（支持按位置/品类/状态筛选）
- `inventory_add` — 入库（条码自动查询 Open Food Facts）
- `inventory_consume` — 记录消耗（按 ID 或名称）
- `inventory_expiring` — 即将过期清单
- `inventory_status` — 库存总览看板

### Decision
- `restock_recommendations` — 补货推荐（基于消耗速度 + 库存余量）
- `meal_suggestions` — 今天吃什么（基于现有库存 + 收藏菜谱）
- `shopping_list` — 生成购物清单（综合补货 + 过期 + 菜谱缺料）

### Baby
- `baby_log_event` — 记录宝宝事件（喂奶、换尿布、睡眠等）
- `baby_supply_status` — 宝宝用品消耗状态和预测

### Config
- `preferences_get` — 读取偏好设置
- `preferences_update` — 更新偏好设置

## CLI Commands

```bash
claw status              # 库存总览
claw list [location]     # 库存列表
claw add <barcode|name>  # 入库
claw consume <id|name>   # 消耗
claw expiring [days]     # 过期预警
claw search <keyword>    # 搜索
claw serve               # 启动 Web 面板
```

## Claude Code / OpenClaw Setup

**Option 1: Skill file** (via CLI)
```bash
claw skill install
```

**Option 2: MCP server** (add to agent settings)
```json
{
  "mcpServers": {
    "household": {
      "command": "node",
      "args": ["/path/to/claw-household/skills/mcp-server.js"]
    }
  }
}
```

## Natural Language Examples

| You say | Tool called |
|---------|------------|
| 家里还有什么菜 | `inventory_list` |
| 帮我记一下买了牛奶 | `inventory_add` |
| 鸡蛋用完了 | `inventory_consume` |
| 什么快过期了 | `inventory_expiring` |
| 这周要买什么 | `shopping_list` |
| 冰箱里的东西能做什么 | `meal_suggestions` |
| 宝宝水奶还能撑几天 | `baby_supply_status` |
| 记一下宝宝喝了 120ml 奶 | `baby_log_event` |

## Data

All data stored locally under `data/` and `config/`. No cloud, no account required (unless multi-user OAuth is configured).
