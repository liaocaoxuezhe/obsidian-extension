"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const esbuild = require("esbuild");

const extensionRoot = path.join(__dirname, "..");

async function loadModule(relativePath, plugins = []) {
  const result = await esbuild.build({
    entryPoints: [path.join(extensionRoot, relativePath)],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    write: false,
    logLevel: "silent",
    plugins,
  });
  const module = { exports: {} };
  Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error("condition timed out"));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function workerFixtureSource() {
  return `
    "use strict";
    const fs = require("node:fs");
    const readline = require("node:readline");
    const stateFile = process.env.ANALOGY_TEST_STATE_FILE;
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { starts: 0 };
    state.starts += 1;
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    readline.createInterface({ input: process.stdin }).on("line", (line) => {
      const req = JSON.parse(line);
      if (req.type === "initialize") {
        fs.mkdirSync(req.cacheDir, { recursive: true });
        fs.writeFileSync(require("node:path").join(req.cacheDir, "reusable.partial"), "partial model cache");
        send({ id: req.id, type: "progress", progress: { phase: "downloading", file: "/private/cache/model.onnx?token=secret", loadedBytes: 5, totalBytes: 10, percent: 50, input: "private model input" } });
        if (state.starts === 1 && process.env.ANALOGY_TEST_HANG_FIRST === "1") return;
        setTimeout(() => {
          send({ id: req.id, ok: true });
          setTimeout(() => send({ id: req.id, type: "progress", progress: { phase: "ready", file: null, loadedBytes: null, totalBytes: null, percent: 100 } }), 10);
        }, 20);
      } else if (req.type === "health") {
        send({ id: req.id, ok: true, memoryUsage: { rss: 1, heapUsed: 1, external: 1 } });
      } else if (req.type === "embed") {
        send({ id: req.id, ok: true, embeddings: req.texts.map(() => [0.25, 0.75]) });
      } else if (req.type === "dispose") {
        send({ id: req.id, ok: true });
        process.exit(0);
      }
    });
  `;
}

test("Transformers progress is normalized and strips paths, queries, and tokens", async () => {
  const { normalizeEmbeddingInitializationProgress } = await loadModule("src/local-vector/embedding.ts");
  assert.deepEqual(
    normalizeEmbeddingInitializationProgress({
      status: "progress",
      file: "/Users/测试/cache/model.onnx?token=secret#fragment",
      loaded: 25,
      total: 100,
    }),
    {
      phase: "downloading",
      file: "model.onnx",
      loadedBytes: 25,
      totalBytes: 100,
      percent: 25,
    },
  );
  assert.deepEqual(
    normalizeEmbeddingInitializationProgress({ status: "ready", file: "C:\\模型\\config.json" }),
    {
      phase: "ready",
      file: "config.json",
      loadedBytes: null,
      totalBytes: null,
      percent: 100,
    },
  );
  const serialized = JSON.stringify(normalizeEmbeddingInitializationProgress({
    status: "progress",
    url: "https://host/model?token=secret",
    cachePath: "/private/cache/secret",
    file: "https://host/model/weights.onnx?token=secret",
    loaded: 1,
    total: 0,
    input: "private model input",
  }));
  assert.equal(serialized.includes("token"), false);
  assert.equal(serialized.includes("private"), false);
  assert.equal(serialized.includes("model input"), false);
});

test("worker progress messages keep the initialize request id and preserve optional modelRevision", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-progress-worker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const moduleRoot = path.join(root, "modules");
  const transformersRoot = path.join(moduleRoot, "@huggingface", "transformers");
  const onnxRoot = path.join(moduleRoot, "onnxruntime-node");
  fs.mkdirSync(transformersRoot, { recursive: true });
  fs.mkdirSync(onnxRoot, { recursive: true });
  fs.writeFileSync(path.join(moduleRoot, "package.json"), "{\"private\":true}\n");
  fs.writeFileSync(path.join(onnxRoot, "package.json"), "{\"name\":\"onnxruntime-node\",\"main\":\"index.js\"}\n");
  fs.writeFileSync(path.join(onnxRoot, "index.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(transformersRoot, "package.json"), "{\"name\":\"@huggingface/transformers\",\"main\":\"index.js\"}\n");
  fs.writeFileSync(path.join(transformersRoot, "index.js"), `
    exports.env = {};
    exports.pipeline = async (_task, _model, options) => {
      require("node:fs").writeFileSync(process.env.ANALOGY_TEST_OPTIONS, JSON.stringify(options));
      options.progress_callback({ status: "progress", file: "/private/cache/weights.onnx?token=secret", loaded: 4, total: 8 });
      const extractor = async (texts) => ({ data: new Float32Array(texts.length * 2).fill(0.5), dims: [texts.length, 2] });
      extractor.dispose = async () => {};
      return extractor;
    };
  `);
  const workerPath = path.join(root, "worker.cjs");
  await esbuild.build({
    entryPoints: [path.join(extensionRoot, "src", "local-vector", "embedding-worker.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    external: ["@huggingface/transformers", "onnxruntime-node"],
    outfile: workerPath,
    logLevel: "silent",
  });
  const child = require("node:child_process").spawn(process.execPath, [workerPath], {
    env: {
      ...process.env,
      ANALOGY_RUNTIME_MODULE_ROOT: moduleRoot,
      ANALOGY_TEST_OPTIONS: path.join(root, "options.json"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  const messages = [];
  let stderr = "";
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) if (line.trim()) messages.push(JSON.parse(line));
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({
    id: "init-中文",
    type: "initialize",
    modelId: "fixture/model",
    modelRevision: "fixed-revision",
    dtype: "q8",
    cacheDir: path.join(root, "cache"),
  })}\n`);
  try {
    await waitFor(() => messages.some((message) => message.id === "init-中文" && message.ok === true));
  } catch (error) {
    throw new Error(`${error.message}; worker stderr: ${stderr}`);
  }
  const terminalIndex = messages.findIndex((message) => message.id === "init-中文" && message.ok === true);
  const progressIndex = messages.findIndex((message) => message.id === "init-中文" && message.type === "progress");
  assert.ok(progressIndex >= 0 && progressIndex < terminalIndex, "progress must stream before initialize completes");
  assert.deepEqual(messages[progressIndex].progress, {
    phase: "downloading",
    file: "weights.onnx",
    loadedBytes: 4,
    totalBytes: 8,
    percent: 50,
  });
  const options = JSON.parse(fs.readFileSync(path.join(root, "options.json"), "utf8"));
  assert.equal(options.revision, "fixed-revision");
});

test("client uses managed spawn settings, ignores late progress, and can retry after cancellation", async (t) => {
  const { EmbeddingWorkerClient, createWorkerSpawnConfiguration } = await loadModule(
    "src/local-vector/embedding-worker-client.ts",
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-client-progress-中文-"));
  const moduleRoot = path.join(root, "managed modules");
  const workerDir = path.join(root, "managed worker");
  const stateFile = path.join(root, "state.json");
  fs.mkdirSync(moduleRoot, { recursive: true });
  fs.writeFileSync(path.join(moduleRoot, "package.json"), "{\"private\":true}\n");

  const spawnConfiguration = createWorkerSpawnConfiguration({
    execPath: process.execPath,
    workerPath: path.join(workerDir, "worker.cjs"),
    moduleRoot,
    cwd: root,
    env: {
      ...process.env,
      NODE_PATH: "/untrusted/vault/node_modules",
      npm_node_execpath: "/untrusted/npm/node",
      ANALOGY_NODE_PATH: "/untrusted/developer/node",
    },
  });
  assert.equal(spawnConfiguration.executable, process.execPath);
  assert.equal(spawnConfiguration.options.shell, false);
  assert.equal(spawnConfiguration.options.env.ANALOGY_RUNTIME_MODULE_ROOT, moduleRoot);
  assert.equal(Object.hasOwn(spawnConfiguration.options.env, "NODE_PATH"), false);
  assert.equal(Object.hasOwn(spawnConfiguration.options.env, "npm_node_execpath"), false);
  assert.equal(Object.hasOwn(spawnConfiguration.options.env, "ANALOGY_NODE_PATH"), false);

  const progress = [];
  const client = new EmbeddingWorkerClient({
    pluginDir: root,
    workerDir,
    buildId: "task7-test",
    workerBundleSource: workerFixtureSource(),
    execPath: process.execPath,
    moduleRoot,
    env: {
      ANALOGY_TEST_STATE_FILE: stateFile,
      ANALOGY_TEST_HANG_FIRST: "1",
    },
    timeoutMs: 5_000,
    terminationGraceMs: 50,
  });
  t.after(async () => {
    await client.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const first = client.initialize("fixture/model", "q8", "mean", path.join(root, "cache"), undefined, "rev-1", (event) => {
    progress.push(event);
  });
  const firstRejected = assert.rejects(first, /EMBEDDING_INITIALIZATION_CANCELLED/);
  await waitFor(() => progress.length === 1);
  await client.cancelInitialization();
  await firstRejected;
  assert.equal(client.isRunning(), false);
  assert.equal(
    fs.readFileSync(path.join(root, "cache", "reusable.partial"), "utf8"),
    "partial model cache",
    "cancellation must leave reusable model cache files intact",
  );

  const retryProgress = [];
  await client.initialize("fixture/model", "q8", "mean", path.join(root, "cache"), undefined, undefined, (event) => {
    retryProgress.push(event);
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(retryProgress.length, 1, "progress arriving after the terminal response must be ignored");
  assert.deepEqual(retryProgress[0], {
    phase: "downloading",
    file: "model.onnx",
    loadedBytes: 5,
    totalBytes: 10,
    percent: 50,
  });
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).starts, 2);
});

function materializationClient(
  EmbeddingWorkerClient,
  root,
  workerDir,
  source = 'process.stdout.write("worker");\n',
  overrides = {},
) {
  const moduleRoot = path.join(root, "modules");
  fs.mkdirSync(moduleRoot, { recursive: true });
  if (!fs.existsSync(path.join(moduleRoot, "package.json"))) {
    fs.writeFileSync(path.join(moduleRoot, "package.json"), "{\"private\":true}\n");
  }
  return new EmbeddingWorkerClient({
    pluginDir: root,
    workerRoot: path.join(root, "managed-runtime"),
    workerDir,
    buildId: "task7-secure-materialization",
    workerBundleSource: source,
    execPath: process.execPath,
    moduleRoot,
    ...overrides,
  });
}

test("worker materialization rejects a worker directory symlink escaping the managed root", async (t) => {
  const { EmbeddingWorkerClient } = await loadModule("src/local-vector/embedding-worker-client.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-worker-dir-symlink-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const managedRoot = path.join(root, "managed-runtime");
  const outside = path.join(root, "outside");
  const workerDir = path.join(managedRoot, "worker");
  fs.mkdirSync(managedRoot, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, workerDir, process.platform === "win32" ? "junction" : "dir");

  const client = materializationClient(EmbeddingWorkerClient, root, workerDir);
  await assert.rejects(client.ensureMaterialized(), /managed worker|symlink|unsafe/i);
  assert.deepEqual(fs.readdirSync(outside), [], "no worker bytes may be written through the symlink");
});

test("worker materialization rejects target symlinks and immutable target tampering", async (t) => {
  const { EmbeddingWorkerClient } = await loadModule("src/local-vector/embedding-worker-client.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-worker-target-symlink-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const managedRoot = path.join(root, "managed-runtime");
  const workerDir = path.join(managedRoot, "worker");
  fs.mkdirSync(workerDir, { recursive: true });
  const source = 'process.stdout.write("worker");\n';
  const digest = require("node:crypto").createHash("sha256").update(source).digest("hex");
  const target = path.join(workerDir, `embedding-worker-task7-secure-materialization-${digest.slice(0, 12)}.cjs`);
  const outsideTarget = path.join(root, "outside-worker.cjs");
  fs.writeFileSync(outsideTarget, source);
  fs.symlinkSync(outsideTarget, target, "file");
  const client = materializationClient(EmbeddingWorkerClient, root, workerDir, source);

  await assert.rejects(client.ensureMaterialized(), /managed worker|symlink|unsafe/i);
  assert.equal(fs.readFileSync(outsideTarget, "utf8"), source);
  fs.unlinkSync(target);
  const materialized = await client.ensureMaterialized();
  fs.writeFileSync(materialized, "tampered");
  await assert.rejects(client.ensureMaterialized(), /hash|tamper|immutable/i);
});

test("concurrent worker materialization converges on one private regular content-addressed file", async (t) => {
  const { EmbeddingWorkerClient } = await loadModule("src/local-vector/embedding-worker-client.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-worker-concurrent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workerDir = path.join(root, "managed-runtime", "worker");
  fs.mkdirSync(workerDir, { recursive: true, mode: 0o755 });
  fs.chmodSync(workerDir, 0o755);
  const first = materializationClient(EmbeddingWorkerClient, root, workerDir);
  const second = materializationClient(EmbeddingWorkerClient, root, workerDir);

  const [firstPath, secondPath] = await Promise.all([
    first.ensureMaterialized(),
    second.ensureMaterialized(),
  ]);
  assert.equal(firstPath, secondPath);
  assert.equal(fs.lstatSync(firstPath).isFile(), true);
  assert.equal(fs.realpathSync(firstPath).startsWith(`${fs.realpathSync(path.join(root, "managed-runtime"))}${path.sep}`), true);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(workerDir).mode & 0o077, 0, "worker directory must be private");
    assert.equal(fs.statSync(firstPath).mode & 0o077, 0, "worker bundle must be private");
  }
});

test("worker client runs the managed runtime snapshot guard before probing or spawning", async (t) => {
  const { EmbeddingWorkerClient } = await loadModule("src/local-vector/embedding-worker-client.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-worker-spawn-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const managedRoot = path.join(root, "managed-runtime");
  const workerDir = path.join(managedRoot, "worker");
  const marker = path.join(root, "worker-executed");
  fs.mkdirSync(managedRoot, { recursive: true });
  const client = materializationClient(
    EmbeddingWorkerClient,
    root,
    workerDir,
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`,
    {
      spawnGuard: async () => {
        throw new Error("managed runtime snapshot stale");
      },
    },
  );

  await assert.rejects(client.health(), /managed runtime snapshot stale/);
  assert.equal(fs.existsSync(marker), false, "the worker process must not exist before snapshot revalidation passes");
});

test("worker client rejects configured paths that differ from the revalidated runtime snapshot", async (t) => {
  const { EmbeddingWorkerClient } = await loadModule("src/local-vector/embedding-worker-client.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-worker-guard-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const managedRoot = path.join(root, "managed-runtime");
  const workerDir = path.join(managedRoot, "worker");
  const marker = path.join(root, "worker-executed");
  const moduleRoot = path.join(root, "modules");
  fs.mkdirSync(managedRoot, { recursive: true });
  const client = materializationClient(
    EmbeddingWorkerClient,
    root,
    workerDir,
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`,
    {
      spawnGuard: async () => ({
        nodeExecutable: path.join(root, "different-managed-node"),
        moduleRoot,
        verification: {
          assetId: "fixture",
          assetSha256: "a".repeat(64),
          internalManifestPath: path.join(root, "manifest.json"),
          internalManifestSha256: "b".repeat(64),
        },
      }),
    },
  );

  await assert.rejects(client.health(), /snapshot.*path|path.*snapshot/i);
  assert.equal(fs.existsSync(marker), false);
});

test("worker client revalidates the content-addressed worker after an async spawn guard", async (t) => {
  const { EmbeddingWorkerClient } = await loadModule("src/local-vector/embedding-worker-client.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-worker-guard-swap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const managedRoot = path.join(root, "managed-runtime");
  const workerDir = path.join(managedRoot, "worker");
  const moduleRoot = path.join(root, "modules");
  const marker = path.join(root, "malicious-worker-executed");
  fs.mkdirSync(managedRoot, { recursive: true });
  const workerProtocol = (topLevel) => `
    "use strict";
    ${topLevel}
    const readline = require("node:readline");
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    readline.createInterface({ input: process.stdin }).on("line", (line) => {
      const req = JSON.parse(line);
      if (req.type === "health") send({ id: req.id, ok: true, memoryUsage: { rss: 1, heapUsed: 1, external: 1 } });
      if (req.type === "dispose") { send({ id: req.id, ok: true }); process.exit(0); }
    });
  `;
  const expectedSource = workerProtocol("");
  const maliciousSource = workerProtocol(
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");`,
  );
  let announceGuardStarted;
  const guardStarted = new Promise((resolve) => { announceGuardStarted = resolve; });
  let releaseGuard;
  const guardRelease = new Promise((resolve) => { releaseGuard = resolve; });
  const client = materializationClient(
    EmbeddingWorkerClient,
    root,
    workerDir,
    expectedSource,
    {
      spawnGuard: async () => {
        announceGuardStarted();
        await guardRelease;
        return {
          nodeExecutable: process.execPath,
          moduleRoot,
          verification: {
            assetId: "fixture",
            assetSha256: "a".repeat(64),
            internalManifestPath: path.join(root, "manifest.json"),
            internalManifestSha256: "b".repeat(64),
          },
        };
      },
    },
  );
  t.after(() => client.dispose());
  const health = client.health();
  await guardStarted;
  const digest = require("node:crypto").createHash("sha256").update(expectedSource).digest("hex");
  const target = path.join(
    workerDir,
    `embedding-worker-task7-secure-materialization-${digest.slice(0, 12)}.cjs`,
  );
  const maliciousCandidate = path.join(workerDir, ".malicious-worker.cjs");
  fs.writeFileSync(maliciousCandidate, maliciousSource, { mode: 0o600 });
  fs.unlinkSync(target);
  fs.renameSync(maliciousCandidate, target);
  releaseGuard();

  await assert.rejects(health, /immutable content hash mismatch/i);
  assert.equal(fs.existsSync(marker), false, "a swapped worker must be rejected before its top-level code runs");
});

test("EmbeddingService returns to idle after cancellation and retries with the managed runtime and model revision", async () => {
  globalThis.__task7ServiceState = {
    workerOptions: null,
    initializeArgs: [],
    attempt: 0,
    rejectInitialization: null,
  };
  const serviceModule = await loadModule("src/local-vector/embedding-service.ts", [{
    name: "task7-service-doubles",
    setup(build) {
      build.onResolve({ filter: /^\.\/embedding$/ }, () => ({ path: "embedding", namespace: "task7" }));
      build.onResolve({ filter: /^\.\/embedding-worker-client$/ }, () => ({ path: "worker", namespace: "task7" }));
      build.onLoad({ filter: /.*/, namespace: "task7" }, (args) => {
        if (args.path === "embedding") {
          return {
            loader: "ts",
            contents: `
              export class LocalEmbeddingService {
                async initialize() {}
                isReady() { return false; }
                getInferenceCount() { return 0; }
                async resetSession() {}
                async embedBatch() { return []; }
              }
            `,
          };
        }
        return {
          loader: "ts",
          contents: `
            export class EmbeddingWorkerClient {
              constructor(options) { globalThis.__task7ServiceState.workerOptions = options; }
              initialize(...args) {
                const state = globalThis.__task7ServiceState;
                state.initializeArgs.push(args);
                state.attempt += 1;
                args[6]?.({ phase: "downloading", file: "weights.onnx", loadedBytes: 2, totalBytes: 4, percent: 50 });
                if (state.attempt > 1) return Promise.resolve();
                return new Promise((_resolve, reject) => { state.rejectInitialization = reject; });
              }
              async cancelInitialization() {
                const reject = globalThis.__task7ServiceState.rejectInitialization;
                globalThis.__task7ServiceState.rejectInitialization = null;
                reject?.(new Error("EMBEDDING_INITIALIZATION_CANCELLED"));
              }
              async embed(texts) { return texts.map(() => [1, 2]); }
              async dispose() {}
              async health() { return { rss: 1, heapUsed: 1, external: 1 }; }
            }
          `,
        };
      });
    },
  }]);
  const managedRuntime = {
    runtimeId: "embedding-runtime-node22-v1-darwin-arm64",
    root: "/managed/runtime/embedding/current",
    nodeExecutable: "/managed/runtime/embedding/current/node/bin/node",
    moduleRoot: "/managed/runtime/embedding/current/node_modules",
    versions: { node: "22.23.2", transformers: "4.2.0", onnxruntime: "1.26.0" },
  };
  const service = new serviceModule.EmbeddingService({
    pluginDir: "/vault/.obsidian/plugins/analogy",
    cacheDir: "/managed/models/cache",
    modelConfig: {
      id: "fixture/model",
      shortName: "fixture-model",
      dtype: "q8",
      pooling: "mean",
      maxInputChars: 100,
      queryPrefix: "",
    },
    modelRevision: "fixed-revision",
    buildId: "task7",
    workerBundleSource: "// embedded worker",
    managedRuntime,
  });
  const progress = [];
  const first = service.initialize((event) => progress.push(event));
  const firstRejected = assert.rejects(first, /EMBEDDING_INITIALIZATION_CANCELLED/);
  await waitFor(() => globalThis.__task7ServiceState.attempt === 1);
  assert.equal(service.getInitializationState(), "initializing");
  await service.cancelInitialization();
  await firstRejected;
  assert.equal(service.getInitializationState(), "idle");
  assert.equal(service.isReady(), false);

  await service.initialize((event) => progress.push(event));
  assert.equal(service.getInitializationState(), "ready");
  assert.equal(service.isReady(), true);
  assert.deepEqual(progress, [
    { phase: "downloading", file: "weights.onnx", loadedBytes: 2, totalBytes: 4, percent: 50 },
    { phase: "downloading", file: "weights.onnx", loadedBytes: 2, totalBytes: 4, percent: 50 },
  ]);
  const workerOptions = globalThis.__task7ServiceState.workerOptions;
  assert.equal(workerOptions.execPath, managedRuntime.nodeExecutable);
  assert.equal(workerOptions.moduleRoot, managedRuntime.moduleRoot);
  assert.equal(workerOptions.workerDir, path.normalize("/managed/runtime/worker"));
  assert.equal(workerOptions.workerRoot, path.normalize("/managed/runtime"));
  assert.equal(globalThis.__task7ServiceState.initializeArgs[1][5], "fixed-revision");
  delete globalThis.__task7ServiceState;
});

test("concurrent initialize isolates epoch clients so an old failure cannot dispose the new ready worker", async () => {
  globalThis.__task7ConcurrentState = { clients: [] };
  const serviceModule = await loadModule("src/local-vector/embedding-service.ts", [{
    name: "task7-concurrent-service-doubles",
    setup(build) {
      build.onResolve({ filter: /^\.\/embedding$/ }, () => ({ path: "embedding", namespace: "task7-concurrent" }));
      build.onResolve({ filter: /^\.\/embedding-worker-client$/ }, () => ({ path: "worker", namespace: "task7-concurrent" }));
      build.onLoad({ filter: /.*/, namespace: "task7-concurrent" }, (args) => {
        if (args.path === "embedding") {
          return {
            loader: "ts",
            contents: `
              export class LocalEmbeddingService {
                async initialize() {}
                isReady() { return false; }
                getInferenceCount() { return 0; }
                async resetSession() {}
                async embedBatch() { return []; }
              }
            `,
          };
        }
        return {
          loader: "ts",
          contents: `
            export class EmbeddingWorkerClient {
              constructor(options) {
                const clients = globalThis.__task7ConcurrentState.clients;
                this.id = clients.length + 1;
                this.disposed = 0;
                this.options = options;
                clients.push(this);
              }
              initialize(...args) {
                this.onProgress = args[6];
                return new Promise((resolve, reject) => {
                  this.resolveInitialization = resolve;
                  this.rejectInitialization = reject;
                });
              }
              async cancelInitialization() {
                this.rejectInitialization?.(new Error("EMBEDDING_INITIALIZATION_CANCELLED"));
              }
              async embed(texts) { return texts.map(() => [this.id, 0.5]); }
              async dispose() { this.disposed += 1; }
              async health() { return { rss: 1, heapUsed: 1, external: 1 }; }
            }
          `,
        };
      });
    },
  }]);
  const service = new serviceModule.EmbeddingService({
    pluginDir: "/vault/.obsidian/plugins/analogy",
    cacheDir: "/managed/models/cache",
    modelConfig: {
      id: "fixture/model",
      shortName: "fixture-model",
      dtype: "q8",
      pooling: "mean",
      maxInputChars: 100,
      queryPrefix: "",
    },
    buildId: "task7-concurrent",
    workerBundleSource: "// embedded worker",
    managedRuntime: {
      runtimeId: "embedding-runtime-node22-v1-darwin-arm64",
      root: "/managed/runtime/embedding/runtime-id",
      nodeExecutable: "/managed/runtime/embedding/runtime-id/node/bin/node",
      moduleRoot: "/managed/runtime/embedding/runtime-id/node_modules",
      versions: { node: "22.23.2", transformers: "4.2.0", onnxruntime: "1.26.0" },
    },
  });
  const progress = [];
  const first = service.initialize((event) => progress.push(["first", event.file]));
  const firstRejected = assert.rejects(first, /old initialization failed/);
  await waitFor(() => globalThis.__task7ConcurrentState.clients.length === 1);
  const second = service.initialize((event) => progress.push(["second", event.file]));
  await waitFor(() => globalThis.__task7ConcurrentState.clients.length === 2);
  const [worker1, worker2] = globalThis.__task7ConcurrentState.clients;

  worker1.onProgress({ phase: "downloading", file: "old.onnx", loadedBytes: 1, totalBytes: 2, percent: 50 });
  worker2.onProgress({ phase: "downloading", file: "new.onnx", loadedBytes: 1, totalBytes: 2, percent: 50 });
  worker1.rejectInitialization(new Error("old initialization failed"));
  await firstRejected;
  worker2.resolveInitialization();
  await second;

  assert.equal(service.getInitializationState(), "ready");
  assert.equal(service.isReady(), true);
  assert.equal(worker1.disposed, 1, "the stale epoch must dispose only its own worker");
  assert.equal(worker2.disposed, 0, "the current ready worker must remain alive");
  assert.deepEqual(progress, [["second", "new.onnx"]], "stale epoch progress must not escape");
  assert.deepEqual(await service.embedBatch(["hello"]), [[2, 0.5]]);
  await service.dispose();
  delete globalThis.__task7ConcurrentState;
});
