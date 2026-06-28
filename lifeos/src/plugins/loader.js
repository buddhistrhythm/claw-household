'use strict';

/**
 * plugins/loader.js — IN-PROCESS 插件加载器（允许清单安全模型）.
 *
 * 一个第三方领域插件 = 一个 `plugins/<x>.js`，导出与 registry 完全相同的契约：
 *   module.exports          factory(store) -> domain instance
 *   module.exports.types    NEW entity types（types.js 派生注册）
 *   module.exports.commands (instance, util) -> { name: {desc, usage, run} }
 *   module.exports.intents  (store) -> Intent[]（捕获 Router 的可路由目标）
 * 只要在 `config/plugins.json` 里把它 `enabled:true`，就能白嫖 CLI 命令、捕获意图、
 * 实体类型与 MCP 暴露 —— 无需改动 registry.js（集成方把本 loader 接进去即可）。
 *
 * 安全模型 / SECURITY MODEL（务必读懂）：
 *   - 允许清单（allowlist）：只有在 config 中列出且 enabled 的插件才会被加载。
 *   - 默认空 / 关闭：随仓发布的 config 默认把示例插件设为 enabled:false。
 *   - IN-PROCESS = FULL TRUST：进程内插件以本进程的完整权限运行（文件系统、网络、
 *     环境变量、数据库），没有沙箱。只启用你信任其代码的插件。
 *     不信任的第三方代码请走 `kind:'mcp'`（进程外，由 MCP bridge 处理），本 loader 跳过它。
 *
 * One declaration per plugin; CLI dispatch, type seeding, capture routing and
 * MCP exposure all derive from the SAME domain contract the core domains use.
 * Allowlist = config; default empty/disabled; in-process plugins run with the
 * full privileges of this process (NO sandbox) — only enable code you trust.
 */

const fs = require('fs');
const path = require('path');

/**
 * 读取并解析 config/plugins.json；任何问题（缺失/非法/读不出）都安全回退为空清单。
 * Read & parse config/plugins.json. Missing / invalid → { plugins: [] } (no throw).
 * @param {string} [root] 仓库根目录（默认 require('../config').root）.
 * @returns {{ plugins: Array<{name,module,enabled?,kind?}> }}
 */
function readPluginConfig(root) {
  const base = root || require('../config').root;
  const file = path.join(base, 'config', 'plugins.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.plugins)) return { plugins: [] };
    return parsed;
  } catch {
    // 文件不存在 / JSON 非法 / 权限问题 —— 一律当作没有插件，绝不抛错。
    // Missing file, bad JSON, unreadable — treat as no plugins. Never throw.
    return { plugins: [] };
  }
}

/**
 * loadPlugins — 按允许清单加载进程内领域插件。
 * @param {object}  [opts]
 * @param {object}  [opts.config] 已解析的 plugins.json；缺省时从 root/config/plugins.json 读。
 * @param {string}  [opts.root]   仓库根目录（默认 require('../config').root）；用于解析相对 module 路径。
 * @returns {{ loaded: Array<{name,mod,module}>, disabled: string[], errors: Array<{name,module,error}> }}
 *   - loaded   : 成功加载的插件（mod 为领域 factory，可挂 .types/.commands/.intents）。
 *   - disabled : enabled:false 的插件名（被显式禁用）。
 *   - errors   : 加载失败的插件（require 抛错 / 导出不是 function）；一个坏插件不影响其它。
 */
function loadPlugins({ config, root } = {}) {
  const base = root || require('../config').root;
  const cfg = config || readPluginConfig(base);
  const entries = (cfg && Array.isArray(cfg.plugins)) ? cfg.plugins : [];

  const loaded = [];
  const disabled = [];
  const errors = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const { name, module: modSpec, enabled, kind } = entry;

    // 显式禁用：记入 disabled，不加载。 Explicitly disabled → record, skip.
    if (enabled === false) {
      disabled.push(name);
      continue;
    }

    // kind:'mcp' = 进程外插件，留给 MCP bridge；本 loader 既不加载也不报错。
    // Out-of-process plugin — left for the MCP bridge; neither loaded nor errored.
    if (kind === 'mcp') continue;

    // 解析 module：相对路径（./ ../ plugins/）相对仓库根；否则当裸包名 require。
    // Resolve module: relative paths are resolved against root; bare names require()'d as-is.
    let resolved = modSpec;
    if (typeof modSpec === 'string'
        && (modSpec.startsWith('./') || modSpec.startsWith('../') || modSpec.startsWith('plugins/'))) {
      resolved = path.resolve(base, modSpec);
    }

    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const mod = require(resolved);
      // 契约校验：导出必须是领域 factory（函数）。 The export MUST be the factory fn.
      if (typeof mod !== 'function') {
        errors.push({
          name, module: modSpec,
          error: `plugin "${name}" module "${modSpec}" must export a factory function (got ${typeof mod})`,
        });
        continue;
      }
      loaded.push({ name, mod, module: modSpec });
    } catch (err) {
      // 一个坏插件绝不能拖垮其它插件 —— 记入 errors 后继续。
      // One bad plugin must NOT break the others — record and carry on.
      errors.push({ name, module: modSpec, error: err && err.message ? err.message : String(err) });
    }
  }

  return { loaded, disabled, errors };
}

module.exports = loadPlugins;
module.exports.readPluginConfig = readPluginConfig;
