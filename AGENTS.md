# Analogy Obsidian 公开仓库

本仓库是 Obsidian 插件、公开本地 MCP、Runtime、测试与发布的唯一权威源。禁止从旧目录 `/Users/zhangyu/PycharmProjects/Analogy/analogy/obsidian-extension` 覆盖或同步源码，禁止加入商业服务端实现与 Secret。

- 真实 Obsidian 本地测试：`npm run build:local`，并核对实际加载目录中的 `main.js`、`manifest.json`、`styles.css`。
- 普通 CI：使用 CI 指定的显式构建命令，不部署到 Vault。
- 正式发布：只使用 `npm run release:prepare` 或 GitHub Tag Release 工作流。
- 新测试统一放在 `test/`，中文文件使用 UTF-8。
