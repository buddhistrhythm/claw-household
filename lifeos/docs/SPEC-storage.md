# Spec：lifeos 存储设计（Postgres）

状态：**已实现 + 真库测试通过** · 2026-06-10
决策来源：整合路径=用 Postgres 设计统一存储；Obsidian=DB 主 + 富镜像；首领域=物品归置 + 信用卡申请

---

## 1. 设计目标

支撑"人生/家庭信息系统"：财务、库存、物品归置、笔记、书籍、网络知识等**任意领域**
共用一套存储，满足：
- **可扩展**：加新领域不改表（新 `type` 即可）。
- **关系一等公民**：物品↔位置、流水↔账户、卡↔机构这类跨实体关系要能高效双向查询、
  并喂给知识图谱（解决上个 spec §5.4 的根问题）。
- **agentic 检索友好**：原生全文检索 + 结构化过滤 + 关系扩展。
- **Postgres 主库**，Obsidian 是派生的富镜像。

## 2. 选型：文档 + 关系（不走纯 EAV，也不走每域一张表）

| 方案 | 取舍 |
|---|---|
| 纯关系（每域一张表） | 类型安全，但加领域=改 schema、跨域查询难、图谱难统一 |
| 纯 EAV（household 现状） | 极灵活，但每个字段一行、查询/索引差、Postgres 原生能力浪费 |
| **文档 + 关系（本设计）** | 公共列上表 + 领域字段进 `JSONB data` + 关系独立成表。兼顾灵活与查询，吃满 Postgres（JSONB/GIN/tsvector/数组） |

## 3. Schema（`sql/001_init.sql`）

### entities — 多态节点（一物一行）
公共列：`id, type, family_id, created_by, title, body, summary, status, tags[],
topics[], source, source_ref, occurred_at, archived, created_at, updated_at`，
领域字段全部进 `data JSONB`，外加生成列 `search tsvector`。

索引：`type`、`(type,status)`、`family_id`、`occurred_at`、`GIN(tags)`、
`GIN(data jsonb_path_ops)`、`GIN(search)`。

> 设计要点：
> - `status` 提到顶层列（生命周期过滤是热路径，如信用卡 applied/approved）。
> - `occurred_at` = 领域事件时间（申请日/交易日），与 `created_at`（入库时间）分开，
>   列表默认按 `COALESCE(occurred_at, created_at)` 倒序。
> - `tags/topics` 用原生 `text[]` + GIN，`@>` 包含查询。
> - `search` 生成列覆盖 title+summary+body，`plainto_tsquery` + `ts_rank`。

### relations — 一等边（`subject -predicate-> object`）
`id, family_id, subject_id→entities, predicate, object_id→entities, weight,
data, created_at`，`UNIQUE(subject_id,predicate,object_id)`，主体/客体/谓词三向索引，
实体删除级联删边。

> 谓词约定（可扩展）：`stored_in`(物品→位置)、`inside`(位置→父位置)、
> `issued_by`(卡→机构)、`references`/`derived_from`(知识)…

### entity_types — 模板注册表（Notion 式）
`type, domain, label, icon, description, schema(JSONB 字段定义), builtin`。
给 UI、校验、Obsidian frontmatter 生成用。新领域在 `store/types.js` 追加。

## 4. 领域映射（首批两个）

**storage（物品归置，`domains/storage.js`）**
- 位置 = `storage_location` 实体；物品 = `item` 实体；
- 归置 = `item -stored_in-> location`（单值，move 用 `relations.replace`）；
- 嵌套 = `location -inside-> parent`；
- API：`createLocation/createItem/place/whereIs(返回位置链)/contents(物品+子位置)`。

**finance / credit card（信用卡申请，`domains/credit_card.js`）**
- 一申请 = `credit_card_application` 实体；生命周期在顶层 `status`
  （planned/applied/approved/denied/cancelled/closed）；
- 金融字段进 `data`（issuer/network/credit_line/annual_fee/signup_bonus/
  bonus_deadline/bonus_earned…），`occurred_at`=申请日；
- 报表用 JSONB 查询：`upcomingBonusDeadlines`（开卡奖励到期未达标提醒）、
  `annualFeeTotal`（在持卡年费合计）。

## 5. Obsidian 镜像（DB 主）

每实体 → `<vault>/<domain>/<type>/<id>__<slug>.md`：YAML frontmatter（公共列 +
`data` 摊平）+ body + `## Relations`（出边渲染成 `[[object]]` wikilink）。文件名用
**稳定 id 前缀**，title 改不影响 id（slug 变会换文件名 → `sync-obsidian` 全量重写，
镜像是派生物，可覆盖）。

## 6. 测试与隔离

对**真 Postgres** 测（非 mock）：每个测试文件用随机 schema（`test_xxx`）+ 连接级
`search_path` 隔离，结束 `DROP SCHEMA CASCADE`。覆盖：实体 CRUD/合并/过滤、FTS 排序、
关系增删替换/级联、storage 链路与 move、信用卡生命周期/奖励到期/年费合计、
Obsidian 渲染。13 用例全过。

## 7. 已知问题 / 下一步

1. **多人可见性**：现 family 级；财务需实体级 private（D4）。
2. **金额精度**：`annual_fee/credit_line` 存 JSONB number；真财务流水建议存「分」整数
   或 numeric 字符串，加 app 层校验（finance 领域扩展时处理）。
3. **加密 vs 可检索**：敏感字段加密会让 FTS/图谱失效，需要「可检索列 vs 加密列」分流。
4. **知识图谱层未接**：relations 已就绪，4 信号图谱（上个 spec）要改成吃
   entities+relations（直接边 = 最强信号，替换之前的 author 代理信号）。
5. **rsspool 并入**：RSS 条目落为 `knowledge_item` 实体（source='rss'），rsspool 的
   ingest 改为写 lifeos store；Obsidian/图谱/MCP 统一到这套。
6. **MCP / agentic 检索**：下一步把 search + relations.neighbors 暴露成 MCP tool，
   做预算化的「检索→关系扩展→带引用作答」。
7. **命名**：lifeos 是代号，待定（D5）。

## 8. 连接

默认 `postgres://lifeos:lifeos@localhost:5432/lifeos`，用 `DATABASE_URL` 覆盖；
`LIFEOS_PG_SCHEMA` 切换 schema（多租户/测试用）。
