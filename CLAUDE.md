# Claw — 家庭智能管理系统

Claude Code companion CLI for household management — inventory, meals, baby tracking, shopping lists.

## Commands

```bash
npm run start            # Start web dashboard (port 3333)
npm run dev              # Watch mode
npm run test             # Run tests (85 total)
claw                     # CLI dashboard / first-run welcome
claw skill install       # Install skill for Claude Code / OpenClaw
```

## Architecture

Hybrid data layer: JSON files (legacy) + SQLite EAV (Notion-like flexible schema). Multi-user with Google/Apple OAuth. CLI + Web + MCP server.

### Key files

| File | Purpose |
|------|---------|
| `bin/claw.js` | CLI entry point — dashboard, inventory commands, skill install |
| `skills/server.js` | Express web server (port 3333), all API routes |
| `skills/mcp-server.js` | MCP stdio server (12 tools) for Claude Code / OpenClaw |
| `skills/inventory.js` | Standalone inventory CLI |
| `skills/lib/db.js` | SQLite + EAV: entities, templates, users, families, invites |
| `skills/lib/auth.js` | Google/Apple OAuth + JWT sessions + middleware |
| `skills/lib/llm-completion.js` | LLM skill: CLI/HTTP backends, SSE streaming, presets |
| `skills/lib/data.js` | JSON file I/O (legacy), path constants |
| `skills/lib/inventory-ops.js` | Inventory business logic |
| `skills/lib/baby-ops.js` | Baby event logging + stats |
| `skills/lib/meal-ops.js` | Meal diary: ingredients, dishes, meals |
| `skills/predict.js` | Consumption prediction engine |
| `skills/public/` | Single-page web UI (HTML + inline JS) |

### Data flow

```
CLI (claw add/consume)  ──→  inventory-ops.js  ──→  data/inventory.json
Web (fetch /api/*)      ──→  server.js routes   ──→  data/*.json + data/household.db
MCP (Claude Code tools) ──→  mcp-server.js      ──→  lib modules
```

### EAV model (Notion-like)

```
entity_templates → prop_defs → entities → entity_values
  (databases)      (columns)    (pages)     (cells)
```

- 7 built-in templates: inventory_item, baby_event, meal_dish, meal_record, meal_ingredient, consumption_record, vehicle
- Custom templates via API: `POST /api/templates`
- Clone built-in: `POST /api/templates/:type/clone`
- Generic CRUD: `GET/POST/PATCH/DELETE /api/eav/:entityType`

### Auth

- Google/Apple OAuth + JWT (`.env` config)
- `AUTH_DISABLED=1` for local dev (auto-creates dev user)
- Family-scoped: each family sees only its own data
- Admin/member roles, invite codes

### LLM integration

Backends: `http` (needs API key) | `cli` (Claude/OpenClaw/Gemini/Codex — no key needed)
- SSE streaming for CLI backend (real-time stdout to browser)
- Presets: `skills/lib/llm-completion.js` → `CLI_PRESETS`
- Cooking recommendations + step expansion

### API summary

| Endpoint | Purpose |
|----------|---------|
| `GET/PATCH /api/preferences` | Settings (legacy JSON) |
| `GET/PATCH /api/v2/preferences` | Settings (SQLite, family-scoped) |
| `GET/POST /api/templates` | Entity template CRUD |
| `GET/POST/PATCH/DELETE /api/eav/:type` | Generic EAV CRUD |
| `POST /api/auth/google\|apple\|dev` | OAuth login |
| `POST /api/families` | Create family |
| `POST /api/families/:id/invites` | Generate invite code |
| `POST /api/invites/redeem` | Join family |
| `POST /api/cooking/llm-recommendations` | LLM cooking (SSE support) |
| `GET /api/calendar?from=&to=` | Calendar aggregation |

## Inventory CLI

```bash
claw add <barcode|name>              # Add item (barcode → Open Food Facts)
claw consume <id|name> [qty] [note]  # Record consumption
claw list [location]                 # List inventory
claw expiring [days]                 # Expiring items (default 7 days)
claw status                          # Overview dashboard
claw search <keyword>                # Search
```

## Natural Language → Action

| You say | Tool / Command |
|---------|---------------|
| 家里还有什么菜 | `inventory_list` |
| 帮我记一下买了牛奶 | `inventory_add` |
| 鸡蛋用完了 | `inventory_consume` |
| 什么快过期了 | `inventory_expiring` |
| 这周要买什么 | `shopping_list` |
| 今晚吃什么 | `meal_suggestions` |
| 宝宝水奶还能撑几天 | `baby_supply_status` |

## Data

All data stored locally. No cloud required.
- JSON files: `data/` and `config/`
- SQLite DB: `data/household.db` (EAV + multi-user)
- Web dashboard: `http://localhost:3333`
