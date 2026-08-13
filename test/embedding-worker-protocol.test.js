const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");

async function loadModule(entry) {
  const source = path.join(__dirname, "..", "src", "local-vector", entry);
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
  const protocol = await loadModule("embedding-worker-protocol.ts");

  const init = { id: "1", type: "initialize", modelId: "Xenova/bge-small-en-v1.5", dtype: "q8", cacheDir: "/tmp/cache" };
  const encoded = protocol.encodeMessage(init);
  assert.strictEqual(encoded, JSON.stringify(init) + "\n", "encode adds newline");

  const decoded = protocol.decodeMessage(encoded);
  assert.deepStrictEqual(decoded, init, "decode round-trips");

  const okResponse = { id: "1", ok: true, embeddings: [[0.1, 0.2]] };
  const validated = protocol.validateResponse(okResponse, "1");
  assert.strictEqual(validated.ok, true, "validates ok response");
  assert.deepStrictEqual(validated.result, [[0.1, 0.2]], "returns embeddings");

  const badId = protocol.validateResponse(okResponse, "2");
  assert.strictEqual(badId.ok, false, "rejects id mismatch");

  const errResponse = { id: "1", ok: false, error: { code: "FAIL", message: "fail" } };
  const validatedErr = protocol.validateResponse(errResponse, "1");
  assert.strictEqual(validatedErr.ok, false, "rejects error response");

  // Safe mode manager test
  const fs = require("fs");
  const os = require("os");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-safe-"));
  const safeModeModule = await loadModule("safe-mode.ts");
  const manager = new safeModeModule.SafeModeManager({ pluginDir: tmpDir });
  assert.strictEqual(manager.isEnabled(), false, "safe mode off by default");

  manager.recordUncleanExit("embedding.model-load");
  manager.recordUncleanExit("embedding.inference");
  assert.strictEqual(manager.isEnabled(), true, "enters safe mode after embedding stage exits");

  manager.clearSafeMode();
  assert.strictEqual(manager.isEnabled(), false, "clears safe mode");

  const workerWindowDir = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-safe-worker-window-"));
  const workerWindowManager = new safeModeModule.SafeModeManager({ pluginDir: workerWindowDir });
  const firstExitAt = 1_000_000;
  workerWindowManager.recordWorkerExit(firstExitAt);
  workerWindowManager.recordWorkerExit(firstExitAt + 10 * 60 * 1000 + 1);
  assert.strictEqual(
    workerWindowManager.isEnabled(),
    false,
    "worker exits outside the ten-minute window must not enter safe mode",
  );
  workerWindowManager.recordWorkerExit(firstExitAt + 10 * 60 * 1000 + 2);
  assert.strictEqual(
    workerWindowManager.isEnabled(),
    true,
    "two worker exits inside the ten-minute window enter safe mode",
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(workerWindowDir, { recursive: true, force: true });

  console.log("Embedding worker protocol and safe mode tests passed");
})();
