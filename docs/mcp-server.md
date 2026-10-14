# Analogy MCP 服务

Analogy 内置一个 MCP（Model Context Protocol）服务，让 Claude Desktop、Claude Code、Cursor、opencode、Codex 等 AI 客户端检索你的 Obsidian 仓库。

- **随插件交付**：服务代码打包在 `main.js` 里，社区插件三件套安装即可使用，不需要 `npm install`、`tsc` 或命令行。
- **离线运行**：用插件已安装并校验过的托管 Node 运行，从插件的模型缓存离线加载嵌入模型，不下载任何东西。
- **Obsidian 关闭也能用**：只读打开插件的 SQLite 索引。
- **混合检索**：语义相似度 + 关键词（专有名词、人名、代码标识符）融合排序。

## 一键接入

1. 在 Obsidian 中完成 Analogy 初始化并建好索引。
2. 打开 **设置 → Analogy → MCP**，在“接入 AI 客户端”里找到你的客户端，点击 **写入配置**。
3. 插件会先展示将要写入的具体改动（diff），确认后才写入；只新增或替换 `analogy-vault` 这一项，文件其余内容（格式、注释、其他服务）一字不改；原文件会在同目录保存为 `*.analogy-backup-<时间戳>`。
4. 重启客户端。

| 客户端 | 配置文件 |
|---|---|
| Claude Desktop | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`；Windows `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Code | `~/.claude.json`（用户级 `mcpServers`） |
| Cursor | `~/.cursor/mcp.json` |
| opencode | `~/.config/opencode/opencode.jsonc`（注释与格式原样保留） |
| Codex | `~/.codex/config.toml`（只替换 `[mcp_servers.analogy-vault]` 段，其余内容原样保留） |

状态说明：**已配置** 表示配置与当前插件一致；**需要更新** 通常出现在推理引擎升级之后（托管 Node 路径变了），再点一次写入即可。

### 手动配置

“复制 JSON”得到通用 stdio 配置，形如：

```json
{
  "mcpServers": {
    "analogy-vault": {
      "command": "<托管运行时的 node 路径>",
      "args": ["<数据目录>/mcp/analogy-mcp-server.cjs"],
      "env": {
        "ANALOGY_VAULT_PATH": "<仓库绝对路径>",
        "ANALOGY_PLUGIN_DIR": "<仓库>/.obsidian/plugins/analogy-rag-in-your-vault",
        "ANALOGY_MODEL": "<当前嵌入模型>",
        "ANALOGY_RUNTIME_MODULE_ROOT": "<托管运行时的 node_modules>"
      }
    }
  }
}
```

服务文件位于设备数据目录（macOS `~/Library/Application Support/Analogy/mcp/`，Windows `%LOCALAPPDATA%\Analogy\mcp\`），插件每次启动会按内容哈希校验并在需要时更新它，因此插件升级后无需改配置。

## 工具

### `vault_index_status`

返回索引状态、分块数量、嵌入模型、关键词索引是否就绪，以及可访问的路径范围。建议客户端先调用它。

### `vault_semantic_search`

参数：`query`（自然语言、名称或标识符）、`top_k`（1–50，默认 5）。返回结果包含 `title`、`path`、`similarity`、`matched_by`（`vector` / `keyword`）和片段内容。

## 环境变量

| 变量 | 说明 |
|---|---|
| `ANALOGY_VAULT_PATH` | 必填，仓库绝对路径 |
| `ANALOGY_PLUGIN_DIR` | 插件目录，默认 `<仓库>/.obsidian/plugins/analogy-rag-in-your-vault` |
| `ANALOGY_MODEL` | 嵌入模型；必须与插件建索引时使用的模型一致 |
| `ANALOGY_RUNTIME_MODULE_ROOT` | 托管运行时的 `node_modules`，用于加载 Transformers.js 与 ONNX Runtime |
| `ANALOGY_LOCAL_DATA_ROOT` | 覆盖设备数据目录（一般不需要） |
| `ANALOGY_ALLOWED_PATHS` | 逗号分隔的允许路径，例如 `projects,notes/public`；不设置则可检索整个仓库 |

## 隐私

- 只返回你允许的路径中的片段；路径过滤在服务端执行。
- 服务只在设备数据目录写一个 `last-query.json`（时间、工具名、结果数量），**不记录查询内容**；设置页的“最近一次 MCP 查询”就来自这里。
- 状态信息不包含仓库的真实路径。

## 故障排查

| 现象 | 处理 |
|---|---|
| “The vault has not been indexed … yet” | 打开 Obsidian，等待 Analogy 完成索引；确认 `ANALOGY_MODEL` 与插件当前模型一致 |
| “The embedding model … is not downloaded yet” | 在插件中完成初始化（模型会下载到设备数据目录） |
| “The Analogy managed runtime was not found” | 推理引擎升级或重装后，到 MCP 设置里点 **更新配置** |
| 搜不到精确名称 | `vault_index_status` 中 `keyword_index` 应为 `ready`；老索引升级后关键词索引在后台补建，期间只有语义检索 |
| 首次调用较慢 | 首次调用需要加载模型（几秒），之后常驻 |

旧版的独立 `mcp-server/` 包仍保留在仓库中供手动部署，但不再需要也不再推荐。
