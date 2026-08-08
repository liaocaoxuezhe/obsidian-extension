const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const esbuild = require("esbuild");

async function loadEmbeddingService() {
  const source = path.join(__dirname, "..", "src", "local-vector", "embedding-service.ts");
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    plugins: [
      {
        name: "embedding-service-test-doubles",
        setup(build) {
          build.onResolve({ filter: /^\.\/embedding$/ }, () => ({
            path: "embedding-double",
            namespace: "test-double",
          }));
          build.onResolve({ filter: /^\.\/embedding-worker-client$/ }, () => ({
            path: "worker-double",
            namespace: "test-double",
          }));
          build.onLoad({ filter: /.*/, namespace: "test-double" }, (args) => {
            if (args.path === "embedding-double") {
              return {
                loader: "ts",
                contents: `
                  export class LocalEmbeddingService {
                    constructor() {
                      globalThis.__embeddingSafetyState.inProcessConstructed += 1;
                    }
                    async initialize() {
                      globalThis.__embeddingSafetyState.inProcessInitialized += 1;
                    }
                    isReady() { return true; }
                    getInferenceCount() { return 0; }
                    async resetSession() {}
                    async embedBatch(texts) {
                      globalThis.__embeddingSafetyState.inProcessEmbedded += 1;
                      return texts.map(() => [99]);
                    }
                  }
                `,
              };
            }
            return {
              loader: "ts",
              contents: `
                export class EmbeddingWorkerClient {
                  constructor(options) {
                    this.options = options;
                    globalThis.__embeddingSafetyState.workerOptions = options;
                    globalThis.__embeddingSafetyState.workerConstructed += 1;
                  }
                  async initialize() {
                    globalThis.__embeddingSafetyState.workerInitializeArgs = [...arguments];
                    globalThis.__embeddingSafetyState.workerInitialized += 1;
                    if (globalThis.__embeddingSafetyState.workerInitError) {
                      throw new Error(globalThis.__embeddingSafetyState.workerInitError);
                    }
                  }
                  async embed(texts) {
                    globalThis.__embeddingSafetyState.workerEmbedded += 1;
                    if (globalThis.__embeddingSafetyState.workerEmbedError) {
                      throw new Error(globalThis.__embeddingSafetyState.workerEmbedError);
                    }
                    return texts.map(() => [1, 2]);
                  }
                  async dispose() { globalThis.__embeddingSafetyState.workerDisposed += 1; }
                  async health() { return { rss: 1, heapUsed: 1, external: 1 }; }
                }
              `,
            };
          });
        },
      },
    ],
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    module,
    module.exports,
    require,
  );
  return module.exports;
}

function resetState() {
  globalThis.__embeddingSafetyState = {
    inProcessConstructed: 0,
    inProcessInitialized: 0,
    inProcessEmbedded: 0,
    workerConstructed: 0,
    workerInitialized: 0,
    workerEmbedded: 0,
    workerDisposed: 0,
    workerInitError: "",
    workerEmbedError: "",
    workerOptions: null,
  };
}

function makeOptions(pluginDir, overrides = {}) {
  const managedRoot = path.join(pluginDir, "managed", "embedding", "runtime-id");
  return {
    pluginDir,
    cacheDir: path.join(pluginDir, "cache"),
    remoteHost: "https://example.invalid/",
    modelConfig: {
      id: "test/model",
      shortName: "test-model",
      dtype: "q8",
      pooling: "mean",
      maxInputChars: 1000,
      queryPrefix: "",
      documentPrefix: "",
    },
    pluginVersion: "1.1.6",
    buildId: "1.1.6+test.1",
    workerBundleSource: "",
    managedRuntime: {
      runtimeId: "embedding-runtime-node22-v1-darwin-arm64",
      root: managedRoot,
      nodeExecutable: process.execPath,
      moduleRoot: path.join(managedRoot, "node_modules"),
      versions: { node: "22.23.2", transformers: "4.2.0", onnxruntime: "1.26.0" },
    },
    ...overrides,
  };
}

async function expectServiceError(promise, expectedCode) {
  let caught = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert(caught, `expected ${expectedCode} error`);
  assert.strictEqual(caught.code, expectedCode);
}

(async () => {
  const { EmbeddingService } = await loadEmbeddingService();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-embedding-safety-"));

  try {
    resetState();
    const safeModeService = new EmbeddingService(makeOptions(tmpDir, {
      safeModeManager: { isEnabled: () => true },
    }));
    await expectServiceError(
      safeModeService.initialize(),
      "EMBEDDING_SAFE_MODE",
    );
    assert.strictEqual(
      globalThis.__embeddingSafetyState.inProcessConstructed,
      0,
      "safe mode must not construct the in-process ONNX service",
    );

    resetState();
    const missingWorkerService = new EmbeddingService(makeOptions(tmpDir, {
      safeModeManager: { isEnabled: () => false },
    }));
    await expectServiceError(
      missingWorkerService.initialize(),
      "EMBEDDING_WORKER_UNAVAILABLE",
    );
    assert.strictEqual(
      globalThis.__embeddingSafetyState.inProcessInitialized,
      0,
      "missing worker must not initialize in-process ONNX by default",
    );

    resetState();
    globalThis.__embeddingSafetyState.workerInitError = "init failed";
    const failedInitService = new EmbeddingService(makeOptions(tmpDir, {
      safeModeManager: { isEnabled: () => false },
      workerBundleSource: "// worker fixture\n",
    }));
    await expectServiceError(
      failedInitService.initialize(),
      "EMBEDDING_WORKER_FAILED",
    );
    assert.strictEqual(
      globalThis.__embeddingSafetyState.inProcessInitialized,
      0,
      "worker initialization failure must not initialize in-process ONNX",
    );
    assert.strictEqual(
      globalThis.__embeddingSafetyState.workerDisposed,
      1,
      "a worker that returns an initialization error must be terminated before retry",
    );

    resetState();
    globalThis.__embeddingSafetyState.workerEmbedError = "embed failed";
    let recordedWorkerExits = 0;
    let safeModeEnabled = false;
    let safeModeEnteredCallbacks = 0;
    const failedEmbedService = new EmbeddingService(makeOptions(tmpDir, {
      safeModeManager: {
        isEnabled: () => safeModeEnabled,
        recordWorkerExit: () => {
          recordedWorkerExits += 1;
          safeModeEnabled = true;
        },
      },
      onSafeModeEntered: () => {
        safeModeEnteredCallbacks += 1;
      },
      workerBundleSource: "// worker fixture\n",
    }));
    await failedEmbedService.initialize();
    assert.strictEqual(
      globalThis.__embeddingSafetyState.workerInitializeArgs[2],
      "mean",
      "embedding service must forward the configured pooling strategy to the worker client",
    );
    await expectServiceError(
      failedEmbedService.embedBatch(["hello"]),
      "EMBEDDING_WORKER_FAILED",
    );
    assert.strictEqual(
      globalThis.__embeddingSafetyState.inProcessEmbedded,
      0,
      "worker inference failure must not retry the request in-process",
    );
    assert.strictEqual(
      recordedWorkerExits,
      0,
      "a logical inference error is not itself a worker process exit",
    );
    assert.strictEqual(
      typeof globalThis.__embeddingSafetyState.workerOptions.onUnexpectedExit,
      "function",
      "embedding service must subscribe to actual unexpected worker exits",
    );
    globalThis.__embeddingSafetyState.workerOptions.onUnexpectedExit({
      code: 1,
      signal: null,
      lastTaskType: "embed",
      modelId: "test/model",
      uptimeMs: 10,
      stderrTail: "",
    });
    assert.strictEqual(
      recordedWorkerExits,
      1,
      "an actual unexpected worker exit is recorded once",
    );
    assert.strictEqual(
      safeModeEnteredCallbacks,
      1,
      "entering safe mode after a worker exit must notify the plugin",
    );
    assert.strictEqual(
      failedEmbedService.getInitializationState(),
      "idle",
      "an unexpected worker exit must leave initialization retryable instead of reporting ready",
    );

    resetState();
    const developmentFallbackService = new EmbeddingService(makeOptions(tmpDir, {
      allowInProcessFallback: true,
      safeModeManager: { isEnabled: () => false },
    }));
    await developmentFallbackService.initialize();
    assert.strictEqual(
      globalThis.__embeddingSafetyState.inProcessInitialized,
      1,
      "explicit development fallback may initialize in-process ONNX",
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete globalThis.__embeddingSafetyState;
  }

  console.log("Embedding service safety tests passed");
})();
