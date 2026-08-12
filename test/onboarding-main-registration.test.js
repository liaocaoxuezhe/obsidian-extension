"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const esbuild = require("esbuild");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const extensionRoot = process.cwd();
const loaded = new Map();

function loadTypeScriptFile(filename) {
  if (loaded.has(filename)) return loaded.get(filename);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  loaded.set(filename, module.exports);
  const localRequire = (specifier) => {
    if (!specifier.startsWith(".")) return require(specifier);
    const resolved = path.resolve(path.dirname(filename), specifier);
    return fs.existsSync(`${resolved}.ts`) ? loadTypeScriptFile(`${resolved}.ts`) : require(resolved);
  };
  Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports, localRequire, module, filename, path.dirname(filename),
  );
  loaded.set(filename, module.exports);
  return module.exports;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message = "condition") {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${message}`);
}

function lease(overrides = {}) {
  return {
    ownership: "analogy",
    pid: 7301,
    executablePath: "/managed/chroma/current/chroma",
    port: 8042,
    runtimeVersion: "cli-1.4.4",
    startedAt: 101,
    ...overrides,
  };
}

function verifiedRuntimes() {
  return {
    chroma: {
      runtimeId: "chroma-cli-1.4.4-darwin-arm64",
      executablePath: "/managed/chroma/current/chroma",
      dataPath: "/device-local/vault/chroma_data_v2",
      preferredPort: 8042,
      runtimeVersion: "cli-1.4.4",
      assetSha256: "a".repeat(64),
      revalidate: async () => ({
        runtimeId: "chroma-cli-1.4.4-darwin-arm64",
        executablePath: "/managed/chroma/current/chroma",
        runtimeVersion: "cli-1.4.4",
        assetSha256: "a".repeat(64),
      }),
    },
    embedding: {
      runtimeId: "embedding-runtime-node22-v1-darwin-arm64",
      root: "/managed/embedding/current",
      nodeExecutable: "/managed/embedding/current/bin/node",
      moduleRoot: "/managed/embedding/current/node_modules",
      versions: { node: "22.23.2", transformers: "4.2.0", onnxruntime: "1.26.0" },
      verification: {
        assetId: "embedding-runtime-node22-v1-darwin-arm64",
        assetSha256: "b".repeat(64),
        internalManifestPath: "/managed/embedding/current/manifest.json",
        internalManifestSha256: "c".repeat(64),
      },
      revalidate: async () => ({
        nodeExecutable: "/managed/embedding/current/bin/node",
        moduleRoot: "/managed/embedding/current/node_modules",
        verification: {
          assetId: "embedding-runtime-node22-v1-darwin-arm64",
          assetSha256: "b".repeat(64),
          internalManifestPath: "/managed/embedding/current/manifest.json",
          internalManifestSha256: "c".repeat(64),
        },
      }),
    },
  };
}

function bootstrapFixture(options = {}) {
  const calls = [];
  const runtime = verifiedRuntimes();
  if (options.chromaRevalidate) runtime.chroma.revalidate = options.chromaRevalidate;
  let state = { ownership: "none", pid: null, executablePath: null, port: 8000,
    runtimeVersion: null, startedAt: null };
  const chromaManager = {
    async start(startOptions) {
      calls.push(["chroma.start", { ...startOptions }]);
      if (options.startChroma) return options.startChroma(startOptions);
      state = lease();
      return { ...state };
    },
    async health(port) { calls.push(["chroma.health", port]); return options.health !== false; },
    getState() { return { ...state }; },
    async stopOwnedProcess(expected) {
      calls.push(["chroma.stop", expected ? { ...expected } : null]);
      if (options.stopChroma) return options.stopChroma(expected, state);
      state = { ownership: "none", pid: null, executablePath: null, port: state.port,
        runtimeVersion: null, startedAt: null };
      return { stopped: true, reason: "stopped" };
    },
  };
  const vectorStore = {
    async initialize(port, vaultId, model) {
      calls.push(["vector.initialize", port, vaultId, model]);
      if (options.vectorError) throw options.vectorError;
    },
  };
  const embedding = {
    async initialize(onProgress) {
      calls.push(["embedding.initialize"]);
      onProgress?.({ phase: "loading", file: null, loadedBytes: null, totalBytes: null, percent: 50 });
      if (options.embeddingGate) await options.embeddingGate.promise;
      if (options.embeddingError) throw options.embeddingError;
    },
    isReady: () => true,
    async dispose() {
      calls.push(["embedding.dispose"]);
      if (options.disposeEmbedding) return options.disposeEmbedding();
    },
  };
  const indexer = {
    async loadState() {
      calls.push(["index.load"]);
      if (options.indexError) throw options.indexError;
    },
    watchVault() { calls.push(["index.watch"]); },
    async stop() { calls.push(["index.stop"]); },
    shutdown() { calls.push(["index.shutdown"]); },
    async flushState() { calls.push(["index.flush"]); },
  };
  const published = [];
  const { LocalServiceBootstrap } = loadTypeScriptFile(path.join(
    extensionRoot, "src/local-vector/local-service-bootstrap.ts",
  ));
  const bootstrap = new LocalServiceBootstrap({
    resolveVerifiedRuntimes: async (signal) => {
      calls.push(["runtime.resolve", signal.aborted]);
      if (options.runtimeGate) await options.runtimeGate.promise;
      return runtime;
    },
    chromaManager,
    vaultId: "vault-v2-0123456789abcdef",
    modelShortName: "multilingual-e5-small",
    maxInputChars: 512,
    createVectorStore: () => vectorStore,
    createEmbeddingService: (managedRuntime) => {
      calls.push(["embedding.create", managedRuntime]);
      return embedding;
    },
    createSummarizer: () => ({ kind: "summary" }),
    createDocumentIndexer: (actualEmbedding, actualStore) => {
      assert.strictEqual(actualEmbedding, embedding);
      assert.strictEqual(actualStore, vectorStore);
      return indexer;
    },
    publishServices: async (ready) => {
      if (options.publishGate && ready) await options.publishGate.promise;
      if (options.publishError && ready) throw options.publishError;
      if (options.publishNullError && !ready) throw options.publishNullError;
      published.push(ready);
    },
    updateSearchState: (patch) => calls.push(["search.state", { ...patch }]),
    coordinator: options.coordinator,
    detectEnvironment: options.detectEnvironment,
  });
  return { bootstrap, calls, published, runtime, embedding, indexer, chromaManager };
}

test("bootstrap starts only exact freshly verified managed runtimes and publishes after health", async () => {
  const { bootstrap, calls, published, runtime } = bootstrapFixture();

  const first = bootstrap.start();
  const second = bootstrap.start();
  assert.strictEqual(first, second, "concurrent start must share one promise");
  const ready = await first;

  assert.deepEqual(calls.find(([name]) => name === "chroma.start")[1], {
    executablePath: runtime.chroma.executablePath,
    dataPath: runtime.chroma.dataPath,
    preferredPort: runtime.chroma.preferredPort,
    runtimeVersion: runtime.chroma.runtimeVersion,
  });
  assert.strictEqual(calls.find(([name]) => name === "embedding.create")[1], runtime.embedding);
  assert.equal(calls.some((entry) => JSON.stringify(entry).includes("python")), false);
  assert.equal(calls.some((entry) => JSON.stringify(entry).includes("pluginDir")), false);
  assert.ok(calls.findIndex(([name]) => name === "chroma.health") < calls.findIndex(([name]) => name === "index.watch"));
  assert.strictEqual(published.at(-1), ready);
  assert.equal(ready.lease.pid, 7301);
});

test("bootstrap waits for durable runtime-state publication and rolls back its exact lease on failure", async () => {
  const publishGate = deferred();
  const publicationError = new Error("RUNTIME_STATE_DURABILITY_FAILED");
  const { bootstrap, calls, published } = bootstrapFixture({ publishGate, publishError: publicationError });
  let settled = false;
  const starting = bootstrap.start().finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(published.some(Boolean), false);

  publishGate.resolve();
  await assert.rejects(starting, /RUNTIME_STATE_DURABILITY_FAILED/);
  assert.deepEqual(calls.find(([name]) => name === "chroma.stop")[1], lease());
  assert.equal(published.some(Boolean), false);
  assert.equal(published.at(-1), null);
});

test("secondary stopped-publication failure preserves the primary durability cause after exact lease cleanup", async () => {
  const primary = new Error("PRIMARY_RUNTIME_STATE_WRITE_FAILED");
  const secondary = new Error("SECONDARY_STOPPED_STATE_WRITE_FAILED");
  const { bootstrap, calls } = bootstrapFixture({ publishError: primary, publishNullError: secondary });

  await assert.rejects(bootstrap.start(), (error) => {
    assert.equal(error.code, "LOCAL_SERVICE_ROLLBACK_FAILED");
    assert.strictEqual(error.cause, primary);
    return true;
  });
  assert.deepEqual(calls.find(([name]) => name === "chroma.stop")[1], lease());
});

test("bootstrap rejects a changed Chroma snapshot immediately before spawn", async () => {
  const { bootstrap, calls } = bootstrapFixture({
    chromaRevalidate: async () => ({
      runtimeId: "chroma-cli-1.4.4-darwin-arm64",
      executablePath: "/managed/chroma/replaced/chroma",
      runtimeVersion: "cli-1.4.4",
      assetSha256: "a".repeat(64),
    }),
  });

  await assert.rejects(bootstrap.start(), /LOCAL_SERVICE_CHROMA_SNAPSHOT_MISMATCH/);

  assert.equal(calls.some(([name]) => name === "chroma.start"), false);
});

test("partial bootstrap failure rolls back embedding, index state, and only its exact Chroma lease", async () => {
  const { bootstrap, calls, published } = bootstrapFixture({ embeddingError: new Error("model failed") });

  await assert.rejects(bootstrap.start(), /model failed/);

  assert.deepEqual(calls.find(([name]) => name === "chroma.stop")[1], lease());
  assert.equal(calls.filter(([name]) => name === "embedding.dispose").length, 1);
  assert.equal(calls.some(([name]) => name === "index.watch"), false);
  assert.equal(published.at(-1), null);
});

test("stop is idempotent and an unload race cannot publish or spawn after verification resolves", async () => {
  const runtimeGate = deferred();
  const { bootstrap, calls, published } = bootstrapFixture({ runtimeGate });
  const starting = bootstrap.start();
  await new Promise((resolve) => setImmediate(resolve));

  const firstStop = bootstrap.stop();
  const secondStop = bootstrap.stop();
  assert.strictEqual(firstStop, secondStop);
  runtimeGate.resolve();
  await firstStop;
  await assert.rejects(starting, /LOCAL_SERVICE_BOOTSTRAP_CANCELLED/);

  assert.equal(calls.some(([name]) => name === "chroma.start"), false);
  assert.equal(published.some(Boolean), false);
});

test("repairAndStart delegates repair, then requires fresh ready evidence before bootstrap", async () => {
  const sequence = [];
  const coordinator = { async retry() { sequence.push("repair"); return { stage: "ready" }; } };
  const detectEnvironment = async () => {
    sequence.push("detect");
    return { platform: "darwin-arm64", chroma: "installed", embeddingRuntime: "ready",
      embeddingModel: "ready", index: "ready", recommendedAction: "start-services" };
  };
  const { bootstrap } = bootstrapFixture({ coordinator, detectEnvironment });

  await bootstrap.repairAndStart();

  assert.deepEqual(sequence, ["repair", "detect"]);
});

test("a failed exact-lease stop keeps ownership evidence and retries on the next stop", async () => {
  let stopAttempts = 0;
  const expected = lease();
  const { bootstrap, calls } = bootstrapFixture({
    stopChroma: async (actual) => {
      stopAttempts += 1;
      assert.deepEqual(actual, expected);
      if (stopAttempts === 1) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      return { stopped: true, reason: "stopped" };
    },
  });
  await bootstrap.start();

  await assert.rejects(bootstrap.stop(), /LOCAL_SERVICE_CLEANUP_FAILED/);
  await bootstrap.stop();

  assert.equal(stopAttempts, 2);
  assert.deepEqual(calls.filter(([name]) => name === "chroma.stop").map((entry) => entry[1]), [expected, expected]);
});

test("setup release avoids coordinator cancellation and a later stop consumes the retained lease", async () => {
  let cancellations = 0;
  const { bootstrap, calls, published } = bootstrapFixture({
    coordinator: { retry: async () => ({ stage: "ready" }), cancel: async () => { cancellations += 1; } },
  });
  await bootstrap.start();

  await bootstrap.releaseSetupServices({ preserveChromaLease: true });

  assert.equal(cancellations, 0);
  assert.equal(calls.filter(([name]) => name === "index.stop").length, 1);
  assert.equal(calls.filter(([name]) => name === "embedding.dispose").length, 1);
  assert.equal(calls.some(([name]) => name === "chroma.stop"), false);
  assert.strictEqual(published.at(-1), null);

  await bootstrap.stop();
  assert.equal(cancellations, 1);
  assert.deepEqual(calls.filter(([name]) => name === "chroma.stop").map((entry) => entry[1]), [lease()]);
});

test("retained setup lease survives onboarding EPERM and bootstrap stop retries the exact lease", async () => {
  const expected = lease();
  let chromaManager;
  let attempts = 0;
  let onboardingCleanupAttempted = false;
  const coordinator = {
    retry: async () => ({ stage: "ready" }),
    cancel: async () => {
      if (onboardingCleanupAttempted) return;
      onboardingCleanupAttempted = true;
      await chromaManager.stopOwnedProcess(expected);
    },
  };
  const fixture = bootstrapFixture({
    coordinator,
    stopChroma: async (actual) => {
      attempts += 1;
      assert.deepEqual(actual, expected);
      if (attempts < 3) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      return { stopped: true, reason: "stopped" };
    },
  });
  chromaManager = fixture.chromaManager;
  await fixture.bootstrap.start();
  await fixture.bootstrap.releaseSetupServices({ preserveChromaLease: true });

  await assert.rejects(fixture.bootstrap.stop(), /LOCAL_SERVICE_CLEANUP_FAILED/);
  await fixture.bootstrap.stop();

  assert.equal(attempts, 3);
});

test("retained lease mismatch is settled without stopping a replacement process", async () => {
  const expected = lease();
  const replacement = lease({ pid: 9999, startedAt: 999 });
  const { bootstrap, calls } = bootstrapFixture({
    stopChroma: async (actual) => {
      assert.deepEqual(actual, expected);
      return { stopped: false, reason: "lease-mismatch" };
    },
  });
  await bootstrap.start();
  await bootstrap.releaseSetupServices({ preserveChromaLease: true });

  await bootstrap.stop();

  assert.deepEqual(calls.filter(([name]) => name === "chroma.stop").map((entry) => entry[1]), [expected]);
  assert.notDeepEqual(calls.find(([name]) => name === "chroma.stop")[1], replacement);
});

test("a new bootstrap generation settles a retained lease before spawning again", async () => {
  const { bootstrap, calls } = bootstrapFixture();
  await bootstrap.start();
  await bootstrap.releaseSetupServices({ preserveChromaLease: true });

  await bootstrap.start();

  const starts = calls.map(([name], index) => [name, index]).filter(([name]) => name === "chroma.start");
  const stopIndex = calls.findIndex(([name]) => name === "chroma.stop");
  assert.equal(starts.length, 2);
  assert.ok(starts[0][1] < stopIndex && stopIndex < starts[1][1]);
});

test("stop during a pending spawn awaits the returned lease and never uses an unconditional stop", async () => {
  const startGate = deferred();
  const expected = lease({ pid: 7402, startedAt: 202 });
  const { bootstrap, calls } = bootstrapFixture({ startChroma: () => startGate.promise });
  const starting = bootstrap.start();
  while (!calls.some(([name]) => name === "chroma.start")) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const stopping = bootstrap.stop();
  startGate.resolve(expected);
  await stopping;
  await assert.rejects(starting, /LOCAL_SERVICE_BOOTSTRAP_CANCELLED/);

  assert.deepEqual(calls.filter(([name]) => name === "chroma.stop").map((entry) => entry[1]), [expected]);
});

test("partial-start rollback preserves both the primary and cleanup failures", async () => {
  let stopAttempts = 0;
  const primary = new Error("index load failed");
  const cleanup = Object.assign(new Error("EPERM"), { code: "EPERM" });
  const { bootstrap } = bootstrapFixture({
    indexError: primary,
    stopChroma: async () => {
      stopAttempts += 1;
      if (stopAttempts === 1) throw cleanup;
      return { stopped: true, reason: "stopped" };
    },
  });

  await assert.rejects(bootstrap.start(), (error) => {
    assert.equal(error.code, "LOCAL_SERVICE_ROLLBACK_FAILED");
    assert.strictEqual(error.cause, primary);
    assert.equal(error.cleanupError.code, "LOCAL_SERVICE_CLEANUP_FAILED");
    assert.strictEqual(error.cleanupError.cause, cleanup);
    return true;
  });
  await bootstrap.stop();
  assert.equal(stopAttempts, 2);
});

test("stop waits for coordinator cancellation during repair and blocks the late detect", async () => {
  const retryGate = deferred();
  const cancelGate = deferred();
  let detectCalls = 0;
  const coordinator = {
    retry: () => retryGate.promise,
    async cancel() { await cancelGate.promise; },
  };
  const { bootstrap } = bootstrapFixture({
    coordinator,
    detectEnvironment: async () => {
      detectCalls += 1;
      return { platform: "darwin-arm64", chroma: "installed", embeddingRuntime: "ready",
        embeddingModel: "ready", index: "ready", recommendedAction: "start-services" };
    },
  });
  const repairing = bootstrap.repairAndStart();
  await new Promise((resolve) => setImmediate(resolve));
  let stopped = false;
  const stopping = bootstrap.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, "stop must await coordinator cancellation cleanup");

  cancelGate.resolve();
  retryGate.resolve({ stage: "ready" });
  await stopping;
  await assert.rejects(repairing, /LOCAL_SERVICE_BOOTSTRAP_CANCELLED/);
  assert.equal(detectCalls, 0);
});

test("onboarding state is independent from query-service status and errors", () => {
  const boundary = loadTypeScriptFile(path.join(extensionRoot, "src/local-vector/search-instance.ts"));
  boundary.updateServiceState({ status: "idle", lastError: "" });
  const searchBefore = { ...boundary.searchInstance.state };
  const observed = [];
  const unsubscribe = boundary.subscribeOnboardingState((state) => observed.push(state));

  boundary.updateOnboardingState({
    visible: true,
    environment: { platform: "darwin-arm64", chroma: "missing", embeddingRuntime: "missing",
      embeddingModel: "missing", index: "empty", recommendedAction: "setup" },
  });

  assert.deepEqual(boundary.searchInstance.state, searchBefore);
  assert.equal(boundary.searchInstance.state.lastError, "");
  assert.equal(observed.at(-1).environment.recommendedAction, "setup");
  unsubscribe();
});

class TFile {
  constructor(filePath = "") { this.path = filePath; this.extension = filePath.split(".").pop() || ""; }
}

class Plugin {
  constructor(app, manifest = { id: "analogy", version: "test", dir: ".obsidian/plugins/analogy" }) {
    this.app = app;
    this.manifest = manifest;
    this.views = new Map();
    this.commands = [];
    this.ribbons = [];
    this.settingTabs = [];
  }
  registerView(type, factory) { this.views.set(type, factory); }
  addCommand(command) { this.commands.push(command); }
  addRibbonIcon(icon, title, callback) { this.ribbons.push({ icon, title, callback }); }
  addSettingTab(tab) { this.settingTabs.push(tab); }
  registerInterval() {}
  registerEvent() {}
  async loadData() { return {}; }
  async saveData() {}
}

const inertClass = class {
  constructor(...args) { Object.assign(this, { args }); }
  open() {}
  close() {}
};

const obsidianValues = {
  Plugin,
  TFile,
  ItemView: inertClass,
  PluginSettingTab: inertClass,
  Modal: inertClass,
  Component: inertClass,
  Notice: inertClass,
  Setting: inertClass,
  TextComponent: inertClass,
  ButtonComponent: inertClass,
  DropdownComponent: inertClass,
  ToggleComponent: inertClass,
  SliderComponent: inertClass,
  ExtraButtonComponent: inertClass,
  addIcon() {},
  setIcon() {},
  normalizePath(value) { return value; },
  requestUrl: async () => ({ status: 200, json: {}, text: "" }),
};
const obsidian = new Proxy(obsidianValues, {
  get(target, property) {
    if (!(property in target)) target[property] = inertClass;
    return target[property];
  },
});

async function loadMainBoundary() {
  const result = await esbuild.build({
    stdin: {
      contents: [
        'import Analogy from "./main";',
        'export { Analogy };',
        'export { onboardingInstance, searchInstance, subscribeOnboardingState } from "./src/local-vector/search-instance";',
        'export { createProductionEmbeddingModel } from "./src/onboarding/production-onboarding-dependencies";',
      ].join("\n"),
      resolveDir: extensionRoot,
      sourcefile: "task-10-main-boundary.ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    packages: "external",
    external: ["obsidian", "react-dom/client", "electron", "@huggingface/transformers", "onnxruntime-node"],
    define: {
      __ANALOGY_BUILD_ID__: JSON.stringify("test-build"),
      __ANALOGY_EMBEDDING_WORKER_SOURCE__: JSON.stringify("worker-source"),
    },
    plugins: [{
      name: "task-10-diagnostic-recorder",
      setup(build) {
        build.onResolve({ filter: /runtime\/platform-detector$/ }, () => ({
          path: "platform-detector", namespace: "task-10",
        }));
        build.onResolve({ filter: /diagnostics\/diagnostic-recorder$/ }, () => ({
          path: "diagnostic-recorder", namespace: "task-10",
        }));
        build.onLoad({ filter: /^platform-detector$/, namespace: "task-10" }, () => ({
          loader: "js",
          contents: 'exports.detectSupportedPlatform = () => "darwin-arm64";',
        }));
        build.onLoad({ filter: /^diagnostic-recorder$/, namespace: "task-10" }, () => ({
          loader: "js",
          contents: `
            class DiagnosticRecorder {
              async initialize() {}
              isSuspectedUncleanExit() { return false; }
              getPreviousMarker() { return null; }
              recordEvent() {}
              updateStage() {}
              info() {}
              warn() {}
              captureException() {}
              async markCleanExit() {}
            }
            exports.DiagnosticRecorder = DiagnosticRecorder;
          `,
        }));
      },
    }],
  });
  const module = { exports: {} };
  const taskRequire = (id) => {
    if (id === "obsidian") return obsidian;
    if (id === "react-dom/client") return { createRoot: () => ({ render() {}, unmount() {} }) };
    return require(require.resolve(id, { paths: [extensionRoot] }));
  };
  Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, taskRequire);
  return module.exports;
}

function mainHarness() {
  const layoutCallbacks = [];
  const workspace = {
    onLayoutReady(callback) { layoutCallbacks.push(callback); },
    getLeavesOfType: () => [],
    getActiveFile: () => null,
  };
  const app = {
    version: "test",
    workspace,
    vault: {
      adapter: { basePath: "/tmp/Analogy 中文 Vault" },
      configDir: ".obsidian",
      getAbstractFileByPath: () => null,
    },
    plugins: { enabledPlugins: new Set(), manifests: [] },
  };
  return { app, layoutCallbacks };
}

function onboardingSnapshot(overrides = {}) {
  return {
    schemaVersion: 1, stage: "not-started", progress: null, completedBytes: null, totalBytes: null,
    currentItem: "", runtimePlatform: null, chromaRuntimeId: null, embeddingRuntimeId: null,
    selectedIndexScope: null, startedAt: null, updatedAt: 0, completedAt: null, dismissedAt: null,
    error: null, ...overrides,
  };
}

test("Ollama onboarding navigation opens Analogy settings and focuses the summary section", async (t) => {
  const boundary = await loadMainBoundary();
  const harness = mainHarness();
  const events = [];
  const previousDocument = global.document;
  const previousWindow = global.window;
  t.after(() => {
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  });
  harness.app.setting = {
    openTabById(id) { events.push(["open", id]); },
  };
  global.document = {
    getElementById(id) {
      events.push(["find", id]);
      return {
        focus(options) { events.push(["focus", options]); },
        scrollIntoView(options) { events.push(["scroll", options]); },
      };
    },
  };
  global.window = {
    requestAnimationFrame(callback) { events.push(["frame"]); callback(); return 1; },
  };
  const plugin = new boundary.Analogy(harness.app);

  assert.equal(typeof plugin.openAnalogySettings, "function", "plugin must expose focused settings navigation");
  plugin.openAnalogySettings("analogy-settings-summary");

  assert.deepEqual(events, [
    ["open", "analogy-rag-in-your-vault"],
    ["frame"],
    ["find", "analogy-settings-summary"],
    ["focus", { preventScroll: true }],
    ["scroll", { behavior: "smooth", block: "start" }],
  ]);
});

test("onload registers UI before layout detection and missing runtime never starts services", async () => {
  global.window = { setInterval: () => 1 };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const boundary = await loadMainBoundary();
  const harness = mainHarness();
  const plugin = new boundary.Analogy(harness.app);
  plugin.registerLicenseRefresh = () => undefined;
  const gate = deferred();
  const calls = [];
  plugin.createRuntimeLifecycle = () => ({
    loadOnboarding: async () => ({ snapshot: onboardingSnapshot() }),
    detect: async (signal) => { calls.push(["detect", signal]); return gate.promise; },
    createBootstrap: () => ({ start: async () => { calls.push(["bootstrap.start"]); }, dispose: async () => {} }),
    dispose: async () => { calls.push(["lifecycle.dispose"]); },
  });

  await plugin.onload();

  assert.equal(calls.length, 0, "environment work must wait for layout-ready");
  assert.ok(plugin.views.size >= 2);
  assert.ok(plugin.ribbons.length >= 2);
  assert.ok(plugin.commands.length >= 3);
  assert.equal(plugin.settingTabs.length, 1);
  harness.layoutCallbacks[0]();
  harness.layoutCallbacks[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter(([name]) => name === "detect").length, 1, "layout detection is single-flight");

  gate.resolve({ platform: "darwin-arm64", chroma: "missing", embeddingRuntime: "missing",
    embeddingModel: "missing", index: "empty", recommendedAction: "setup" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.some(([name]) => name === "bootstrap.start"), false);
  assert.equal(boundary.onboardingInstance.state.visible, true);
  assert.equal(boundary.searchInstance.state.status, "idle");
  assert.equal(boundary.searchInstance.state.lastError, "");
  await plugin.onunload();
});

test("main settings persistence strips device-local Chroma port and index state from data.json", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-settings-local-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  const boundary = await loadMainBoundary();
  const harness = mainHarness();
  const plugin = new boundary.Analogy(harness.app);
  const saved = [];
  plugin.loadData = async () => ({
    uiLanguage: "zh",
    chromaPort: 8123,
    indexStates: {},
    excludedIndexPaths: [],
  });
  plugin.saveData = async (value) => saved.push(JSON.parse(JSON.stringify(value)));

  await plugin.loadSettings();
  await plugin.saveSettings();

  assert.equal(plugin.runtimePort, 8123);
  assert.equal(saved.length >= 1, true);
  assert.equal(saved.every((value) => !("chromaPort" in value) && !("indexStates" in value)), true);
});

test("port-only legacy settings persist device-local state before sanitizing synchronized data", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-port-only-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  const boundary = await loadMainBoundary();
  const harness = mainHarness();
  harness.app.vault.adapter.basePath = path.join(root, "Port Only Vault");
  const plugin = new boundary.Analogy(harness.app);
  plugin.loadData = async () => ({
    uiLanguage: "zh", chromaPort: 8345, excludedIndexPaths: [],
  });
  let sanitized = false;
  plugin.saveData = async (value) => {
    const runtimeVaultId = `vault-v2-${crypto.createHash("sha256")
      .update(path.resolve(harness.app.vault.adapter.basePath).normalize("NFC"), "utf8")
      .digest("hex").slice(0, 16)}`;
    const runtimeStatePath = path.join(
      root, "Library", "Application Support", "Analogy", "vaults", runtimeVaultId, "runtime-state.json",
    );
    const state = JSON.parse(await fs.promises.readFile(runtimeStatePath, "utf8"));
    assert.equal(state.activeGeneration, "legacy");
    assert.equal(state.port, 8345);
    assert.equal("chromaPort" in value, false);
    sanitized = true;
  };

  await plugin.loadSettings();
  assert.equal(sanitized, true);
});

test("production runtime lifecycle constructs and holds a real coordinator without starting setup", async (t) => {
  global.window = { setInterval: () => 1 };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const source = fs.readFileSync(path.join(extensionRoot, "main.ts"), "utf8");
  assert.match(source, /new OnboardingCoordinator\s*\(/);
  const boundary = await loadMainBoundary();
  const harness = mainHarness();
  const plugin = new boundary.Analogy(harness.app);
  plugin.settings = {
    embeddingModel: "bge-small-en-v1.5", embeddingModelHost: "https://hf-mirror.com/",
    summaryModel: "qwen3.5:0.8b", excludedIndexPaths: [], indexStates: {}, chromaPort: 8000,
  };

  const lifecycle = plugin.createRuntimeLifecycle();
  const bootstrap = lifecycle.createBootstrap();

  assert.equal(lifecycle.coordinator.constructor.name, "OnboardingCoordinator");
  assert.strictEqual(plugin.onboardingCoordinator, lifecycle.coordinator);
  assert.equal(lifecycle.coordinator.getSnapshot().stage, "not-started");
  assert.strictEqual(bootstrap.options.chromaManager, lifecycle.chromaManager);
  assert.equal(
    lifecycle.chromaManager.hooks.leaseStore.runtimeVaultId,
    plugin.runtimeVaultId,
  );
  assert.equal(
    lifecycle.chromaManager.hooks.leaseStore.leasePath,
    plugin.runtimePaths.chromaProcessLease,
  );
  assert.strictEqual(bootstrap.options.coordinator, lifecycle.coordinator);
  assert.equal(typeof bootstrap.options.detectEnvironment, "function");
  assert.equal(typeof lifecycle.coordinator.options.runtimes.chroma.download, "function");
  assert.equal(typeof lifecycle.coordinator.options.runtimes.chroma.verify, "function");
  assert.equal(typeof lifecycle.coordinator.options.runtimes.chroma.install, "function");
  assert.equal(typeof lifecycle.coordinator.options.embeddingModel.download, "function");
  assert.equal(typeof lifecycle.coordinator.options.embeddingModel.warmUp, "function");
  assert.equal(lifecycle.coordinator.options.quickIndex.constructor.name, "QuickIndexCoordinator");
  assert.equal(typeof lifecycle.coordinator.options.legacyMigration.prepare, "function");
  assert.equal(typeof lifecycle.coordinator.options.legacyMigration.copy, "function");
  assert.equal(typeof lifecycle.coordinator.options.legacyMigration.reconcile, "function");
  assert.equal(typeof lifecycle.coordinator.options.legacyMigration.verify, "function");
  assert.equal(typeof lifecycle.coordinator.options.legacyMigration.cancel, "function");
  const productionHistoryResolver = plugin.runtimeControlSurface.options.resolveTrustedRuntimeAsset;
  const activeChroma = lifecycle.coordinator.options.runtimes.chroma.asset;
  assert.deepEqual(productionHistoryResolver("chroma", activeChroma.id), {
    id: activeChroma.id,
    sha256: activeChroma.sha256,
  });
  assert.equal(productionHistoryResolver("chroma", "unknown-retired-runtime"), null);
  assert.deepEqual(await plugin.runtimeControlSurface.listLegacyChromaRecoveries(), [],
    "production control surface must expose the path-free recovery inventory");
  assert.equal(typeof plugin.runtimeControlSurface.retryLegacyChromaRecovery, "function");
  assert.equal(typeof plugin.runtimeControlSurface.restoreLegacyChromaRecovery, "function");
  const quickFile = {
    path: "中文 笔记.md", name: "中文 笔记.md", extension: "md",
    stat: { mtime: 1000, ctime: 500, size: 100 },
  };
  harness.app.vault.getFiles = () => [quickFile];
  harness.app.vault.getAbstractFileByPath = () => quickFile;
  let quickBootstrapStarts = 0;
  bootstrap.start = async () => {
    quickBootstrapStarts += 1;
    return {
      documentIndexer: {
        buildDocId: (candidate) => candidate.path,
        isExcluded: () => false,
        getAllFileStatuses: () => [{
          path: quickFile.path, name: quickFile.name, status: "unindexed",
          mtime: quickFile.stat.mtime, chunkCount: 0, muted: false,
        }],
        indexFiles: async () => ({
          requested: 1, indexed: 1, skipped: 0, failed: 0, chunkCount: 2,
          cancelled: false,
          files: [{ path: quickFile.path, status: "indexed", chunkCount: 2 }],
        }),
      },
    };
  };
  assert.deepEqual(
    await lifecycle.coordinator.options.quickIndex.run({ type: "vault" }, () => {}),
    {
      requested: 1,
      scopeType: "vault",
      selectedFileCount: 1,
      indexed: 1,
      skipped: 0,
      failed: 0,
      chunkCount: 2,
      selectedDocuments: [{ docId: quickFile.path, path: quickFile.path, mtime: quickFile.stat.mtime }],
    },
  );
  assert.equal(quickBootstrapStarts, 1, "production quick index must resolve an initialized indexer from bootstrap");
  const downloaded = [];
  lifecycle.coordinator.options.store = {
    load: async () => ({ snapshot: onboardingSnapshot() }),
    save: async () => {},
    flush: async () => {},
  };
  lifecycle.coordinator.options.detectEnvironment = async () => ({
    platform: "darwin-arm64", chroma: "missing", embeddingRuntime: "missing",
    embeddingModel: "missing", index: "empty", recommendedAction: "setup",
  });
  lifecycle.coordinator.options.runtimes.chroma.download = async () => { downloaded.push("chroma"); };
  lifecycle.coordinator.options.runtimes.embedding.download = async () => { downloaded.push("embedding"); };
  const setup = lifecycle.coordinator.start();
  while (lifecycle.coordinator.getSnapshot().stage !== "awaiting-consent") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(downloaded, [], "production coordinator must pause before consent");
  await lifecycle.coordinator.cancel();
  assert.equal((await setup).stage, "cancelled");

  const modelRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "analogy-model-adapter-"));
  t.after(() => fs.rmSync(modelRoot, { recursive: true, force: true }));
  const modelEvents = [];
  let modelReady = false;
  const productionModel = boundary.createProductionEmbeddingModel({
    paths: { modelCache: modelRoot },
    runtimeManager: { resolve: async () => ({ runtimeId: "managed" }) },
    modelConfig: { shortName: "model-test" },
    createService: () => ({
      async initialize() { modelEvents.push("model.initialize"); modelReady = true; },
      isReady: () => modelReady,
      async embed() { modelEvents.push("model.embed"); return [0.25, 0.75]; },
      async cancelInitialization() {},
      async dispose() { modelEvents.push("service.dispose"); },
    }),
  });
  lifecycle.coordinator.options.embeddingRuntimeManager = { resolve: async () => ({}) };
  lifecycle.coordinator.options.embeddingModel = productionModel;
  lifecycle.coordinator.options.detectEnvironment = async () => ({
    platform: "darwin-arm64", chroma: "running", embeddingRuntime: "ready",
    embeddingModel: "missing", index: "ready", recommendedAction: "setup",
  });
  lifecycle.coordinator.options.store = {
    load: async () => ({ snapshot: onboardingSnapshot() }),
    save: async (snapshot) => {
      if (snapshot.stage === "warming-up-model" && snapshot.progress === null) {
        modelEvents.push("save:warming-up-model");
      }
      if (snapshot.stage === "ready") modelEvents.push("save:ready");
    },
    flush: async () => {},
  };
  const modelSetup = lifecycle.coordinator.start();
  while (lifecycle.coordinator.getSnapshot().stage !== "awaiting-consent") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await lifecycle.coordinator.provideConsent(true);
  assert.equal((await modelSetup).stage, "ready");
  assert.deepEqual(modelEvents, [
    "model.initialize",
    "save:warming-up-model",
    "model.embed",
    "service.dispose",
    "save:ready",
  ]);
  await lifecycle.dispose();
});

test("production quick-index finalizer verifies v2 data and switches the runtime pointer before ready", async () => {
  const boundary = await loadMainBoundary();
  const harness = mainHarness();
  harness.app.vault.getMarkdownFiles = () => [];
  const plugin = new boundary.Analogy(harness.app);
  plugin.settings = {
    embeddingModel: "bge-small-en-v1.5", embeddingModelHost: "https://hf-mirror.com/",
    summaryModel: "qwen3.5:0.8b", excludedIndexPaths: [],
  };
  const lifecycle = plugin.createRuntimeLifecycle();
  const events = [];
  const pendingGeneration = {
    schemaVersion: 1,
    generation: "v2",
    runtimeId: "chroma-cli-1.4.4",
    runtimeVaultId: plugin.runtimeVaultId,
    modelShortName: "bge-small-en-v1.5",
    collectionName: `analogy_${plugin.runtimeVaultId}_bge-small-en-v1.5_0123456789ab`,
    dataPath: plugin.runtimePaths.chromaDataV2,
    port: 8123,
    rebuildCompletedAt: null,
    legacyDataPath: null,
    transitionToken: "0123456789abcdef0123456789abcdef",
    stateRevision: 4,
  };
  plugin.documentIndexer = {
    async verifyCurrentGeneration(selectedDocuments) {
      events.push(["verify", selectedDocuments]);
      return {
        expectedFileCount: 1,
        selectedDocuments,
        indexState: { "note.md": { path: "note.md", mtime: 1, chunkCount: 2 } },
        collectionDocuments: [{ docId: "note.md", path: "note.md", mtime: 1, chunkCount: 2 }],
        chunkCount: 2,
        smokeResults: [{ content: "smoke-hit" }],
      };
    },
    async runSmokeQuery(query) {
      events.push(["smoke", query]);
      return [{ content: "fresh-smoke-hit" }];
    },
  };
  plugin.chromaDataMigration = {
    async resumePendingGeneration() { return pendingGeneration; },
    async completeRebuild(generation, verification) {
      events.push(["complete", JSON.parse(JSON.stringify(generation)), await verification.smokeQuery("Analogy 固定重建验证查询")]);
      return { ...generation, rebuildCompletedAt: 123 };
    },
  };

  await lifecycle.coordinator.options.finalizeQuickIndex({
    requested: 1, scopeType: "recent", selectedFileCount: 1,
    indexed: 1, skipped: 0, failed: 0, chunkCount: 2,
    selectedDocuments: [{ docId: "note.md", path: "note.md", mtime: 1 }],
  });

  assert.deepEqual(events.map(([name]) => name), ["verify", "smoke", "complete"]);
  assert.deepEqual(events[0][1], [{ docId: "note.md", path: "note.md", mtime: 1 }]);
  assert.equal(events[2][1].collectionName, pendingGeneration.collectionName);
  assert.deepEqual(events[2][2], [{ content: "fresh-smoke-hit" }]);
  await lifecycle.dispose();
});

test("manual rebuild rolls the pointer back and restores the old service when transition stop fails", async () => {
  const boundary = await loadMainBoundary();
  const plugin = new boundary.Analogy(mainHarness().app);
  const primary = new Error("stop failed after partial cleanup");
  const events = [];
  let stopAttempts = 0;
  const migration = {
    async rollbackToPreviousGeneration(port) { events.push(["rollback", port]); },
  };
  const bootstrap = {
    async stop(options) {
      stopAttempts += 1;
      events.push([`stop:${stopAttempts}`, options]);
      if (stopAttempts === 1) throw primary;
    },
    async start() {
      events.push(["start"]);
      return { lease: { port: 8124 } };
    },
  };

  await assert.rejects(
    plugin.restartServicesAfterPointerSwitch(
      migration,
      { generation: "v2", port: 8123 },
      bootstrap,
      8123,
    ),
    (error) => error === primary,
  );
  assert.deepEqual(events, [
    ["stop:1", { preserveChromaLease: true }],
    ["rollback", 8123],
    ["stop:2", { preserveChromaLease: true }],
    ["start"],
  ]);
});

test("manual rebuild rolls the pointer back and restores the old service when new service start fails", async () => {
  const boundary = await loadMainBoundary();
  const plugin = new boundary.Analogy(mainHarness().app);
  const primary = new Error("new generation start failed");
  const events = [];
  let startAttempts = 0;
  const migration = {
    async rollbackToPreviousGeneration(port) { events.push(["rollback", port]); },
  };
  const bootstrap = {
    async stop(options) { events.push(["stop", options]); },
    async start() {
      startAttempts += 1;
      events.push([`start:${startAttempts}`]);
      if (startAttempts === 1) throw primary;
      return { lease: { port: 8123 } };
    },
  };

  await assert.rejects(
    plugin.restartServicesAfterPointerSwitch(
      migration,
      { generation: "v2", port: 8124 },
      bootstrap,
      8124,
    ),
    (error) => error === primary,
  );
  assert.deepEqual(events, [
    ["stop", { preserveChromaLease: true }],
    ["start:1"],
    ["rollback", 8124],
    ["stop", { preserveChromaLease: true }],
    ["start:2"],
  ]);
});

test("ready-bootstrap generation switch completes quick finalize without cancelling its coordinator run", async () => {
  const boundary = await loadMainBoundary();
  const plugin = new boundary.Analogy(mainHarness().app);
  const quickAbort = new AbortController();
  let coordinatorCancellations = 0;
  const { bootstrap } = bootstrapFixture({
    coordinator: {
      async cancel() {
        coordinatorCancellations += 1;
        quickAbort.abort();
      },
    },
  });
  await bootstrap.start();
  const { QuickIndexCoordinator } = loadTypeScriptFile(path.join(
    extensionRoot, "src/onboarding/quick-index-coordinator.ts",
  ));
  const file = {
    path: "成功切换.md", name: "成功切换.md", extension: "md",
    stat: { mtime: 10, ctime: 5, size: 20 },
  };
  const quick = new QuickIndexCoordinator({
    vault: { getFiles: () => [file], getAbstractFileByPath: () => file },
    getDocumentIndexer: async () => ({
      buildDocId: (candidate) => candidate.path,
      isExcluded: () => false,
      getAllFileStatuses: () => [{
        path: file.path, name: file.name, status: "unindexed",
        mtime: file.stat.mtime, chunkCount: 0, muted: false,
      }],
      indexFiles: async () => ({
        requested: 1, indexed: 1, skipped: 0, failed: 0, chunkCount: 1,
        cancelled: false, files: [{ path: file.path, status: "indexed", chunkCount: 1 }],
      }),
    }),
    getLicenseState: () => null,
    hashSalt: "vault-v2-0123456789abcdef",
  });

  const result = await quick.run({ type: "vault" }, () => {}, {
    signal: quickAbort.signal,
    finalize: async () => {
      await plugin.restartServicesAfterPointerSwitch(
        { rollbackToPreviousGeneration: async () => assert.fail("successful switch must not roll back") },
        { generation: "v2", port: 8042 },
        bootstrap,
        8042,
      );
    },
  });

  assert.equal(result.indexed, 1);
  assert.equal(coordinatorCancellations, 0);
  assert.equal(bootstrap.isReady(), true);
});

test("rollback to a previous v2 model rebuilds services with the target model and collection", async () => {
  const boundary = await loadMainBoundary();
  const plugin = new boundary.Analogy(mainHarness().app);
  plugin.settings = {
    embeddingModel: "bge-small-en-v1.5", embeddingModelHost: "https://hf-mirror.com/",
    summaryModel: "qwen3.5:0.8b", excludedIndexPaths: [],
  };
  plugin.runtimePaths = { runtimeState: "/tmp/runtime-state.json" };
  const events = [];
  const targetPointer = {
    generation: "v2", runtimeId: "chroma-cli-1.4.4", port: 8123,
    modelShortName: "jina-nano", collectionName: "analogy_vault-v2-0123456789abcdef_jina-nano_aaaaaaaaaaaa",
    rebuildCompletedAt: 100, scopeCompletion: { evidenceId: "a".repeat(32) },
  };
  const migration = {
    async read() { return { previousGeneration: targetPointer }; },
    async rollbackToPreviousGeneration(port) { events.push(["pointer", port]); },
  };
  plugin.chromaDataMigration = migration;
  const currentBootstrap = {
    async stopForGenerationSwitch(options) { events.push(["old.stop", options]); },
    async start() { events.push(["old.start"]); return { lease: { port: 8124 } }; },
  };
  const targetBootstrap = {
    async start() {
      events.push(["target.start", plugin.settings.embeddingModel, targetPointer.collectionName]);
      return { lease: { port: 8123 } };
    },
    async stopForGenerationSwitch(options) { events.push(["target.stop", options]); },
  };
  plugin.localServiceBootstrap = currentBootstrap;
  const originalLifecycle = {
    async dispose() { events.push(["old.lifecycle.dispose"]); },
    createBootstrapForModel(modelShortName) {
      events.push(["factory", modelShortName]);
      return targetBootstrap;
    },
  };
  const targetLifecycle = {
    async detect() { return { modelShortName: plugin.settings.embeddingModel }; },
    coordinator: { options: { quickIndex: { modelShortName: "jina-nano" } } },
    createBootstrapForModel(modelShortName) {
      events.push(["factory", modelShortName]);
      return targetBootstrap;
    },
    async dispose() {},
  };
  plugin.runtimeLifecycle = originalLifecycle;
  plugin.createRuntimeLifecycle = () => {
    events.push(["target.lifecycle.create", plugin.settings.embeddingModel]);
    return targetLifecycle;
  };
  plugin.saveSettings = async () => { events.push(["settings", plugin.settings.embeddingModel]); };
  plugin.chromaManager = { getPort: () => 8124 };

  await plugin.rollbackManagedChromaData();

  assert.equal(plugin.settings.embeddingModel, "jina-nano");
  assert.strictEqual(plugin.localServiceBootstrap, targetBootstrap);
  assert.strictEqual(plugin.runtimeLifecycle, targetLifecycle);
  assert.deepEqual(await plugin.runtimeLifecycle.detect(), { modelShortName: "jina-nano" });
  assert.equal(plugin.runtimeLifecycle.coordinator.options.quickIndex.modelShortName, "jina-nano");
  assert.strictEqual(plugin.runtimeLifecycle.createBootstrapForModel("jina-nano"), targetBootstrap);
  assert.deepEqual(events, [
    ["old.stop", { preserveChromaLease: false }],
    ["pointer", undefined],
    ["settings", "jina-nano"],
    ["target.lifecycle.create", "jina-nano"],
    ["factory", "jina-nano"],
    ["target.start", "jina-nano", targetPointer.collectionName],
    ["old.lifecycle.dispose"],
    ["factory", "jina-nano"],
  ]);
});

test("rollback to legacy releases the v2 lease and leaves managed services stopped", async () => {
  const boundary = await loadMainBoundary();
  const plugin = new boundary.Analogy(mainHarness().app);
  plugin.settings = {
    embeddingModel: "bge-small-en-v1.5", embeddingModelHost: "https://hf-mirror.com/",
    summaryModel: "qwen3.5:0.8b", excludedIndexPaths: [],
  };
  plugin.runtimePaths = { runtimeState: "/tmp/runtime-state.json" };
  const events = [];
  plugin.chromaDataMigration = {
    async read() {
      return { previousGeneration: {
        generation: "legacy", runtimeId: "legacy-chroma", port: 7999,
        modelShortName: "jina-nano", collectionName: "analogy_legacy_jina-nano",
        rebuildCompletedAt: null, scopeCompletion: null,
      } };
    },
    async rollbackToPreviousGeneration(port) { events.push(["pointer", port]); },
  };
  plugin.localServiceBootstrap = {
    async stopForGenerationSwitch(options) { events.push(["old.stop", options]); },
    async start() { assert.fail("legacy rollback must not restart managed v2 services"); },
  };
  const originalLifecycle = {
    async dispose() { events.push(["old.lifecycle.dispose"]); },
    createBootstrapForModel() { assert.fail("legacy rollback must not create a v2 bootstrap"); },
  };
  const legacyLifecycle = {
    createBootstrapForModel() { assert.fail("legacy rollback must not create a v2 bootstrap"); },
    async dispose() {},
  };
  plugin.runtimeLifecycle = originalLifecycle;
  plugin.createRuntimeLifecycle = () => { events.push(["legacy.lifecycle.create"]); return legacyLifecycle; };
  plugin.saveSettings = async () => { events.push(["settings", plugin.settings.embeddingModel]); };
  plugin.publishLocalServices = (ready, model) => { events.push(["publish", ready, model]); };
  plugin.chromaManager = { getPort: () => 8124 };

  await plugin.rollbackManagedChromaData();

  assert.equal(plugin.localServiceBootstrap, null);
  assert.strictEqual(plugin.runtimeLifecycle, legacyLifecycle);
  assert.deepEqual(events, [
    ["old.stop", { preserveChromaLease: false }],
    ["pointer", undefined],
    ["settings", "jina-nano"],
    ["legacy.lifecycle.create"],
    ["publish", null, "jina-nano"],
    ["old.lifecycle.dispose"],
  ]);
});

test("failed previous-model startup restores the original pointer settings and service graph", async () => {
  const boundary = await loadMainBoundary();
  const plugin = new boundary.Analogy(mainHarness().app);
  plugin.settings = {
    embeddingModel: "bge-small-en-v1.5", embeddingModelHost: "https://hf-mirror.com/",
    summaryModel: "qwen3.5:0.8b", excludedIndexPaths: [],
  };
  plugin.runtimePaths = { runtimeState: "/tmp/runtime-state.json" };
  const primary = new Error("target model failed");
  const events = [];
  plugin.chromaDataMigration = {
    async read() {
      return { previousGeneration: {
        generation: "v2", runtimeId: "chroma-cli-1.4.4", port: 8123,
        modelShortName: "jina-nano", collectionName: "analogy_vault-v2-0123456789abcdef_jina-nano_aaaaaaaaaaaa",
        rebuildCompletedAt: 100, scopeCompletion: { evidenceId: "a".repeat(32) },
      } };
    },
    async rollbackToPreviousGeneration(port) { events.push(["pointer", port]); },
  };
  const oldBootstrap = {
    async stopForGenerationSwitch(options) { events.push(["old.stop", options]); },
    async start() { events.push(["old.start"]); return { lease: { port: 8124 } }; },
  };
  const targetBootstrap = {
    async start() { events.push(["target.start"]); throw primary; },
    async stopForGenerationSwitch(options) { events.push(["target.stop", options]); },
  };
  plugin.localServiceBootstrap = oldBootstrap;
  const originalLifecycle = {
    createBootstrapForModel: () => targetBootstrap,
    async dispose() { events.push(["old.lifecycle.dispose"]); },
  };
  const targetLifecycle = {
    createBootstrapForModel: () => targetBootstrap,
    async dispose() { events.push(["target.lifecycle.dispose"]); },
  };
  plugin.runtimeLifecycle = originalLifecycle;
  plugin.createRuntimeLifecycle = () => { events.push(["target.lifecycle.create"]); return targetLifecycle; };
  plugin.saveSettings = async () => { events.push(["settings", plugin.settings.embeddingModel]); };
  plugin.chromaManager = { getPort: () => 8124 };

  await assert.rejects(plugin.rollbackManagedChromaData(), (error) => error === primary);

  assert.equal(plugin.settings.embeddingModel, "bge-small-en-v1.5");
  assert.strictEqual(plugin.localServiceBootstrap, oldBootstrap);
  assert.strictEqual(plugin.runtimeLifecycle, originalLifecycle);
  assert.deepEqual(events, [
    ["old.stop", { preserveChromaLease: false }],
    ["pointer", undefined],
    ["settings", "jina-nano"],
    ["target.lifecycle.create"],
    ["target.start"],
    ["pointer", undefined],
    ["settings", "bge-small-en-v1.5"],
    ["target.stop", { preserveChromaLease: false }],
    ["target.lifecycle.dispose"],
    ["old.start"],
  ]);
});

test("production model cancel waits for a late runtime resolve and prevents service creation", async (t) => {
  global.window = { setInterval: () => 1 };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const boundary = await loadMainBoundary();
  const modelRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "analogy-model-resolve-"));
  t.after(() => fs.rmSync(modelRoot, { recursive: true, force: true }));
  const resolveGate = deferred();
  const events = [];
  const runtime = { runtimeId: "managed", revalidate: async () => ({ runtimeId: "managed" }) };
  const adapter = boundary.createProductionEmbeddingModel({
    paths: { modelCache: modelRoot },
    runtimeManager: { async resolve() { events.push("resolve"); return resolveGate.promise; } },
    modelConfig: { shortName: "model-test" },
    createService: () => { events.push("create"); throw new Error("must not create after cancel"); },
  });
  const downloading = adapter.download(new AbortController().signal, () => {});
  while (!events.includes("resolve")) await new Promise((resolve) => setImmediate(resolve));

  const cancelling = adapter.cancel();
  resolveGate.resolve(runtime);
  await cancelling;
  await assert.rejects(downloading, /DOWNLOAD_CANCELLED/);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, ["resolve"]);
});

test("production quick-index releases only its own failed bootstrap, goes non-ready, and retries fresh", async () => {
  global.window = { setInterval: () => 1 };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const boundary = await loadMainBoundary();
  const harness = mainHarness();
  const quickFile = {
    path: "首次索引.md", name: "首次索引.md", extension: "md",
    stat: { mtime: 1000, ctime: 500, size: 100 },
  };
  harness.app.vault.getFiles = () => [quickFile];
  harness.app.vault.getMarkdownFiles = () => [quickFile];
  harness.app.vault.getAbstractFileByPath = () => quickFile;
  const plugin = new boundary.Analogy(harness.app);
  plugin.settings = {
    embeddingModel: "bge-small-en-v1.5", embeddingModelHost: "https://hf-mirror.com/",
    summaryModel: "qwen3.5:0.8b", excludedIndexPaths: [], indexStates: {}, chromaPort: 8000,
  };
  const starts = [];
  const stops = [];
  let bootstrapCreations = 0;
  plugin.createLocalServiceBootstrap = () => {
    bootstrapCreations += 1;
    const bootstrap = {
      async start() {
        const generation = starts.length + 1;
        starts.push(generation);
        boundary.searchInstance.state.status = "ready";
        return {
          documentIndexer: {
            buildDocId: (candidate) => candidate.path,
            isExcluded: () => false,
            getAllFileStatuses: () => [{
              path: quickFile.path, name: quickFile.name, status: "unindexed",
              mtime: quickFile.stat.mtime, chunkCount: 0, muted: false,
            }],
            indexFiles: async () => generation === 1 ? ({
              requested: 1, indexed: 0, skipped: 0, failed: 1, chunkCount: 0, cancelled: false,
              files: [{ path: quickFile.path, status: "failed", chunkCount: 0, errorCategory: "embedding" }],
            }) : ({
              requested: 1, indexed: 1, skipped: 0, failed: 0, chunkCount: 2, cancelled: false,
              files: [{ path: quickFile.path, status: "indexed", chunkCount: 2 }],
            }),
          },
        };
      },
      async releaseSetupServices(options) {
        stops.push([starts.at(-1), options]);
        boundary.searchInstance.state.status = "idle";
      },
    };
    return bootstrap;
  };
  const lifecycle = plugin.createRuntimeLifecycle();
  const quickIndex = lifecycle.coordinator.options.quickIndex;

  await assert.rejects(quickIndex.run({ type: "vault" }, () => {}), /QUICK_INDEX_FAILED/);
  assert.deepEqual(stops, [[1, { preserveChromaLease: false }]]);
  assert.equal(boundary.searchInstance.state.status, "idle");
  assert.deepEqual(await quickIndex.run({ type: "vault" }, () => {}), {
    requested: 1, scopeType: "vault", selectedFileCount: 1,
    indexed: 1, skipped: 0, failed: 0, chunkCount: 2,
    selectedDocuments: [{ docId: quickFile.path, path: quickFile.path, mtime: quickFile.stat.mtime }],
  });
  assert.deepEqual(starts, [1, 2]);
  assert.equal(bootstrapCreations, 2, "retry must construct a fresh bootstrap and indexer generation");
  assert.deepEqual(stops, [[1, { preserveChromaLease: false }]], "successful retry hands its fresh bootstrap off");
  await lifecycle.dispose();
});

test("production quick-index never stops a pre-existing ready bootstrap on failure", async () => {
  global.window = { setInterval: () => 1 };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const boundary = await loadMainBoundary();
  const harness = mainHarness();
  const quickFile = {
    path: "已有服务.md", name: "已有服务.md", extension: "md",
    stat: { mtime: 1000, ctime: 500, size: 100 },
  };
  harness.app.vault.getFiles = () => [quickFile];
  harness.app.vault.getMarkdownFiles = () => [quickFile];
  harness.app.vault.getAbstractFileByPath = () => quickFile;
  const plugin = new boundary.Analogy(harness.app);
  plugin.settings = {
    embeddingModel: "bge-small-en-v1.5", embeddingModelHost: "https://hf-mirror.com/",
    summaryModel: "qwen3.5:0.8b", excludedIndexPaths: [], indexStates: {}, chromaPort: 8000,
  };
  let stopCalls = 0;
  const readyIndexer = {
    buildDocId: (candidate) => candidate.path,
    isExcluded: () => false,
    getAllFileStatuses: () => [{
      path: quickFile.path, name: quickFile.name, status: "unindexed",
      mtime: quickFile.stat.mtime, chunkCount: 0, muted: false,
    }],
    indexFiles: async () => ({
      requested: 1, indexed: 0, skipped: 0, failed: 1, chunkCount: 0, cancelled: false,
      files: [{ path: quickFile.path, status: "failed", chunkCount: 0, errorCategory: "embedding" }],
    }),
  };
  plugin.localServiceBootstrap = {
    isReady: () => true,
    start: async () => ({ documentIndexer: readyIndexer }),
    stop: async () => { stopCalls += 1; },
  };
  const lifecycle = plugin.createRuntimeLifecycle();

  await assert.rejects(
    lifecycle.coordinator.options.quickIndex.run({ type: "vault" }, () => {}),
    /QUICK_INDEX_EXISTING_SERVICE_UNAVAILABLE/,
  );
  assert.equal(stopCalls, 0);
  await lifecycle.dispose();
});

test("production coordinator records quick-index failure without recursive cancellation", async () => {
  global.window = { setInterval: () => 1 };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const boundary = await loadMainBoundary();
  const harness = mainHarness();
  const quickFile = {
    path: "组合失败.md", name: "组合失败.md", extension: "md",
    stat: { mtime: 1000, ctime: 500, size: 100 },
  };
  harness.app.vault.getFiles = () => [quickFile];
  harness.app.vault.getMarkdownFiles = () => [quickFile];
  harness.app.vault.getAbstractFileByPath = () => quickFile;
  const plugin = new boundary.Analogy(harness.app);
  plugin.settings = {
    embeddingModel: "bge-small-en-v1.5", embeddingModelHost: "https://hf-mirror.com/",
    summaryModel: "qwen3.5:0.8b", excludedIndexPaths: [], indexStates: {}, chromaPort: 8000,
  };
  let coordinator;
  let stopCalls = 0;
  let releaseCalls = 0;
  plugin.createLocalServiceBootstrap = () => ({
    async start() {
      return {
        documentIndexer: {
          isExcluded: () => false,
          getAllFileStatuses: () => [{
            path: quickFile.path, name: quickFile.name, status: "unindexed",
            mtime: quickFile.stat.mtime, chunkCount: 0, muted: false,
          }],
          indexFiles: async () => {
            throw Object.assign(new Error("INDEXER_MAINTENANCE_FAILED"), {
              code: "INDEXER_MAINTENANCE_FAILED",
            });
          },
        },
      };
    },
    async releaseSetupServices(options) {
      releaseCalls += 1;
      assert.deepEqual(options, { preserveChromaLease: true });
    },
    async stop() {
      stopCalls += 1;
      await coordinator.cancel();
    },
  });
  const lifecycle = plugin.createRuntimeLifecycle();
  coordinator = lifecycle.coordinator;
  let stored = onboardingSnapshot();
  coordinator.options.store = {
    load: async () => ({ snapshot: { ...stored } }),
    save: async (snapshot) => { stored = { ...snapshot }; },
  };
  coordinator.options.detectEnvironment = async () => ({
    platform: "darwin-arm64", chroma: "running", embeddingRuntime: "ready",
    embeddingModel: "ready", index: "empty", recommendedAction: "setup",
  });
  coordinator.options.embeddingRuntimeManager = { resolve: async () => ({ runtimeId: "ready" }) };
  coordinator.options.embeddingModel.cancel = async () => {};

  const operation = coordinator.start();
  await waitFor(() => coordinator.getSnapshot().stage === "awaiting-consent", "consent stage");
  await coordinator.provideConsent(true);
  await waitFor(() => coordinator.getSnapshot().stage === "selecting-index-scope", "scope stage");
  await coordinator.selectIndexScope({ type: "vault" });
  const result = await operation;

  assert.equal(result.stage, "failed");
  assert.equal(result.error.code, "QUICK_INDEX_FAILED");
  assert.equal(releaseCalls, 1);
  assert.equal(stopCalls, 0);
  await lifecycle.dispose();
});

test("production model cancel disposes a service created late and never initializes it", async (t) => {
  global.window = { setInterval: () => 1 };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const boundary = await loadMainBoundary();
  const modelRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "analogy-model-create-"));
  t.after(() => fs.rmSync(modelRoot, { recursive: true, force: true }));
  const createGate = deferred();
  const events = [];
  const runtime = { runtimeId: "managed", revalidate: async () => ({ runtimeId: "managed" }) };
  const service = {
    async initialize() { events.push("initialize"); },
    isReady: () => true,
    async embed() { return [1]; },
    async cancelInitialization() { events.push("cancelInitialization"); },
    async dispose() { events.push("dispose"); },
  };
  const adapter = boundary.createProductionEmbeddingModel({
    paths: { modelCache: modelRoot },
    runtimeManager: { resolve: async () => runtime },
    modelConfig: { shortName: "model-test" },
    createService: async (actualRuntime) => {
      assert.strictEqual(actualRuntime, runtime, "managed runtime object and revalidate guard must remain intact");
      events.push("create");
      return createGate.promise;
    },
  });
  const downloading = adapter.download(new AbortController().signal, () => {});
  while (!events.includes("create")) await new Promise((resolve) => setImmediate(resolve));

  const cancelling = adapter.cancel();
  createGate.resolve(service);
  await cancelling;
  await assert.rejects(downloading, /DOWNLOAD_CANCELLED/);

  assert.deepEqual(events, ["create", "dispose"]);
});

test("production model cancel joins one initialize flight shared with concurrent warm-up", async (t) => {
  global.window = { setInterval: () => 1 };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const boundary = await loadMainBoundary();
  const modelRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "analogy-model-init-"));
  t.after(() => fs.rmSync(modelRoot, { recursive: true, force: true }));
  const initializeGate = deferred();
  const events = [];
  let ready = false;
  const service = {
    async initialize() {
      events.push("initialize");
      await initializeGate.promise;
      ready = true;
    },
    isReady: () => ready,
    async embed() { events.push("embed"); return [1]; },
    async cancelInitialization() { events.push("cancelInitialization"); initializeGate.resolve(); },
    async dispose() { events.push("dispose"); },
  };
  const adapter = boundary.createProductionEmbeddingModel({
    paths: { modelCache: modelRoot },
    runtimeManager: { resolve: async () => ({ runtimeId: "managed" }) },
    modelConfig: { shortName: "model-test" },
    createService: () => service,
  });
  const downloading = adapter.download(new AbortController().signal, () => {});
  while (!events.includes("initialize")) await new Promise((resolve) => setImmediate(resolve));
  const warming = adapter.warmUp(new AbortController().signal, () => {});

  await adapter.cancel();
  await assert.rejects(downloading, /DOWNLOAD_CANCELLED/);
  await assert.rejects(warming, /DOWNLOAD_CANCELLED/);

  assert.deepEqual(events, ["initialize", "cancelInitialization", "dispose"]);
});

test("production model AbortSignal blocks a new generation until cancelled initialization is disposed", async (t) => {
  global.window = { setInterval: () => 1 };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const boundary = await loadMainBoundary();
  const modelRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "analogy-model-signal-"));
  t.after(() => fs.rmSync(modelRoot, { recursive: true, force: true }));
  const initializeGate = deferred();
  const events = [];
  const adapter = boundary.createProductionEmbeddingModel({
    paths: { modelCache: modelRoot },
    runtimeManager: { resolve: async () => ({ runtimeId: "managed" }) },
    modelConfig: { shortName: "model-test" },
    createService: () => ({
      async initialize() { events.push("initialize"); await initializeGate.promise; },
      isReady: () => true,
      async embed() { return [1]; },
      async cancelInitialization() { events.push("cancelInitialization"); initializeGate.resolve(); },
      async dispose() { events.push("dispose"); },
    }),
  });
  const controller = new AbortController();
  const first = adapter.download(controller.signal, () => {});
  while (!events.includes("initialize")) await new Promise((resolve) => setImmediate(resolve));

  controller.abort();
  const concurrent = adapter.download(new AbortController().signal, () => {});
  await assert.rejects(concurrent, /DOWNLOAD_CANCELLED/);
  await assert.rejects(first, /DOWNLOAD_CANCELLED/);
  await adapter.cancel();

  assert.deepEqual(events, ["initialize", "cancelInitialization", "dispose"]);
});

test("production model warm-up always releases its temporary service and retry creates a fresh one", async (t) => {
  global.window = { setInterval: () => 1 };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const boundary = await loadMainBoundary();
  const modelRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "analogy-model-lifecycle-"));
  t.after(() => fs.rmSync(modelRoot, { recursive: true, force: true }));
  let serviceCount = 0;
  let disposeCalls = 0;
  let failFirstEmbed = true;
  const adapter = boundary.createProductionEmbeddingModel({
    paths: { modelCache: modelRoot },
    runtimeManager: { resolve: async () => ({ runtimeId: "managed" }) },
    modelConfig: { shortName: "model-test" },
    createService: () => {
      serviceCount += 1;
      let ready = false;
      return {
        async initialize() { ready = true; },
        isReady: () => ready,
        async embed() {
          if (failFirstEmbed) {
            failFirstEmbed = false;
            throw new Error("raw model input and /private/path must stay bounded");
          }
          return [0.5];
        },
        async cancelInitialization() {},
        async dispose() { disposeCalls += 1; },
      };
    },
  });

  await adapter.download(new AbortController().signal, () => {});
  await assert.rejects(
    adapter.warmUp(new AbortController().signal, () => {}),
    (error) => error.code === "EMBEDDING_MODEL_WARMUP_FAILED"
      && error.message === "EMBEDDING_MODEL_WARMUP_FAILED",
  );
  assert.equal(disposeCalls, 1);

  await adapter.warmUp(new AbortController().signal, () => {});
  assert.equal(serviceCount, 2);
  assert.equal(disposeCalls, 2);
  await adapter.cancel();
  assert.equal(disposeCalls, 2, "cancel after warm-up must not double-dispose the temporary service");
});

test("dismissed onboarding stays quiet and a ready report alone starts bootstrap", async () => {
  global.window = { setInterval: () => 1 };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const boundary = await loadMainBoundary();
  const missingHarness = mainHarness();
  const missingPlugin = new boundary.Analogy(missingHarness.app);
  missingPlugin.registerLicenseRefresh = () => undefined;
  let missingStarts = 0;
  missingPlugin.createRuntimeLifecycle = () => ({
    loadOnboarding: async () => ({ snapshot: onboardingSnapshot({ dismissedAt: 123 }) }),
    detect: async () => ({ platform: "darwin-arm64", chroma: "corrupt", embeddingRuntime: "missing",
      embeddingModel: "missing", index: "empty", recommendedAction: "repair" }),
    createBootstrap: () => ({ start: async () => { missingStarts += 1; }, dispose: async () => {} }),
    dispose: async () => {},
  });
  await missingPlugin.onload();
  missingHarness.layoutCallbacks[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(boundary.onboardingInstance.state.visible, false);
  assert.equal(missingStarts, 0);
  await missingPlugin.onunload();

  const readyHarness = mainHarness();
  const readyPlugin = new boundary.Analogy(readyHarness.app);
  readyPlugin.registerLicenseRefresh = () => undefined;
  let readyStarts = 0;
  readyPlugin.createRuntimeLifecycle = () => ({
    loadOnboarding: async () => ({ snapshot: onboardingSnapshot({ stage: "ready" }) }),
    detect: async () => ({ platform: "darwin-arm64", chroma: "installed", embeddingRuntime: "ready",
      embeddingModel: "ready", index: "ready", recommendedAction: "start-services" }),
    createBootstrap: () => ({ start: async () => { readyStarts += 1; return {}; }, dispose: async () => {} }),
    dispose: async () => {},
  });
  await readyPlugin.onload();
  readyHarness.layoutCallbacks[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readyStarts, 1);
  assert.equal(boundary.onboardingInstance.state.visible, false);
  await readyPlugin.onunload();
});

test("unload aborts pending detection and a late continuation cannot start bootstrap", async () => {
  global.window = { setInterval: () => 1 };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const boundary = await loadMainBoundary();
  const harness = mainHarness();
  const plugin = new boundary.Analogy(harness.app);
  plugin.registerLicenseRefresh = () => undefined;
  const gate = deferred();
  let signal;
  let starts = 0;
  plugin.createRuntimeLifecycle = () => ({
    loadOnboarding: async () => ({ snapshot: onboardingSnapshot() }),
    detect: async (value) => { signal = value; return gate.promise; },
    createBootstrap: () => ({ start: async () => { starts += 1; }, dispose: async () => {} }),
    dispose: async () => {},
  });
  await plugin.onload();
  harness.layoutCallbacks[0]();
  await new Promise((resolve) => setImmediate(resolve));

  await plugin.onunload();
  assert.equal(signal.aborted, true);
  gate.resolve({ platform: "darwin-arm64", chroma: "installed", embeddingRuntime: "ready",
    embeddingModel: "ready", index: "ready", recommendedAction: "start-services" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 0);
});

test("unload resets onboarding state, notifies subscribers, and retains failed bootstrap cleanup for retry", async () => {
  global.window = { setInterval: () => 1 };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const boundary = await loadMainBoundary();
  const harness = mainHarness();
  const plugin = new boundary.Analogy(harness.app);
  const cleanupError = Object.assign(new Error("EPERM"), { code: "EPERM" });
  const bootstrap = { dispose: async () => { throw cleanupError; } };
  plugin.localServiceBootstrap = bootstrap;
  boundary.onboardingInstance.state.visible = true;
  boundary.onboardingInstance.state.environment = {
    platform: "darwin-arm64", chroma: "missing", embeddingRuntime: "missing",
    embeddingModel: "missing", index: "empty", recommendedAction: "setup",
  };
  boundary.onboardingInstance.state.snapshot = onboardingSnapshot({ stage: "awaiting-consent" });
  const observed = [];
  const unsubscribe = boundary.subscribeOnboardingState((state) => observed.push(state));

  await plugin.onunload();

  assert.deepEqual(boundary.onboardingInstance.state, { visible: false, environment: null, snapshot: null });
  assert.deepEqual(observed.at(-1), { visible: false, environment: null, snapshot: null });
  assert.strictEqual(plugin.localServiceBootstrap, bootstrap);
  unsubscribe();
});

test("store and detector failures are contained in onboarding state without unhandled rejection", async (t) => {
  global.window = { setInterval: () => 1 };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const boundary = await loadMainBoundary();
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  for (const failureAt of ["store", "detector"]) {
    boundary.onboardingInstance.state.visible = false;
    boundary.onboardingInstance.state.environment = null;
    const harness = mainHarness();
    const plugin = new boundary.Analogy(harness.app);
    plugin.registerLicenseRefresh = () => undefined;
    plugin.createRuntimeLifecycle = () => ({
      loadOnboarding: async () => {
        if (failureAt === "store") throw new Error("onboarding store unavailable");
        return { snapshot: onboardingSnapshot() };
      },
      detect: async () => {
        if (failureAt === "detector") throw new Error("environment detector unavailable");
        return { platform: "darwin-arm64", chroma: "missing", embeddingRuntime: "missing",
          embeddingModel: "missing", index: "empty", recommendedAction: "setup" };
      },
      createBootstrap: () => { throw new Error("bootstrap must not be created"); },
      dispose: async () => {},
    });
    await plugin.onload();
    harness.layoutCallbacks[0]();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(boundary.onboardingInstance.state.visible, true, `${failureAt} failure remains recoverable in onboarding`);
    assert.equal(boundary.searchInstance.state.status, "idle");
    assert.equal(boundary.searchInstance.state.lastError, "");
    await plugin.onunload();
  }
  assert.deepEqual(unhandled, []);
});
