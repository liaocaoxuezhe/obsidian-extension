const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");

async function loadModule(relativeSource) {
  const source = path.join(__dirname, "..", "src", relativeSource);
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["obsidian"],
    write: false,
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    module,
    module.exports,
    (id) => id === "obsidian" ? {} : require(id),
  );
  return module.exports;
}

function chunk(chunkId, docId, distance = 0.1, overrides = {}) {
  return {
    chunkId,
    docId,
    path: `${docId}.md`,
    title: docId,
    content: `content:${chunkId}`,
    chunkIndex: 0,
    chunkCount: 1,
    sectionLabel: docId,
    mtime: 100,
    distance,
    ...overrides,
  };
}

(async () => {
  const { SemanticWalkController } = await loadModule("semantic-walk/walk-controller.ts");
  const { ChunkRelationService } = await loadModule("semantic-walk/relation-service.ts");
  const { createWalkSessionState, semanticWalkReducer } = await loadModule("semantic-walk/graph-reducer.ts");

  const modeState = semanticWalkReducer(createWalkSessionState(), {
    type: "set-candidate-mode",
    mode: "pure",
  });
  const filteredModeState = semanticWalkReducer(modeState, {
    type: "set-exclude-same-document",
    exclude: true,
  });
  assert.strictEqual(filteredModeState.candidateMode, "pure", "reducer 必须提供结果分布 setter");
  assert.strictEqual(filteredModeState.excludeSameDocument, true, "reducer 必须独立记录排除当前文档条件");

  const root = chunk("Root::chunk-0", "Root", 0, { embedding: [0.4, 0.6] });
  const related = chunk("Related::chunk-0", "Related", 0.2);
  const chunks = new Map([[root.chunkId, root], [related.chunkId, related]]);
  const queryOptions = [];
  let indexRevision = 4;
  let activeModel = "model-a";
  const controller = new SemanticWalkController({
    repository: {
      async getChunk(chunkId, includeEmbedding = false) {
        const value = chunks.get(chunkId);
        return value ? { ...value, ...(includeEmbedding ? { embedding: [0.4, 0.6] } : { embedding: undefined }) } : null;
      },
    },
    relationService: {
      async findRelatedChunks(_source, options) {
        queryOptions.push({ ...options });
        return [related];
      },
    },
    getIndexRevision: () => indexRevision,
    getActiveModel: () => activeModel,
  });

  await controller.setStart(root.chunkId);
  await controller.expand(root.chunkId);
  assert.deepStrictEqual(queryOptions.map((options) => options.mode), ["balanced"]);
  assert.strictEqual(queryOptions[0].excludeSameDocument, false, "默认查询必须允许当前文档");
  assert.strictEqual(queryOptions[0].limit, 6, "生产 controller 默认每次应请求 6 张下一级卡片");

  const modeResult = await controller.setCandidateMode("pure");
  assert.strictEqual(modeResult.status, "success", "切换候选模式应立即重新展开当前焦点");
  assert.strictEqual(controller.getState().candidateMode, "pure");
  assert.deepStrictEqual(
    queryOptions.map((options) => options.mode),
    ["balanced", "pure"],
    "模式切换必须清理旧候选缓存，并让下一批使用新模式",
  );

  indexRevision += 1;
  await controller.expand(root.chunkId);
  assert.strictEqual(queryOptions.length, 3, "索引 revision 变化后不得复用旧展开缓存");

  activeModel = "model-b";
  await controller.expand(root.chunkId);
  assert.strictEqual(queryOptions.length, 4, "active model 变化后不得复用旧展开缓存");

  chunks.set(root.chunkId, { ...root, mtime: 200 });
  await controller.expand(root.chunkId);
  assert.strictEqual(queryOptions.length, 5, "源文档 mtime 变化后不得复用旧展开缓存");

  const filterRoot = chunk("FilterRoot::chunk-0", "FilterRoot", 0, { embedding: [0.4, 0.6] });
  const oldLeaf = chunk("OldLeaf::chunk-0", "OldLeaf", 0.1);
  const visitedChild = chunk("Visited::chunk-0", "Visited", 0.2);
  const crossLeaf = chunk("CrossLeaf::chunk-0", "CrossLeaf", 0.3);
  const pureCrossLeaf = chunk("PureCrossLeaf::chunk-0", "PureCrossLeaf", 0.4);
  const filterChunks = new Map(
    [filterRoot, oldLeaf, visitedChild, crossLeaf, pureCrossLeaf].map((value) => [value.chunkId, value]),
  );
  const filterQueries = [];
  const filterController = new SemanticWalkController({
    repository: {
      async getChunk(chunkId) {
        return filterChunks.get(chunkId) ?? null;
      },
    },
    relationService: {
      async findRelatedChunks(_source, options) {
        filterQueries.push({ ...options });
        const candidates = options.excludeSameDocument
          ? options.mode === "pure" ? [pureCrossLeaf] : [crossLeaf]
          : [oldLeaf, visitedChild];
        return candidates.filter((candidate) => !options.excludeChunkIds.includes(candidate.chunkId));
      },
    },
  });
  await filterController.setStart(filterRoot.chunkId);
  await filterController.expand(filterRoot.chunkId);
  filterController.focus(visitedChild.chunkId);
  filterController.focus(filterRoot.chunkId);
  await filterController.toggleNodeExpansion(filterRoot.chunkId);
  await filterController.setExcludeSameDocument(true);
  assert.strictEqual(filterQueries.length, 1, "收起时切换排除当前文档不得查询");
  assert.strictEqual(filterController.getState().nodes[filterRoot.chunkId].collapsed, true, "筛选切换不得暗中展开节点");

  await filterController.toggleNodeExpansion(filterRoot.chunkId);
  let filterState = filterController.getState();
  assert.strictEqual(filterQueries.length, 2, "筛选签名过期后再次展开必须刷新");
  assert.strictEqual(filterState.edges[`${filterRoot.chunkId}->${oldLeaf.chunkId}`], undefined, "旧未访问叶子不得累积");
  assert.ok(filterState.edges[`${filterRoot.chunkId}->${visitedChild.chunkId}`], "已访问路径必须保留");
  assert.ok(filterState.edges[`${filterRoot.chunkId}->${crossLeaf.chunkId}`], "新筛选候选必须出现");

  await filterController.setCandidateMode("pure");
  assert.strictEqual(filterQueries.length, 3, "展开状态切换结果分布必须立即刷新");
  await filterController.setCandidateMode("balanced");
  assert.strictEqual(filterQueries.length, 3, "切回旧筛选组合必须复用对应缓存");
  filterState = filterController.getState();
  assert.ok(filterState.edges[`${filterRoot.chunkId}->${crossLeaf.chunkId}`]);
  assert.strictEqual(filterState.edges[`${filterRoot.chunkId}->${pureCrossLeaf.chunkId}`], undefined);

  const candidates = [
    chunk("Source::chunk-0", "Source", 0.01),
    chunk("Empty::chunk-0", "Empty", 0.02, { content: "   " }),
    chunk("Missing::chunk-0", "Missing", 0.03),
    chunk("Stale::chunk-0", "Stale", 0.04),
    chunk("A::chunk-0", "A", 0.05),
    chunk("A::chunk-1", "A", 0.06),
    chunk("A::chunk-2", "A", 0.07),
    chunk("A::chunk-3", "A", 0.08),
    chunk("A::chunk-4", "A", 0.09),
    chunk("A::chunk-4", "A", 0.1),
    chunk("B::chunk-0", "B", 0.11),
    chunk("C::chunk-0", "C", 0.12),
  ];
  let requestedTopK = 0;
  const service = new ChunkRelationService({
    search: {
      async searchByEmbedding(_embedding, topK) {
        requestedTopK = topK;
        return candidates;
      },
    },
    validateCandidate: async (candidate) => !["Missing", "Stale"].includes(candidate.docId),
  });
  const selected = await service.findRelatedChunks(
    { ...chunk("Source::chunk-0", "Source", 0), embedding: [0.2] },
    { limit: 4, mode: "balanced", excludeSameDocument: false },
  );
  assert.strictEqual(requestedTopK, 40, "关系查询必须先取最多 40 条，再做过滤和多样性回填");
  assert.deepStrictEqual(
    selected.map((candidate) => candidate.chunkId),
    ["A::chunk-0", "A::chunk-1", "B::chunk-0", "C::chunk-0"],
    "同文档前排、空正文、missing、stale 和重复结果均不能阻止后排候选回填",
  );

  const normalized = await service.findRelatedChunks(
    { ...chunk("Source::chunk-0", "Source", 0), embedding: [0.2] },
    { limit: Number.NaN, mode: "pure", excludeSameDocument: false },
  );
  assert.strictEqual(normalized.length, 7, "非法 limit 应回退到默认 8，并在过滤后返回全部有效候选");

  controller.dispose();
  filterController.dispose();
  console.log("Semantic walk mode, cache, and relation tests passed");
})().catch((error) => {
  console.error("Semantic walk mode, cache, and relation tests FAILED:", error);
  process.exit(1);
});
