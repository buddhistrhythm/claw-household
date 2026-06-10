# Spec：rsspool 知识图谱层（LLM Wiki 模式落地）

状态：**草案，待评审** · 2026-06-10
参考：[nashsu/llm_wiki](https://github.com/nashsu/llm_wiki)（Karpathy "LLM Wiki" 模式）、[Ontos-AI/knowhere](https://github.com/Ontos-AI/knowhere)

---

## 1. 背景与动机

rsspool 目前是一个"纯池子"：RSS/RSSHub 条目 → 归一化 → SQLite/Postgres + Obsidian
单条笔记 → MCP 检索。条目之间**没有结构**——`pool_related` 只靠朴素的共享标签查询，
Obsidian 笔记之间没有互链，看不出主题聚类，更发现不了知识盲区。

llm_wiki 的核心论点是：**传统 RAG 每次查询都从头检索，知识应该"编译一次、持续维护"**。
它的做法分两层：

1. **LLM 编译层**：两步 ingest（分析→生成），把原始材料编译成 entity/concept wiki
   页面，带 `[[wikilink]]` 互链和 `sources[]` 溯源；
2. **图谱层**：在页面之上算 4 信号关联图 + Louvain 社区检测 + cohesion 评分，
   做展示和盲区发现。

本 spec 先落地 **图谱层**（确定性、无需 LLM key、跑在现有数据上），LLM 编译层留作
Phase 2 的 seam。

## 2. 与参考项目的差距（关键认知）

| | llm_wiki | rsspool 现状 |
|---|---|---|
| 图的节点 | **LLM 编译后的 wiki 页面**（entity/concept，语义密度高） | **原始 RSS 条目**（未消化，语义密度低） |
| 边的来源 | LLM 写出的 `[[wikilinks]]`（语义判断） | 只能用代理信号（标签/作者/类目） |
| 增量性 | SHA256 缓存 + 增量编译 | content_hash 去重有了；图每次全量重建 |
| 展示 | Tauri 桌面 + sigma.js 力导图 | 无 UI（导出 JSON 留给未来 UI） |

> **本质差距**：llm_wiki 的图建立在"已编译知识"上，我们的图建立在"原料"上。
> 没有 LLM 编译层之前，图的质量上限受制于代理信号的质量（见 §5 问题 1）。

## 3. 目标 / 非目标

**目标（Phase 1）**
- 4 信号加权图：确定性、可解释（每条边能看到信号构成）。
- Louvain 社区检测 + cohesion 评分：自动聚类、标记低内聚社区（盲区候选）。
- 暴露面：MCP（`pool_graph` / `pool_communities`，`pool_related` 升级为图谱相关度）、
  CLI（`graph` / `communities`）、Obsidian（每个社区一篇 MOC 笔记，用 `[[wikilink]]`
  把成员串起来，让 Obsidian 自带 graph view 真正能看）、`graph.json` 导出（喂未来 Web UI）。

**非目标（Phase 1 不做）**
- LLM 编译 entity/concept 页面（Phase 2）。
- 向量/embedding 语义检索（Phase 2，可换掉弱信号）。
- 自建力导图 Web UI（先用 Obsidian graph view + JSON 导出顶上）。
- Chrome 剪藏插件。

## 4. 设计

### 4.1 四信号映射（llm_wiki → rsspool）

| llm_wiki 信号 | 权重 | rsspool 对应 | 理由 / 已知弱点 |
|---|---|---|---|
| 直接 `[[wikilink]]` | ×3.0 | **共享主题标签**（enrich 产出，剔除 source/category 回声标签） | 弱点：标签来自关键词词表，粒度粗（见 §5.1） |
| 共享原始 source | ×4.0 | **同作者** | 弱点：RSS 作者常缺失，或整个 feed 同作者 → 会连成 clique（见 §5.2） |
| Adamic-Adar | ×1.5 | **标签共邻**：Σ 1/log(1+拥有该标签的条目数)，罕见标签贡献更大 | 直接对应，无折损 |
| 同页面类型 | ×1.0 | **同 feed category**（`topics`） | 直接对应 |

边权 = 四信号之和；每条边保留 `signals` 明细和 `shared_tags`，保证可解释。

### 4.2 候选对生成（控制复杂度）

不做全量 O(n²)：只对"共享 ≥1 个主题标签 或 同作者"的条目对打分（倒排索引：
tag → items，author → items，桶内两两组合、全局去重）。

### 4.3 社区检测

- 纯 JS 实现单层 **Louvain**（模块度优化 + 聚合迭代），无新依赖。
- **cohesion** = 社区内实际边数 / 可能边数；沿用 llm_wiki 的经验阈值
  **< 0.15 标记为低内聚**（= "你自己都没意识到的知识盲区"候选：一堆条目被归在
  一起但互相关联很弱，说明这块知识只有零散输入、没有成体系）。
- 每个社区输出：代表节点（degree 最高）、成员数、cohesion、Top 共享标签。

### 4.4 暴露面

```
MCP   pool_graph        { topic?, min_weight? } → { nodes, edges }
      pool_communities  { } → [{ label, size, cohesion, low_cohesion, top_tags, members }]
      pool_related      升级：edge weight 排序 + signals 明细（替换现在的朴素 tag 查询）
CLI   graph [--topic T] [--min-weight W]
      communities
      export-graph      → data/export/graph.json（nodes/edges/communities，喂未来 UI）
Obsidian  vault/_communities/<n>-<label>.md   每社区一篇 MOC，[[wikilink]] 到成员笔记
```

> Obsidian 注意：`[[wikilink]]` 要求文件名稳定可解析。现有笔记文件名
> `<id>__<slug>.md` 含截断 slug + 中文，MOC 将用完整文件名（不带 .md）链接，
> 重 ingest 内容变化时文件名不变（id 稳定、slug 由 title 派生——title 变则断链，
> 见 §5.7）。

### 4.5 Phase 2 seam：LLM 编译层

`src/pipeline/enrich.js` 已是 enrich seam。Phase 2 增加 `compile` 步骤
（llm_wiki 的两步法）：分析（实体/概念/与已有 wiki 的关联与矛盾）→ 生成
（entity/concept 页面 + 更新 index/log）。编译产出的真实 `[[wikilinks]]`
直接成为图的第一信号，替换掉代理信号的主导地位。需要 LLM key
（复用主仓 `@anthropic-ai/sdk` 的模式）。

## 5. 当前问题与风险（诚实清单）

1. **标签信号太稀**（最大问题）。enrich 是 ~15 个主题的英文关键词词表：
   - 中文内容（小红书）基本打不上标签 → 中文条目在图里成孤岛；
   - "ai/llm" 这类宽标签会把半个池子连起来，区分度低。
   缓解：扩词表 + 中文关键词；根治：Phase 2 LLM 标签/编译，或 embedding。
2. **author ×4 过强**。整个 feed 同一作者（常见）→ feed 内部全连成 clique，
   Louvain 会按 feed 分社区而不是按主题分——图退化成"来源分组"，没信息量。
   **需要决策**：同 feed 内部边是否降权/去掉 author 信号（倾向：同 feed 时
   author 信号置 0，跨 feed 同作者才算强信号）。
3. **热门标签桶爆炸**。`ai` 标签下 500 条 → 12 万条候选对。需要桶上限
   （如 size > 100 的标签跳过两两组合，只保留 Adamic-Adar 低贡献）或 IDF 阈值。
4. **Louvain 自实现的风险**。分辨率参数、小图不稳定、正确性需测试兜底
   （已知社区结构的小图做 golden test）。0.15 阈值是 llm_wiki 经验值，
   对 RSS 条目图未必合适，先做成可配。
5. **全量重建 vs 增量**。Phase 1 每次内存全量建图（千条级 < 1s，可接受）；
   万条级需要物化 edges 表 + 增量更新。**需要决策**：图是否物化进 DB
   （倾向：Phase 1 不物化，导出 JSON 即缓存）。
6. **双后端一致性**。图构建只依赖 `listItems()` 拉全量，与 SQLite/Postgres
   无关——但 `listItems` 现有 limit 默认值需要加"拉全量"路径。
7. **Obsidian 断链**。title 变 → slug 变 → 文件名变 → MOC 里的 wikilink 断。
   缓解：MOC 每次重新生成（它是派生物，可全量覆盖）；或笔记文件名只用 id（丑）。
8. **未验证的现实数据效果**。以上设计在 fixtures（5 条）上能跑通测试，但
   真实价值要在几百条真实 feed 数据上看社区质量——需要你配好 feeds.json
   跑一轮真数据来调权重和阈值。

## 6. 待决问题（需要你拍板）

| # | 问题 | 我的倾向 |
|---|---|---|
| D1 | 同 feed 内 author 信号怎么处理（§5.2） | 同 feed 置 0，跨 feed 才 ×4 |
| D2 | 图是否物化进 DB（§5.5） | Phase 1 不物化 |
| D3 | 中文内容标签：先扩词表还是直接等 Phase 2 LLM | 先扩最小中文词表（一天内），不阻塞 |
| D4 | Phase 2 LLM 编译层做不做、什么时候做 | 图谱层在真数据上验证后再启动 |

## 7. 里程碑与验收

- **M1 图核心**：`src/graph/{build,louvain}.js` + 单测（含 golden 社区测试）。
  （`build.js` 已有草稿实现，按 D1/§5.3 修订后定稿）
- **M2 暴露面**：MCP 三个 tool + CLI 两个命令 + `export-graph`。
- **M3 Obsidian MOC**：`_communities/` 生成，Obsidian graph view 可见聚类。
- **验收**：fixtures 全链路测试通过；真实数据 ≥200 条时，社区划分肉眼可解释、
  低 cohesion 标记有意义；`pool_related` 返回带 signals 明细。
