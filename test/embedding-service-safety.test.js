const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");

async function loadEmbeddingService() {
  const entry = path.join(
    __dirname,
    "..",
    "src",
    "local-vector",
    "embedding-service.ts",
  );
  const result = await esbuild.build({
    entryPoints: [entry],
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
          build.onResolve(
            { filter: /^\.\/embedding-worker-client$/ },
            () => ({
              path: "worker-double",
              namespace: "test-double",
            }),
          );
          build.onLoad(
            { filter: /.*/, namespace: "test-double" },
            (args) => {
              if (args.path === "embedding-double") {
                return {
                  loader: "ts",
                  contents: `
                    export class LocalEmbeddingService {
                      async initialize() {
                        globalThis.__embeddingServiceState.inProcessInitialized += 1;
                      }
                      isReady() { return true; }
                      getInferenceCount() { return 0; }
                      async resetSession() {}
                      async embedBatch(texts) {
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
                      globalThis.__embeddingServiceState.workerOptions = options;
                      globalThis.__embeddingServiceState.workerConstructed += 1;
                    }
                    async initialize() {
                      globalThis.__embeddingServiceState.workerInitialized += 1;
                    }
                    async embed(texts) {
                      return texts.map(() => [1, 2]);
                    }
                    async dispose() {}
                    async health() {
                      return { rss: 1, heapUsed: 1, external: 1 };
                    }
                  }
                `,
              };
            },
          );
        },
      },
    ],
  });
  const loadedModule = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    loadedModule,
    loadedModule.exports,
    require,
  );
  return loadedModule.exports;
}

function resetState() {
  globalThis.__embeddingServiceState = {
    inProcessInitialized: 0,
    workerConstructed: 0,
    workerInitialized: 0,
    workerOptions: null,
  };
}

function makeOptions(workerBundleSource, overrides = {}) {
  return {
    pluginDir: "/tmp/analogy-plugin",
    cacheDir: "/tmp/analogy-cache",
    remoteHost: "https://example.invalid/",
    modelConfig: {
      id: "test/model",
      shortName: "test-model",
      dtype: "q8",
      maxInputChars: 1_000,
      queryPrefix: "",
      documentPrefix: "",
    },
    pluginVersion: "1.1.8",
    buildId: "1.1.8+service-test",
    workerBundleSource,
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
  assert(caught, `expected ${expectedCode}`);
  assert.strictEqual(caught.code, expectedCode);
}

(async () => {
  const { EmbeddingService } = await loadEmbeddingService();
  const workerSource = "'use strict';\nprocess.stdin.resume();\n";

  try {
    resetState();
    const missingWorkerService = new EmbeddingService(makeOptions(""));
    await expectServiceError(
      missingWorkerService.initialize(),
      "EMBEDDING_WORKER_UNAVAILABLE",
    );
    assert.strictEqual(globalThis.__embeddingServiceState.workerConstructed, 0);
    assert.strictEqual(
      globalThis.__embeddingServiceState.inProcessInitialized,
      0,
      "missing embedded source must not enable in-process fallback",
    );

    resetState();
    const embeddedWorkerService = new EmbeddingService(
      makeOptions(workerSource),
    );
    await embeddedWorkerService.initialize();
    assert.strictEqual(globalThis.__embeddingServiceState.workerConstructed, 1);
    assert.strictEqual(globalThis.__embeddingServiceState.workerInitialized, 1);
    assert.strictEqual(
      globalThis.__embeddingServiceState.workerOptions.workerBundleSource,
      workerSource,
      "the service must pass the exact embedded source to the worker client",
    );

    resetState();
    const explicitFallbackService = new EmbeddingService(
      makeOptions("", { allowInProcessFallback: true }),
    );
    await explicitFallbackService.initialize();
    assert.strictEqual(globalThis.__embeddingServiceState.inProcessInitialized, 1);
  } finally {
    delete globalThis.__embeddingServiceState;
  }

  console.log("Embedding service safety test passed");
})();
