# Spec：人生信息系统（Personal Life OS）

状态：**愿景草案，待定方向** · 2026-06-10
关联：`SPEC-knowledge-graph.md`（图谱层）、claw-household EAV 引擎、rsspool

---

## 1. 愿景

一个**人生信息系统**：把人生中产生和需要的各类信息统一管理，全部以 **Obsidian**
为可读基底，支持 **agentic 检索**（自然语言提问 → agent 多步检索 → 带引用作答）。

领域（domains）：
- **财务** finance：账户、流水、预算、订阅
- **日用百货 / 库存** household：物品、消耗、补货（**已有**）
- **物品归置** storage：东西放在哪（柜子/抽屉/仓库 ↔ 物品）
- **笔记 / 书记** notes：自由笔记、灵感、待办
- **书籍 / 阅读** reading：书、读书笔记、划线
- **网络知识** knowledge：RSS/RSSHub 条目（**已有 = rsspool**）

## 2. 关键洞察：底座已存在一大半

| 能力 | 现状 | 在哪 |
|---|---|---|
| 通用实体引擎（任意领域 = 一组模板） | ✅ EAV：entity_templates / prop_defs / entities / entity_values，支持自定义+克隆模板 | claw-household `skills/lib/db.js` |
| 多用户 / 家庭 / 权限 | ✅ users/families/members/invites | 同上 |
| Obsidian 单条笔记同步 | ✅ frontmatter + 按来源分目录 | rsspool `storage/obsidian.js` |
| 4 信号知识图谱 + 社区 | ✅ 设计完成（草稿） | rsspool `graph/` + SPEC-knowledge-graph |
| 通用 MCP 检索 | ✅ 两套（household 业务 tool + rsspool pool_*） | 两处 |
| 录入口 | ✅ 手动/扫码/EasyLog（household）、RSS（rsspool） | 两处 |

**结论**：不是从零造，而是把 rsspool 的"Obsidian + 图谱 + agent 检索"层**上移为
通用层**，盖在 EAV 引擎之上；household 的家务数据和 rsspool 的 RSS 数据都只是其中
两个领域。新领域（finance/notes/storage/reading）= 新增 entity templates。

## 3. 目标架构（分层）

```
┌─ Agentic 检索层 ── NL 问题 → 规划 → 全文检索 + 图谱扩展 + 跨域 join → 带引用作答
│                    （MCP tools + 预算化检索，借 llm_wiki 60/20/15 预算思路）
├─ 关联层 (Graph) ── 4 信号 + 关系边（物品↔位置、流水↔账户↔商家、书↔概念）
│                    Louvain 社区 + cohesion 盲区
├─ Obsidian 基底 ── 每实体一篇笔记（frontmatter+body+[[wikilink]]），社区 MOC，Dataview
├─ 存储底座 (EAV) ── 每领域一组 entity templates；统一字段约定见 §4
└─ Ingestion ────── 手动 / 扫码 / RSS / 银行账单·CSV / EasyLog / 剪藏(未来)
```

### 统一实体约定（让跨域图谱 + Obsidian 成立）

每个实体（无论哪个领域）尽量带：`title`、`tags[]`、`topics[]`、`sources[]`、
`links[]`（指向其它实体 id = `[[wikilink]]` 的来源）、`body`（正文/备注）、
`occurred_at`。领域专有字段照旧放各自 prop_defs。

### 新领域草图

- finance：`finance_account`（名称/类型/币种/余额）、`finance_txn`（金额/方向/账户/
  商家/分类/时间）、`finance_subscription`、`finance_budget`
- storage：`storage_location`（柜/抽屉/仓库，可嵌套 parent_ref）；inventory_item 增
  `location_ref` → "东西归置"= 物品↔位置关系边
- notes：`note`（自由文本 + tags + links）
- reading：`book`、`reading_log`、`highlight`

## 4. 与现有代码的关系（三个走法 = 主决策）

- **A. 在 EAV 上长（推荐）**：把 rsspool 的 Obsidian/图谱/MCP 适配到 EAV 引擎，
  RSS 并为一个 ingestion；finance/notes/storage/reading 加为新模板。
  一套存储、一套图谱、一套 Obsidian、一套 agent。
- **B. rsspool 当主系统**：household 迁进来，等于重造 EAV。浪费已有引擎。
- **C. 联邦**：rsspool 作检索层跨 household + rsspool 两个库查。集成最复杂。

推荐 **A**：复用已经很完善的 EAV（多用户/模板/克隆），rsspool 的价值上移为通用层。
代价：rsspool 现在自带独立 SQLite/PG schema，要做一次**存储整合**（rsspool store
适配到 EAV，或把 EAV 暴露成 rsspool 的 store 接口）。

## 5. 现在的问题 / 风险（诚实清单）

1. **两套存储要整合**（最大工程）。household = EAV（SQLite，`skills/lib/db.js`），
   rsspool = 自带 `knowledge_items` 表（SQLite/PG）。走 A 必须二选一统一，
   且 EAV 目前是**同步 better-sqlite3**，rsspool 接口是 **async**——要么 EAV 包一层
   async，要么 rsspool 降到同步。还有 Postgres 支持目前只在 rsspool 侧。
2. **Obsidian 主源 vs 镜像**（地基决策，改起来贵）。DB 主、Obsidian 富镜像（现状）
   简单可控；但若你想"住在 Obsidian 里手改"，需要 markdown 主 + DB 当索引 +
   双向同步（冲突/解析成本高）。
3. **finance schema 不轻**。账户/流水/对账/多币种/周期账单容易蔓延；且**敏感数据**
   要加密（repo 已有 `crypto-vault.js` 苗头，但 finance 全量加密会让图谱/检索失效，
   需要"可检索字段 vs 加密字段"的取舍）。
4. **关系要成一等公民**。跨域图谱靠"关系边"（物品↔位置、流水↔账户），但 EAV 现在
   relation 是弱类型 JSON，没有反向索引。图谱层要能吃显式关系，需要补一张关系表
   或约定 `*_ref` 字段 + 建索引。
5. **检索质量上限**（承自上个 spec 的根问题）。标签来自英文关键词词表，中文/跨域
   语义弱；agentic 检索再聪明也受底层信号制约。根治要 embedding 或 LLM 标注。
6. **隐私 / 多人边界**。财务可能不想共享给整个 family；现有权限是 family 级，
   需要实体级/领域级可见性。
7. **范围爆炸**。一次只能落"通用层整合 + 一个新领域"，不能六个领域齐头并进。
8. **命名 / 定位**。rsspool 这名字已不匹配（不再只是 RSS）。要不要再改名
   （如 lifedb / second-brain / 一个中文名）。

## 6. 待决问题（需要你拍板）

| # | 问题 | 我的倾向 |
|---|---|---|
| D1 | 走 A / B / C？ | **A**：rsspool 检索层上移到 EAV 引擎 |
| D2 | Obsidian 主源 还是 富镜像？ | 先 **DB 主 + Obsidian 富镜像**（可控），双向同步留后 |
| D3 | 第一个落地的新领域？ | **storage（东西归置）**：离现有 inventory 最近、见效快；或 finance（价值高但 schema 重） |
| D4 | 多人可见性需要做到实体级吗？ | Phase 1 沿用 family 级，finance 单独标 private |
| D5 | 要不要改名 | 可以，但不阻塞，最后再定 |

## 7. 建议的推进顺序（落地路线）

1. **整合 Spike**：让 rsspool 的 store 接口能后端到 household EAV（一个 adapter），
   RSS 条目作为 `knowledge_item` 实体进 EAV。证明"一套存储"可行。（验证 D1/§5.1）
2. **通用层**：Obsidian 同步 + 图谱 + MCP 改为对任意 entity_type 通用。
3. **第一个新领域**（按 D3）：加模板 + 录入口 + 进图谱 + 进 Obsidian。
4. **agentic 检索**：跨域 NL 问答 tool（图谱扩展 + 预算化）。
5. 逐个领域复制 step 3。

> 一句话：先证明"一套存储 + 一套检索层"能盖住两个已有领域，再往上加财务/笔记/书籍。
