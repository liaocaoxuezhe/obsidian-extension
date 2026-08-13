const assert = require("assert");
const path = require("path");
const esbuild = require("../node_modules/esbuild");

async function loadModule() {
  const source = path.join(
    __dirname,
    "..",
    "src",
    "local-vector",
    "document-indexer.ts",
  );
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
  const embedding = {
    embedBatch: async (texts) => texts.map(() => [1, 0, 0]),
    getInferenceCount: () => 0,
    resetSession: async () => {},
  };
  const indexer = new DocumentIndexer(
    embedding,
    {},
    { adapter: { read: async () => "" }, getFiles: () => [] },
    { load: async () => ({}), save: async () => {} },
  );

  const distances = [0.1, 0.11, 0.12, 0.9];
  indexer.cosineSimilarity = () => 1 - distances.shift();

  const chunks = await indexer.splitIntoChunks(
    "第一段第一句。\n\n第二段第一句。第二段第二句。第二段第三句。最后一句。"
  );

  assert.strictEqual(
    chunks[0],
    "第一段第一句。\n\n第二段第一句。 第二段第二句。 第二段第三句。",
  );
  assert.strictEqual(chunks[1], "最后一句。");

  console.log("Obsidian chunk newline preservation tests passed");
})();
