const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");

async function loadModule() {
  const source = path.join(__dirname, "..", "src", "local-vector", "embedding.ts");
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

(async () => {
  const { ensureEmbeddingRuntime, installEmbeddingRuntimeDependencies } = await loadModule();
  assert.strictEqual(typeof ensureEmbeddingRuntime, "function");
  assert.strictEqual(installEmbeddingRuntimeDependencies, undefined, "system npm auto-install must stay removed");

  assert.doesNotThrow(() => ensureEmbeddingRuntime({
    versions: { node: "22.23.2", transformers: "4.2.0", onnxruntime: "1.26.0" },
  }));
  assert.throws(
    () => ensureEmbeddingRuntime(null),
    /managed embedding runtime is not ready.*automatic npm installation is disabled/i,
  );

  console.log("Managed embedding runtime readiness test passed");
})().catch((error) => {
  console.error("Managed embedding runtime readiness test FAILED:", error);
  process.exit(1);
});
