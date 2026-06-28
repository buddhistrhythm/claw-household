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
| events | `life_event` | 事件溯源 P0：消耗/补货/喂养皆事件，`qty <id>` 折叠出当前量 |
| meals | `food_ingredient`, `dish`, `meal` | 餐食日记（食材→菜→一餐，`uses`/`serves` 边） |
| inbox | `capture` | 捕获收件箱（append-only，可溯源，见下「捕获管线」） |
| baby | `baby` | 宝宝档案 + 喂奶/换尿布/睡眠事件 + **透明的「为什么哭」推断**（见下） |
| (新领域) | … | 一个 `src/domains/<x>.js` 声明 `types`/`commands`/`intents`，registry 派生一切，不改表 |

## 领域 manifest（一次声明，处处派生）

每个领域模块只声明一次自己（`module.exports` 工厂 + `.types` + `.commands` + `.intents`），
`src/registry.js` 据此派生：**CLI 命令表与帮助文本**（`node src/cli.js help` 全自动生成）、
**entity_types 注册**、**捕获 Router 的可路由目标**。加领域 = 加一个文件，零接线。

## 运行时插件（第三方扩展，见 plugins/README.md）

第三方无需改 registry 即可扩展 lifeos，两条路（`node src/cli.js plugins` 看状态）：

- **进程内（允许清单）**：`config/plugins.json` 里 `enabled` 的模块在加载期被 `require`，
  与内置领域**同契约**（factory + `types`/`commands`/`intents`），自动获得 CLI/路由/类型/MCP。
  参考模板 `plugins/water.js`（喝水追踪）。安全默认 = **白名单、默认全关**；进程内插件以**完全信任**
  运行（无沙箱），只启用你信任的代码。坏插件被 loader 容错隔离，不连累其它。
- **跨进程（MCP server）**：配置项 `kind:'mcp'`（`command` 跑 stdio 子进程，或 `url` 连 HTTP）。
  lifeos 当 **MCP client** 连上去，把它的 tool 转成 Intent：tool 的 JSON Schema 直接当入参，
  `run` 调远程 tool、**结果包成 `plugin_result` 实体**（带 `captured_from` 溯源）。外部代码**永不碰 DB**，
  默认 `confirm:'always'`——必须人工确认才真正调用。由 `registry.initMcpPlugins()` 在 web/mcp-http/mcp
  常驻入口启动时连接（best-effort，坏插件只记录不致命）。

## 捕获管线（录入即产品，见 docs/SPEC-plugins.md）

`Source → Capture(inbox) → Router(规则优先，LLM 兜底) → Intent → entity`

```bash
node src/cli.js capture-text "加 2 箱 3号尿布 到 车库"   # 规则命中 → 直接落库+归置
node src/cli.js capture-text "花了 \$12.99 Blue Bottle"  # 财务永不自动入账 → pending
node src/cli.js captures                                  # 待确认队列（带路由建议）
node src/cli.js capture-confirm <id> --args '{"account":"Chase Checking"}'
node src/cli.js capture-serve --secret S   # webhook 源（眼镜/Shortcuts/IM 网关 POST 进来）
node src/cli.js capture-watch ~/Pictures/glasses   # 监听目录（眼镜照片同步文件夹）
```

- **确定性优先**：规则能确定就不调模型;设 `ANTHROPIC_API_KEY` 后自由文本走 Claude tool-use 路由。
- **钱和库存不许瞎猜**：`finance.add_txn` 标记 `confirm:'always'`，永远停在 pending 等确认。
- **一切可溯源**：落库实体带 `captured_from` 边回指捕获；重复 `source_ref` 自动去重。
- Meta Ray-Ban 等设备 = 再加一个 Source（语音→IM 网关→webhook；照片→同步目录→watch），核心零改动。

## 迁移（统一者，而非第三个 silo）

```bash
node src/cli.js import-household --dir ~/家庭管理 [--dry-run]  # 库存/消耗/宝宝日志/餐食 → 实体+事件
node src/cli.js import-rsspool rsspool-items.json              # rsspool 知识池 → knowledge_item
```
幂等：保留源 id（`inv_*`/`ing_*`…），重复运行 created=0;消耗记录变 `life_event`,
`qty inv_xxx` 即可按事件折叠出当前量。

## 手机端：Web PWA + 宝宝哭推断 + Tailscale

`node src/cli.js web`（compose 里的 `web` 服务）起一个移动端优先的 PWA + JSON API：
四个 Tab——**宝宝**（大按钮「👶 宝宝哭了」）/ **收件**（待确认捕获）/ **找**（混合检索）/ **状态**。
加到手机主屏即有 App 图标(`manifest.webmanifest` + service worker，无需应用商店)。

- **「为什么哭」是确定性的可解释推断,不是黑盒**:对 {困了/饿了/要换尿布/想玩} 打分,
  每个候选展开都列出**信号 + 数字依据**(`POST /api/baby/cry`)。三层叠加:
  ① last-event(距上次喂/醒了多久 vs 月龄 wake-window);
  ② **个人基线**(最近 7 天该宝宝的喂奶间隔/清醒窗中位数,够样本就覆盖群体表);
  ③ **时间-of-day 圈昼夜节律 + 趋势**(「过去 7 天此时 5/7 在睡」「最近喂量在降」)。
  例:不止「困了 72%」,而是「困了 72% · 已醒 105min(个人均值 95min) · 此时 7 天 5 天在睡」。
- **手机访问走 Tailscale**(compose 的 `tailscale` 边车,`--profile tailnet` 启用):
  设 `TS_AUTHKEY` 后 `tailscale serve` 把 `https://lifeos.<tailnet>.ts.net` 反代到 `web:8850`,
  自动 HTTPS、不开公网端口;再叠 `LIFEOS_WEB_TOKEN` 做 bearer 鉴权。不设 `TS_AUTHKEY` 则边车跳过、仅本机。

## Chrome 扩展：批量录信用卡 offer（又一个 Source）

`extensions/chrome-cc-offers/`(Load unpacked)。在 doctorofcredit 等 offer 页点扩展 →
抓取页面文本 POST 到 `/api/captures`(hints.kind=`cc_offers`)→ 规则确定性路由到
`credit_card.bulk_offers` → 先正则抽取(`ANTHROPIC_API_KEY` 有则 LLM 兜底)→ 批量建 N 条
`status:'planned'` 的信用卡申请,每条带 `Source:<url>` 与 `captured_from` 边,在网页**收件** Tab 复核。
**扩展不进核心一行**——它只是 N+1 个 Source 里的一个,印证「插件即接入点」。

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

## 路线

已落地：HTTP/SSE MCP 常驻（`mcp-http`，bearer token）；pgvector 语义/混合检索
（`hybrid-search` / `reindex`）；捕获管线 P0+P1；household/rsspool 迁移导入器；
事件溯源 P0；领域 manifest。剩余：

- 多人实体级可见性（财务 private）。
- FTS 中文分词：`simple` 配置下中文连写串只成一个 token（「3号尿布」搜「尿布」不中）;
  语义检索可兜底，但应换 zhparser/pg_jieba 或 pg_bigm 根治。
- 捕获 P2：vision 路由（照片→库存/条码）、IM 机器人 Source（打通眼镜语音路）。
- 网页 inbox 确认界面（pending 队列的勾选确认）。
