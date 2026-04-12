#!/usr/bin/env node
'use strict';

/**
 * claw — Claude Code companion CLI for household management
 *
 * Usage:
 *   claw                  # dashboard or first-run welcome
 *   claw status           # inventory overview
 *   claw list [location]  # list inventory
 *   claw add <barcode|name> # add item
 *   claw consume <id|name> [qty] [note]
 *   claw expiring [days]
 *   claw search <keyword>
 *   claw serve [--port N] # start web dashboard
 *   claw skill install    # install Claude Code / OpenClaw skill
 *   claw skill show       # show skill content
 *   claw skill remove     # uninstall skill
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const BASE = path.join(__dirname, '..');
const INVENTORY_CLI = path.join(BASE, 'skills', 'inventory.js');
const SERVER_JS = path.join(BASE, 'skills', 'server.js');
const MCP_SERVER = path.join(BASE, 'skills', 'mcp-server.js');

// ─── Colors ──────────────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m',
  red: '\x1b[31m', magenta: '\x1b[35m', blue: '\x1b[34m',
};

// ─── First run detection ─────────────────────────────────────────────────────

function dataDir() {
  return process.env.CLAW_DATA_DIR || path.join(BASE, 'data');
}

function isFirstRun() {
  const inv = path.join(dataDir(), 'inventory.json');
  return !fs.existsSync(inv);
}

// ─── Welcome ─────────────────────────────────────────────────────────────────

function showWelcome() {
  console.log(`
${c.bold}${c.cyan}  🏠  Claw — 家庭智能管理${c.reset}
${c.dim}  Claude Code companion for household management${c.reset}

  ${c.green}Quick start:${c.reset}

    ${c.bold}claw serve${c.reset}              Start web dashboard (port 3333)
    ${c.bold}claw add 牛奶${c.reset}           Add item to inventory
    ${c.bold}claw status${c.reset}             Overview dashboard
    ${c.bold}claw skill install${c.reset}      Install skill for Claude Code

  ${c.green}Inventory:${c.reset}

    ${c.bold}claw list${c.reset}               List all items
    ${c.bold}claw list 冰箱冷藏${c.reset}      List items by location
    ${c.bold}claw expiring${c.reset}           Items expiring soon
    ${c.bold}claw search 鸡蛋${c.reset}        Search inventory
    ${c.bold}claw consume 牛奶${c.reset}       Record consumption

  ${c.green}Agent integration:${c.reset}

    ${c.bold}claw skill install${c.reset}      Install for Claude Code / OpenClaw
    ${c.bold}claw skill show${c.reset}         Show skill file content
    ${c.bold}claw skill remove${c.reset}       Uninstall skill

  ${c.dim}Data: ${dataDir()}${c.reset}
  ${c.dim}Web:  http://localhost:3333${c.reset}
`);
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

async function showDashboard() {
  return runInventory(['status']);
}

// ─── Inventory proxy ─────────────────────────────────────────────────────────

function runInventory(args) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [INVENTORY_CLI, ...args], {
      stdio: 'inherit',
      cwd: BASE,
    });
    proc.on('close', (code) => resolve(code || 0));
    proc.on('error', (e) => {
      console.error(`${c.red}Error: ${e.message}${c.reset}`);
      resolve(1);
    });
  });
}

// ─── Serve ───────────────────────────────────────────────────────────────────

function runServe(port) {
  const env = { ...process.env };
  if (port) env.PORT = String(port);
  const proc = spawn(process.execPath, [SERVER_JS], {
    stdio: 'inherit',
    cwd: BASE,
    env,
  });
  proc.on('error', (e) => {
    console.error(`${c.red}Error: ${e.message}${c.reset}`);
    process.exit(1);
  });
  // Forward SIGINT
  process.on('SIGINT', () => { proc.kill('SIGINT'); });
}

// ─── Skill management ────────────────────────────────────────────────────────

function skillFrontmatter() {
  return `---
name: household
description: "Search and manage the user's household inventory, meal planning, baby tracking, and shopping lists. Use when the user asks about groceries, expiring items, what to cook, baby supplies, or restocking."
---`;
}

function skillBody() {
  return `
# Household Agent — Claw

家庭智能管理助手：库存、餐食、宝宝、补货。

## Available Commands

\`\`\`bash
claw status              # 库存总览
claw list [location]     # 库存列表
claw add <barcode|name>  # 入库
claw consume <id|name>   # 消耗
claw expiring [days]     # 过期预警
claw search <keyword>    # 搜索
claw serve               # 启动 Web 面板
\`\`\`

## MCP Tools (12 tools via stdio)

When this skill is installed as an MCP server, you have access to:

- \`inventory_list\` — 查看库存（按位置/品类/状态筛选）
- \`inventory_add\` — 入库（条码自动查询）
- \`inventory_consume\` — 记录消耗
- \`inventory_expiring\` — 过期清单
- \`inventory_status\` — 总览
- \`restock_recommendations\` — 补货推荐
- \`meal_suggestions\` — 今天吃什么
- \`shopping_list\` — 购物清单
- \`baby_log_event\` — 宝宝事件
- \`baby_supply_status\` — 宝宝用品预测
- \`preferences_get\` / \`preferences_update\` — 设置

## Natural Language Examples

| 用户说 | 操作 |
|--------|------|
| 家里还有什么菜 | \`claw list\` or \`inventory_list\` |
| 帮我记一下买了牛奶 | \`claw add 牛奶\` |
| 鸡蛋用完了 | \`claw consume 鸡蛋\` |
| 什么快过期了 | \`claw expiring\` |
| 这周要买什么 | \`shopping_list\` |
| 今晚吃什么 | \`meal_suggestions\` |
| 宝宝水奶还能撑几天 | \`baby_supply_status\` |

## Data

All data stored locally. No cloud, no account required.
- Inventory: ${dataDir()}/inventory.json
- Web dashboard: http://localhost:3333
`;
}

function skillContent(withFrontmatter) {
  return withFrontmatter ? skillFrontmatter() + '\n' + skillBody() : skillBody();
}

function detectAgents() {
  const agents = [];
  const claudeDir = path.join(os.homedir(), '.claude');
  const openclawDir = path.join(os.homedir(), '.openclaw');
  const codexDir = path.join(os.homedir(), '.codex');

  if (fs.existsSync(claudeDir)) agents.push({ name: 'Claude Code', dir: path.join(claudeDir, 'commands'), ext: '.md', frontmatter: true });
  if (fs.existsSync(openclawDir)) agents.push({ name: 'OpenClaw', dir: path.join(openclawDir, 'commands'), ext: '.md', frontmatter: true });
  if (fs.existsSync(codexDir)) agents.push({ name: 'Codex', dir: path.join(codexDir, 'instructions'), ext: '.md', frontmatter: false });

  // Default: Claude Code
  if (agents.length === 0) {
    agents.push({ name: 'Claude Code', dir: path.join(claudeDir, 'commands'), ext: '.md', frontmatter: true });
  }
  return agents;
}

function installSkill() {
  const agents = detectAgents();
  const results = [];

  for (const agent of agents) {
    const filePath = path.join(agent.dir, `household${agent.ext}`);
    const content = skillContent(agent.frontmatter);

    fs.mkdirSync(agent.dir, { recursive: true });

    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, 'utf-8');
      if (existing === content) {
        results.push({ agent: agent.name, action: 'up-to-date', path: filePath });
        continue;
      }
    }

    fs.writeFileSync(filePath, content);
    results.push({ agent: agent.name, action: fs.existsSync(filePath) ? 'updated' : 'installed', path: filePath });
  }

  // Also install MCP server config hint
  const mcpHint = `
  ${c.dim}To also enable MCP tools, add to your agent settings:${c.reset}

    ${c.cyan}"mcpServers": {
      "household": {
        "command": "node",
        "args": ["${MCP_SERVER}"]
      }
    }${c.reset}
`;

  return { results, mcpHint };
}

function removeSkill() {
  const agents = detectAgents();
  const removed = [];
  for (const agent of agents) {
    const filePath = path.join(agent.dir, `household${agent.ext}`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      removed.push({ agent: agent.name, path: filePath });
    }
  }
  return removed;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || '';

  if (!cmd) {
    if (isFirstRun()) {
      showWelcome();
    } else {
      await showDashboard();
    }
    return;
  }

  switch (cmd) {
    case 'status':
      await runInventory(['status']);
      break;

    case 'list':
    case 'ls':
      await runInventory(['list', ...args.slice(1)]);
      break;

    case 'add':
      await runInventory(['add', ...args.slice(1)]);
      break;

    case 'consume':
    case 'use':
      await runInventory(['consume', ...args.slice(1)]);
      break;

    case 'expiring':
    case 'exp':
      await runInventory(['expiring', ...args.slice(1)]);
      break;

    case 'search':
    case 'find':
      await runInventory(['search', ...args.slice(1)]);
      break;

    case 'serve':
    case 'web':
    case 'server': {
      const portIdx = args.indexOf('--port');
      const port = portIdx >= 0 ? args[portIdx + 1] : undefined;
      runServe(port);
      break;
    }

    case 'skill': {
      const sub = args[1] || 'show';

      if (sub === 'install') {
        const { results, mcpHint } = installSkill();
        if (results.length === 0) {
          console.log(`  ${c.yellow}No agents detected.${c.reset} Use ${c.bold}claw skill show${c.reset} to copy manually.`);
          break;
        }
        const labels = { installed: `${c.green}Installed${c.reset}`, updated: `${c.green}Updated${c.reset}`, 'up-to-date': `${c.dim}Already up to date${c.reset}` };
        for (const r of results) {
          console.log(`  ${labels[r.action] || r.action} for ${c.bold}${r.agent}${c.reset}: ${c.dim}${r.path}${c.reset}`);
        }
        if (results.some((r) => r.action === 'installed' || r.action === 'updated')) {
          console.log(`\n  Try: ${c.cyan}/household${c.reset} in Claude Code, or ask about your inventory.`);
          console.log(mcpHint);
        }
      } else if (sub === 'show') {
        console.log(skillContent(true));
      } else if (sub === 'remove' || sub === 'uninstall') {
        const removed = removeSkill();
        if (removed.length === 0) {
          console.log(`  ${c.dim}No skill files found to remove.${c.reset}`);
        } else {
          for (const r of removed) {
            console.log(`  ${c.red}Removed${c.reset} from ${c.bold}${r.agent}${c.reset}: ${c.dim}${r.path}${c.reset}`);
          }
        }
      } else {
        console.log(`  Unknown skill command: ${sub}`);
        console.log(`  Usage: claw skill install|show|remove`);
      }
      break;
    }

    case 'version':
    case '-v':
    case '--version': {
      const pkg = require(path.join(BASE, 'package.json'));
      console.log(`claw v${pkg.version}`);
      break;
    }

    case 'help':
    case '-h':
    case '--help':
      showWelcome();
      break;

    default:
      // Try as inventory subcommand
      await runInventory(args);
  }
}

main().catch((e) => {
  console.error(`${c.red}${e.message || e}${c.reset}`);
  process.exit(1);
});
