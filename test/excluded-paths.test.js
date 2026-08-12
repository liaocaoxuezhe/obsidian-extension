const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");

async function loadModule() {
  const source = path.join(__dirname, "..", "src", "local-vector", "excluded-paths.ts");
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
  const { normalizeExcludedIndexPaths, isPathExcludedFromIndex } = await loadModule();

  assert.deepStrictEqual(
    normalizeExcludedIndexPaths([" Drafts/ ", "", "/Archive", "Archive/", "Drafts"]),
    ["Drafts", "Archive"]
  );

  const excluded = normalizeExcludedIndexPaths(["Drafts", "Archive/Old note.md"]);
  assert.strictEqual(isPathExcludedFromIndex("Drafts/idea.md", excluded), true);
  assert.strictEqual(isPathExcludedFromIndex("Archive/Old note.md", excluded), true);
  assert.strictEqual(isPathExcludedFromIndex("Archive/New note.md", excluded), false);
  assert.strictEqual(isPathExcludedFromIndex("Draftsmanship.md", excluded), false);

  console.log("Excluded path tests passed");
})();
