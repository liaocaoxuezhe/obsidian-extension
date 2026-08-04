const assert = require("assert");
const fs = require("fs");
const os = require("os");
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
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    module,
    module.exports,
    require,
  );
  return module.exports;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readState(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function makeClient(EmbeddingWorkerClient, root, env = {}, overrides = {}) {
  const workerBundleSource = fs.readFileSync(
    path.join(__dirname, "fixtures", "embedding-worker-fixture.cjs"),
    "utf8",
  );
  const moduleRoot = path.join(root, "managed-modules");
  fs.mkdirSync(moduleRoot, { recursive: true });
  fs.writeFileSync(path.join(moduleRoot, "package.json"), "{\"private\":true}\n", "utf8");
  return new EmbeddingWorkerClient({
    pluginDir: root,
    buildId: "1.1.6+worker-test.1",
    workerBundleSource,
    execPath: process.execPath,
    moduleRoot,
    // The full suite runs several esbuild/Chrome harnesses in parallel. Keep
    // the normal worker deadline above that scheduler contention; the explicit
    // timeout scenario below still overrides this with 40 ms.
    timeoutMs: 10_000,
    terminationGraceMs: 50,
    maxMessageBytes: 1024,
    env,
    ...overrides,
  });
}

async function expectRejected(promise, messagePattern) {
  let caught = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert(caught, "expected promise to reject");
  assert.match(caught.message, messagePattern);
}

(async () => {
  const { EmbeddingWorkerClient } = await loadModule("embedding-worker-client.ts");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-worker-lifecycle-"));
  const clients = [];

  try {
    const concurrencyDir = path.join(tmpDir, "concurrency");
    const concurrencyState = path.join(tmpDir, "concurrency-state.json");
    const concurrentClient = makeClient(
      EmbeddingWorkerClient,
      concurrencyDir,
      {
        ANALOGY_TEST_DELAY_MS: "80",
        ANALOGY_TEST_STATE_FILE: concurrencyState,
      },
    );
    clients.push(concurrentClient);
    await concurrentClient.initialize("test/model", "q8", path.join(tmpDir, "cache"));
    const first = concurrentClient.embed(["one"]);
    await wait(10);
    const second = concurrentClient.embed(["two"]);
    const third = concurrentClient.embed(["three"]);
    await Promise.all([first, second, third]);
    assert.strictEqual(
      readState(concurrencyState).maxActive,
      1,
      "client must serialize embedding requests",
    );
    await concurrentClient.dispose();
    await wait(30);
    assert.strictEqual(
      concurrentClient.getExitCount(),
      0,
      "expected dispose must not count as a worker crash",
    );

    const malformedDir = path.join(tmpDir, "malformed");
    const malformedClient = makeClient(
      EmbeddingWorkerClient,
      malformedDir,
      { ANALOGY_TEST_WORKER_MODE: "malformed" },
    );
    clients.push(malformedClient);
    await malformedClient.initialize("test/model", "q8", path.join(tmpDir, "cache"));
    await expectRejected(
      malformedClient.embed(["one", "two"]),
      /dimension/i,
    );
    await malformedClient.dispose();

    const requestLimitDir = path.join(tmpDir, "request-limit");
    const requestLimitClient = makeClient(
      EmbeddingWorkerClient,
      requestLimitDir,
      {},
      { maxMessageBytes: 256 },
    );
    clients.push(requestLimitClient);
    await requestLimitClient.initialize("m", "q8", "c");
    await expectRejected(
      requestLimitClient.embed(["x".repeat(1024)]),
      /too large/i,
    );
    await requestLimitClient.dispose();

    const outputLimitDir = path.join(tmpDir, "output-limit");
    const outputLimitClient = makeClient(
      EmbeddingWorkerClient,
      outputLimitDir,
      { ANALOGY_TEST_WORKER_MODE: "oversized" },
      { maxMessageBytes: 512 },
    );
    clients.push(outputLimitClient);
    await outputLimitClient.initialize("m", "q8", "c");
    await expectRejected(
      outputLimitClient.embed(["x"]),
      /too large/i,
    );
    await outputLimitClient.dispose();

    const timeoutDir = path.join(tmpDir, "timeout");
    const timeoutState = path.join(tmpDir, "timeout-state.json");
    const unexpectedExits = [];
    const timeoutClient = makeClient(
      EmbeddingWorkerClient,
      timeoutDir,
      {
        ANALOGY_TEST_WORKER_MODE: "hang",
        ANALOGY_TEST_IGNORE_SIGTERM: "1",
        ANALOGY_TEST_STATE_FILE: timeoutState,
      },
      {
        timeoutMs: 5_000,
        terminationGraceMs: 40,
        onUnexpectedExit: (info) => unexpectedExits.push(info),
      },
    );
    clients.push(timeoutClient);
    await timeoutClient.initialize("test/model", "q8", path.join(tmpDir, "cache"));
    const timeoutPid = readState(timeoutState).pid;
    try {
      await expectRejected(timeoutClient.embed(["hang"]), /timed out/i);
      await wait(120);
      assert.strictEqual(
        isProcessAlive(timeoutPid),
        false,
        "worker that ignores SIGTERM must be killed after the grace period",
      );
      assert.strictEqual(timeoutClient.isRunning(), false);
      assert.strictEqual(
        unexpectedExits.length,
        1,
        "timed out worker exit must be reported once",
      );
    } finally {
      if (isProcessAlive(timeoutPid)) {
        process.kill(timeoutPid, "SIGKILL");
      }
    }
  } finally {
    await Promise.allSettled(clients.map((client) => client.dispose()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("Embedding worker lifecycle tests passed");
})();
