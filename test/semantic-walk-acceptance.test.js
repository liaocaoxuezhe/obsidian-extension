const assert = require("assert");
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");
const { createSemanticWalkVault } = require("./helpers/create-semantic-walk-vault");

const extensionRoot = path.join(__dirname, "..");
const vaultRoot = createSemanticWalkVault();

async function loadAcceptanceBoundary() {
  const result = await esbuild.build({
    stdin: {
      contents: [
        'export { SemanticWalkController } from "./src/semantic-walk/walk-controller";',
        'export { ChunkRelationService, SemanticWalkRelationError } from "./src/semantic-walk/relation-service";',
        'export { loadChunksForPath, loadPickerIndex, pickRandomChunk } from "./src/semantic-walk/components/ChunkPicker";',
        'export { clampCanvasZoom } from "./src/semantic-walk/components/SemanticWalkCanvas";',
      ].join("\n"),
      resolveDir: extensionRoot,
      sourcefile: "semantic-walk-acceptance-boundary.ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    external: ["react", "obsidian", "lucide-react"],
    logLevel: "silent",
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, (id) => {
    if (id === "obsidian") return {};
    return require(id);
  });
  return module.exports;
}

function parseFixtureVault() {
  const files = fs.readdirSync(vaultRoot).filter((name) => name.endsWith(".md")).sort();
  assert.ok(files.length >= 101, `验收 vault 必须至少有 101 篇 Markdown，实际 ${files.length}`);
  const documents = [];
  const chunks = [];
  for (const [documentIndex, fileName] of files.entries()) {
    const content = fs.readFileSync(path.join(vaultRoot, fileName), "utf8");
    assert.ok(!content.includes("\ufffd"), `${fileName} 必须能以 UTF-8 无损读取`);
    const sections = content
      .split(/(?=^#{1,3}\s+)/m)
      .map((section) => section.trim())
      .filter(Boolean);
    const docId = `fixture-doc-${String(documentIndex + 1).padStart(3, "0")}`;
    const documentChunks = sections.map((section, chunkIndex) => {
      const heading = section.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim() || fileName.replace(/\.md$/, "");
      return {
        chunkId: `${docId}::chunk-${chunkIndex}`,
        docId,
        path: fileName,
        title: fileName.replace(/\.md$/, ""),
        content: section,
        chunkIndex,
        chunkCount: sections.length,
        sectionLabel: heading,
        mtime: documentIndex + 1,
      };
    });
    documents.push({ docId, path: fileName, mtime: documentIndex + 1, chunkCount: documentChunks.length });
    chunks.push(...documentChunks);
  }
  return { files, documents, chunks };
}

function searchResult(chunk, distance = 0.2) {
  return {
    chunkId: chunk.chunkId,
    docId: chunk.docId,
    path: chunk.path,
    title: chunk.title,
    content: chunk.content,
    chunkIndex: chunk.chunkIndex,
    chunkCount: chunk.chunkCount,
    sectionLabel: chunk.sectionLabel,
    distance,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

(async () => {
  const {
    ChunkRelationService,
    SemanticWalkRelationError,
    SemanticWalkController,
    clampCanvasZoom,
    loadChunksForPath,
    loadPickerIndex,
    pickRandomChunk,
  } = await loadAcceptanceBoundary();
  const fixture = parseFixtureVault();
  const specialDocument = fixture.documents.find((entry) => entry.path.includes("note_101_semantic_walk"));
  assert.ok(specialDocument, "必须包含专用中文多级主题 fixture");
  const specialText = fs.readFileSync(path.join(vaultRoot, specialDocument.path), "utf8");
  assert.match(specialText, /^#\s+/m);
  assert.match(specialText, /^##\s+/m);
  assert.match(specialText, /^###\s+/m);
  assert.match(specialText, /语义探索[\s\S]*关联漫游/, "fixture 必须包含两个相近主题段落");

  const chunkMap = new Map(fixture.chunks.map((chunk) => [chunk.chunkId, chunk]));
  const chunksByDocument = new Map();
  for (const chunk of fixture.chunks) {
    const current = chunksByDocument.get(chunk.docId) || [];
    current.push(chunk);
    chunksByDocument.set(chunk.docId, current);
  }
  let randomCursor = 0;
  const repository = {
    async getChunk(chunkId, includeEmbedding = false) {
      const chunk = chunkMap.get(chunkId);
      return chunk ? { ...chunk, ...(includeEmbedding ? { embedding: [0.25, 0.5, 0.75] } : {}) } : null;
    },
    async listChunksByDocument(docId) { return [...(chunksByDocument.get(docId) || [])]; },
    async listIndexedDocuments() { return [...fixture.documents]; },
    async getRandomChunk() {
      const chunk = fixture.chunks[randomCursor % fixture.chunks.length] || null;
      randomCursor += 1;
      return chunk;
    },
  };

  const diagnosticEvents = [];
  const diagnosticRecorder = {
    recordSemanticWalkExpand(event) { diagnosticEvents.push(event); },
  };
  const specialChunks = chunksByDocument.get(specialDocument.docId);
  assert.ok(specialChunks.length >= 8, "多 H1/H2/H3 fixture 应生成至少 8 个稳定 chunk");
  const pathChunks = fixture.chunks.filter((chunk) => chunk.docId !== specialDocument.docId).slice(0, 12);
  const branchChunk = specialChunks[1];
  const relationService = {
    async findRelatedChunks(source, options) {
      let candidates;
      if (source.chunkId === specialChunks[0].chunkId) {
        candidates = [branchChunk, pathChunks[0]];
      } else {
        const index = pathChunks.findIndex((chunk) => chunk.chunkId === source.chunkId);
        candidates = index >= 0 && pathChunks[index + 1]
          ? [pathChunks[index + 1], ...(index === 0 ? [specialChunks[0]] : [])]
          : source.chunkId === branchChunk.chunkId
            ? [specialChunks[2]]
            : [];
      }
      return candidates.slice(0, options.limit).map((chunk, index) => searchResult(chunk, 0.08 + index * 0.17));
    },
  };

  const pickerIndex = await loadPickerIndex(repository);
  assert.strictEqual(pickerIndex.status, "ready");
  assert.ok(pickerIndex.documents.length >= 101, "fake repository 应真实承载 101+ vault 文档");
  const currentDocument = await loadChunksForPath(repository, specialDocument.path);
  assert.strictEqual(currentDocument.status, "ready", "当前文档入口应按 path 找到真实索引 chunks");
  assert.strictEqual(currentDocument.chunks.length, specialChunks.length);

  const entryController = new SemanticWalkController({ repository, relationService, diagnosticRecorder, model: "fixture-model" });
  await entryController.setStart(currentDocument.chunks[3].chunkId);
  assert.strictEqual(entryController.getState().rootNodeId, currentDocument.chunks[3].chunkId, "当前文档入口应能选择任意中间 chunk");
  entryController.reset();
  const queryResult = searchResult(pathChunks[2], 0.11);
  await entryController.setStart(queryResult.chunkId);
  assert.strictEqual(entryController.getState().rootNodeId, queryResult.chunkId, "搜索入口应以结果 chunkId 启动画布");
  entryController.reset();
  await entryController.setStart(pathChunks[3].chunkId);
  assert.strictEqual(entryController.getState().rootNodeId, pathChunks[3].chunkId, "侧栏入口应精确传递结果 chunkId");
  entryController.reset();
  const randomEntry = await pickRandomChunk(repository);
  assert.strictEqual(randomEntry.status, "ready");
  await entryController.setStart(randomEntry.chunk.chunkId);
  assert.strictEqual(entryController.getState().rootNodeId, randomEntry.chunk.chunkId, "随机入口应从本地索引选择根 chunk");

  const controller = new SemanticWalkController({
    repository,
    relationService,
    diagnosticRecorder,
    model: "fixture-model",
    candidateLimit: 8,
  });
  await controller.setStart(specialChunks[0].chunkId);
  await controller.addChunk(specialChunks[1].chunkId);
  assert.strictEqual(
    Object.values(controller.getState().nodes).filter((node) => node.chunk.docId === specialDocument.docId).length,
    2,
    "同一文档不同 chunk 必须同时存在",
  );
  controller.reset();
  await controller.setStart(specialChunks[0].chunkId);
  await controller.expand(specialChunks[0].chunkId);
  assert.ok(controller.getState().edges[`${specialChunks[0].chunkId}->${branchChunk.chunkId}`], "根节点分支应建立");
  controller.focus(pathChunks[0].chunkId);
  for (let index = 0; index < 10; index += 1) {
    const current = pathChunks[index];
    const expanded = await controller.expand(current.chunkId);
    assert.strictEqual(expanded.status, "success", `第 ${index + 1} 跳应成功`);
    controller.focus(pathChunks[index + 1].chunkId);
  }
  const afterTenJumps = controller.getState();
  assert.ok(afterTenJumps.nodes[specialChunks[0].chunkId], "10 跳后根节点必须保留");
  assert.ok(afterTenJumps.nodes[branchChunk.chunkId], "10 跳后旧分支候选必须保留");
  assert.ok(afterTenJumps.visitedOrder.length >= 11, "至少 10 次跳转必须保留完整访问顺序");
  const nodeCountBeforeDuplicate = Object.keys(afterTenJumps.nodes).length;
  assert.ok(afterTenJumps.edges[`${pathChunks[0].chunkId}->${specialChunks[0].chunkId}`], "重复命中已有节点时应补充缺失边");
  assert.strictEqual(Object.keys(afterTenJumps.nodes).length, nodeCountBeforeDuplicate, "重复命中不得复制节点");
  await controller.expand(branchChunk.chunkId);
  assert.ok(controller.getState().nodes[specialChunks[2].chunkId], "回到早期节点后应能展开另一分支");

  const oldRoot = controller.getState().rootNodeId;
  controller.reset();
  const nextBatch = await pickRandomChunk(repository);
  await controller.setStart(nextBatch.chunk.chunkId);
  assert.notStrictEqual(controller.getState().rootNodeId, oldRoot, "换一批应生成新的随机根 chunk");
  assert.strictEqual(Object.keys(controller.getState().nodes).length, 1, "换一批必须清空旧路径");

  assert.strictEqual(clampCanvasZoom(0.01), 0.4, "画布最小缩放必须是 40%");
  assert.strictEqual(clampCanvasZoom(9), 1.8, "画布最大缩放必须是 180%");
  const semanticCss = fs.readFileSync(path.join(extensionRoot, "tailwind.css"), "utf8");
  const semanticCssStart = semanticCss.indexOf("\n\t.semantic-walk-canvas {");
  const semanticCssEnd = semanticCss.indexOf("\n@layer components {\n\t.scroll-reveal", semanticCssStart);
  const semanticThemeCss = semanticCss.slice(semanticCssStart, semanticCssEnd);
  assert.ok(semanticCssStart >= 0 && semanticCssEnd > semanticCssStart, "应存在独立语义画布样式段");
  assert.match(semanticThemeCss, /\.semantic-walk-free-text-dialog\s*\{/, "应存在自由文本弹窗遮罩样式");
  assert.match(
    semanticThemeCss,
    /\.semantic-walk-free-text-dialog textarea\s*\{[^}]*overflow-y:\s*auto/s,
    "自由文本超长时必须只在 6 行文本框内纵向滚动",
  );
  assert.match(
    semanticThemeCss,
    /\.semantic-walk-free-text-dialog button\[type="submit"\]\s*\{[^}]*width:\s*100%/s,
    "开始漫游必须是通栏按钮",
  );
  assert.match(semanticThemeCss, /var\(--(?:background|text|interactive|divider|color)-/, "画布颜色必须继承 Obsidian 浅色/深色主题变量");
  assert.doesNotMatch(semanticThemeCss, /#[0-9a-f]{3,8}|rgba?\(|hsla?\(/i, "画布不得以硬编码颜色破坏浅色/深色主题");
  const semanticWalkViewSource = fs.readFileSync(
    path.join(extensionRoot, "src/semantic-walk/SemanticWalkView.tsx"),
    "utf8",
  );
  assert.doesNotMatch(
    semanticWalkViewSource,
    /className=\{viewClassName\}\s+aria-label=\{t\("semanticWalk\.viewName"\)\}/,
    "覆盖整个页面的语义漫游容器不得设置会触发 Obsidian tooltip 的 aria-label",
  );

  assert.deepStrictEqual(await loadPickerIndex({ listIndexedDocuments: async () => [] }), { status: "empty", documents: [] }, "空索引应有明确状态");
  assert.deepStrictEqual(await pickRandomChunk({ getRandomChunk: async () => null }), { status: "empty" }, "空索引随机入口应可恢复");
  const deletedController = new SemanticWalkController({
    repository: { getChunk: async () => null },
    relationService,
    diagnosticRecorder,
    model: "fixture-model",
  });
  assert.strictEqual((await deletedController.setStart("deleted::chunk-0")).status, "missing", "文档删除后不得替换成其他 chunk");
  const unavailableController = new SemanticWalkController({
    repository,
    relationService: { async findRelatedChunks() { throw new Error("本地语义服务尚未启动"); } },
    diagnosticRecorder,
    model: "fixture-model",
  });
  await unavailableController.setStart(pathChunks[0].chunkId);
  assert.strictEqual((await unavailableController.expand(pathChunks[0].chunkId)).status, "expand-error", "服务未启动应返回可重试错误");

  assert.strictEqual(typeof SemanticWalkRelationError, "function", "relation service 必须导出带 category 的错误类型");
  const categorizedCases = [
    {
      category: "service-unavailable",
      service: new ChunkRelationService({ search: null, embedding: null }),
      source: { ...pathChunks[0], embedding: [0.1] },
    },
    {
      category: "embedding",
      service: new ChunkRelationService({
        search: { async searchByEmbedding() { return []; } },
        embedding: { async embedDocument() { throw new Error("embedding sentinel"); } },
      }),
      source: { ...pathChunks[0], embedding: undefined },
    },
    {
      category: "query",
      service: new ChunkRelationService({
        search: { async searchByEmbedding() { throw new Error("query sentinel"); } },
        embedding: null,
      }),
      source: { ...pathChunks[0], embedding: [0.1] },
    },
  ];
  for (const scenario of categorizedCases) {
    await assert.rejects(
      () => scenario.service.findRelatedChunks(scenario.source, {
        limit: 2,
        mode: "pure",
        excludeChunkIds: [],
      }),
      (error) => error instanceof SemanticWalkRelationError && error.category === scenario.category,
      `relation service 必须直接抛出 ${scenario.category} typed error`,
    );
    const categorizedEvents = [];
    const categorizedController = new SemanticWalkController({
      repository: {
        getChunk: async (_chunkId, includeEmbedding) => includeEmbedding
          ? scenario.source
          : pathChunks[0],
      },
      relationService: scenario.service,
      diagnosticRecorder: { recordSemanticWalkExpand(event) { categorizedEvents.push(event); } },
      model: "fixture-model",
    });
    await categorizedController.setStart(pathChunks[0].chunkId);
    assert.strictEqual((await categorizedController.expand(pathChunks[0].chunkId)).status, "expand-error");
    assert.strictEqual(
      categorizedEvents.findLast((event) => event.stage === "error")?.errorCategory,
      scenario.category,
      `${scenario.category} 必须精确进入 controller diagnostics context`,
    );
  }

  let queryAttempts = 0;
  const retryController = new SemanticWalkController({
    repository,
    relationService: {
      async findRelatedChunks() {
        queryAttempts += 1;
        if (queryAttempts === 1) throw new Error("暂时查询失败");
        return [searchResult(pathChunks[1], 0.31)];
      },
    },
    diagnosticRecorder,
    model: "fixture-model",
  });
  await retryController.setStart(pathChunks[0].chunkId);
  assert.strictEqual((await retryController.expand(pathChunks[0].chunkId)).status, "expand-error", "首次查询失败应保持错误状态");
  assert.strictEqual((await retryController.refreshExpansion(pathChunks[0].chunkId)).status, "success", "重试后应恢复并保留根节点");
  assert.ok(retryController.getState().nodes[pathChunks[1].chunkId]);

  const pending = deferred();
  const cleanupController = new SemanticWalkController({
    repository,
    relationService: { findRelatedChunks: () => pending.promise },
    diagnosticRecorder,
    model: "fixture-model",
  });
  await cleanupController.setStart(pathChunks[0].chunkId);
  const unsubscribe = cleanupController.subscribe(() => {});
  const inFlight = cleanupController.expand(pathChunks[0].chunkId);
  await Promise.resolve();
  unsubscribe();
  pending.resolve([searchResult(pathChunks[1], 0.2)]);
  assert.strictEqual((await inFlight).status, "cancelled", "最后一个 view 订阅卸载后必须取消迟到响应");
  assert.ok(!cleanupController.getState().nodes[pathChunks[1].chunkId], "卸载后不得写入迟到候选");
  cleanupController.dispose();

  const fallbackDiagnosticEvents = [];
  const fallbackService = new ChunkRelationService({
    search: { async searchByEmbedding() { return []; } },
    embedding: { async embedDocument() { return [0.4, 0.6]; } },
    diagnosticRecorder: { recordSemanticWalkExpand(event) { fallbackDiagnosticEvents.push(event); } },
    model: "fixture-model",
  });
  await fallbackService.findRelatedChunks({ ...pathChunks[0], embedding: undefined }, {
    limit: 2,
    mode: "pure",
    excludeChunkIds: [],
  });
  assert.deepStrictEqual(
    fallbackDiagnosticEvents.map((event) => ({
      stage: event.stage,
      usedEmbeddingFallback: event.usedEmbeddingFallback,
      candidateCount: event.candidateCount,
    })),
    [{ stage: "fallback", usedEmbeddingFallback: true, candidateCount: 0 }],
    "relation 链路只在缺少存量 embedding 时记录 allowlisted fallback 事件",
  );

  assert.ok(
    diagnosticEvents.some((event) => event.stage === "start")
      && diagnosticEvents.some((event) => event.stage === "success")
      && diagnosticEvents.some((event) => event.stage === "error"),
    "controller/relation 验收链路必须记录 start/success/error 诊断阶段",
  );
  assert.ok(diagnosticEvents.every((event) => event.model === "fixture-model"), "诊断模型字段必须由 ItemView/controller 链路注入");
  const allowedDiagnosticKeys = [
    "candidateCount",
    "chunkId",
    "distanceRange",
    "durationMs",
    "errorCategory",
    "model",
    "stage",
    "usedEmbeddingFallback",
  ];
  assert.ok(
    diagnosticEvents.every((event) => JSON.stringify(Object.keys(event).sort()) === JSON.stringify(allowedDiagnosticKeys)),
    "controller 发送给 recorder 的事件也必须只含白名单字段",
  );

  const nonBlockingController = new SemanticWalkController({
    repository,
    relationService: { async findRelatedChunks() { return [searchResult(pathChunks[1], 0.2)]; } },
    diagnosticRecorder: { recordSemanticWalkExpand() { throw new Error("诊断存储不可用"); } },
    model: "fixture-model",
  });
  await nonBlockingController.setStart(pathChunks[0].chunkId);
  assert.strictEqual(
    (await nonBlockingController.expand(pathChunks[0].chunkId)).status,
    "success",
    "诊断 recorder 抛错不得阻塞 controller 展开",
  );

  const nonBlockingFallback = new ChunkRelationService({
    search: { async searchByEmbedding() { return []; } },
    embedding: { async embedDocument() { return [0.7]; } },
    diagnosticRecorder: { recordSemanticWalkExpand() { throw new Error("诊断存储不可用"); } },
    model: "fixture-model",
  });
  await nonBlockingFallback.findRelatedChunks({ ...pathChunks[0], embedding: undefined }, {
    limit: 1,
    mode: "pure",
    excludeChunkIds: [],
    onEmbeddingFallback() { throw new Error("诊断回调不可用"); },
  });

  console.log(`Semantic walk acceptance passed: ${fixture.files.length} UTF-8 notes, four entries, 10 jumps, reset/retry/cleanup`);
})().catch((error) => {
  console.error("Semantic walk acceptance FAILED:", error);
  process.exit(1);
}).finally(() => {
  fs.rmSync(vaultRoot, { recursive: true, force: true });
});
