# lifeos

人生 / 家庭信息系统的**统一存储层**。一套 Postgres 存所有领域（财务、库存、物品归置、
笔记、书籍、网络知识…），**DB 主 + Obsidian 富镜像**，为 agentic 检索而设计。

> 代号 lifeos，命名待定。设计详见 [`docs/SPEC-storage.md`](docs/SPEC-storage.md)，
> 更大愿景见 `../rsspool/docs/SPEC-life-os.md`。

## 核心：文档 + 关系

- **entities**：多态节点。公共列（title/body/status/tags[]/topics[]/occurred_at）
  + `data JSONB`（领域字段）+ `search tsvector`（全文检索）。新领域 = 新 `type`，不改表。
- **relations**：一等边 `subject -predicate-> object`，双向索引、级联删除。
  物品↔位置、卡↔机构、知识引用都靠它，也是知识图谱的最强信号。
- **entity_types**：模板注册表（Notion 式，给 UI/校验/Obsidian frontmatter）。

## 快速开始

```bash
cd lifeos
npm install                     # pg + dotenv + @modelcontextprotocol/sdk + zod（纯 JS，无原生编译）

# 需要一个 Postgres；默认连 postgres://lifeos:lifeos@localhost:5432/lifeos
node src/cli.js migrate
node src/cli.js stats

# 物品归置
ROOM=$(node src/cli.js loc 书房 --kind room | jq -r .id)
DRAWER=$(node src/cli.js loc 抽屉 --kind drawer --parent $ROOM | jq -r .id)
ITEM=$(node src/cli.js put 护照 --in $DRAWER | jq -r .id)
node src/cli.js where $ITEM           # → 抽屉 / 书房

# 信用卡申请
node src/cli.js cc-add "Amex Gold" --issuer Amex --applied 2026-06-01 --fee 250 --bonus-deadline 2026-07-05
node src/cli.js cc-deadlines --days 60     # 开卡奖励快到期、未达标的

# 笔记 / 书籍
node src/cli.js book-add "DDIA" --author "Martin Kleppmann" --status reading
node src/cli.js reading                     # 在读
node src/cli.js note-add "读书心得" --about <bookId>

# 财务（敏感字段加密，可检索字段明文）
ACID=$(node src/cli.js acct-add "Chase Checking" --kind checking --institution Chase --last4 1234 | jq -r .id)
node src/cli.js txn-add --account $ACID --amount-cents 4599 --direction debit --category groceries --merchant "Whole Foods" --posted-on 2026-06-01 --memo "weekly"
node src/cli.js balance $ACID
node src/cli.js spend --from 2026-06-01 --to 2026-06-30   # 按品类汇总

# 网络知识：RSS / RSSHub 入库 + 图谱
node src/cli.js ingest                       # config/feeds.json（file/url/rsshub）
node src/cli.js graph-build                  # 物化 related_to 相似边
node src/cli.js graph-expand <id> --depth 2  # 子图扩展

# 检索 + 镜像 + MCP
node src/cli.js search 护照 --type item
node src/cli.js sync-obsidian                # 把所有实体写成 Obsidian 笔记
node src/cli.js mcp                          # 启动 stdio MCP（agentic 检索）
```

## 领域

| domain | types | 说明 |
|---|---|---|
| storage | `item`, `storage_location` | 东西归置：位置可嵌套，`stored_in`/`inside` 关系 |
| finance | `credit_card_application`, `finance_account`, `finance_txn` | 信用卡追踪；账户+流水（金额/品类/方向明文可检索，账号/备注加密存 `data.enc`） |
| notes | `note` | 自由笔记，可 `about` 任意实体 |
| reading | `book` | 阅读追踪：想读/在读/读完/弃读 + 评分 + 进度 |
| knowledge | `knowledge_item` | RSS/RSSHub 入库（移植自 rsspool），去重 upsert |
| (新领域) | … | 加 `type` + `src/domains/<x>.js`（导出 `types`）即可，不改表 |

## 加密策略（财务）

可检索字段（金额/币种/品类/方向/商户/日期/账户引用）**明文**存在列/`data` 里，
保证全文检索、SQL 聚合、知识图谱可用；敏感字段（账号、last4、备注、原始摘要）
**加密**进单个不透明 token `data.enc`（AES-256-GCM）。密钥来自 `LIFEOS_SECRET_KEY`，
未设置时退化为明文 `plain:` 模式（开发用，明确标记）。丢密钥只丢 `data.enc`，按设计。

## 知识图谱 + MCP（agentic 检索）

- `src/graph.js`：`neighbors` / `expand`（有界 BFS 子图）/ `buildSimilarityEdges`
  （按共享 tag/topic 物化 `related_to` 边，直接边=最强信号）。
- `src/mcp/server.js`：stdio MCP，工具 `life_search` / `life_get` / `life_neighbors`
  / `life_expand` / `life_recent` / `life_stats` / `life_context`。
  `life_context` = 检索 + 1 跳关系扩展 → **带引用的上下文**（服务端不调 LLM，由客户端 LLM 据此引用作答）。

## Docker Compose（运行时编排 / 胶水层）

领域逻辑是代码（`src/`），但 **运行时编排** 用 compose：Postgres、迁移、定时入库、
Obsidian 卷、MCP 一条命令拉起。详见 [`docker-compose.yml`](docker-compose.yml)。

```bash
cp .env.example .env            # 填 LIFEOS_SECRET_KEY 等
docker compose up -d db         # 常驻 Postgres
docker compose run --rm migrate # 建表
docker compose up -d ingest     # 每小时抓 RSS 入库
docker compose run --rm mcp     # stdio MCP（由客户端 spawn，故用 run 非 up）
```

> 注：MCP 是 stdio transport，由 MCP 客户端按需 spawn，不是常驻 daemon；要做成常驻
> service 需给 MCP 加 HTTP/SSE transport（路线项）。

## 测试

```bash
npm test     # node --test，对真 Postgres 跑，每个文件用随机 schema 隔离后 DROP
```

需要可连接的 Postgres（设 `DATABASE_URL`）。CI 里起一个 postgres service 即可。

## 路线（见 SPEC §7）

- 多人实体级可见性（财务 private）。
- MCP 加 HTTP/SSE transport，让它能作为常驻 compose service。
- `life_context` 接入向量检索（pgvector）做语义召回，补充全文/图谱信号。
