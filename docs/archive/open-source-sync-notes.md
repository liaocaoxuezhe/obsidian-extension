# 已停用：旧公开仓库同步流程

> 此流程已经停用，禁止执行。本文仅保留迁移历史说明，不再包含可运行的同步、复制或清理命令。

Analogy Obsidian 插件过去由混合开发目录生成公开镜像，需要人工复制白名单文件并删除商业服务端内容。这一流程容易产生版本漂移、漏测和边界风险，现已由仓库拆分替代。

当前唯一权威源：

- 插件、公开本地 MCP、Runtime、测试与 Release：本公开仓库。
- Stripe、License、Admin、诊断接收、数据库与部署：私有 `obsidian-commercial-service` 仓库。

两个仓库仅通过 `contracts/commercial-api/v1/` 中公开、版本化且向后兼容的 HTTPS API 契约协作，不复制彼此源码，也不使用 Git Submodule。旧混合目录仅作为迁移来源保留，不能用于 build、release 或 deploy。

迁移依据见父项目中的《Obsidian 插件与商业服务端仓库拆分实施计划》以及本仓库的 Git 历史。任何试图恢复白名单复制、目录镜像或双写发布的变更都应被拒绝。
