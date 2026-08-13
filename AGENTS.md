# Analogy Obsidian 公开仓库

本仓库是 Obsidian 插件、公开本地 MCP、Runtime、测试与发布的唯一权威源。旧目录 `/Users/zhangyu/PycharmProjects/Analogy/analogy/obsidian-extension` 已彻底退役、仅供历史查询；禁止从该目录覆盖或同步源码，禁止加入商业服务端实现与 Secret。

- 真实 Obsidian 本地测试：只使用 `npm run build:local`，并核对实际加载目录中的 `main.js`、`manifest.json`、`styles.css`；这是唯一允许部署到 Vault 的根目录构建命令。
- 普通 CI：只使用 `npm run build:ci`，不部署到 Vault，也不创建或上传 Release。
- 发布候选准备：使用 `npm run release:prepare`；`npm run build:release` 仅是其内部步骤，二者都不构成发布授权。
- 正式发布是单独的外部变更。只有用户完成验收并针对本次发布再次明确授权后，才允许创建/推送版本 Tag、运行带 `publish=true` 的 Runtime Workflow、创建或更新 GitHub Release、提交 Obsidian 社区发布。禁止灰度发布。
- 如果运行过 `build:ci`、`build:release` 或 `release:prepare`，在让用户刷新真实 Obsidian 前必须再次执行 `npm run build:local` 并复核三件套。
- 当前托管 Runtime 发布范围仅为 `darwin-arm64` 与 `win32-x64`；`darwin-x64` 已获用户批准延期，禁止把未验证 Intel 产物加入 Manifest 或 Release。
- 新测试统一放在 `test/`，中文文件使用 UTF-8。
