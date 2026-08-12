# Analogy Obsidian MCP Server 配置说明

## 概述

Analogy MCP Server 将 Obsidian vault 的本地向量搜索能力暴露给 AI Agent。Agent 可以通过 MCP 协议对你的笔记库进行**语义搜索**——基于余弦相似度匹配 embedding 向量，而非关键词匹配。

### 工作原理

```
AI Agent (Claude Code / Cursor / ...)
    │
    │  stdio (MCP 协议)
    ▼
Analogy MCP Server (Node.js 进程)
    │
    ├── 连接 ChromaDB (由 Obsidian 插件启动，默认端口 8000)
    │       └── 读取已索引的文档向量
    │
    └── 加载 Embedding 模型 (与插件使用同一模型)
            └── 将查询文本转为向量 → 余弦相似度搜索
```

**前提条件：Obsidian 必须在运行中，且 Analogy 插件已完成文档索引。**

---

## 构建

```bash
cd /path/to/analogy-rag-in-your-vault/mcp-server

npm install
npm run build
```

构建产物在 `mcp-server/dist/index.js`。

---

## MCP Tools 说明

Server 提供两个工具，Agent 应按顺序使用：

### 1. `vault_index_status`

**用途：** 查询索引状态。Agent 应**先调用此工具**，了解 vault 是否就绪、索引了多少文档块、以及当前的访问权限范围。

**参数：** 无

**返回示例：**

```json
{
  "status": "ready",
  "vault": "my-vault (id: 299773cf649a). Embedding model: jina-nano. Scope: entire vault",
  "collection_name": "analogy_299773cf649a_jina-nano",
  "total_chunks": 1842,
  "embedding_model": "jina-nano",
  "chroma_port": 8000,
  "access_control": {
    "mode": "restricted",
    "allowed_paths": ["notes/public", "projects"]
  }
}
```

### 2. `vault_semantic_search`

**用途：** 通过余弦相似度在已索引的文档中搜索语义最相近的内容块。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 是 | 自然语言查询文本。用语义描述而非关键词效果更好 |
| `top_k` | number | 否 | 返回最相似的前 K 条结果（1-50，默认 5） |

**返回示例：**

```json
{
  "query": "如何管理项目依赖",
  "model": "jina-nano",
  "total_results": 3,
  "results": [
    {
      "rank": 1,
      "title": "Python 项目管理",
      "path": "notes/dev/python-deps.md",
      "cosine_distance": 0.2341,
      "similarity": 0.7659,
      "content": "使用 uv 管理 Python 依赖是目前推荐的方式..."
    }
  ]
}
```

### 错误码

所有错误返回 JSON 格式，包含 `error`（错误码）、`message`（详细描述）和 `suggestion`（修复建议）：

| 错误码 | 含义 |
|--------|------|
| `EMPTY_QUERY` | 查询字符串为空 |
| `COLLECTION_NOT_FOUND` | 向量集合不存在，vault 可能未索引 |
| `SEARCH_FAILED` | 搜索执行失败（ChromaDB 不可用或模型错误） |
| `STATUS_CHECK_FAILED` | 无法连接 ChromaDB 检查状态 |

---

## 客户端配置

### Claude Code

编辑 `~/.claude/settings.json`（全局）或项目目录下的 `.claude/settings.json`：

```json
{
  "mcpServers": {
    "analogy-vault": {
      "command": "node",
      "args": [
        "/path/to/analogy-rag-in-your-vault/mcp-server/dist/index.js"
      ],
      "env": {
        "ANALOGY_VAULT_PATH": "/path/to/your-obsidian-vault",
        "ANALOGY_CHROMA_PORT": "8000",
        "ANALOGY_MODEL": "jina-nano"
      }
    }
  }
}
```

### Cursor

编辑 `~/.cursor/mcp.json` 或项目目录下的 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "analogy-vault": {
      "command": "node",
      "args": [
        "/path/to/analogy-rag-in-your-vault/mcp-server/dist/index.js"
      ],
      "env": {
        "ANALOGY_VAULT_PATH": "/path/to/your-obsidian-vault"
      }
    }
  }
}
```

### 其他 MCP 客户端（通用 stdio 格式）

任何支持 MCP stdio 传输的客户端都可以连接。核心配置：

- **命令：** `node`
- **参数：** `["/path/to/mcp-server/dist/index.js"]`
- **环境变量：** 至少设置 `ANALOGY_VAULT_PATH`

---

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `ANALOGY_VAULT_PATH` | **是** | — | Obsidian vault 的绝对路径 |
| `ANALOGY_CHROMA_PORT` | 否 | `8000` | ChromaDB 监听端口，需与 Obsidian 插件设置一致 |
| `ANALOGY_MODEL` | 否 | `jina-nano` | Embedding 模型。可选：`jina-nano`、`bge-small-zh` |
| `ANALOGY_PLUGIN_DIR` | 否 | 自动推导 | Analogy 插件目录的绝对路径（非标准安装时使用） |
| `ANALOGY_MODEL_HOST` | 否 | `https://hf-mirror.com/` | 模型下载镜像地址（海外用户可改为 `https://huggingface.co/`） |
| `ANALOGY_ALLOWED_PATHS` | 否 | 空（全 vault） | 逗号分隔的允许搜索路径，用于权限控制 |

### Embedding 模型选择

| 模型 | 大小 | 特点 | 最大输入字符 |
|------|------|------|-------------|
| `jina-nano` | 239M (Q8) | 多语言，精度较高，推荐默认 | 8000 |
| `bge-small-zh` | ~50M (Q8) | 中文优化，体积小 | 1500 |

**注意：MCP server 使用的模型必须与 Obsidian 插件设置中的模型一致**，否则查询向量和索引向量维度不匹配，搜索结果无意义。

---

## 访问权限控制

通过 `ANALOGY_ALLOWED_PATHS` 限制 Agent 可以搜索的 vault 路径范围。

### 不设置（默认）

Agent 可以搜索整个 vault 的所有已索引文档。

### 限制特定目录

```json
"env": {
  "ANALOGY_VAULT_PATH": "/path/to/my-vault",
  "ANALOGY_ALLOWED_PATHS": "notes/public,projects/docs"
}
```

上例中 Agent 只能获取 `notes/public/` 和 `projects/docs/` 下的搜索结果。其余目录的文档即使已被索引，也会在结果中被过滤掉。

### 权限控制原理

- 过滤在 MCP server 侧执行，ChromaDB 返回的原始结果在送达 Agent 前经过路径白名单检查
- 路径匹配规则：精确匹配或前缀匹配（`projects` 会匹配 `projects/` 下的所有文件）
- Agent 调用 `vault_index_status` 时会看到 `access_control` 字段，明确告知可访问范围

---

## 故障排查

### MCP server 连接后 Agent 报错 "ChromaDB is not reachable"

1. 确认 Obsidian 正在运行
2. 在 Obsidian 中打开 Analogy 插件设置，确认状态为 "ready"
3. 检查 `ANALOGY_CHROMA_PORT` 是否与插件设置中的端口一致（默认 8000）
4. 终端测试：`curl http://127.0.0.1:8000/api/v2/heartbeat`

### 报错 "Vector collection not found"

1. Obsidian 插件可能还在索引中，等待完成
2. 检查 `ANALOGY_MODEL` 是否与插件中选择的模型一致
3. vault 路径是否正确（不同路径会生成不同的 collection name）

### 搜索结果为空

1. 调用 `vault_index_status` 确认 `total_chunks > 0`
2. 如果设置了 `ANALOGY_ALLOWED_PATHS`，确认目标文件在允许路径内
3. 尝试更通用的查询语句——这是语义搜索，过于具体的专有名词可能没有近义匹配

### 首次调用很慢

正常现象。MCP server 采用懒初始化策略——首次调用工具时才加载 embedding 模型（约 5-15 秒），后续调用即时响应。
