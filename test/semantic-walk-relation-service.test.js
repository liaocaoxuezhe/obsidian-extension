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
  const fn = new Function("module", "exports", "require", result.outputFiles[0].text);
  fn(module, module.exports, (id) => id === "obsidian" ? {} : require(id));
  return module.exports;
}

async function loadLocalizedRelationBoundary() {
  const result = await esbuild.build({
    stdin: {
      contents: [
        'export { ChunkRelationService } from "./src/semantic-walk/relation-service";',
        'export { setLocale } from "./src/util/i18n";',
      ].join("\n"),
      resolveDir: path.join(__dirname, ".."),
      sourcefile: "semantic-walk-localized-relation-boundary.ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["obsidian"],
    write: false,
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

function chunk(chunkId, docId, distance) {
  return {
    chunkId,
    docId,
    path: `${docId}.md`,
    title: docId,
    content: chunkId,
    chunkIndex: 0,
    chunkCount: 4,
    sectionLabel: "",
    mtime: 1,
    distance,
  };
}

(async () => {
  const { LocalSemanticSearch } = await loadModule("local-vector/search.ts");
  const localSearch = new LocalSemanticSearch(
    { async embedQuery() { return [0.1]; } },
    { async search() {
      return [
        { chunkId: "Note::chunk-0", content: "排除的段落", distance: 0.01, score: 0.01, metadata: { path: "Note.md", doc_id: "Note" } },
        { chunkId: "Muted::chunk-0", content: "静音文档段落", distance: 0.02, score: 0.02, metadata: { path: "Muted.md", doc_id: "Muted" } },
        { chunkId: "Note::chunk-1", content: "保留的同文档段落", distance: 0.03, score: 0.03, metadata: { path: "Note.md", doc_id: "Note" } },
      ];
    } },
  );
  localSearch.setDocumentIndexer({ getMutedPaths: () => new Set(["Muted.md"]) });
  const chunkFiltered = await localSearch.searchByEmbedding([0.1], 1, {
    excludeChunkIds: ["Note::chunk-0"],
  });
  assert.deepStrictEqual(chunkFiltered.map((result) => result.chunkId), ["Note::chunk-1"]);

  const { ChunkRelationService } = await loadModule("semantic-walk/relation-service.ts");
  const source = { ...chunk("Source::chunk-0", "Source", 0), embedding: [0.1, 0.2] };
  const candidates = [
    chunk("Source::chunk-0", "Source", 0.01),
    chunk("Muted::chunk-0", "Muted", 0.02),
    chunk("Hidden::chunk-0", "Hidden", 0.03),
    chunk("Source::chunk-1", "Source", 0.04),
    chunk("A::chunk-0", "A", 0.05),
    chunk("A::chunk-1", "A", 0.06),
    chunk("A::chunk-2", "A", 0.07),
    chunk("B::chunk-0", "B", 0.08),
  ];
  let usedEmbedding;
  let requestedTopK;
  const search = {
    async searchByEmbedding(embedding, topK, options) {
      usedEmbedding = embedding;
      requestedTopK = topK;
      return candidates.filter((candidate) =>
        !options.excludeChunkIds.includes(candidate.chunkId) && candidate.path !== "Muted.md"
      );
    },
  };
  const service = new ChunkRelationService({
    search,
    embedding: { async embedDocument() { throw new Error("stored embedding should be used"); } },
  });

  const balanced = await service.findRelatedChunks(source, {
    limit: 4,
    mode: "balanced",
    excludeSameDocument: false,
    excludeChunkIds: ["Hidden::chunk-0"],
  });
  assert.deepStrictEqual(usedEmbedding, [0.1, 0.2]);
  assert.strictEqual(requestedTopK, 40, "relation service must fetch a 40-result pool before filtering");
  assert.deepStrictEqual(balanced.map((candidate) => candidate.chunkId), [
    "Source::chunk-1",
    "A::chunk-0",
    "A::chunk-1",
    "B::chunk-0",
  ]);
  assert.ok(balanced.every((candidate) => candidate.chunkId !== source.chunkId));
  assert.ok(balanced.every((candidate) => candidate.path !== "Muted.md"));
  assert.ok(balanced.every((candidate) => candidate.chunkId !== "Hidden::chunk-0"));

  const balancedCrossDocument = await service.findRelatedChunks(source, {
    limit: 4,
    mode: "balanced",
    excludeSameDocument: true,
    excludeChunkIds: [],
  });
  assert.deepStrictEqual(balancedCrossDocument.map((candidate) => candidate.chunkId), [
    "Hidden::chunk-0",
    "A::chunk-0",
    "A::chunk-1",
    "B::chunk-0",
  ], "均衡与排除当前文档必须可以独立组合");

  const pure = await service.findRelatedChunks(source, {
    limit: 4,
    mode: "pure",
    excludeSameDocument: false,
    excludeChunkIds: [],
  });
  assert.deepStrictEqual(pure.map((candidate) => candidate.chunkId), [
    "Hidden::chunk-0",
    "Source::chunk-1",
    "A::chunk-0",
    "A::chunk-1",
  ]);

  const pureCrossDocument = await service.findRelatedChunks(source, {
    limit: 4,
    mode: "pure",
    excludeSameDocument: true,
    excludeChunkIds: [],
  });
  assert.deepStrictEqual(pureCrossDocument.map((candidate) => candidate.chunkId), [
    "Hidden::chunk-0",
    "A::chunk-0",
    "A::chunk-1",
    "A::chunk-2",
  ], "纯相关与排除当前文档组合后不得限制其他文档的 chunk 数量");

  let embeddedContent = "";
  const fallbackService = new ChunkRelationService({
    search: { async searchByEmbedding(embedding) { usedEmbedding = embedding; return []; } },
    embedding: { async embedDocument(content) { embeddedContent = content; return [0.9]; } },
  });
  await fallbackService.findRelatedChunks({ ...source, content: "需要兜底的正文", embedding: undefined }, {
    limit: 1,
    mode: "pure",
    excludeSameDocument: false,
    excludeChunkIds: [],
  });
  assert.strictEqual(embeddedContent, "需要兜底的正文");
  assert.deepStrictEqual(usedEmbedding, [0.9]);

  const localizedBoundary = await loadLocalizedRelationBoundary();
  const LocalizedChunkRelationService = localizedBoundary.ChunkRelationService;
  const { setLocale } = localizedBoundary;
  setLocale("zh");
  const localizedQueryService = new LocalizedChunkRelationService({
    search: { async searchByEmbedding() { throw {}; } },
  });
  await assert.rejects(
    () => localizedQueryService.findRelatedChunks(source, { mode: "pure", excludeSameDocument: false }),
    /语义关系查询失败/,
    "关系查询 fallback 错误必须走 i18n",
  );
  const localizedEmbeddingService = new LocalizedChunkRelationService({
    search: { async searchByEmbedding() { return []; } },
    embedding: { async embedDocument() { throw {}; } },
  });
  await assert.rejects(
    () => localizedEmbeddingService.findRelatedChunks(
      { ...source, embedding: undefined },
      { mode: "pure", excludeSameDocument: false },
    ),
    /Embedding 兜底失败/,
    "embedding fallback 错误必须走 i18n",
  );
  setLocale("en");

  console.log("Semantic walk relation service tests passed");
})().catch((err) => {
  console.error("Semantic walk relation service tests FAILED:", err);
  process.exit(1);
});
