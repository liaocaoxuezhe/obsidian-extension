const assert = require("assert");
const path = require("path");
const esbuild = require("../node_modules/esbuild");

async function loadModule() {
  const source = path.join(
    __dirname,
    "..",
    "src",
    "local-vector",
    "document-indexer.ts"
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
  let savedState = null;
  const indexer = new DocumentIndexer(
    {},
    {
      listIndexedDocumentEntries: async () => [
        {
          docId: "Notes/中文.md",
          path: "Notes/中文.md",
          mtime: 1234,
          chunkCount: 3,
        },
      ],
    },
    { adapter: { read: async () => "" }, getFiles: () => [] },
    {
      load: async () => ({}),
      save: async (state) => {
        savedState = state;
      },
    }
  );

  await indexer.loadState();

  assert.ok(savedState);
  assert.strictEqual(savedState["Notes/中文.md"].chunkCount, 3);
  assert.strictEqual(savedState["Notes/中文.md"].mtime, 1234);

  const [status] = indexer.getAllFileStatuses([file("Notes/中文.md", 1234)]);
  assert.strictEqual(status.status, "indexed");
  assert.strictEqual(status.chunkCount, 3);

  console.log("Obsidian index state recovery test passed");
})();
