const assert = require("assert");
const path = require("path");
const esbuild = require("../node_modules/esbuild");

async function loadModule() {
  const source = path.join(__dirname, "..", "src", "local-vector", "search-result-cache.ts");
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

(async () => {
  const { SearchResultCache } = await loadModule();
  const cache = new SearchResultCache(2);
  const key = {
    mode: "document",
    path: "Notes/Idea.md",
    mtime: 1000,
    topK: 10,
    model: "jina-v2",
  };
  const results = [{ title: "Related", content: "match", source: "local", score: 0.8, path: "Related.md" }];
  const entry = { results, queryText: "用于匹配的摘要文本" };

  cache.set(key, entry);

  assert.deepStrictEqual(cache.get(key), entry);
  assert.strictEqual(cache.get({ ...key, mtime: 2000 }), null);

  const excludeCache = new SearchResultCache(5);
  excludeCache.set({ ...key, query: "same", excludePaths: ["B.md"] }, { results: [{ title: "Only A" }] });
  excludeCache.set({ ...key, query: "same", excludePaths: ["A.md"] }, { results: [{ title: "Only B" }] });
  assert.deepStrictEqual(
    excludeCache.get({ ...key, query: "same", excludePaths: ["B.md"] }),
    { results: [{ title: "Only A" }] }
  );
  assert.deepStrictEqual(
    excludeCache.get({ ...key, query: "same", excludePaths: ["A.md"] }),
    { results: [{ title: "Only B" }] }
  );
  excludeCache.set({ ...key, query: "same", excludePaths: ["B.md", "A.md"] }, { results: [{ title: "Sorted" }] });
  assert.deepStrictEqual(
    excludeCache.get({ ...key, query: "same", excludePaths: ["A.md", "B.md"] }),
    { results: [{ title: "Sorted" }] }
  );

  cache.set({ ...key, path: "Notes/Second.md" }, { results: [{ title: "Second" }] });
  cache.set({ ...key, path: "Notes/Third.md" }, { results: [{ title: "Third" }] });
  assert.strictEqual(cache.get(key), null);

  console.log("Search result cache tests passed");
})();
