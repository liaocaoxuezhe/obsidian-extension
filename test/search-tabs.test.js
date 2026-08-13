const assert = require("assert");
const path = require("path");
const esbuild = require("../node_modules/esbuild");

async function loadModule(source) {
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const module = { exports: {} };
  const fn = new Function("module", "exports", result.outputFiles[0].text);
  fn(module, module.exports);
  return module.exports;
}

function result(chunkId, pathName, title) {
  return {
    chunkId,
    docId: pathName,
    path: pathName,
    title,
    content: `${title} content`,
    chunkIndex: 0,
    chunkCount: 2,
    sectionLabel: "",
    distance: 0.2,
    source: "local",
    score: 0.8,
  };
}

(async () => {
  const extensionRoot = path.join(__dirname, "..");
  const { createDefaultSearchTab, createDerivedSearchTab } = await loadModule(
    path.join(extensionRoot, "src", "search-tabs.ts")
  );
  const { SearchResultCache } = await loadModule(
    path.join(extensionRoot, "src", "local-vector", "search-result-cache.ts")
  );

  const cache = new SearchResultCache(10);
  const baseKey = { mode: "query", query: "same", topK: 10, excludePaths: ["Muted.md"] };
  cache.set(
    { ...baseKey, excludeChunkIds: ["chunk-b", "chunk-a", "chunk-a"] },
    { results: [{ title: "first exclusion set" }] }
  );

  assert.deepStrictEqual(
    cache.get({ ...baseKey, excludeChunkIds: ["chunk-a", "chunk-b"] }),
    { results: [{ title: "first exclusion set" }] },
    "excludeChunkIds 的顺序和重复项不应制造无谓 cache miss"
  );
  assert.strictEqual(
    cache.get({ ...baseKey, excludeChunkIds: ["chunk-a", "chunk-c"] }),
    null,
    "不同 chunk 排除集合不能错误命中同一缓存"
  );

  const firstChunk = result("Notes/Same.md::0", "Notes/Same.md", "First chunk");
  const secondChunk = result("Notes/Same.md::1", "Notes/Same.md", "Second chunk");
  const otherChunk = result("Notes/Other.md::0", "Notes/Other.md", "Other chunk");
  const parentTab = {
    ...createDefaultSearchTab("parent"),
    excludedPaths: ["Muted.md"],
    excludedChunkIds: ["already-seen"],
    results: [firstChunk, secondChunk, otherChunk],
  };

  const derived = createDerivedSearchTab("child", parentTab, firstChunk);

  assert.deepStrictEqual(
    derived.excludedPaths,
    ["Muted.md"],
    "派生搜索不能因为看过一个结果就排除同一文档的所有 chunk"
  );
  assert.deepStrictEqual(
    derived.excludedChunkIds,
    ["already-seen", "Notes/Same.md::0", "Notes/Same.md::1", "Notes/Other.md::0"],
    "派生搜索应按稳定 chunkId 收集所有已见结果"
  );

  const grandchildResult = result("Notes/Grandchild.md::0", "Notes/Grandchild.md", "Grandchild chunk");
  const grandchild = createDerivedSearchTab("grandchild", {
    ...derived,
    results: [grandchildResult, firstChunk],
  }, grandchildResult);
  const greatGrandchildResult = result("Notes/Great.md::0", "Notes/Great.md", "Great-grandchild chunk");
  const greatGrandchild = createDerivedSearchTab("great-grandchild", {
    ...grandchild,
    results: [greatGrandchildResult, secondChunk],
  }, greatGrandchildResult);

  assert.deepStrictEqual(grandchild.excludedPaths, ["Muted.md"]);
  assert.deepStrictEqual(greatGrandchild.excludedPaths, ["Muted.md"]);
  assert.deepStrictEqual(greatGrandchild.excludedChunkIds, [
    "already-seen",
    "Notes/Same.md::0",
    "Notes/Same.md::1",
    "Notes/Other.md::0",
    "Notes/Grandchild.md::0",
    "Notes/Great.md::0",
  ], "三代派生 tab 必须继承全部已见 chunkId，并稳定去重");

  console.log("Search tab chunk exclusion tests passed");
})();
