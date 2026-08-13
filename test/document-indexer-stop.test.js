const assert = require("assert");
const path = require("path");
const esbuild = require(path.join(__dirname, "..", "node_modules", "esbuild"));

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

function file(filePath) {
  const name = filePath.split("/").pop();
  return {
    path: filePath,
    name,
    extension: "md",
    stat: { mtime: 1000, ctime: 500, size: 100 },
  };
}

(async () => {
  const { DocumentIndexer } = await loadModule();
  const indexer = new DocumentIndexer(
    { getInferenceCount: () => 0, resetSession: async () => {} },
    {},
    { adapter: { read: async () => "" }, getFiles: () => [] },
    { load: async () => ({}), save: async () => {} }
  );

  const processed = [];
  indexer.indexDocument = async (item) => {
    processed.push(item.path);
    if (item.path === "One.md") {
      indexer.stop();
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  };

  await indexer.rebuildIndex([file("One.md"), file("Two.md"), file("Three.md")], { force: true });

  assert.deepStrictEqual(processed, ["One.md"]);
  assert.strictEqual(indexer.getIsIndexing(), false);

  indexer.indexDocument = async (item) => {
    processed.push(item.path);
  };

  await indexer.rebuildIndex([file("Four.md")], { force: true });

  assert.deepStrictEqual(processed, ["One.md", "Four.md"]);

  console.log("Document indexer stop tests passed");
})();
