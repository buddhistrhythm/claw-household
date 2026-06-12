# SPEC — lifeos 插件 / 捕获系统（Capture → Router → Intent）

> 状态：**P0+P1 已落地**（`src/capture/`：规则+LLM Router、webhook/watch-folder 两个 Source、pending 确认、MCP `life_capture`；测试见 `test/capture.test.js`）。P2（vision/IM Source）与 P3 未做。原设计稿如下。目标是让任意「输入边」（Meta Ray-Ban 眼镜、邮件、Webhook、
> 扫码枪、消息机器人、Shortcuts…）都能把现实世界的一句话 / 一张照片，优雅地变成
> lifeos 里**正确领域的实体**——而不需要为「眼镜×库存」「邮件×记账」这种组合各写一遍。

## 0. 一句话

> **一条管线，两端插件**：`Source 插件` 把外部边变成统一的 **Capture**；通用 `Router`
> 把 Capture 解释成某个领域的 **Intent**；`Domain 插件` 把 Intent 落成实体。
> 眼镜不是特例,它只是一个 Source。

```
[Meta Ray-Ban] ─┐
[Email]        ─┤
[Webhook]      ─┼─►  Capture(归一化, 入 inbox, 可溯源)
[Barcode]      ─┤        │
[IM Bot]       ─┘        ▼
                    Router ── 规则命中? ──► Domain Intent ──► entity (+captured_from 边)
                       │ 否
                       └─ LLM 路由(含 vision) ──► Intent(args) ─┬─ 高置信 ► 自动落库
                                                                 └─ 低置信 ► pending,人工确认
```

## 1. 为什么是这个形状（设计原则）

1. **N×M → N+M**。输入源 N 个、领域 M 个。硬连是 N×M 段胶水;管线让两端各自只关心
   自己:Source 只管「产出 Capture」,Domain 只管「声明 Intent + 落库」。新增眼镜=加 1 个
   Source;新增「健身记录」领域=加 1 个 Intent 集。互不知道对方存在。
2. **领域自描述,路由通用**。每个 Domain 插件声明若干 **Intent**(名字+描述+JSON schema)。
   Router 不内置任何领域知识——它把「当前已注册的 Intent 集」作为**工具集**交给 LLM 做
   tool-use 分类与抽参(照片走 vision)。加领域=自动多一个可路由目标,Router 一行不改。
   这正是 lifeos「加 type 不改表」哲学在输入侧的对称体现。
3. **确定性优先,LLM 兜底**。能用规则/结构化负载/条码判定的,绝不调模型(便宜、可审计、离线)。
   只有自由文本/照片才落到 LLM 路由。省钱、可解释、可回放。
4. **钱和库存不许瞎猜**。低置信的捕获**不自动落库**,而是进 `pending` 待确认队列(网页/补货式
   勾选确认)。优雅 = 在不确定时诚实地停下,而不是制造错账。
5. **一切可溯源,幂等**。每个 Capture 自身就是一条实体(`type=capture`,append-only inbox),
   带稳定 `source_ref`(邮件 Message-Id、照片 sha、条码)用于去重;落库实体回连
   `entity -[captured_from]-> capture`。任何自动决策都能被追溯、复核、撤销。
6. **进程内起步,边界面向未来**。先做**进程内注册表**(个人规模,够了);但 Source/Intent 的
   契约设计成「可跨进程」——未来可把第三方插件做成独立 MCP server 或 WASM 沙箱接入,核心不变。

## 2. 数据模型（复用现有 entities/relations,不加表）

新增两个领域 type(沿用 `module.exports.types` 注册即可):

- `capture`（domain `inbox`）— 归一化的入站事件,**append-only**。
  ```jsonc
  { type:'capture', source:<channel>, source_ref:<外部稳定ID>,
    title:<摘要>, body:<text/transcript>, occurred_at:<采集时间>,
    status:'new'|'routed'|'pending'|'committed'|'dismissed'|'error',
    data:{ kind:'text'|'voice'|'photo'|'barcode'|'structured',
           media:[{ref,sha,mime}],      // 媒体只存引用,不内联
           author, hints, route:{intent, confidence, args, by:'rule'|'llm'},
           error? } }
  ```
- `pending_action`（domain `inbox`,可选)— 当置信不足时,把「建议的 Intent+args」挂起等确认;
  确认后执行 Intent、把 capture 置 `committed`。也可直接用 capture.status=`pending` + data.route 表达,
  省一个 type。**默认用后者**(KISS)。

关系:
- `entity -[captured_from]-> capture`（任何由捕获产生的实体都回指来源)
- `capture -[same_as]-> capture`（去重时把重复捕获并到首条)

## 3. 契约（接口）

### 3.1 Capture（归一化事件）
```ts
interface Capture {
  channel: string;                  // 'email' | 'webhook' | 'ray-ban' | 'barcode' | ...
  kind: 'text'|'voice'|'photo'|'barcode'|'structured';
  source_ref: string;               // 稳定外部ID(去重键)
  text?: string;                    // 文本 / 语音转写
  media?: { ref:string; mime:string; sha?:string }[];  // 照片等(引用)
  author?: string;
  occurred_at?: string;             // ISO
  hints?: Record<string,any>;       // 来源给的弱提示,如 {domain:'storage'}
  raw?: any;                        // 原始负载(审计)
}
```

### 3.2 Source 插件（入站适配器）
```ts
interface SourcePlugin {
  name: string;                     // 'webhook'
  channel: string;                  // 写进 capture.channel
  kind?: 'push'|'poll';
  // push: 框架给你 emit,你在收到外部事件时调用
  start?(emit: (c: Capture)=>Promise<void>): Promise<void>|void;
  // 或 HTTP 源:框架把 /ingest/<name> 的请求转给你
  webhook?(req): Promise<Capture|Capture[]>;
  // poll: 框架按 interval 调你
  poll?(): Promise<Capture[]>;
}
```

### 3.3 Domain Intent 插件（出站,领域自描述）
```ts
interface Intent {
  name: string;                     // 'storage.add_item'
  description: string;              // 给 LLM 路由读的自然语言说明
  schema: ZodSchema;                // 抽参 schema(也用于生成 tool-use JSON Schema)
  rules?: (c: Capture)=>({args}|null);   // 可选:确定性命中(命中即跳过 LLM)
  run(args, ctx): Promise<Entity>;  // ctx = { store, domains, capture }
  confirm?: 'always'|'never'|'low'; // 是否需人工确认(钱/库存默认 'low')
}
```
领域模块新增可选导出 `module.exports.intents = (store)=>Intent[]`,与现有
`module.exports.types` 对称。`storage.js` 先开 `add_item` / `place`;`finance.js` 开
`add_txn`;`baby` 开 `log_feed` / `log_diaper`;`notes` 开 `add_note`。

### 3.4 Router
1. 跑所有 Intent 的 `rules`,命中(唯一)→ 直接得 `{intent,args,confidence:1,by:'rule'}`。
2. 否则:把全部 Intent 当 **Anthropic tool-use 工具集**(含 vision:照片转 image block),
   让 Claude 选 1 个 intent 并抽参,返回 `{intent,args,confidence,by:'llm'}`。
   （无 LLM key 时:仅规则,未命中入 `pending`,等人工。优雅降级。)
3. 按 `Intent.confirm` 与 `confidence` 决策:`run` 自动落库,或挂 `pending`。

## 4. Meta Ray-Ban 怎么接（三条现实路径,都是「加一个 Source」）

眼镜目前**没有开放的第三方 API**,所以走它已有的出口,统一汇成 Capture:

- **A·语音**：「Hey Meta, message <lifeos 的 WhatsApp/Telegram 联系人>: *garage 加两箱 3 号尿布*」
  → `imessage/whatsapp/telegram` Source 收到文本 → Router(LLM) → `storage.add_item({name:'尿布',
  diaper_spec:{stage:3}, quantity:2, location:'garage'})`。
- **B·照片**：眼镜拍照自动同步到手机相册 → iCloud/Google Photos 共享相册 → `watch-folder`
  Source 监听目录 → photo Capture → Claude **vision** 读图(「3 罐番茄罐头,保质期 2026-08」或读条码)
  → `storage.add_item`。
- **C·Shortcut/Webhook**(若 Meta 开放或经伴侣 App 分享面板)→ iOS 快捷指令 POST → `webhook` Source。

**关键品味**:三条路对核心是同一件事——一个新的 Source 插件喂同一条管线。眼镜不进核心代码一行。

## 5. 与 agentic 侧闭环

- 新增 MCP 工具 `life_capture(text|image, hints?)`:让任意 Agent / Claude 客户端把一次观察
  直接推进 inbox,走同一 Router。检索(`life_context`)与录入(`life_capture`)共用一套实体与图谱。
- 反向:Router 的 LLM 路由其实就是「带 lifeos 领域工具的小 Agent」,与 MCP 工具集同源(同一批 Intent
  既是录入工具也可暴露给外部 Agent)。**录入和检索是同一套工具的两个方向。**

## 6. 安全 / 隐私

- 媒体只存**引用**(路径/URL+sha),不内联进 DB;敏感字段沿用财务那套加密拆分(明文可检索 + `data.enc`)。
- Webhook Source 必须校验签名/共享密钥;`config/plugins.json` 用**显式允许清单**启用插件,默认全关。
- inbox 是 append-only 审计带:谁、何时、用什么规则/模型、落成了什么,全部可回放与撤销。

## 7. 落地分期

- **P0(骨架,本仓即可实现)**:capture 实体 + 进程内注册表 + `webhook` & `watch-folder` 两个 Source
  + 确定性规则路由 + `storage.add_item` Intent + `pending` 队列 + 测试。无需任何外部依赖。
- **P1**:LLM 路由(Anthropic tool-use,文本)+ `finance.add_txn` / `baby.*` Intents + MCP `life_capture`。
- **P2**:vision 路由(照片→库存/条码)+ IM 机器人 Source(WhatsApp/Telegram)→ 打通眼镜语音/照片两路。
- **P3**:插件跨进程化(第三方插件作为独立 MCP server 接入)+ 网页 inbox 确认界面。

## 8. 明确不做（避免竞品踩过的坑,见 docs/COMPETITIVE.md）

- 不做「插件市场 / 任意第三方代码沙箱」的重型平台——个人规模,先进程内 + 允许清单。
- 不做「AI 自动什么都记」——钱/库存默认要确认;LLM 只在自由文本/照片处兜底,不抢规则的活。
- 不做实时双向同步引擎(CRDT/sync 地狱);DB 主 + 镜像 + append-only inbox 足够,冲突面小。
