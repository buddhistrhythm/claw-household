# Plugins — 第三方领域插件（in-process）

Drop a `plugins/<x>.js` domain module, enable it in `config/plugins.json`, and you
get CLI commands, capture-router intents, entity types, and MCP exposure **for
free** — with no edit to the registry.

一个插件 = 一个领域模块，导出与核心 `src/domains/*` **完全相同的契约**。把它加进
允许清单（`config/plugins.json`）并设 `enabled:true`，registry 就会自动派生出
CLI 命令、实体类型与捕获意图。参考实现见 [`water.js`](./water.js)（复制即用）。

## The domain contract

```js
module.exports = function myDomain(store) {  // REQUIRED: factory(store) -> instance
  return { /* your methods, e.g. async log({...}) { ... } */ };
};

// OPTIONAL — new entity types this plugin introduces (auto-registered):
module.exports.types = [
  { type: 'hydration_log', domain: 'health', label: '喝水', icon: '💧',
    description: '...', schema: { fields: { ml: 'number' } } },
];

// OPTIONAL — CLI commands (auto-wired into the cli). util = { csv, num }:
module.exports.commands = (instance, { num }) => ({
  water: { desc: '...', usage: 'water <ml>',
           run: ({ positional, flags }) => instance.log({ ml: Number(positional[0]) }) },
});

// OPTIONAL — capture-router / MCP intents (auto-wired). zod is available:
module.exports.intents = (store) => [
  { name: 'health.log_water', description: '...', confirm: 'low',
    schema: z.object({ ml: z.number().int().positive() }),
    rules: (c) => { /* deterministic match -> {args} | null */ },
    run: async (args, ctx) => myDomain(ctx.store).log(args) },
];
```

How the registry derives everything from this one declaration:

- **`types`** → seeded into `entity_types` (Web/labels/icons).
- **`commands(instance, util)`** → the CLI dispatch table (`desc` / `usage` / `run`).
  `run` receives `{ positional, flags }`. `util.num` / `util.csv` coerce flag values.
- **`intents(store)`** → routable targets for the capture pipeline (and exposed over
  MCP). Each Intent: `name`, `description`, zod `schema`, optional `rules(capture)`
  (deterministic hit → `{args}` or `null`), `run(args, ctx)` → entity, and a
  `confirm` policy (`'never' | 'low' | 'always'`).

## Enabling a plugin — the allowlist

`config/plugins.json` is the **allowlist**. Default = empty / everything disabled.

```json
{ "plugins": [ { "name": "water", "module": "./plugins/water.js", "enabled": true } ] }
```

- `module`: a path starting with `./`, `../`, or `plugins/` resolves against the repo
  root; anything else is treated as a bare npm package name.
- `enabled`: omit or `true` to load; `false` to keep it disabled (still documented).
- `kind`: omit (default) for an in-process plugin; `"mcp"` for an out-of-process one.

## ⚠️ Trust warning

**In-process plugins run with the FULL privileges of the lifeos process** —
filesystem, network, environment variables, the database. There is **no sandbox**.
进程内插件以本进程的完整权限运行，没有沙箱。**只启用你信任其代码的插件。**

If you need to run untrusted or third-party code at arm's length, ship it as an
**out-of-process MCP plugin** (`"kind": "mcp"`). The in-process loader skips those
entries; they are handled by the MCP bridge, which talks to the plugin over the MCP
protocol instead of `require()`-ing it into this process.
