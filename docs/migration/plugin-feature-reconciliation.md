# 插件功能域对账记录

本记录关闭 Task 7 的 Semantic Walk、Embedding、Runtime、MCP 与 License UI 五个功能域。
对账输入固定为 Task 1 清单中记录的私有目录 SHA-256；2026-08-12 复核时，私有目录对应文件仍与清单完全一致，没有把迁移期间的新工作区状态当作输入。

## 处理原则

- 逐文件比较私有目录与公开仓库，不执行整目录覆盖。
- 公开仓库的许可证、作者、GitHub Actions、Release URL、已发布 Runtime Manifest 与更新的安全修复优先。
- 私有版本没有公开版本之外的独有业务分支时，保留公开版本并记录来源提交，而不是把旧文件复制回来。
- 所有保留测试由 `docs/migration/test-execution-inventory.json`、Runner Manifest 和 CI 执行 Manifest 共同门禁。

## 功能域结论

### Semantic Walk

- `src/semantic-walk/chunk-repository.ts` 在两边的冻结 SHA-256 均为 `66a091eaf56dd502a3876fb6dd50091125824a1989cda1eee9b76576aec8ab8a`，不存在待吸收的私有实现。
- 迁移验收发现大文档集合会触发无界 Chroma 读取，公开仓库在 `a4f7fc4a92b009f631764c8d37e8b5296a8e3d3f` 追加分页修复；该修复由真实 `LocalVectorStore` 聚合测试覆盖。
- 结论：保留公开版本；目标提交 `a4f7fc4a92b009f631764c8d37e8b5296a8e3d3f`。

### Embedding

- Task 1 标记的 6 个差异文件已逐项复核：`embedding-service.ts`、`embedding-worker-client.ts`、`embedding-worker-protocol.ts`、`embedding-worker.ts`、`embedding.ts`、`local-service-bootstrap.ts`。
- 公开版本保留私有版本的初始化、Worker 生命周期与 Bootstrap 行为，并新增每模型 pooling、Granite 模型、Jina 非商业许可说明、严格 Worker 响应判别及集合名解析扩展；回写私有版本会造成能力和安全回退。
- 结论：保留公开版本；主要来源提交 `d6b1c1cea84c4d8eb7969255dfce05b13dc4e664`。

### Runtime

- `embedding-runtime-manager.ts`、`legacy-chroma-runtime-bridge.ts`、`RuntimeControlPanel.tsx` 的公开差异分别是 pooling 参数传递、Node 类型兼容与结构化清理结果插值，均是私有版本之上的修正。
- `generated-embedding-runtime-manifest.ts` 必须保留公开仓库的 `published` 绑定；私有目录版本不能覆盖公开发布元数据。
- 结论：保留公开版本；Runtime 主链来源提交 `d6b1c1cea84c4d8eb7969255dfce05b13dc4e664`，控制面来源提交 `3ef0f79a85533ba42a0a6ca53d5a47ee35f4f344`。

### MCP

- 私有与公开版本仅有 JSON-RPC `id` 判别差异；公开版本只接受字符串或数字，避免把任意对象键转换为待处理请求 ID。
- 结论：保留公开版本；目标提交 `4d8de2192b9db68e14535777b6eee9e41340fdb9`。

### License UI

- `src/license/license-api.ts`、`license-device.ts`、`license-limits.ts`、`license-store.ts`、`license-types.ts` 在两边逐文件相同，没有未发布私有改动。
- 客户端只保留公开 v1 Contract、设备标识、本地状态和限制展示；商业签名、Stripe、Webhook 与 Admin 实现不进入公开仓库。
- 结论：保留公开版本；公开来源提交 `383b7170a536272197bcd509c05694954a478a95`。

## 验证集合

- Semantic Walk：`test/semantic-walk-*.test.js`、`test/semantic-walk-chunk-repository.test.js`。
- Embedding：`test/embedding-*.test.js`、`test/summary-models.test.js`。
- Runtime：`test/chroma-*.test.js`、`test/runtime-*.test.js`、`test/onboarding-*.test.js`。
- MCP：`test/mcp-*.test.js`、`test/node-runtime-resolution.test.js`。
- License：`test/license-api.test.js`、`test/license-limits.test.js`、`test/api-contract.test.js`。
- 全局：`npm run typecheck`、`npm run test:public`、`npm run test:runtime`、`npm run build:ci`。

最终结论：五个功能域均已关闭，没有需要从旧私有目录继续复制的插件实现；公开仓库功能不少于冻结的私有目录，同时保留了公开仓库后续的 Runtime、Embedding、MCP 和发布安全修复。
