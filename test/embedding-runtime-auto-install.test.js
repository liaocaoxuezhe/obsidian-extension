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
  const { ensureEmbeddingRuntime, installEmbeddingRuntimeDependencies } = await loadModule();
  assert.strictEqual(
    typeof ensureEmbeddingRuntime,
    "function",
    "ensureEmbeddingRuntime should be exported for testing the missing-runtime bootstrap"
  );
  assert.strictEqual(
    typeof installEmbeddingRuntimeDependencies,
    "function",
    "installEmbeddingRuntimeDependencies should be exported so GUI PATH handling is testable"
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

  const childProcess = require("child_process");
  const originalSpawnSync = childProcess.spawnSync;
  const spawnCalls = [];
  childProcess.spawnSync = (command, args, options) => {
    spawnCalls.push({ command, args, cwd: options && options.cwd });
    if (command === "npm") {
      return { status: null, error: Object.assign(new Error("spawnSync npm ENOENT"), { code: "ENOENT" }) };
    }
    if (command === "/bin/zsh" && args[0] === "-lc" && args[1] === "npm install --omit=dev") {
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected command" };
  };
  try {
    installEmbeddingRuntimeDependencies(pluginDir);
  } finally {
    childProcess.spawnSync = originalSpawnSync;
  }

  assert.deepStrictEqual(spawnCalls, [
    { command: "/bin/zsh", args: ["-lc", "npm install --omit=dev"], cwd: pluginDir },
  ]);

  console.log("Embedding runtime auto-install test passed");
})().catch((err) => {
  console.error("Embedding runtime auto-install test FAILED:", err);
  process.exit(1);
});
