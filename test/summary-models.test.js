const assert = require("assert");
const path = require("path");
const esbuild = require("../node_modules/esbuild");

async function loadModule(relativePath) {
  const source = path.join(__dirname, "..", relativePath);
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const module = { exports: {} };
  const fn = new Function("module", "exports", "require", result.outputFiles[0].text);
  fn(module, module.exports, require);
  return module.exports;
}

(async () => {
  const mod = await loadModule("src/local-vector/summary-models.ts");
  const keys = Object.keys(mod.SUMMARY_MODELS);

  assert.deepStrictEqual(keys, [
    "qwen3:1.7b",
    "qwen3:0.6b",
    "qwen3.5:0.8b",
    "qwen3.5:2b",
    "gemma3:1b",
    "gemma3:270m",
    "gemma4:e2b",
  ]);
  assert.strictEqual(mod.DEFAULT_SUMMARY_MODEL_KEY, "qwen3.5:0.8b");
  assert.strictEqual(mod.formatModelBytes(291_000_000), "291 MB");
  assert.strictEqual(mod.formatModelBytes(1_400_000_000), "1.4 GB");

  console.log("Summary model tests passed");
})();
