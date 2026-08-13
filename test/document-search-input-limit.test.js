const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");

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
  const { MAX_DOCUMENT_SEARCH_CHARS, createDocumentSearchInput } = await loadModule();
  const content = "中".repeat(2500);

  const result = createDocumentSearchInput(content, 8000);

  assert.strictEqual(MAX_DOCUMENT_SEARCH_CHARS, 5000);
  assert.strictEqual(result.length, 2500, "content below the current 5000-character product limit must not be truncated");
  assert.strictEqual(result, content);

  const oversized = createDocumentSearchInput("中".repeat(6000), 8000);
  assert.strictEqual(oversized.length, 5000, "document search input must still respect MAX_DOCUMENT_SEARCH_CHARS");

  console.log("Document search input limit test passed");
})().catch((err) => {
  console.error("Document search input limit test FAILED:", err);
  process.exit(1);
});
