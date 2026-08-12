const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");

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

function file(filePath, mtime = 1000) {
  const name = filePath.split("/").pop();
  return {
    path: filePath,
    name,
    extension: "md",
    stat: { mtime, ctime: 500, size: 100 },
  };
}

(async () => {
  const { DocumentIndexer } = await loadModule();
  const deletedDocIds = [];
  const vectorStore = {
    deleteDocument: async (docId) => {
      deletedDocIds.push(docId);
    },
  };
  const indexer = new DocumentIndexer(
    {},
    vectorStore,
    { adapter: { read: async () => "" }, getFiles: () => [] },
    __dirname
  );

  indexer.indexState = {
    "Old.md": {
      path: "Old.md",
      mtime: 1000,
      chunkCount: 2,
    },
  };

  await indexer.handleRename(file("New.md", 1000), "Old.md");

  assert.deepStrictEqual(deletedDocIds, ["Old.md"]);
  assert.strictEqual(indexer.indexState["Old.md"], undefined);
  assert.strictEqual(indexer.indexState["New.md"].path, "Old.md");

  const [status] = indexer.getAllFileStatuses([file("New.md", 1000)]);
  assert.strictEqual(status.status, "outdated");
  assert.strictEqual(status.chunkCount, 2);

  const singleSentenceChunks = await indexer.splitIntoChunks("什么是 RAG 技术？");
  assert.deepStrictEqual(singleSentenceChunks, ["什么是 RAG 技术？"]);
  assert.ok(
    singleSentenceChunks.every((chunk) => typeof chunk === "string"),
    "single-sentence chunks must remain strings for downstream trim operations",
  );

  console.log("Document rename outdated tests passed");
})();
