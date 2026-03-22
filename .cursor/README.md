# Cursor MCP（本仓库）

## Notion

已配置官方远程 MCP：`https://mcp.notion.com/mcp`（见 `mcp.json`）。

### 你需要做的

1. **完全退出并重新打开 Cursor**（或重载窗口），让 MCP 配置生效。
2. 打开 **Cursor Settings → MCP**，确认列表里出现 **notion**，状态为已连接或待授权。
3. **第一次**使用 Notion 相关工具时，按提示完成 **浏览器 OAuth**，登录并授权工作区。
4. 在 Notion 里对需要 AI 访问的页面：**⋯ → 连接 / Add connections**，把 **Notion MCP**（或对应集成）连到该页面，否则 API 读不到。

### 全局配置（可选）

若希望所有项目都能用 Notion MCP：在 Cursor **Settings → MCP → Add new global MCP server** 中粘贴与 `mcp.json` 相同的 `notion` 配置。

文档：<https://developers.notion.com/docs/get-started-with-mcp>
