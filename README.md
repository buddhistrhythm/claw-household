# Household Agent

**English** | [🌐 中文](./README_CN.md)

AI-powered household management — let AI handle the small daily decisions so you don't have to.

Track groceries, predict restocking needs, plan meals from what's in your fridge, and monitor baby supplies — all through Claude Code (MCP), CLI, or a local web dashboard.

## Quick Start

```bash
npm install
npm start          # Web dashboard at http://localhost:3333
```

## Usage

### Claude Code (MCP)

Add to your Claude Code MCP config (`~/.claude/settings.json`):

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

Then just talk naturally:

- "What groceries do we have?" → `inventory_list`
- "What do we need to buy this week?" → `shopping_list`
- "How many days of baby formula left?" → `baby_supply_status`
- "Log 3 diapers used" → `baby_log_event`
- "What can I cook with what's in the fridge?" → `meal_suggestions`

### OpenClaw

Import the `skills/` folder via OpenClaw Skill Manager, or add MCP config:

```
command: node
args: [/path/to/household/skills/mcp-server.js]
```

Skill metadata is defined in [`skills/SKILL.md`](./skills/SKILL.md).

### CLI

```bash
node skills/inventory.js add <barcode or name>     # Add item (auto-lookup via Open Food Facts)
node skills/inventory.js consume <ID or name> [qty] # Record consumption
node skills/inventory.js list [location]            # View inventory
node skills/inventory.js expiring [days]            # Expiring items (default 7 days)
node skills/inventory.js status                     # Dashboard summary
```

### Web Dashboard

`http://localhost:3333` — tabs for inventory, restock, cooking, calendar, baby tracking, and settings.

## Architecture

```
household/
├── skills/
│   ├── lib/
│   │   ├── data.js            # Shared data layer (atomic JSON I/O, paths, utils)
│   │   ├── inventory-ops.js   # Inventory CRUD + restock logic
│   │   ├── baby-ops.js        # Baby log operations
│   │   └── meal-ops.js        # Meal diary + cooking recommendations
│   ├── mcp-server.js          # MCP server (12 tools, stdio transport)
│   ├── server.js              # Express web server + API
│   ├── inventory.js           # CLI entry point
│   ├── predict.js             # Consumption prediction engine
│   └── public/index.html      # Single-page web dashboard
├── data/                      # JSON data files (gitignored)
└── config/                    # Category, preference, and location configs
```

Three entry points — MCP server, web server, and CLI — share a common data layer (`lib/`), operating on the same JSON files.

## MCP Tools

| Tool | Description |
|------|-------------|
| `inventory_list` | List inventory with filters (location, category, status) |
| `inventory_add` | Add item with optional barcode lookup |
| `inventory_consume` | Record consumption by ID or name |
| `inventory_expiring` | Items expiring within N days |
| `inventory_status` | Summary stats (totals, by location/category) |
| `restock_recommendations` | Smart restock suggestions based on consumption rate |
| `meal_suggestions` | What to cook based on available ingredients |
| `shopping_list` | Combined shopping list (restock + expiring + recipe gaps) |
| `baby_log_event` | Log baby events (feeding, diaper, sleep, etc.) |
| `baby_supply_status` | Baby supply levels and days-until-empty predictions |
| `preferences_get` | Read household preferences |
| `preferences_update` | Update a preference field |

## Key Features

- **Consumption prediction** — tracks usage patterns to predict when items run out
- **Smart restock** — auto-generates shopping lists based on consumption velocity
- **Recipe gap matching** — finds dishes you can almost make (missing just 1 ingredient)
- **Baby tracking** — feeding, diaper, sleep logging with supply predictions
- **Barcode scanning** — auto-lookup via Open Food Facts API
- **Image recognition** — identify items via Claude Vision (web dashboard)

## Baby Tracker Import

Import baby life records from [Baby Tracker](https://nighp.com/babytracker/) app (`.btcp` format):

```bash
node skills/import-btcp.js <file.btcp> [--dry-run] [--tz=8]
```

Or upload via web dashboard at Settings → Import.

## Data Storage

All data is local JSON files — no cloud, no database server, no account required. Atomic writes (write-tmp-then-rename) prevent corruption.

## License

Apache License 2.0 — see [LICENSE](./LICENSE).

Premium features and add-on services may be offered under separate terms.
