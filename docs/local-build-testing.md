# Obsidian 插件本地构建与真实宿主测试

本文是 Analogy Obsidian 插件的本地开发标准流程。目标是让真实 Obsidian 加载当前源码构建出的插件，同时复用本机已经安装并校验通过的托管运行时。

## 1. 核心规则

- 在真实 Obsidian 中测试本地源码时，必须使用 `npm run build:local`。
- 不要把普通 `npm run build` 的产物作为真实 Obsidian 本地测试包。普通构建允许仓库中的 `development-fixture`，该 fixture 使用 `example.invalid`，无法完成真实运行时初始化。
- `build:local` 只在构建时读取本机已验证的运行时绑定，不修改仓库中用于正式发布的生成清单。
- 本地部署必须同时更新 `main.js`、`manifest.json` 和 `styles.css`，不能只复制 `main.js`。
- 如果验证过程中运行过 `npm run build`，必须在交付用户刷新前再次运行 `npm run build:local`，确保开发插件目录里最后留下的是本地产物。
- 正式发布仍使用 `npm run release:prepare`，不得用本地构建代替三平台运行时发布和签名验证。

## 2. 当前开发环境

当前源码目录是本公开仓库的本地 Clone，例如：

```text
/path/to/obsidian-extension
```

测试 Vault（示例）：

```text
/path/to/vault
```

Vault 中的插件入口：

```text
/path/to/vault/.obsidian/plugins/analogy
```

该入口应链接到源码仓库中的开发插件目录：

```text
/path/to/obsidian-extension/.obsidian/plugins/obsidian-extension
```

macOS 本机托管运行时默认位于：

```text
~/Library/Application Support/Analogy
```

## 3. 构建前检查

进入插件目录：

```bash
cd /path/to/obsidian-extension
```

确认 Vault 插件入口指向开发目录：

```bash
ls -ld /path/to/vault/.obsidian/plugins/analogy
```

确认本机已有嵌入运行时指针：

```bash
jq . "$HOME/Library/Application Support/Analogy/runtime/current/embedding-runtime.json"
```

`build:local` 会继续验证运行时 ID、安装路径、下载归档、归档元数据、文件大小、SHA-256 和内部 manifest。任一项不一致都会停止构建，不能通过删除状态文件或跳过哈希校验绕过。

## 4. 自动化测试

修改本地构建脚本、运行时绑定、部署路径或三文件同步逻辑后，先执行回归测试：

```bash
node --test test/local-development-plugin-build.test.js
```

测试必须覆盖：

1. 从已安装运行时生成本地构建绑定。
2. bundle 不包含 `development-fixture` 或 `example.invalid`。
3. `main.js`、`manifest.json`、`styles.css` 被完整同步。
4. bundle 中的运行时 ID 和 SHA-256 与本机指针一致。

新增测试文件统一放在项目根目录的 `test/` 文件夹中，并使用 UTF-8 编码。

## 5. 执行本地构建

运行：

```bash
npm run build:local
```

成功输出应包含：

```text
[esbuild] deployed local plugin to .../.obsidian/plugins/obsidian-extension
```

如需部署到其他真实目录，目标目录必须已经存在，并且应传入真实目录而不是符号链接本身：

```bash
ANALOGY_LOCAL_PLUGIN_DIR="/absolute/real/plugin/directory" npm run build:local
```

如需使用非默认的 Analogy 数据目录：

```bash
ANALOGY_LOCAL_DATA_ROOT="/absolute/Analogy/data/root" npm run build:local
```

## 6. 构建后验证

检查 bundle 语法：

```bash
node --check /path/to/vault/.obsidian/plugins/analogy/main.js
```

检查三个源产物与 Obsidian 实际加载文件的 SHA-256；同一文件的两行哈希必须一致：

```bash
shasum -a 256 main.js /path/to/vault/.obsidian/plugins/analogy/main.js
shasum -a 256 manifest.json /path/to/vault/.obsidian/plugins/analogy/manifest.json
shasum -a 256 styles.css /path/to/vault/.obsidian/plugins/analogy/styles.css
```

检查真实插件 bundle 不含开发占位资源；命令应无输出：

```bash
rg -n "development-fixture|example\\.invalid" /path/to/vault/.obsidian/plugins/analogy/main.js
```

读取本机运行时 ID 和哈希：

```bash
jq -r '.runtimeId, .assetSha256' "$HOME/Library/Application Support/Analogy/runtime/current/embedding-runtime.json"
```

然后确认这两个值均已嵌入真实插件 bundle：

```bash
rg -n "embedding-runtime-node22-v1-darwin-arm64" /path/to/vault/.obsidian/plugins/analogy/main.js
rg -n "<本机指针中的 SHA-256>" /path/to/vault/.obsidian/plugins/analogy/main.js
```

第二条命令中的 SHA-256 是当前机器的示例值。若本机指针发生可信升级，应使用上一条 `jq` 命令实际输出的值，不能继续硬编码旧值。

## 7. 在 Obsidian 中重新加载

1. 打开 Obsidian 设置。
2. 进入“第三方插件”。
3. 找到 “Analogy - RAG in your vault”。
4. 关闭插件，再重新开启。
5. 如果修复窗口保留了上一次失败状态，点击一次“重试”。
6. 若界面或样式仍未刷新，完全退出 Obsidian 后重新打开。

也可以安装 Hot-Reload 插件辅助日常开发，但交付前仍应手动完成一次关闭/开启验证。

## 8. 真实宿主冒烟测试

每次本地构建至少验证：

- 插件可以启用，不出现初始化失败。
- 设置页可以打开。
- 本次修改涉及的入口、按钮或视图可见且可操作。
- 修改过样式时，确认 Obsidian 使用的是新 `styles.css`。
- 执行一次与改动直接相关的成功路径。
- 执行一次取消、空输入或可恢复错误路径。
- 开发者控制台没有由本次改动新增的异常。

涉及运行时、索引或 Semantic Walk 时，还应按照 [local-runtime.md](./local-runtime.md) 中的真实 Obsidian 检查清单执行对应验证。

## 9. 常见故障

### `DOWNLOAD_NETWORK_ERROR` 且 stage 为 `downloading-embedding-runtime`

先检查实际加载的 `main.js` 是否包含 `example.invalid`。如果包含，说明最后部署的是普通构建或旧 fixture；重新执行 `npm run build:local`，再关闭并开启插件。

### `LOCAL_DEVELOPMENT_RUNTIME_*`

本地运行时指针、归档、元数据、安装目录或内部 manifest 不一致。不要绕过校验。检查 `~/Library/Application Support/Analogy` 中对应文件，必要时通过插件的可信运行时安装/修复流程重新安装。

### JavaScript 已更新但界面样式没有变化

比较源目录和 Vault 插件目录中的 `styles.css` 哈希。如果不同，说明没有执行完整的 `build:local` 部署。

### 构建成功但 Obsidian 仍显示旧行为

确认 Vault 插件目录的符号链接目标和三个文件哈希，然后关闭/开启插件；仍未更新时完全退出并重启 Obsidian。

## 10. 完成标准

只有同时满足以下条件，才可以通知用户加载本地插件：

- 相关自动化测试通过。
- `npm run build:local` 退出码为 0。
- Obsidian 实际加载目录与源码产物的三个文件哈希一致。
- `main.js` 通过语法检查。
- `main.js` 不包含 `development-fixture` 或 `example.invalid`。
- bundle 的运行时 ID、SHA-256 与本机指针一致。
- 已向用户提供关闭/开启插件的加载步骤。
