# Obsidian 发布合规与可验证构建设计

日期：2026-07-27

## 目标

修复 Obsidian 对 1.1.7 的自动审核阻断项，并将下一次公开发布版本升级为 1.1.8。新的发布流程必须满足：

1. 官方 Obsidian ESLint 规则可在本地和 Pull Request 中复现。
2. 社区安装器只下载 `main.js`、`manifest.json`、`styles.css` 时，本地嵌入 worker 仍可启动。
3. Release 资产由 GitHub Actions 从对应 tag 构建，而不是依赖本地上传。
4. Release 资产具有 GitHub artifact provenance attestation。
5. 公开仓库不包含私有服务实现、内部环境配置或其他敏感材料。

## 范围

- 开发源仓库和公开发布仓库同步修改 worker 与审核阻断相关源码。
- ESLint、TypeScript、Pull Request CI 和 Release workflow 只加入公开发布仓库。
- 不重写已经发布的 `1.1.7` tag；修复通过 `1.1.8` 发布。
- 保留完整运行时压缩包供手动安装，但插件运行不能依赖 Obsidian 社区安装器下载该压缩包或额外 worker 文件。

## Worker 分发设计

### 构建

esbuild 先在内存中构建 `src/local-vector/embedding-worker.ts`，得到 CommonJS worker 源码。随后将这段源码作为编译期常量注入主插件构建：

```text
embedding-worker.ts
        │ esbuild（write: false）
        ▼
内存中的 CommonJS 源码
        │ JSON 安全编码并注入
        ▼
main.js
```

生产构建不再输出或发布独立的 `embedding-worker.js`。构建在 worker 源码为空、构建失败或无法注入时立即失败。

### 运行

`EmbeddingWorkerClient` 接收内嵌 worker 源码，在插件目录的 `worker/` 子目录中生成带 build ID 的 `.cjs` 文件：

1. 计算内嵌源码 SHA-256。
2. 写入同目录临时文件。
3. 校验临时文件 SHA-256。
4. 使用 rename 原子替换目标文件。
5. 保留当前及上一个 worker 文件，清理更旧版本。
6. 使用现有受控子进程协议启动 worker。

这样社区安装只需 Obsidian 支持的三个文件。手动完整运行时安装与社区安装使用同一份 `main.js`，不会形成两套 worker 行为。

### 错误处理

- 缺少或为空的内嵌源码产生明确的 `EMBEDDING_WORKER_UNAVAILABLE` 错误。
- 写入、校验或启动失败继续进入现有诊断与安全模式流程。
- 临时文件尽力清理，但清理失败不能覆盖原始错误。
- 不启用默认的进程内嵌入回退，以维持 1.1.7 引入的崩溃隔离目标。

## 自动审核与类型检查

公开仓库迁移到 ESLint 9 flat config，并使用官方 `eslint-plugin-obsidianmd@0.4.1` 推荐规则。项目规则保留必要的 TypeScript 兼容设置，但不允许通过行内指令关闭 `no-console`。

新增脚本：

- `npm run lint`：运行 TypeScript 基础规则和 Obsidian 官方推荐规则。
- `npm run typecheck`：运行 `tsc --noEmit`。
- `npm run check`：顺序执行 lint、typecheck、公开测试和生产构建。

历史 release、生成 bundle、运行时依赖目录和本地缓存不参与源码 lint；当前 `main.ts`、`src/`、manifest 和许可证参与检查。

## Pull Request CI

Pull Request 和主分支推送运行同一个验证工作流：

1. Checkout。
2. 固定 Node.js 20 并启用 npm 缓存。
3. `npm ci`。
4. `npm run lint`。
5. `npm run typecheck`。
6. 运行公开回归测试。
7. `npm run build`。
8. 验证工作区生成的标准发布文件完整。

任一步骤失败都会阻止工作流通过。Obsidian 规则的 warning 保持 warning；官方规则标记为 error 的问题阻止合并。

## Release 与 attestation

Release workflow 支持语义版本 tag 和手动指定 tag。流程为：

1. 校验 tag、`package.json`、`manifest.json`、`versions.json` 版本一致。
2. 从 tag 对应 commit 执行与 PR 相同的验证。
3. 生成生产构建和完整运行时压缩包。
4. 对 `main.js`、`manifest.json`、`styles.css` 和完整运行时压缩包执行 `actions/attest@v4`。
5. 创建或更新对应 GitHub Release，并上传同一次 workflow 生成且已证明来源的文件。

工作流最小权限为：

- `contents: write`：创建或更新 Release。
- `id-token: write`：获取短期 OIDC 身份。
- `attestations: write`：写入 provenance attestation。
- `artifact-metadata: write`：建立 GitHub artifact 记录。

Release 不再上传独立 `embedding-worker.js`。完整运行时压缩包仍是手动安装补充资产，Obsidian 社区安装逻辑不依赖它。

## 测试策略

行为修改采用测试先行：

1. 先增加失败测试，证明只有社区标准文件时旧实现无法物化 worker。
2. 实现内嵌 worker 后，使物化、SHA-256 校验、复用和旧文件清理测试通过。
3. 增加发布完整性测试，断言 Release 标准文件不包含独立 worker 依赖。
4. 增加静态审核测试，阻止未描述 ESLint directive 和 `no-console` 禁用指令再次出现。
5. 在两个仓库运行相关回归测试；在公开仓库运行完整 lint、typecheck、构建和发布完整性验证。

所有专门测试文件放在各自项目的 `test/` 目录。

## 同步与安全边界

- 先在开发源仓库应用并验证源码修改，再将相同的公开源码白名单同步到发布仓库。
- CI、workflow、公开测试和公开构建配置在发布仓库维护。
- 同步后对 tracked 文件执行敏感关键词、环境文件和私有入口扫描。
- 不复制私有文档、商业服务端目录、内部测试、环境文件或部署产物。

## 验收标准

- 源码中不再存在本次审核命中的 7 个 ESLint disable 指令。
- `npm run lint` 不包含阻断级错误。
- `npm run typecheck` 成功。
- 仅安装 `main.js`、`manifest.json`、`styles.css` 时能够物化并启动 worker。
- 生产构建不再生成或要求独立 `embedding-worker.js` Release 资产。
- Pull Request CI 能复现上述验证。
- 1.1.8 tag workflow 能构建 Release，并为发布资产生成可验证的 GitHub attestation。
- 公开仓库敏感内容扫描无新增命中。
