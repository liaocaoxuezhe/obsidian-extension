const assert = require("assert");
const fs = require("fs");
const os = require("os");
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
  const { ensureEmbeddingRuntime } = await loadModule();
  assert.strictEqual(
    typeof ensureEmbeddingRuntime,
    "function",
    "ensureEmbeddingRuntime should be exported for testing the missing-runtime bootstrap"
  );

  const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-runtime-"));
  fs.writeFileSync(path.join(pluginDir, "main.js"), "");

  const installCalls = [];
  ensureEmbeddingRuntime(pluginDir, {
    canLoad: () => installCalls.length > 0,
    install: (dir) => {
      installCalls.push(dir);
    },
  });

  assert.deepStrictEqual(installCalls, [pluginDir]);
  const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"));
  assert.strictEqual(pkg.private, true);
  assert.strictEqual(pkg.scripts["setup:local"], "npm install --omit=dev");
  assert.ok(pkg.dependencies["@huggingface/transformers"]);
  assert.ok(pkg.dependencies["onnxruntime-node"]);

  console.log("Embedding runtime auto-install test passed");
})().catch((err) => {
  console.error("Embedding runtime auto-install test FAILED:", err);
  process.exit(1);
});
