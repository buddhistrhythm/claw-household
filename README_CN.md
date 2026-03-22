# Household Agent

[🌐 English](./README.md) | **中文**

AI 驱动的家庭管理——让 AI 处理日常琐事，释放你的精力。

追踪食材、预测补货需求、根据冰箱现有食材推荐菜谱、监控宝宝用品——通过 Claude Code（MCP）、命令行或本地 Web 面板操作。

## 快速开始

```bash
npm install
npm start          # Web 面板：http://localhost:3333
```

## 使用方式

### Claude Code（MCP）

在 Claude Code MCP 配置文件（`~/.claude/settings.json`）中添加：

```json
{
  "mcpServers": {
    "household": {
      "command": "node",
      "args": ["/path/to/household/skills/mcp-server.js"]
    }
  }
}
```

然后用自然语言对话即可：

- "家里还有什么菜" → `inventory_list`
- "这周要买什么" → `shopping_list`
- "宝宝水奶还能撑几天" → `baby_supply_status`
- "记一下用了 3 片尿布" → `baby_log_event`
- "冰箱里的东西能做什么菜" → `meal_suggestions`

### OpenClaw

通过 OpenClaw Skill Manager 导入 `skills/` 文件夹，或添加 MCP 配置：

```
command: node
args: [/path/to/household/skills/mcp-server.js]
```

Skill 元数据定义在 [`skills/SKILL.md`](./skills/SKILL.md)。

### 命令行

```bash
node skills/inventory.js add <条码或名称>           # 添加物品（通过 Open Food Facts 自动查询）
node skills/inventory.js consume <ID 或名称> [数量]  # 记录消耗
node skills/inventory.js list [存放位置]             # 查看库存
node skills/inventory.js expiring [天数]             # 即将过期物品（默认 7 天）
node skills/inventory.js status                     # 仪表盘概览
```

### Web 面板

`http://localhost:3333` — 包含库存、补货、烹饪、日历、宝宝追踪和设置等标签页。

## 架构

```
household/
├── skills/
│   ├── lib/
│   │   ├── data.js            # 共享数据层（原子 JSON 读写、路径、工具函数）
│   │   ├── inventory-ops.js   # 库存增删改查 + 补货逻辑
│   │   ├── baby-ops.js        # 宝宝日志操作
│   │   └── meal-ops.js        # 餐食日记 + 烹饪推荐
│   ├── mcp-server.js          # MCP 服务器（12 个工具，stdio 传输）
│   ├── server.js              # Express Web 服务器 + API
│   ├── inventory.js           # CLI 入口
│   ├── predict.js             # 消耗预测引擎
│   └── public/index.html      # 单页 Web 面板
├── data/                      # JSON 数据文件（已 gitignore）
└── config/                    # 分类、偏好和存放位置配置
```

三个入口——MCP 服务器、Web 服务器和 CLI——共享同一数据层（`lib/`），操作相同的 JSON 文件。

## MCP 工具

| 工具 | 描述 |
|------|------|
| `inventory_list` | 按筛选条件（位置、分类、状态）列出库存 |
| `inventory_add` | 添加物品，支持条码自动查询 |
| `inventory_consume` | 按 ID 或名称记录消耗 |
| `inventory_expiring` | 查看 N 天内即将过期物品 |
| `inventory_status` | 概览统计（总量、按位置/分类） |
| `restock_recommendations` | 基于消耗速率的智能补货建议 |
| `meal_suggestions` | 根据现有食材推荐菜谱 |
| `shopping_list` | 综合购物清单（补货 + 过期 + 菜谱缺口） |
| `baby_log_event` | 记录宝宝事件（喂养、尿布、睡眠等） |
| `baby_supply_status` | 宝宝用品余量及用尽时间预测 |
| `preferences_get` | 读取家庭偏好设置 |
| `preferences_update` | 更新偏好字段 |

## 核心功能

- **消耗预测** — 追踪使用模式，预测物品耗尽时间
- **智能补货** — 根据消耗速率自动生成购物清单
- **菜谱缺口匹配** — 找出只差 1 种食材就能做的菜
- **宝宝追踪** — 喂养、尿布、睡眠记录及用品预测
- **条码扫描** — 通过 Open Food Facts API 自动查询
- **图像识别** — 通过 Claude Vision 识别物品（Web 面板）

## 宝宝追踪器导入

从 [Baby Tracker](https://nighp.com/babytracker/) 应用导入宝宝生活记录（`.btcp` 格式）：

```bash
node skills/import-btcp.js <文件.btcp> [--dry-run] [--tz=8]
```

或通过 Web 面板在"设置 → 导入"中上传。

## 数据存储

所有数据均为本地 JSON 文件——无需云服务、数据库服务器或账号。原子写入（先写临时文件再重命名）防止数据损坏。

## 许可证

Apache License 2.0 — 详见 [LICENSE](./LICENSE)。

高级功能和附加服务可能有单独的条款。
