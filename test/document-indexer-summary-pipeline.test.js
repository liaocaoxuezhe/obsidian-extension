const assert = require("assert");
const path = require("path");
const esbuild = require("../node_modules/esbuild");

async function loadModule() {
  const source = path.join(__dirname, "..", "src", "local-vector", "document-indexer.ts");
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
      return { TFile: class TFile {}, Notice: class Notice {} };
    }
    return require(id);
  };
  fn(module, module.exports, testRequire);
  return module.exports;
}

(async () => {
  const { DocumentIndexer } = await loadModule();
  const embedded = [];
  const embedding = {
    embedBatch: async (texts) => {
      embedded.push(...texts);
      return texts.map(() => [1, 0, 0]);
    },
    getInferenceCount: () => 0,
    resetSession: async () => {},
  };
  const vectorStore = {
    deleteDocument: async () => {},
    upsertDocument: async () => {},
    listIndexedDocumentEntries: async () => [],
  };
  const vault = { adapter: { read: async () => "# 标题\n原文很长。" } };
  const stateStore = { load: async () => ({}), save: async () => {} };
  let summarizeCalls = 0;
  const summarizer = {
    summarize: async () => {
      summarizeCalls++;
      return { text: "摘要文本包含足够长度用于嵌入。", usedSummary: true };
    },
  };
  const indexer = new DocumentIndexer(embedding, vectorStore, vault, stateStore, [], undefined, summarizer);

  await indexer.indexDocument({
    path: "note.md",
    name: "note.md",
    extension: "md",
    stat: { mtime: 1, ctime: 1, size: 20 },
  });

  assert.strictEqual(summarizeCalls, 0);
  assert.ok(embedded.some((text) => text.includes("原文很长")));
  assert.strictEqual(embedded.some((text) => text.includes("摘要文本")), false);

  console.log("Document indexer keeps original Chroma pipeline test passed");
})();
