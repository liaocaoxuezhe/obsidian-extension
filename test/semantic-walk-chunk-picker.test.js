const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

async function loadModule(relativeSource) {
  const result = await esbuild.build({
    stdin: {
      contents: `export * from ${JSON.stringify(`./src/semantic-walk/${relativeSource}`)}; export { setLocale } from "./src/util/i18n";`,
      resolveDir: path.join(__dirname, ".."),
      sourcefile: "semantic-walk-chunk-picker-boundary.ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["react", "react-dom", "obsidian"],
    write: false,
    logLevel: "silent",
  });
  const module = { exports: {} };
  const requireForTest = (id) => id === "obsidian" ? {} : require(id);
  new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, requireForTest);
  return module.exports;
}

function indexedChunk(chunkId, docId, chunkIndex, overrides = {}) {
  return {
    chunkId,
    docId,
    path: `${docId}.md`,
    title: docId,
    content: `${chunkId} 的正文`,
    chunkIndex,
    chunkCount: 3,
    sectionLabel: "主题",
    mtime: 100,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

(async () => {
  const regressionFailures = [];
  const check = (condition, message) => {
    if (!condition) regressionFailures.push(message);
  };
  const {
    loadChunksForPath,
    loadPickerIndex,
    pickDifferentRandomChunk,
    pickRandomChunk,
    sortChunksByIndex,
  } = await loadModule("components/ChunkPicker.tsx");
  const { WalkEmptyState, setLocale } = await loadModule("components/WalkEmptyState.tsx");
  setLocale("zh");
  const { setLocale: setI18nLocale, t } = await loadModule("../util/i18n.ts");
  setI18nLocale("zh");
  assert.strictEqual(t("semanticWalk.localMapName"), "Analogy笔记漫游");
  const { SemanticWalkController } = await loadModule("walk-controller.ts");

  const unsortedChunks = [
    indexedChunk("Guide::2", "Guide", 2),
    indexedChunk("Guide::0", "Guide", 0),
    indexedChunk("Guide::1", "Guide", 1),
  ];
  assert.deepStrictEqual(
    sortChunksByIndex(unsortedChunks).map((chunk) => chunk.chunkId),
    ["Guide::0", "Guide::1", "Guide::2"],
    "chunk 抽屉必须按 chunkIndex 排序",
  );

  const requestedDocumentIds = [];
  const repository = {
    listIndexedDocuments: async () => [
      { docId: "Other", path: "Other.md", mtime: 90, chunkCount: 1 },
      { docId: "Guide", path: "Guide.md", mtime: 100, chunkCount: 3 },
    ],
    listChunksByDocument: async (docId) => {
      requestedDocumentIds.push(docId);
      return unsortedChunks;
    },
    getRandomChunk: async () => null,
  };
  const currentDocument = await loadChunksForPath(repository, "Guide.md");
  assert.strictEqual(currentDocument.status, "ready");
  assert.strictEqual(currentDocument.document.docId, "Guide");
  assert.deepStrictEqual(requestedDocumentIds, ["Guide"], "按 path 定位后必须用 docId 请求 chunks");
  assert.deepStrictEqual(currentDocument.chunks.map((chunk) => chunk.chunkIndex), [0, 1, 2]);

  const unindexed = await loadChunksForPath(repository, "Missing.md");
  assert.deepStrictEqual(unindexed, { status: "unindexed", path: "Missing.md" });
  assert.deepStrictEqual(requestedDocumentIds, ["Guide"], "未索引文档不得静默读取或重建");

  const emptyIndex = await loadPickerIndex({ listIndexedDocuments: async () => [] });
  assert.deepStrictEqual(emptyIndex, { status: "empty", documents: [] });
  const emptyRandom = await pickRandomChunk(repository);
  assert.deepStrictEqual(emptyRandom, { status: "empty" }, "随机入口在空索引上必须返回可展示反馈");

  let boundedRandomCalls = 0;
  const unchangedRandom = await pickDifferentRandomChunk({
    listIndexedDocuments: async () => [
      { docId: "Root", path: "Root.md", mtime: 100, chunkCount: 1 },
      { docId: "Other", path: "Other.md", mtime: 100, chunkCount: 1 },
    ],
    getRandomChunk: async () => {
      boundedRandomCalls++;
      return indexedChunk("Root::0", "Root", 0, { chunkCount: 1 });
    },
  }, "Root::0");
  assert.deepStrictEqual(unchangedRandom, { status: "unchanged" });
  assert.strictEqual(boundedRandomCalls, 8, "换一批排除旧根节点时必须使用有上限的重抽策略");

  let differentRandomCalls = 0;
  const differentSequence = ["Root::0", "Root::0", "Other::0"];
  const differentRandom = await pickDifferentRandomChunk({
    listIndexedDocuments: async () => [
      { docId: "Root", path: "Root.md", mtime: 100, chunkCount: 1 },
      { docId: "Other", path: "Other.md", mtime: 100, chunkCount: 1 },
    ],
    getRandomChunk: async () => {
      const chunkId = differentSequence[differentRandomCalls++];
      return indexedChunk(chunkId, chunkId.split("::")[0], 0, { chunkCount: 1 });
    },
  }, "Root::0");
  assert.strictEqual(differentRandom.status, "ready");
  assert.strictEqual(differentRandom.chunk.chunkId, "Other::0");
  assert.strictEqual(differentRandomCalls, 3, "换一批应跳过旧根节点并接受首个不同随机 chunk");

  let singleRandomCalls = 0;
  const singleRandom = await pickDifferentRandomChunk({
    listIndexedDocuments: async () => [
      { docId: "Root", path: "Root.md", mtime: 100, chunkCount: 1 },
    ],
    getRandomChunk: async () => {
      singleRandomCalls++;
      return indexedChunk("Root::0", "Root", 0, { chunkCount: 1 });
    },
  }, "Root::0");
  assert.strictEqual(singleRandom.status, "ready", "只有一个 chunk 时应允许继续使用同一根节点");
  assert.strictEqual(singleRandom.chunk.chunkId, "Root::0");
  assert.strictEqual(singleRandomCalls, 1);

  const emptyMarkup = renderToStaticMarkup(React.createElement(WalkEmptyState, {
    onChooseNote: () => {},
    onOpenFreeText: () => {},
    onPickRandom: () => {},
  }));
  assert.match(emptyMarkup, /选择笔记/);
  assert.match(emptyMarkup, /从已索引的笔记中选择/);
  assert.match(emptyMarkup, /自由探索/);
  assert.match(emptyMarkup, /输入文本，开始漫游/);
  assert.match(emptyMarkup, /随机漫游/);

  const disabledMarkup = renderToStaticMarkup(React.createElement(WalkEmptyState, {
    onChooseNote: () => {},
    onOpenFreeText: () => {},
    onPickRandom: () => {},
    disabledReason: "本地服务不可用",
  }));
  assert.strictEqual((disabledMarkup.match(/disabled=""/g) || []).length, 3, "服务不可用时三个入口应全部禁用");

  const chunks = new Map([
    ["Root::0", indexedChunk("Root::0", "Root", 0)],
    ["Added::0", indexedChunk("Added::0", "Added", 0)],
    ["Expand::0", indexedChunk("Expand::0", "Expand", 0)],
  ]);
  const getChunkCalls = [];
  const relatedCalls = [];
  const controllerRepository = {
    getChunk: async (chunkId, includeEmbedding = false) => {
      getChunkCalls.push({ chunkId, includeEmbedding });
      const chunk = chunks.get(chunkId);
      return chunk ? { ...chunk, ...(includeEmbedding ? { embedding: [0.2, 0.8] } : {}) } : null;
    },
  };
  const relationService = {
    findRelatedChunks: async (source) => {
      relatedCalls.push(source);
      return [{
        chunkId: `${source.chunkId}:related`,
        docId: "Related",
        path: "Related.md",
        title: "Related",
        content: "关联内容",
        chunkIndex: 0,
        chunkCount: 1,
        sectionLabel: "",
        distance: 0.12,
      }];
    },
  };
  const controller = new SemanticWalkController({ repository: controllerRepository, relationService });

  await controller.setStart("Root::0");
  assert.strictEqual(controller.getState().rootNodeId, "Root::0");
  assert.strictEqual(relatedCalls.length, 0, "设为起点不得查询关系");
  assert.strictEqual("embedding" in controller.getState().nodes["Root::0"].chunk, false, "embedding 不得进入图状态");

  await controller.addChunk("Added::0");
  assert.ok(controller.getState().nodes["Added::0"]);
  assert.strictEqual(relatedCalls.length, 0, "加入当前画布不得查询关系");

  await controller.addAndExpand("Expand::0");
  assert.strictEqual(relatedCalls.length, 1, "只有加入并展开才查询关系");
  assert.deepStrictEqual(relatedCalls[0].embedding, [0.2, 0.8], "展开应复用 source embedding");
  assert.ok(controller.getState().nodes["Expand::0:related"]);
  assert.strictEqual("embedding" in controller.getState().nodes["Expand::0"].chunk, false);
  assert.deepStrictEqual(controller.getCachedCandidates("Expand::0"), [
    { chunkId: "Expand::0:related", distance: 0.12 },
  ], "缓存只能保存候选身份和距离");

  chunks.set("Expand::0:related", indexedChunk("Expand::0:related", "Related", 0, { chunkCount: 1 }));
  const cachedExpansion = await controller.expand("Expand::0");
  check(cachedExpansion?.status === "success", "缓存展开应返回 success 结果");
  check(relatedCalls.length === 1, "重复展开必须读取候选缓存，不能再次查询关系服务");

  const bandChunks = new Map([
    ["BandRoot::0", indexedChunk("BandRoot::0", "BandRoot", 0)],
    ["Band2::0", indexedChunk("Band2::0", "Band2", 0, { chunkCount: 1 })],
    ["Band3::0", indexedChunk("Band3::0", "Band3", 0, { chunkCount: 1 })],
  ]);
  let bandRelationCalls = 0;
  const bandController = new SemanticWalkController({
    repository: {
      getChunk: async (chunkId, includeEmbedding = false) => {
        const value = bandChunks.get(chunkId);
        return value ? { ...value, ...(includeEmbedding ? { embedding: [0.3] } : {}) } : null;
      },
    },
    relationService: {
      findRelatedChunks: async () => {
        bandRelationCalls++;
        return [
          { ...indexedChunk("Band1::0", "Band1", 0, { chunkCount: 1 }), distance: 0.1 },
          { ...indexedChunk("Band2::0", "Band2", 0, { chunkCount: 1 }), distance: 0.2 },
          { ...indexedChunk("Band3::0", "Band3", 0, { chunkCount: 1 }), distance: 0.3 },
          { ...indexedChunk("Band4::0", "Band4", 0, { chunkCount: 1 }), distance: 0.4 },
        ];
      },
    },
  });
  await bandController.setStart("BandRoot::0");
  await bandController.expand("BandRoot::0");
  await bandController.expand("BandRoot::0");
  check(bandRelationCalls === 1, "缓存缺失候选过滤时也不得回查 relation service");
  check(JSON.stringify(bandController.getCachedCandidates("BandRoot::0")) === JSON.stringify([
    { chunkId: "Band2::0", distance: 0.2 },
    { chunkId: "Band3::0", distance: 0.3 },
  ]), "缓存命中时必须过滤 repository 中已失效的候选");
  check(bandController.getState().edges["BandRoot::0->Band2::0"]?.relationBand === "strong", "过滤失效缓存后首个剩余候选必须重算为 strong");
  check(bandController.getState().edges["BandRoot::0->Band3::0"]?.relationBand === "exploratory", "过滤失效缓存后末个剩余候选必须重算为 exploratory");

  const preservedRelation = deferred();
  const preservedController = new SemanticWalkController({
    repository: {
      getChunk: async (chunkId, includeEmbedding = false) => {
        if (chunkId === "Missing::0") return null;
        if (chunkId === "Throw::0") throw new Error("索引读取失败");
        const chunk = chunks.get(chunkId);
        return chunk ? { ...chunk, ...(includeEmbedding ? { embedding: [0.5] } : {}) } : null;
      },
    },
    relationService: { findRelatedChunks: () => preservedRelation.promise },
  });
  await preservedController.setStart("Root::0");
  const preservedExpansion = preservedController.expand("Root::0");
  await Promise.resolve();
  await Promise.resolve();
  const missingStart = await preservedController.setStart("Missing::0", async () => true);
  check(missingStart?.status === "missing", "missing start 应返回可区分的 missing 结果");
  preservedRelation.resolve([{
    chunkId: "Preserved::0",
    docId: "Preserved",
    path: "Preserved.md",
    title: "Preserved",
    content: "原会话仍应接收的结果",
    chunkIndex: 0,
    chunkCount: 1,
    sectionLabel: "",
    distance: 0.2,
  }]);
  await preservedExpansion;
  check(Boolean(preservedController.getState().nodes["Preserved::0"]), "missing start 不得取消旧会话正在进行的展开");

  const throwingRelation = deferred();
  const throwingController = new SemanticWalkController({
    repository: {
      getChunk: async (chunkId, includeEmbedding = false) => {
        if (chunkId === "Throw::0") throw new Error("索引读取失败");
        const chunk = chunks.get(chunkId);
        return chunk ? { ...chunk, ...(includeEmbedding ? { embedding: [0.6] } : {}) } : null;
      },
    },
    relationService: { findRelatedChunks: () => throwingRelation.promise },
  });
  await throwingController.setStart("Root::0");
  const throwingExpansion = throwingController.expand("Root::0");
  await Promise.resolve();
  await Promise.resolve();
  await assert.rejects(() => throwingController.setStart("Throw::0", async () => true), /索引读取失败/);
  throwingRelation.resolve([{
    chunkId: "AfterThrow::0",
    docId: "AfterThrow",
    path: "AfterThrow.md",
    title: "AfterThrow",
    content: "异常后旧会话仍完整",
    chunkIndex: 0,
    chunkCount: 1,
    sectionLabel: "",
    distance: 0.25,
  }]);
  await throwingExpansion;
  check(Boolean(throwingController.getState().nodes["AfterThrow::0"]), "start 抛错不得取消旧会话正在进行的展开");

  const firstAdd = deferred();
  const secondAdd = deferred();
  let concurrentAddCalls = 0;
  const concurrentController = new SemanticWalkController({
    repository: {
      getChunk: async (chunkId) => {
        if (chunkId === "Root::0" || chunkId === "Added::0") return chunks.get(chunkId);
        concurrentAddCalls++;
        return concurrentAddCalls === 1 ? firstAdd.promise : secondAdd.promise;
      },
    },
    relationService,
  });
  await concurrentController.setStart("Root::0");
  const firstConcurrentAdd = concurrentController.addChunk("Concurrent::0");
  const secondConcurrentAdd = concurrentController.addChunk("Concurrent::0");
  firstAdd.resolve(indexedChunk("Concurrent::0", "Concurrent", 0));
  await firstConcurrentAdd;
  check(concurrentController.getState().focusNodeId === "Concurrent::0", "新加入的节点必须成为当前焦点");
  concurrentController.move("Concurrent::0", 777, 333);
  concurrentController.focus("Root::0");
  secondAdd.resolve(indexedChunk("Concurrent::0", "Concurrent", 0, { content: "过期并发副本" }));
  await secondConcurrentAdd;
  check(concurrentController.getState().nodes["Concurrent::0"].x === 777, "并发 add 完成后必须复查 existing，不能覆盖手动节点");
  check(concurrentController.getState().nodes["Concurrent::0"].positionMode === "manual", "并发 add 不得把 manual 节点重建为 auto");
  check(concurrentController.getState().focusNodeId === "Root::0", "迟到 add 发现节点已存在时不得抢回用户后续选择的焦点");

  const originalRoot = concurrentController.getState().rootNodeId;
  const restartWithoutConfirmation = await concurrentController.setStart("Added::0");
  check(restartWithoutConfirmation?.status === "confirmation-required", "非空画布重新开始必须要求确认");
  check(concurrentController.getState().rootNodeId === originalRoot, "未确认重新开始不得清空当前画布");
  const confirmedRestart = await concurrentController.setStart("Added::0", async () => true);
  check(confirmedRestart?.status === "success", "确认后应允许明确重新开始");
  check(concurrentController.getState().rootNodeId === "Added::0", "确认重新开始应原子替换 root");

  const slowConfirmation = deferred();
  const startRaceChunks = new Map([
    ["Root::0", indexedChunk("Root::0", "Root", 0)],
    ["StartA::0", indexedChunk("StartA::0", "StartA", 0)],
    ["StartB::0", indexedChunk("StartB::0", "StartB", 0)],
  ]);
  const startRaceController = new SemanticWalkController({
    repository: { getChunk: async (chunkId) => startRaceChunks.get(chunkId) ?? null },
    relationService,
  });
  await startRaceController.setStart("Root::0");
  const olderStart = startRaceController.setStart("StartA::0", () => slowConfirmation.promise);
  const newerStart = startRaceController.setStart("StartB::0", async () => true);
  await newerStart;
  slowConfirmation.resolve(true);
  const olderStartResult = await olderStart;
  check(olderStartResult?.status === "cancelled", "较早 start 的确认晚返回时必须标记 cancelled");
  check(startRaceController.getState().rootNodeId === "StartB::0", "较早 start 不得在确认晚返回后覆盖较新的 root");

  const detachedRelation = deferred();
  const replayController = new SemanticWalkController({
    repository: controllerRepository,
    relationService: { findRelatedChunks: () => detachedRelation.promise },
  });
  await replayController.setStart("Root::0");
  const unsubscribe = replayController.subscribe(() => {});
  const detachedExpansion = replayController.expand("Root::0");
  await Promise.resolve();
  await Promise.resolve();
  unsubscribe();
  check(replayController.getState().nodes["Root::0"].loading === false, "最后 listener unsubscribe 必须立即清除在途节点 loading");
  detachedRelation.resolve([{
    chunkId: "Detached::0",
    docId: "Detached",
    path: "Detached.md",
    title: "Detached",
    content: "卸载后的旧结果",
    chunkIndex: 0,
    chunkCount: 1,
    sectionLabel: "",
    distance: 0.3,
  }]);
  await detachedExpansion;
  check(!replayController.getState().nodes["Detached::0"], "最后一个 listener 取消后必须丢弃旧异步响应");
  const replayStates = [];
  const unsubscribeReplay = replayController.subscribe((state) => replayStates.push(state));
  const replayAdd = await replayController.addChunk("Added::0");
  check(replayAdd?.status === "success" && replayStates.length >= 2, "取消订阅后的 controller 必须可重新订阅并继续工作");
  unsubscribeReplay();

  const staleRelation = deferred();
  const staleController = new SemanticWalkController({
    repository: controllerRepository,
    relationService: { findRelatedChunks: () => staleRelation.promise },
  });
  await staleController.setStart("Root::0");
  const staleExpansion = staleController.expand("Root::0");
  await Promise.resolve();
  await Promise.resolve();
  staleController.reset();
  staleRelation.resolve([{
    chunkId: "Stale::0",
    docId: "Stale",
    path: "Stale.md",
    title: "Stale",
    content: "过期结果",
    chunkIndex: 0,
    chunkCount: 1,
    sectionLabel: "",
    distance: 0.4,
  }]);
  await staleExpansion;
  assert.deepStrictEqual(staleController.getState().nodes, {}, "reset 后必须丢弃旧异步响应");
  assert.deepStrictEqual(staleController.getCachedCandidates("Root::0"), [], "reset 必须清空候选缓存");

  let attempts = 0;
  const retryController = new SemanticWalkController({
    repository: controllerRepository,
    relationService: {
      findRelatedChunks: async () => {
        attempts++;
        if (attempts === 1) throw new Error("向量服务暂不可用");
        return [];
      },
    },
  });
  await retryController.setStart("Root::0");
  await retryController.expand("Root::0");
  assert.strictEqual(retryController.getState().nodes["Root::0"].status, "error");
  assert.match(retryController.getState().nodes["Root::0"].error, /向量服务暂不可用/);
  await retryController.expand("Root::0");
  assert.strictEqual(attempts, 2, "错误节点应可重试");
  assert.strictEqual(retryController.getState().nodes["Root::0"].error, undefined);

  let failedExpansionAttempts = 0;
  const failedExpansionController = new SemanticWalkController({
    repository: controllerRepository,
    relationService: {
      findRelatedChunks: async () => {
        failedExpansionAttempts++;
        throw new Error("关系查询失败");
      },
    },
  });
  await failedExpansionController.setStart("Root::0");
  const addAndExpandFailure = await failedExpansionController.addAndExpand("Added::0");
  check(addAndExpandFailure?.status === "expand-error", "addAndExpand 必须把关系失败与 missing 区分开");
  check(addAndExpandFailure?.error === "关系查询失败", "expand-error 必须携带节点可展示的错误");
  check(failedExpansionAttempts === 1, "addAndExpand 关系失败不应误走 missing 分支");

  assert.deepStrictEqual(getChunkCalls.slice(0, 3), [
    { chunkId: "Root::0", includeEmbedding: false },
    { chunkId: "Added::0", includeEmbedding: false },
    { chunkId: "Expand::0", includeEmbedding: false },
  ], "所有 picker 选择动作最终只传 chunkId 给 controller");

  controller.dispose();
  bandController.dispose();
  staleController.dispose();
  retryController.dispose();
  preservedController.dispose();
  throwingController.dispose();
  concurrentController.dispose();
  startRaceController.dispose();
  replayController.dispose();
  failedExpansionController.dispose();
  assert.deepStrictEqual(regressionFailures, [], `Task 6 controller regressions:\n- ${regressionFailures.join("\n- ")}`);
  setLocale("en");
  console.log("Semantic walk chunk picker tests passed");
})().catch((error) => {
  console.error("Semantic walk chunk picker tests FAILED:", error);
  process.exit(1);
});
