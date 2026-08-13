# Obsidian review fix: local runtime

目标：降低 Obsidian 审核中 `Shell Execution` 和 `Direct Filesystem Access` 两项高风险警告。

## 必要修改

### 1. 停止插件自动启动 ChromaDB

当前问题：

- `src/local-vector/chroma-process.ts` 使用 `child_process.spawn()` 自动执行 `chroma`、`python3 -m chromadb...` 等命令。
- 这会触发 Obsidian 审核的 `Shell Execution` 警告。

修复方案：

- 移除插件运行时对 `child_process` 的依赖。
- `ChromaProcessManager` 改为只检查 `127.0.0.1:<port>` 是否已有 ChromaDB 服务。
- 如果服务未运行，在设置页提示用户手动启动：

```bash
chroma run --path <vault-or-plugin-data-dir>/chroma_data --host 127.0.0.1 --port 8000
```

- 插件只负责连接本地服务，不负责安装、启动或停止外部进程。

涉及文件：

- `src/local-vector/chroma-process.ts`
- `main.ts`
- `src/SettingView.tsx`
- `docs/local-runtime.md`

### 2. 移除运行时索引状态的直接文件系统缓存

当前问题：

- `src/local-vector/document-indexer.ts` 使用 Node `fs` 在插件目录读写 `index_state_*.json`。
- `main.ts` 和 `src/local-vector/embedding.ts` 也用 `fs.existsSync()` 检测本地模型文件。
- 这些会触发 Obsidian 审核的 `Direct Filesystem Access` 警告。

修复方案：

- 将 `DocumentIndexer` 的索引状态读写迁移到 Obsidian 插件数据 API：
  - 由主插件通过 `loadData()` 加载状态。
  - 由主插件通过 `saveData()` 保存状态。
  - 状态按模型名存入插件数据字段，例如 `indexStates[modelShortName]`。
- `DocumentIndexer` 不再接收 `pluginDir/statePath`，改为接收状态读写回调。
- 本地模型文件检测不再使用 `fs.existsSync()`；改为：
  - 默认使用远程模型下载/Transformers 缓存；
  - 或在设置中让用户显式选择本地模型模式，并说明社区审核版本默认不检测任意磁盘路径。

涉及文件：

- `src/local-vector/document-indexer.ts`
- `src/local-vector/embedding.ts`
- `main.ts`
- `src/SettingView.tsx`

## 验收标准

- 构建后的 `main.js` 中不再出现 `child_process`。
- 构建后的 `main.js` 中不再出现 `require("fs")`、`from "fs"` 或 `fs.existsSync`。
- ChromaDB 未启动时，插件显示清晰错误和手动启动命令，而不是尝试自动执行命令。
- 现有索引状态可从旧 `index_state_*.json` 放弃或手动迁移；社区审核版本优先保证不再直接访问文件系统。
- `npm run build` 成功。

## 不在本次范围

- 不移除 vault 文件读取能力；RAG 索引仍需要通过 Obsidian Vault API 读取 Markdown。
- 不处理 `localStorage`、CSS lint、依赖漏洞提示和 GitHub artifact attestations。
- 不改变 ChromaDB 本身的数据存储方式；只改变插件是否自动启动外部进程、是否直接读写索引状态文件。
