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
  const fn = new Function("module", "exports", "require", result.outputFiles[0].text);
  fn(module, module.exports, require);
  return module.exports;
}

(async () => {
  const { getEmbeddingErrorMessage } = await loadModule();
  const message = getEmbeddingErrorMessage(
    new Error(
      "Missing managed embedding runtime dependency @huggingface/transformers. " +
        "Open Analogy runtime onboarding to repair it. Original error: Cannot find module '@huggingface/transformers'"
    )
  );

  assert.match(message, /managed runtime dependencies are missing or invalid/i);
  assert.match(message, /runtime onboarding/i);
  assert.doesNotMatch(message, /npm install|setup:local/i);

  console.log("Embedding runtime error message test passed");
})().catch((err) => {
  console.error("Embedding runtime error message test FAILED:", err);
  process.exit(1);
});
