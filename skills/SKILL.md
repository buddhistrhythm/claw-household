---
name: household
description: Household management agent — track groceries, predict restocking, plan meals, monitor baby supplies. Uses local JSON storage with MCP stdio transport for Claude Code and OpenClaw integration.
metadata: {"openclaw":{"homepage":"https://github.com/s546126/household-agent","requires":{"bins":["node"]},"install":[{"id":"node","kind":"node","package":"household-agent","bins":["node"],"label":"Install Household Agent (npm)"}]}}
---

# Household Agent Skill

家庭智能管理助手 — 让 AI 帮你做家务小决策。

## MCP Tools (stdio)

This skill exposes 12 MCP tools via stdio transport:

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

## Setup

```bash
cd /path/to/household
npm install
```

### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "household": {
      "command": "node",
      "args": ["/path/to/household/skills/mcp-server.js"]
    }
  }
}
```

### OpenClaw

Import this skill folder via OpenClaw Skill Manager, or copy `skills/` into your OpenClaw skills directory. The MCP server runs via:

```
command: node
args: [skills/mcp-server.js]
```

## Baby Tracker Import

Supports importing baby life records from [Baby Tracker](https://nighp.com/babytracker/) app (.btcp format):

```bash
node skills/import-btcp.js <file.btcp> [--dry-run] [--tz=8]
```

Or via the web dashboard: upload `.btcp` file at `POST /api/import/btcp`.

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

All data stored as local JSON files under `data/` and `config/`. No cloud, no database server, no account required.
