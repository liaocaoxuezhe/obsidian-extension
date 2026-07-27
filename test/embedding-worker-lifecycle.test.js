const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const esbuild = require("esbuild");

async function loadWorkerClient() {
  const entry = path.join(
    __dirname,
    "..",
    "src",
    "local-vector",
    "embedding-worker-client.ts",
  );
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const loadedModule = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    loadedModule,
    loadedModule.exports,
    require,
  );
  return loadedModule.exports;
}

function makeClient(EmbeddingWorkerClient, pluginDir, overrides = {}) {
  const workerBundleSource = fs.readFileSync(
    path.join(__dirname, "fixtures", "embedding-worker-fixture.cjs"),
    "utf8",
  );
  return new EmbeddingWorkerClient({
    pluginDir,
    buildId: "1.1.8+lifecycle-test",
    workerBundleSource,
    execPath: process.execPath,
    timeoutMs: 1_000,
    terminationGraceMs: 100,
    maxMessageBytes: 8_192,
    ...overrides,
  });
}

(async () => {
  const { EmbeddingWorkerClient } = await loadWorkerClient();
  const pluginDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "analogy-worker-lifecycle-"),
  );
  const client = makeClient(EmbeddingWorkerClient, pluginDir);

  try {
    await client.initialize(
      "test/model",
      "q8",
      path.join(pluginDir, "cache"),
    );
    assert.strictEqual(client.isRunning(), true);
    assert.deepStrictEqual(await client.embed(["one", "three"]), [
      [3, 1],
      [5, 1],
    ]);
    assert.deepStrictEqual(await client.health(), {
      rss: 1,
      heapUsed: 1,
      external: 1,
    });
    await client.dispose();
    assert.strictEqual(client.isRunning(), false);
    assert.strictEqual(
      client.getExitCount(),
      0,
      "a requested dispose must not count as an unexpected worker exit",
    );
  } finally {
    await client.dispose();
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }

  console.log("Embedding worker lifecycle test passed");
})();
