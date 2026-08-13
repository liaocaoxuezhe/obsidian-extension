const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const esbuild = require("../node_modules/esbuild");

const sourcePath = path.join(
  __dirname,
  "../src/local-vector/embedding.ts"
);

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function loadEmbeddingModule(fakeTransformers) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const compiled = esbuild.transformSync(source, {
    loader: "ts",
    format: "cjs",
    target: "es2020",
  }).code;
  const module = { exports: {} };
  const sandboxRequire = (id) => {
    if (id === "module") {
      return {
        createRequire: () => (requested) => {
          if (requested === "@huggingface/transformers") return fakeTransformers;
          return require(requested);
        },
      };
    }
    return require(id);
  };
  vm.runInNewContext(compiled, {
    Buffer,
    Headers,
    Request,
    Response,
    URL,
    clearTimeout,
    console,
    module,
    exports: module.exports,
    require: sandboxRequire,
    setTimeout,
  });
  return module.exports;
}

async function testResetWaitsForActiveInferenceWithoutDisposing() {
  const inference = createDeferred();
  let disposeCount = 0;
  let pipelineCalls = 0;

  const activeEmbedder = async () => ({
    data: await inference.promise,
  });
  activeEmbedder.dispose = async () => {
    disposeCount++;
  };

  const replacementEmbedder = async () => ({
    data: new Float32Array([3, 4]),
  });
  replacementEmbedder.dispose = async () => {};

  const fakeTransformers = {
    env: {},
    pipeline: async () => {
      pipelineCalls++;
      return replacementEmbedder;
    },
  };
  const { LocalEmbeddingService, EMBEDDING_MODELS } = loadEmbeddingModule(fakeTransformers);
  const service = new LocalEmbeddingService({
    cacheDir: "cache",
    pluginDir: __dirname,
    modelConfig: EMBEDDING_MODELS["bge-small-en-v1.5"],
  });
  service.embedder = activeEmbedder;
  service.ready = true;

  const embedPromise = service.embed("hello");
  const resetPromise = service.resetSession();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.strictEqual(
    disposeCount,
    0,
    "resetSession must not dispose the current session while inference is still running"
  );

  inference.resolve(new Float32Array([1, 2]));
  assert.deepStrictEqual(Array.from(await embedPromise), [1, 2]);
  await resetPromise;
  assert.strictEqual(
    disposeCount,
    0,
    "resetSession must not dispose Transformers sessions because the library can reuse disposed cached sessions"
  );
  assert.strictEqual(
    pipelineCalls,
    0,
    "resetSession must not reload the pipeline during indexing"
  );
  assert.deepStrictEqual(Array.from(await service.embed("again")), [1, 2]);
}

async function testDisposedBatchDoesNotFallbackThroughDisposedSession() {
  let callCount = 0;
  const disposedEmbedder = async () => {
    callCount++;
    throw new Error("Session already disposed.");
  };
  disposedEmbedder.dispose = async () => {};

  const fakeTransformers = {
    env: {},
    pipeline: async () => disposedEmbedder,
  };
  const { LocalEmbeddingService, EMBEDDING_MODELS } = loadEmbeddingModule(fakeTransformers);
  const service = new LocalEmbeddingService({
    cacheDir: "cache",
    pluginDir: __dirname,
    modelConfig: EMBEDDING_MODELS["bge-small-en-v1.5"],
  });
  service.embedder = disposedEmbedder;
  service.ready = true;

  await assert.rejects(
    () => service.embedBatch(["one", "two", "three"]),
    /Session already disposed/
  );
  assert.strictEqual(
    callCount,
    1,
    "disposed sessions should be reset by the caller instead of falling back once per text"
  );
}

Promise.resolve()
  .then(testResetWaitsForActiveInferenceWithoutDisposing)
  .then(testDisposedBatchDoesNotFallbackThroughDisposedSession)
  .then(() => {
    console.log("embedding-session-lifecycle.test.js passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
