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
npm install                     # 只依赖 pg + dotenv（纯 JS，无原生编译）

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

# 检索 + 镜像
node src/cli.js search 护照 --type item
node src/cli.js sync-obsidian              # 把所有实体写成 Obsidian 笔记
```

## 领域

| domain | types | 说明 |
|---|---|---|
| storage | `item`, `storage_location` | 东西归置：位置可嵌套，`stored_in`/`inside` 关系 |
| finance | `credit_card_application` | 信用卡申请：状态机 + 年费 + 开卡奖励到期提醒 |
| (未来) | note / book / knowledge_item / finance_txn … | 加 type + domain 模块即可 |

## 测试

```bash
npm test     # node --test，对真 Postgres 跑，每个文件用随机 schema 隔离后 DROP
```

需要可连接的 Postgres（设 `DATABASE_URL`）。CI 里起一个 postgres service 即可。

## 路线（见 SPEC §7）

- 多人实体级可见性（财务 private）。
- 知识图谱层接到 entities+relations（直接边=最强信号）。
- rsspool 的 RSS ingest 改写进本 store（`knowledge_item` 实体）。
- MCP + agentic 检索：search + 关系扩展 + 带引用作答。
