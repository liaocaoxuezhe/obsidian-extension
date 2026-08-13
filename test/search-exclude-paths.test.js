const assert = require("assert");
const path = require("path");
const esbuild = require("../node_modules/esbuild");

async function loadModule() {
  const source = path.join(__dirname, "..", "src", "local-vector", "search.ts");
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
  const testRequire = (id) => {
    if (id === "obsidian") {
      return { TFile: class TFile {} };
    }
    return require(id);
  };
  fn(module, module.exports, testRequire);
  return module.exports;
}

(async () => {
  const { LocalSemanticSearch } = await loadModule();
  const embedding = {
    embedQuery: async () => [1, 0],
    embedDocument: async () => [0, 1],
  };
  const requestedTopK = [];
  const vectorStore = {
    search: async (_embedding, topK) => {
      requestedTopK.push(topK);
      return [
        { content: "muted", score: 0.99, metadata: { title: "Muted", path: "muted.md" } },
        { content: "excluded", score: 0.98, metadata: { title: "Excluded", path: "excluded.md" } },
        { content: "kept one", score: 0.97, metadata: { title: "Kept One", path: "one.md" } },
        { content: "kept two", score: 0.96, metadata: { title: "Kept Two", path: "two.md" } },
      ];
    },
  };
  const indexer = {
    getMutedPaths: () => new Set(["muted.md"]),
  };

  const search = new LocalSemanticSearch(embedding, vectorStore, 512);
  search.setDocumentIndexer(indexer);

  const results = await search.searchByQuery("query", 2, { excludePaths: ["excluded.md"] });

  assert.deepStrictEqual(results.map((result) => result.path), ["one.md", "two.md"]);
  assert.strictEqual(requestedTopK[0] > 2, true);

  const pagedRequests = [];
  const pagedVectorStore = {
    search: async (_embedding, topK) => {
      pagedRequests.push(topK);
      return [
        { content: "excluded 1a", score: 0.99, metadata: { title: "Excluded 1", path: "excluded-1.md" } },
        { content: "excluded 1b", score: 0.98, metadata: { title: "Excluded 1", path: "excluded-1.md" } },
        { content: "excluded 1c", score: 0.97, metadata: { title: "Excluded 1", path: "excluded-1.md" } },
        { content: "excluded 2a", score: 0.96, metadata: { title: "Excluded 2", path: "excluded-2.md" } },
        { content: "excluded 2b", score: 0.95, metadata: { title: "Excluded 2", path: "excluded-2.md" } },
        { content: "excluded 2c", score: 0.94, metadata: { title: "Excluded 2", path: "excluded-2.md" } },
        { content: "excluded 3a", score: 0.93, metadata: { title: "Excluded 3", path: "excluded-3.md" } },
        { content: "excluded 3b", score: 0.92, metadata: { title: "Excluded 3", path: "excluded-3.md" } },
        { content: "excluded 3c", score: 0.91, metadata: { title: "Excluded 3", path: "excluded-3.md" } },
        { content: "kept 1", score: 0.96, metadata: { title: "Kept 1", path: "kept-1.md" } },
        { content: "kept 2", score: 0.95, metadata: { title: "Kept 2", path: "kept-2.md" } },
        { content: "kept 3", score: 0.94, metadata: { title: "Kept 3", path: "kept-3.md" } },
      ].slice(0, topK);
    },
  };
  const pagedSearch = new LocalSemanticSearch(embedding, pagedVectorStore, 512);
  const pagedResults = await pagedSearch.searchByQuery("query", 3, {
    excludePaths: ["excluded-1.md", "excluded-2.md", "excluded-3.md"],
  });

  assert.deepStrictEqual(
    pagedResults.map((result) => result.path),
    ["kept-1.md", "kept-2.md", "kept-3.md"]
  );
  assert.strictEqual(pagedRequests.length > 1, true);
  assert.strictEqual(pagedRequests[pagedRequests.length - 1] >= 6, true);

  console.log("Search exclude paths tests passed");
})();
