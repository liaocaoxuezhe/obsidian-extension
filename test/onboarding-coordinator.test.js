"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const loaded = new Map();

function loadTypeScriptFile(filename) {
  if (!fs.existsSync(filename)) return {};
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

function coordinatorModule() {
  return loadTypeScriptFile(path.join(
    process.cwd(), "src/onboarding/onboarding-coordinator.ts",
  ));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function baseSnapshot(stage = "not-started", overrides = {}) {
  return {
    schemaVersion: 1,
    stage,
    progress: null,
    completedBytes: null,
    totalBytes: null,
    currentItem: "",
    runtimePlatform: null,
    chromaRuntimeId: null,
    embeddingRuntimeId: null,
    selectedIndexScope: null,
    legacyIndexChoice: null,
    legacyRecordsCopied: null,
    legacyRecordsTotal: null,
    legacySourceBytes: null,
    startedAt: null,
    updatedAt: 0,
    completedAt: null,
    dismissedAt: null,
    error: null,
    ...overrides,
  };
}

function environment(overrides = {}) {
  return {
    platform: "darwin-arm64",
    chroma: "missing",
    embeddingRuntime: "missing",
    embeddingModel: "missing",
    index: "empty",
    recommendedAction: "setup",
    ...overrides,
  };
}

const asset = (kind) => ({
  id: `${kind}-fixture`,
  kind,
  platform: "darwin-arm64",
  version: "1",
  url: `https://example.invalid/${kind}`,
  fileName: `${kind}.bin`,
  archive: "none",
  size: 10,
  sha256: "a".repeat(64),
  executableRelativePath: `${kind}.bin`,
  licenseName: "fixture",
  licenseUrl: "https://example.invalid/license",
  source: "published",
  ...(kind === "embedding-runtime" ? {
    runtimeVersions: { node: "22.23.2", transformers: "4.2.0", onnxruntime: "1.26.0" },
  } : {}),
});

async function waitFor(predicate, message = "condition") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${message}`);
}

function fixture(options = {}) {
  const calls = [];
  let stored = clone(options.snapshot || baseSnapshot());
  let now = 100;
  const store = options.store || {
    async load() {
      calls.push("store.load");
      return { snapshot: clone(stored), recommendedAction: "setup", migrated: false, removedLegacyKeys: [] };
    },
    async save(snapshot) {
      calls.push(`save:${snapshot.stage}`);
      stored = clone(snapshot);
    },
    async flush() { calls.push("store.flush"); },
  };
  const report = options.report || environment();
  const pipelines = {};
  for (const kind of ["chroma", "embedding-runtime"]) {
    const label = kind === "chroma" ? "chroma" : "embedding";
    const custom = options[`${label}Pipeline`] || {};
    pipelines[label] = {
      asset: asset(kind),
      async download(signal, onProgress) {
        calls.push(`${label}.download`);
        onProgress?.({ receivedBytes: 5, totalBytes: 10, percent: 50, currentItem: `${label}.bin` });
        if (custom.download) return custom.download(signal, onProgress);
        return { path: `/${label}.part`, receivedBytes: 10 };
      },
      async verify(downloaded) {
        calls.push(`${label}.verify`);
        if (custom.verify) return custom.verify(downloaded);
        return { ok: true, actualSize: 10, actualSha256: "a".repeat(64), errorCode: null };
      },
      async install(downloaded) {
        calls.push(`${label}.install`);
        if (custom.install) return custom.install(downloaded);
        return { runtimeId: `${kind}-fixture`, executablePath: `/${label}` };
      },
    };
  }
  const chromaState = { ownership: "none", pid: null, executablePath: null, port: 8000,
    runtimeVersion: null, startedAt: null, ...(options.chromaInitialState || {}) };
  const chromaManager = {
    getState() { calls.push("chroma.getState"); return { ...chromaState }; },
    async start(startOptions) {
      calls.push("chroma.start");
      if (options.startChroma) {
        const state = await options.startChroma(startOptions, chromaState);
        Object.assign(chromaState, state);
        return state;
      }
      Object.assign(chromaState, { ownership: "analogy", pid: 42, executablePath: "/chroma",
        runtimeVersion: "1", startedAt: now, port: 8000 });
      return { ...chromaState };
    },
    async stopOwnedProcess(expectedLease) {
      calls.push("chroma.stop");
      calls.push({ expectedLease: clone(expectedLease) });
      if (options.stopChroma) await options.stopChroma(expectedLease, chromaState);
      Object.assign(chromaState, { ownership: "none", pid: null, executablePath: null,
        runtimeVersion: null, startedAt: null });
    },
  };
  let embeddingReady = report.embeddingModel === "ready";
  const embeddingModel = options.embeddingModel || {
    isReady: () => embeddingReady,
    async download(signal, onProgress) {
      calls.push("model.download");
      if (options.downloadModel) return options.downloadModel(signal, onProgress);
      onProgress?.({ phase: "downloading", file: "model.onnx", loadedBytes: 5, totalBytes: 10, percent: 50 });
    },
    async warmUp(signal, onProgress) {
      calls.push("model.warm");
      if (options.warmUpModel) return options.warmUpModel(signal, onProgress, () => { embeddingReady = true; });
      if (options.initializeModel) return options.initializeModel(onProgress, () => { embeddingReady = true; });
      onProgress?.({ phase: "loading", file: null, loadedBytes: null, totalBytes: null, percent: 100 });
      embeddingReady = true;
    },
    async cancel() {
      calls.push("model.cancel");
      if (options.cancelModel) await options.cancelModel();
    },
  };
  const quickIndex = {
    async run(scope, onProgress, runOptions) {
      calls.push(`index.run:${scope.type}`);
      onProgress?.({ current: 1, total: 1, currentFileName: "note.md" });
      const result = options.runIndex
        ? await options.runIndex(scope, onProgress, runOptions)
        : {
          requested: 1, scopeType: scope.type, selectedFileCount: 1,
          indexed: 1, skipped: 0, failed: 0, chunkCount: 1,
          selectedDocuments: [{ docId: "note.md", path: "note.md", mtime: 1 }],
        };
      await runOptions?.finalize?.(result);
      return result;
    },
  };
  const legacyMigration = options.legacyMigration || {
    async prepare() { calls.push("legacy.prepare"); },
    async copy(_signal, onProgress) {
      calls.push("legacy.copy");
      onProgress?.({ copiedRecords: 1, totalRecords: 2, sourceBytes: 1000 });
    },
    async reconcile(_signal, onProgress) {
      calls.push("legacy.reconcile");
      onProgress?.({ copiedRecords: 2, totalRecords: 2, sourceBytes: 1000 });
    },
    async verify() { calls.push("legacy.verify"); },
    async cancel() { calls.push("legacy.cancel"); },
  };
  const { OnboardingCoordinator } = coordinatorModule();
  assert.equal(typeof OnboardingCoordinator, "function", "Task 9 should export OnboardingCoordinator");
  const coordinator = new OnboardingCoordinator({
    detectEnvironment: async (signal) => {
      calls.push("detect");
      return options.detect ? options.detect(signal) : clone(report);
    },
    store,
    runtimes: pipelines,
    chromaManager,
    chromaStartOptions: (installed) => ({
      executablePath: installed?.executablePath || "/installed/chroma",
      dataPath: "/local/chroma-data",
      runtimeVersion: "1",
    }),
    embeddingRuntimeManager: {
      async resolve() {
        calls.push("embedding.resolve");
        if (options.resolveEmbedding) return options.resolveEmbedding();
        return { runtimeId: "embedding-runtime-fixture" };
      },
    },
    embeddingModel,
    quickIndex,
    legacyMigration,
    finalizeQuickIndex: options.finalizeQuickIndex,
    now: () => ++now,
  });
  return { coordinator, calls, store, getStored: () => clone(stored), chromaState };
}

async function passSuspensions(coordinator, scope = { type: "recent", limit: 30 }) {
  await waitFor(() => coordinator.getSnapshot().stage === "awaiting-consent", "consent stage");
  assert.equal(await coordinator.provideConsent(true), true);
  await waitFor(() => coordinator.getSnapshot().stage === "selecting-index-scope", "scope stage");
  assert.equal(await coordinator.selectIndexScope(scope), true);
}

test("happy path commits the exact stage order before each side effect", async () => {
  const { coordinator, calls } = fixture();
  const stages = [];
  coordinator.subscribe((snapshot) => stages.push(snapshot.stage));
  const operation = coordinator.start();
  await passSuspensions(coordinator);
  const result = await operation;
  assert.equal(result.stage, "ready");
  assert.deepEqual(stages.filter((stage, index) => stage !== stages[index - 1]), [
    "not-started",
    "checking",
    "awaiting-consent",
    "downloading-chroma",
    "verifying-chroma",
    "installing-chroma",
    "downloading-embedding-runtime",
    "verifying-embedding-runtime",
    "installing-embedding-runtime",
    "starting-chroma",
    "downloading-embedding-model",
    "warming-up-model",
    "selecting-index-scope",
    "building-quick-index",
    "ready",
  ]);
  for (const [stage, sideEffect] of [
    ["downloading-chroma", "chroma.download"],
    ["verifying-chroma", "chroma.verify"],
    ["installing-chroma", "chroma.install"],
    ["downloading-embedding-runtime", "embedding.download"],
    ["verifying-embedding-runtime", "embedding.verify"],
    ["installing-embedding-runtime", "embedding.install"],
    ["starting-chroma", "chroma.start"],
    ["downloading-embedding-model", "model.download"],
    ["warming-up-model", "model.warm"],
    ["building-quick-index", "index.run:recent"],
  ]) {
    assert.ok(calls.indexOf(`save:${stage}`) < calls.indexOf(sideEffect), `${stage} persisted first`);
  }
});

test("legacy index reuse runs explicit migration stages and never invokes quick rebuild", async () => {
  const { coordinator, calls } = fixture({
    report: environment({
      chroma: "running",
      embeddingRuntime: "ready",
      embeddingModel: "ready",
      index: "legacy",
      recommendedAction: "repair",
    }),
  });
  const stages = [];
  coordinator.subscribe((snapshot) => stages.push(snapshot.stage));
  const operation = coordinator.start();
  await waitFor(() => coordinator.getSnapshot().stage === "awaiting-consent", "legacy consent");
  assert.equal(await coordinator.provideConsent(true), true);
  await waitFor(() => coordinator.getSnapshot().stage === "selecting-legacy-index-action", "legacy choice");

  assert.equal(await coordinator.selectLegacyIndexAction("reuse"), true);
  const result = await operation;

  assert.equal(result.stage, "ready");
  assert.equal(result.legacyIndexChoice, "reuse");
  assert.equal(result.legacyRecordsCopied, 2);
  assert.equal(result.legacyRecordsTotal, 2);
  assert.deepEqual(calls.filter((call) => typeof call === "string" && call.startsWith("legacy.")), [
    "legacy.prepare", "legacy.copy", "legacy.reconcile", "legacy.verify",
  ]);
  assert.equal(calls.some((call) => typeof call === "string" && call.startsWith("index.run:")), false);
  assert.deepEqual(stages.filter((stage, index) => stage !== stages[index - 1]).filter((stage) => stage.includes("legacy")), [
    "selecting-legacy-index-action",
    "preparing-legacy-snapshot",
    "migrating-legacy-index",
    "reconciling-legacy-index",
    "verifying-legacy-index",
  ]);
});

test("legacy rebuild is explicit and enters existing scope selection only after the choice", async () => {
  const { coordinator, calls } = fixture({
    report: environment({
      chroma: "running", embeddingRuntime: "ready", embeddingModel: "ready", index: "legacy",
    }),
  });
  const operation = coordinator.start();
  await waitFor(() => coordinator.getSnapshot().stage === "awaiting-consent");
  await coordinator.provideConsent(true);
  await waitFor(() => coordinator.getSnapshot().stage === "selecting-legacy-index-action");
  assert.equal(await coordinator.selectLegacyIndexAction("rebuild"), true);
  await waitFor(() => coordinator.getSnapshot().stage === "selecting-index-scope");
  await coordinator.selectIndexScope({ type: "recent", limit: 30 });

  assert.equal((await operation).stage, "ready");
  assert.equal(calls.includes("index.run:recent"), true);
  assert.equal(calls.includes("legacy.copy"), false);
});

test("legacy migration failure stays failed and never silently starts quick indexing", async () => {
  const { coordinator, calls } = fixture({
    report: environment({
      chroma: "running", embeddingRuntime: "ready", embeddingModel: "ready", index: "legacy",
    }),
    legacyMigration: {
      async prepare() {},
      async copy() { throw Object.assign(new Error("private path"), { code: "LEGACY_VECTOR_COPY_FAILED" }); },
      async reconcile() {},
      async verify() {},
      async cancel() {},
    },
  });
  const operation = coordinator.start();
  await waitFor(() => coordinator.getSnapshot().stage === "awaiting-consent");
  await coordinator.provideConsent(true);
  await waitFor(() => coordinator.getSnapshot().stage === "selecting-legacy-index-action");
  await coordinator.selectLegacyIndexAction("reuse");

  const result = await operation;
  assert.equal(result.stage, "failed");
  assert.equal(result.error.code, "LEGACY_INDEX_MIGRATION_FAILED");
  assert.equal(result.error.technicalMessage.includes("private"), false);
  assert.equal(calls.some((call) => typeof call === "string" && call.startsWith("index.run:")), false);
});

test("failed legacy migration can switch explicitly to rebuild without retrying vector copy", async () => {
  let copyAttempts = 0;
  const { coordinator, calls } = fixture({
    report: environment({
      chroma: "running", embeddingRuntime: "ready", embeddingModel: "ready", index: "legacy",
    }),
    legacyMigration: {
      async prepare() {},
      async copy() { copyAttempts += 1; throw Object.assign(new Error("copy"), { code: "LEGACY_VECTOR_COPY_FAILED" }); },
      async reconcile() {}, async verify() {}, async cancel() {},
    },
  });
  const first = coordinator.start();
  await waitFor(() => coordinator.getSnapshot().stage === "awaiting-consent");
  await coordinator.provideConsent(true);
  await waitFor(() => coordinator.getSnapshot().stage === "selecting-legacy-index-action");
  await coordinator.selectLegacyIndexAction("reuse");
  assert.equal((await first).stage, "failed");

  const fallback = coordinator.fallbackToLegacyRebuild();
  await waitFor(() => coordinator.getSnapshot().stage === "selecting-index-scope");
  await coordinator.selectIndexScope({ type: "recent", limit: 30 });
  assert.equal((await fallback).stage, "ready");
  assert.equal(copyAttempts, 1);
  assert.equal(calls.includes("index.run:recent"), true);
});

test("quick index finalization atomically completes data generation before ready is committed", async () => {
  const order = [];
  const { coordinator, calls } = fixture({
    finalizeQuickIndex: async (result) => {
      order.push(["finalize", clone(result)]);
    },
  });
  coordinator.subscribe((snapshot) => {
    if (snapshot.stage === "ready") order.push(["ready"]);
  });
  const operation = coordinator.start();
  await passSuspensions(coordinator);
  assert.equal((await operation).stage, "ready");

  assert.deepEqual(order, [
    ["finalize", {
      requested: 1, scopeType: "recent", selectedFileCount: 1,
      indexed: 1, skipped: 0, failed: 0, chunkCount: 1,
      selectedDocuments: [{ docId: "note.md", path: "note.md", mtime: 1 }],
    }],
    ["ready"],
  ]);
  assert.ok(calls.indexOf("index.run:recent") < calls.indexOf("save:ready"));
});

test("resume after crash between index save and finalizer replays finalization before ready", async () => {
  const order = [];
  const { coordinator, calls } = fixture({
    snapshot: baseSnapshot("building-quick-index", {
      startedAt: 50,
      selectedIndexScope: { type: "recent", limit: 30 },
    }),
    report: environment({
      chroma: "running", embeddingRuntime: "ready", embeddingModel: "ready",
      index: "partial", recommendedAction: "resume",
    }),
    runIndex: async () => ({
      requested: 1, scopeType: "recent", selectedFileCount: 1,
      indexed: 0, skipped: 1, failed: 0, chunkCount: 1,
      selectedDocuments: [{ docId: "note.md", path: "note.md", mtime: 1 }],
    }),
    finalizeQuickIndex: async () => { order.push("finalize"); },
  });
  coordinator.subscribe((snapshot) => {
    if (snapshot.stage === "ready") order.push("ready");
  });

  assert.equal((await coordinator.resume()).stage, "ready");
  assert.deepEqual(order, ["finalize", "ready"]);
  assert.equal(calls.includes("save:awaiting-consent"), false);
  assert.equal(calls.includes("index.run:recent"), true);
});

test("data generation finalization failure commits the rebuild error and never ready", async () => {
  const cause = new Error("CHROMA_REBUILD_CHUNK_COUNT_MISMATCH");
  const { coordinator, calls } = fixture({
    finalizeQuickIndex: async () => {
      throw Object.assign(new Error("CHROMA_DATA_REBUILD_FAILED"), {
        code: "CHROMA_DATA_REBUILD_FAILED",
        cause,
      });
    },
  });
  const operation = coordinator.start();
  await passSuspensions(coordinator);
  const result = await operation;

  assert.equal(result.stage, "failed");
  assert.equal(result.error.code, "CHROMA_DATA_REBUILD_FAILED");
  assert.equal(result.error.recoverable, true);
  assert.equal(calls.includes("save:ready"), false);
  assert.equal(calls.includes("save:failed"), true);
});

test("start, resume, and retry share one in-flight promise", async () => {
  const gate = deferred();
  const { coordinator, calls } = fixture({ detect: () => gate.promise });
  const first = coordinator.start();
  const second = coordinator.start();
  const third = coordinator.resume();
  const fourth = coordinator.retry();
  assert.strictEqual(first, second);
  assert.strictEqual(first, third);
  assert.strictEqual(first, fourth);
  gate.resolve(environment({ chroma: "running", embeddingRuntime: "ready", embeddingModel: "ready", index: "ready" }));
  assert.equal((await first).stage, "ready");
  assert.equal(calls.filter((entry) => entry === "detect").length, 1);
});

test("retryRuntime explicitly reinstalls only the selected runtime asset", async () => {
  const readySnapshot = baseSnapshot("ready", { startedAt: 1, completedAt: 2 });
  const chromaFixture = fixture({
    snapshot: readySnapshot,
    report: environment({
      chroma: "corrupt", embeddingRuntime: "ready", embeddingModel: "ready", index: "ready",
      recommendedAction: "repair",
    }),
  });
  assert.equal((await chromaFixture.coordinator.retryRuntime("chroma")).stage, "ready");
  assert.equal(chromaFixture.calls.filter((entry) => entry === "chroma.download").length, 1);
  assert.equal(chromaFixture.calls.filter((entry) => entry === "embedding.download").length, 0);

  const embeddingFixture = fixture({
    snapshot: readySnapshot,
    report: environment({
      chroma: "running", embeddingRuntime: "corrupt", embeddingModel: "ready", index: "ready",
      recommendedAction: "repair",
    }),
  });
  assert.equal((await embeddingFixture.coordinator.retryRuntime("embedding-runtime")).stage, "ready");
  assert.equal(embeddingFixture.calls.filter((entry) => entry === "embedding.download").length, 1);
  assert.equal(embeddingFixture.calls.filter((entry) => entry === "chroma.download").length, 0);
});

test("consent and index selection suspend explicitly and reject unsafe scope", async () => {
  const { coordinator, calls } = fixture();
  const operation = coordinator.start();
  await waitFor(() => coordinator.getSnapshot().stage === "awaiting-consent");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.includes("chroma.download"), false);
  assert.equal(await coordinator.provideConsent(true), true);
  await waitFor(() => coordinator.getSnapshot().stage === "selecting-index-scope");
  assert.equal(await coordinator.selectIndexScope({ type: "folder", path: "/Users/private/Vault" }), false);
  assert.equal(await coordinator.selectIndexScope({ type: "folder", path: "../outside" }), false);
  assert.equal(await coordinator.selectIndexScope({ type: "folder", path: "中文 文件夹" }), true);
  assert.equal((await operation).stage, "ready");
  assert.ok(calls.includes("index.run:folder"));
});

test("declining consent deterministically settles as cancelled without downloads", async () => {
  const { coordinator, calls } = fixture();
  const operation = coordinator.start();
  await waitFor(() => coordinator.getSnapshot().stage === "awaiting-consent");
  assert.equal(await coordinator.provideConsent(false), true);
  const result = await operation;
  assert.equal(result.stage, "cancelled");
  assert.ok(result.dismissedAt > 0);
  assert.equal(calls.some((entry) => entry.endsWith(".download")), false);
});

test("cancel aborts the active download and settles exactly once", async () => {
  const entered = deferred();
  const { coordinator, calls } = fixture({
    chromaPipeline: {
      download(signal) {
        entered.resolve(signal);
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(Object.assign(new Error("token=secret /Users/private"), {
            code: "DOWNLOAD_CANCELLED",
          })), { once: true });
        });
      },
    },
  });
  const operation = coordinator.start();
  await waitFor(() => coordinator.getSnapshot().stage === "awaiting-consent");
  await coordinator.provideConsent(true);
  const signal = await entered.promise;
  const firstCancel = coordinator.cancel();
  const secondCancel = coordinator.cancel();
  assert.strictEqual(firstCancel, secondCancel);
  await firstCancel;
  assert.equal(signal.aborted, true);
  assert.equal((await operation).stage, "cancelled");
  assert.equal(calls.includes("chroma.verify"), false);
  assert.equal(calls.filter((entry) => entry === "model.cancel").length, 1);
});

test("cancelling a late Chroma start stops only a process owned by this generation", async () => {
  const startGate = deferred();
  const { coordinator, calls } = fixture({
    snapshot: baseSnapshot("starting-chroma", { startedAt: 1 }),
    report: environment({ chroma: "installed", embeddingRuntime: "ready", embeddingModel: "ready", index: "ready" }),
    startChroma: () => startGate.promise,
  });
  const operation = coordinator.resume();
  await waitFor(() => calls.includes("chroma.start"));
  const cancelling = coordinator.cancel();
  startGate.resolve({ ownership: "analogy", pid: 91, executablePath: "/chroma", port: 8000,
    runtimeVersion: "1", startedAt: 1 });
  await cancelling;
  assert.equal((await operation).stage, "cancelled");
  assert.equal(calls.filter((entry) => entry === "chroma.stop").length, 1);
});

test("cancel never stops external, pre-existing, or handed-off Chroma", async (t) => {
  await t.test("external", async () => {
    const modelGate = deferred();
    const { coordinator, calls } = fixture({
      snapshot: baseSnapshot("starting-chroma", { startedAt: 1 }),
      report: environment({ chroma: "installed", embeddingRuntime: "ready", embeddingModel: "missing", index: "ready" }),
      startChroma: async () => ({ ownership: "external", pid: null, executablePath: null, port: 8000,
        runtimeVersion: "1", startedAt: null }),
      initializeModel: () => modelGate.promise,
    });
    const operation = coordinator.resume();
    await waitFor(() => calls.includes("model.warm"));
    await coordinator.cancel();
    modelGate.reject(Object.assign(new Error("cancelled"), { code: "DOWNLOAD_CANCELLED" }));
    await operation;
    assert.equal(calls.includes("chroma.stop"), false);
  });
  await t.test("pre-existing", async () => {
    const { coordinator, calls } = fixture({
      report: environment({ chroma: "running", embeddingRuntime: "ready", embeddingModel: "ready", index: "ready" }),
      chromaInitialState: { ownership: "analogy", pid: 11, executablePath: "/old", runtimeVersion: "1", startedAt: 1 },
    });
    await coordinator.resume();
    await coordinator.cancel();
    assert.equal(calls.includes("chroma.stop"), false);
  });
  await t.test("handed off", async () => {
    const { coordinator, calls } = fixture({
      snapshot: baseSnapshot("starting-chroma", { startedAt: 1 }),
      report: environment({ chroma: "installed", embeddingRuntime: "ready", embeddingModel: "ready", index: "ready" }),
    });
    assert.equal((await coordinator.resume()).stage, "ready");
    await coordinator.cancel();
    assert.equal(calls.includes("chroma.stop"), false);
  });
});

test("hash failure retry redownloads only that asset and preserves completed dependencies", async () => {
  let verifyAttempts = 0;
  let currentReport = environment();
  const { coordinator, calls } = fixture({
    detect: async () => clone(currentReport),
    chromaPipeline: {
      verify: async () => {
        verifyAttempts += 1;
        if (verifyAttempts === 1) return { ok: false, actualSize: 10, actualSha256: "b".repeat(64), errorCode: "DOWNLOAD_HASH_MISMATCH" };
        currentReport = environment({ chroma: "installed" });
        return { ok: true, actualSize: 10, actualSha256: "a".repeat(64), errorCode: null };
      },
    },
  });
  const first = coordinator.start();
  await waitFor(() => coordinator.getSnapshot().stage === "awaiting-consent");
  await coordinator.provideConsent(true);
  const failed = await first;
  assert.equal(failed.stage, "failed");
  assert.equal(failed.error.code, "DOWNLOAD_HASH_MISMATCH");
  const retried = coordinator.retry();
  await waitFor(() => coordinator.getSnapshot().stage === "selecting-index-scope");
  await coordinator.selectIndexScope({ type: "recent", limit: 30 });
  assert.equal((await retried).stage, "ready");
  assert.equal(calls.filter((entry) => entry === "chroma.download").length, 2);
  assert.equal(calls.filter((entry) => entry === "embedding.download").length, 1);
});

test("resume trusts fresh evidence, skipping valid runtimes but not a stale ready snapshot", async () => {
  const valid = fixture({
    snapshot: baseSnapshot("installing-embedding-runtime", { startedAt: 1 }),
    report: environment({ chroma: "installed", embeddingRuntime: "ready", embeddingModel: "ready", index: "ready" }),
  });
  assert.equal((await valid.coordinator.resume()).stage, "ready");
  assert.equal(valid.calls.some((entry) => entry.endsWith(".download")), false);
  assert.equal(valid.calls.includes("embedding.resolve"), true);
  assert.equal(valid.calls.includes("chroma.start"), true);

  const stale = fixture({
    snapshot: baseSnapshot("ready", { startedAt: 1, completedAt: 2 }),
    report: environment(),
  });
  const operation = stale.coordinator.resume();
  await waitFor(() => stale.coordinator.getSnapshot().stage === "selecting-index-scope");
  await stale.coordinator.selectIndexScope({ type: "vault" });
  assert.equal((await operation).stage, "ready");
  assert.equal(stale.calls.filter((entry) => entry === "chroma.download").length, 1);
  assert.equal(stale.calls.filter((entry) => entry === "embedding.download").length, 1);
});

test("stale progress, throwing listeners, unsubscribe, and listener reentry cannot corrupt state", async () => {
  let lateProgress;
  const gate = deferred();
  const { coordinator, calls } = fixture({
    chromaPipeline: {
      download: (signal, onProgress) => {
        lateProgress = onProgress;
        return gate.promise;
      },
    },
  });
  let reentered;
  const unsubscribe = coordinator.subscribe((snapshot) => {
    if (snapshot.stage === "checking") reentered = coordinator.start();
    throw new Error("listener secret /Users/private");
  });
  const first = coordinator.start();
  assert.strictEqual(reentered, undefined);
  await waitFor(() => reentered !== undefined);
  assert.strictEqual(first, reentered);
  await waitFor(() => coordinator.getSnapshot().stage === "awaiting-consent");
  await coordinator.provideConsent(true);
  await waitFor(() => typeof lateProgress === "function");
  await coordinator.cancel();
  gate.reject(Object.assign(new Error("cancelled"), { code: "DOWNLOAD_CANCELLED" }));
  await first;
  unsubscribe();
  const before = calls.filter((entry) => entry === "save:cancelled").length;
  lateProgress({ percent: 999, receivedBytes: -5, totalBytes: Infinity,
    currentItem: "https://host/model?token=secret" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.getSnapshot().stage, "cancelled");
  assert.equal(calls.filter((entry) => entry === "save:cancelled").length, before);
  assert.ok(Object.isFrozen(coordinator.getSnapshot()));
});

test("progress arriving during the next stage commit cannot roll the snapshot backward", async () => {
  const verifyingGate = deferred();
  const verifyingEntered = deferred();
  const lateProgressGate = deferred();
  let lateProgress;
  let late = false;
  let stored = baseSnapshot();
  const store = {
    async load() { return { snapshot: clone(stored) }; },
    async save(snapshot) {
      if (snapshot.stage === "verifying-chroma") {
        verifyingEntered.resolve();
        await verifyingGate.promise;
      }
      if (late && snapshot.stage === "downloading-chroma" && snapshot.progress === 91) {
        await lateProgressGate.promise;
      }
      stored = clone(snapshot);
    },
  };
  const { coordinator } = fixture({
    store,
    chromaPipeline: {
      async download(_signal, onProgress) {
        lateProgress = onProgress;
        return { path: "/chroma.part", receivedBytes: 10 };
      },
    },
  });
  const observed = [];
  coordinator.subscribe((snapshot) => {
    observed.push(snapshot.stage);
    if (snapshot.stage === "awaiting-consent") void coordinator.provideConsent(true);
    if (snapshot.stage === "selecting-index-scope") {
      void coordinator.selectIndexScope({ type: "recent", limit: 30 });
    }
  });
  const operation = coordinator.start();
  await verifyingEntered.promise;
  late = true;
  lateProgress({ receivedBytes: 9, totalBytes: 10, percent: 91, currentItem: "chroma.bin" });
  await new Promise((resolve) => setImmediate(resolve));
  verifyingGate.resolve();
  await waitFor(() => observed.includes("verifying-chroma"));
  lateProgressGate.resolve();
  assert.equal((await operation).stage, "ready");
  const verifyingIndex = observed.indexOf("verifying-chroma");
  assert.equal(observed.slice(verifyingIndex + 1).includes("downloading-chroma"), false);
});

test("technical errors are bounded and redact tokens, URLs, paths, and model input", () => {
  const { classifyOnboardingError } = coordinatorModule();
  const raw = Object.assign(new Error(
    `request https://models.invalid/file?token=super-secret /Users/alice/Vault 中文内容 ${"x".repeat(2000)}`,
  ), { code: "EMBEDDING_MODEL_DOWNLOAD_FAILED", input: "private note body" });
  const classified = classifyOnboardingError(raw, "downloading-embedding-model");
  assert.equal(classified.code, "EMBEDDING_MODEL_DOWNLOAD_FAILED");
  assert.equal(classified.recoverable, true);
  assert.ok(classified.technicalMessage.length <= 240);
  assert.doesNotMatch(classified.technicalMessage, /super-secret|Users|Vault|private note|https?:|中文内容/);
  const unknown = classifyOnboardingError(new Error("mystery"), "installing-chroma");
  assert.equal(unknown.recoverable, false);
  assert.equal(unknown.action, "none");
});

test("a transient store failure becomes a committed sanitized failure", async () => {
  let stored = baseSnapshot();
  let failed = false;
  const store = {
    async load() { return { snapshot: clone(stored), recommendedAction: "setup", migrated: false, removedLegacyKeys: [] }; },
    async save(snapshot) {
      if (!failed && snapshot.stage === "checking") {
        failed = true;
        throw Object.assign(new Error("/Users/private token=secret"), { code: "EACCES" });
      }
      stored = clone(snapshot);
    },
  };
  const { coordinator } = fixture({ store });
  const result = await coordinator.start();
  assert.equal(result.stage, "failed");
  assert.equal(result.error.code, "LOCAL_DATA_ROOT_UNAVAILABLE");
  assert.doesNotMatch(result.error.technicalMessage, /Users|secret/);
  assert.equal(stored.stage, "failed");
});

test("dispose closes new work synchronously, is single-flight, and cleans active work", async () => {
  const downloadGate = deferred();
  const { coordinator, calls } = fixture({
    chromaPipeline: {
      download(signal) {
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), {
            code: "DOWNLOAD_CANCELLED",
          })), { once: true });
          downloadGate.promise.then(resolve, reject);
        });
      },
    },
  });
  const operation = coordinator.start();
  await waitFor(() => coordinator.getSnapshot().stage === "awaiting-consent");
  await coordinator.provideConsent(true);
  await waitFor(() => calls.includes("chroma.download"));
  const first = coordinator.dispose();
  const second = coordinator.dispose();
  assert.strictEqual(first, second);
  assert.rejects(coordinator.start(), /ONBOARDING_COORDINATOR_DISPOSED/);
  await first;
  assert.equal((await operation).stage, "cancelled");
  assert.equal(calls.filter((entry) => entry === "model.cancel").length, 1);
});

test("cancellation at each asynchronous dependency boundary blocks every later stage", async (t) => {
  const cases = [
    {
      name: "detector", enteredBy: "detect",
      configure: (gate) => ({ detect: () => gate.promise }),
      value: environment(),
    },
    {
      name: "download", enteredBy: "chroma.download",
      configure: (gate) => ({ chromaPipeline: { download: () => gate.promise } }),
      value: { path: "/chroma.part", receivedBytes: 10 },
    },
    {
      name: "verify", enteredBy: "chroma.verify",
      configure: (gate) => ({ chromaPipeline: { verify: () => gate.promise } }),
      value: { ok: true, actualSize: 10, actualSha256: "a".repeat(64), errorCode: null },
    },
    {
      name: "install", enteredBy: "chroma.install",
      configure: (gate) => ({ chromaPipeline: { install: () => gate.promise } }),
      value: { runtimeId: "chroma-fixture", executablePath: "/chroma" },
    },
    {
      name: "embedding runtime resolve", enteredBy: "embedding.resolve",
      configure: (gate) => ({ resolveEmbedding: () => gate.promise }),
      value: { runtimeId: "embedding-runtime-fixture" },
    },
    {
      name: "Chroma start", enteredBy: "chroma.start",
      configure: (gate) => ({ startChroma: () => gate.promise }),
      value: { ownership: "analogy", pid: 44, executablePath: "/chroma", port: 8000,
        runtimeVersion: "1", startedAt: 1 },
    },
    {
      name: "model download", enteredBy: "model.download",
      configure: (gate) => ({ downloadModel: () => gate.promise }),
      value: undefined,
    },
    {
      name: "model warm-up", enteredBy: "model.warm",
      configure: (gate) => ({ initializeModel: (_progress, ready) => gate.promise.then(() => ready()) }),
      value: undefined,
    },
    {
      name: "quick index", enteredBy: "index.run:recent",
      configure: (gate) => ({ runIndex: () => gate.promise }),
      value: { requested: 1, indexed: 1, skipped: 0, failed: 0, chunkCount: 1 },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const gate = deferred();
      const { coordinator, calls } = fixture(item.configure(gate));
      const operation = coordinator.start();
      for (let attempt = 0; attempt < 200 && !calls.includes(item.enteredBy); attempt += 1) {
        if (coordinator.getSnapshot().stage === "awaiting-consent") await coordinator.provideConsent(true);
        if (coordinator.getSnapshot().stage === "selecting-index-scope") {
          await coordinator.selectIndexScope({ type: "recent", limit: 30 });
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.ok(calls.includes(item.enteredBy), `${item.name} entered`);
      const cancelling = coordinator.cancel();
      gate.resolve(item.value);
      await cancelling;
      assert.equal((await operation).stage, "cancelled");
      assert.equal(calls.includes("index.run:recent") && item.name !== "quick index", false);
    });
  }
});

test("cancel while a stage commit is pending cannot publish the stale stage", async () => {
  const gate = deferred();
  const seen = [];
  let firstSave = true;
  let stored = baseSnapshot();
  const store = {
    async load() { return { snapshot: clone(stored) }; },
    async save(snapshot) {
      if (firstSave) {
        firstSave = false;
        await gate.promise;
      }
      stored = clone(snapshot);
    },
  };
  const { coordinator } = fixture({ store });
  coordinator.subscribe((snapshot) => seen.push(snapshot.stage));
  const operation = coordinator.start();
  await new Promise((resolve) => setImmediate(resolve));
  const cancelling = coordinator.cancel();
  gate.resolve();
  await cancelling;
  assert.equal((await operation).stage, "cancelled");
  assert.deepEqual(seen, ["not-started", "cancelled"]);
  assert.equal(stored.stage, "cancelled");
});

test("ready listener cancellation races after handoff and cannot stop the service", async () => {
  const { coordinator, calls } = fixture({
    snapshot: baseSnapshot("starting-chroma", { startedAt: 1 }),
    report: environment({ chroma: "installed", embeddingRuntime: "ready", embeddingModel: "ready", index: "ready" }),
  });
  let cancellation;
  coordinator.subscribe((snapshot) => {
    if (snapshot.stage === "ready") cancellation = coordinator.cancel();
  });
  assert.equal((await coordinator.resume()).stage, "ready");
  await cancellation;
  assert.equal(calls.includes("chroma.stop"), false);
});

test("cleanup failures are contained and cancellation still settles", async () => {
  const startGate = deferred();
  const { coordinator, calls } = fixture({
    snapshot: baseSnapshot("starting-chroma", { startedAt: 1 }),
    report: environment({ chroma: "installed", embeddingRuntime: "ready", embeddingModel: "ready", index: "ready" }),
    startChroma: () => startGate.promise,
    stopChroma: async () => { throw new Error("cleanup /Users/private token=secret"); },
    cancelModel: async () => { throw new Error("worker cleanup failed"); },
  });
  const operation = coordinator.resume();
  await waitFor(() => calls.includes("chroma.start"));
  const cancelling = coordinator.cancel();
  startGate.resolve({ ownership: "analogy", pid: 9, executablePath: "/chroma", port: 8000,
    runtimeVersion: "1", startedAt: 1 });
  await cancelling;
  assert.equal((await operation).stage, "cancelled");
  assert.equal(calls.filter((entry) => entry === "chroma.stop").length, 1);
});

test("persistent store failure publishes only the adopted snapshot before rejecting boundedly", async () => {
  const store = {
    async load() { return { snapshot: baseSnapshot() }; },
    async save() { throw Object.assign(new Error("/Users/private token=secret"), { code: "EACCES" }); },
  };
  const { coordinator } = fixture({ store });
  const notifications = [];
  coordinator.subscribe((snapshot) => { notifications.push(snapshot.stage); });
  await assert.rejects(coordinator.start(), (error) => {
    assert.equal(error.code, "LOCAL_DATA_ROOT_UNAVAILABLE");
    assert.doesNotMatch(error.message, /Users|secret/);
    return true;
  });
  assert.deepEqual(notifications, ["not-started"]);
});

test("listeners can synchronously provide consent and scope without losing a continuation", async () => {
  const { coordinator } = fixture();
  coordinator.subscribe((snapshot) => {
    if (snapshot.stage === "awaiting-consent") void coordinator.provideConsent(true);
    if (snapshot.stage === "selecting-index-scope") {
      void coordinator.selectIndexScope({ type: "recent", limit: 30 });
    }
  });
  assert.equal((await coordinator.start()).stage, "ready");
});

test("a second resume revalidates fresh evidence instead of trusting in-memory ready flags", async () => {
  let report = environment({ chroma: "running", embeddingRuntime: "ready", embeddingModel: "ready", index: "ready" });
  const { coordinator, calls } = fixture({ detect: async () => clone(report) });
  assert.equal((await coordinator.resume()).stage, "ready");
  report = environment();
  const operation = coordinator.resume();
  await waitFor(() => coordinator.getSnapshot().stage === "selecting-index-scope");
  await coordinator.selectIndexScope({ type: "recent", limit: 30 });
  assert.equal((await operation).stage, "ready");
  assert.equal(calls.filter((entry) => entry === "chroma.download").length, 1);
  assert.equal(calls.filter((entry) => entry === "embedding.download").length, 1);
  assert.equal(calls.filter((entry) => entry === "chroma.start").length, 1);
  assert.equal(calls.filter((entry) => entry === "model.download").length, 1);
});

test("model failure cleans owned Chroma and retry starts a fresh process", async () => {
  let modelAttempts = 0;
  const { coordinator, calls } = fixture({
    initializeModel: async (_progress, ready) => {
      modelAttempts += 1;
      if (modelAttempts === 1) {
        throw Object.assign(new Error("model download failed"), { code: "EMBEDDING_MODEL_DOWNLOAD_FAILED" });
      }
      ready();
    },
  });
  const first = coordinator.start();
  await waitFor(() => coordinator.getSnapshot().stage === "awaiting-consent");
  await coordinator.provideConsent(true);
  assert.equal((await first).stage, "failed");
  assert.equal(calls.filter((entry) => entry === "chroma.stop").length, 1);
  const retry = coordinator.retry();
  await waitFor(() => coordinator.getSnapshot().stage === "selecting-index-scope");
  await coordinator.selectIndexScope({ type: "recent", limit: 30 });
  assert.equal((await retry).stage, "ready");
  assert.equal(calls.filter((entry) => entry === "chroma.start").length, 2);
  assert.equal(calls.filter((entry) => entry === "chroma.stop").length, 1);
  await coordinator.dispose();
  assert.equal(calls.filter((entry) => entry === "chroma.stop").length, 1, "ready service is handed off");
});

test("failed quick index immediately stops setup-owned Chroma before dispose", async () => {
  const { coordinator, calls } = fixture({
    runIndex: async () => { throw Object.assign(new Error("index failed"), { code: "QUICK_INDEX_FAILED" }); },
  });
  const operation = coordinator.start();
  await passSuspensions(coordinator);
  assert.equal((await operation).stage, "failed");
  assert.equal(calls.filter((entry) => entry === "chroma.stop").length, 1);
  await coordinator.dispose();
  assert.equal(calls.filter((entry) => entry === "chroma.stop").length, 1);
});

test("known dependency error codes map to the intended recovery boundary", () => {
  const { classifyOnboardingError } = coordinatorModule();
  const cases = [
    ["DOWNLOAD_INSECURE_URL", "downloading-chroma", "DOWNLOAD_NETWORK_ERROR", false, "none"],
    ["DOWNLOAD_PART_CHANGED", "downloading-chroma", "DOWNLOAD_SIZE_MISMATCH", true, "redownload"],
    ["RUNTIME_SMOKE_TEST_FAILED", "installing-chroma", "RUNTIME_SMOKE_TEST_FAILED", true, "redownload"],
    ["CHROMA_PORT_CONFLICT", "starting-chroma", "CHROMA_PORT_CONFLICT", true, "change-port"],
    ["EMBEDDING_RUNTIME_HASH_MISMATCH", "verifying-embedding-runtime", "EMBEDDING_RUNTIME_INVALID", true, "redownload"],
    ["EMBEDDING_WORKER_FAILED", "warming-up-model", "EMBEDDING_MODEL_WARMUP_FAILED", true, "retry"],
    ["QUICK_INDEX_FAILED", "building-quick-index", "QUICK_INDEX_FAILED", true, "retry"],
  ];
  for (const [code, stage, expectedCode, recoverable, action] of cases) {
    const result = classifyOnboardingError(Object.assign(new Error(code), { code }), stage);
    assert.deepEqual(
      [result.code, result.recoverable, result.action],
      [expectedCode, recoverable, action],
      code,
    );
  }
});

test("cancel wins while ready persistence is blocked and prevents ready handoff", async () => {
  const readySave = deferred();
  const readyEntered = deferred();
  let stored = baseSnapshot();
  const store = {
    async load() { return { snapshot: clone(stored) }; },
    async save(snapshot) {
      if (snapshot.stage === "ready") {
        readyEntered.resolve();
        await readySave.promise;
      }
      stored = clone(snapshot);
    },
  };
  const { coordinator, calls } = fixture({ store });
  const observed = [];
  coordinator.subscribe((snapshot) => {
    observed.push(snapshot.stage);
    if (snapshot.stage === "awaiting-consent") void coordinator.provideConsent(true);
    if (snapshot.stage === "selecting-index-scope") {
      void coordinator.selectIndexScope({ type: "recent", limit: 30 });
    }
  });
  const operation = coordinator.start();
  await readyEntered.promise;
  const cancellation = coordinator.cancel();
  readySave.resolve();
  await cancellation;
  assert.equal((await operation).stage, "cancelled");
  assert.equal(stored.stage, "cancelled");
  assert.equal(observed.includes("ready"), false);
  assert.equal(calls.filter((entry) => entry === "chroma.stop").length, 1);
});

test("cleanup compares the complete Chroma lease and never stops a replacement PID", async () => {
  let liveState;
  const { coordinator, calls } = fixture({
    startChroma: async (_options, state) => {
      liveState = state;
      Object.assign(state, { ownership: "analogy", pid: 41, executablePath: "/chroma", port: 8000,
        runtimeVersion: "1", startedAt: 101 });
      return { ...state };
    },
    initializeModel: async () => {
      Object.assign(liveState, { pid: 99, startedAt: 202, executablePath: "/replacement" });
      throw Object.assign(new Error("model failed"), { code: "EMBEDDING_MODEL_WARMUP_FAILED" });
    },
  });
  const operation = coordinator.start();
  await waitFor(() => coordinator.getSnapshot().stage === "awaiting-consent");
  await coordinator.provideConsent(true);
  assert.equal((await operation).stage, "failed");
  assert.equal(calls.filter((entry) => entry === "chroma.stop").length, 1);
  const stopCall = calls.find((entry) => typeof entry === "object" && entry.expectedLease);
  assert.deepEqual(stopCall.expectedLease, {
    ownership: "analogy", pid: 41, executablePath: "/chroma", port: 8000,
    runtimeVersion: "1", startedAt: 101,
  });
});

test("progress persistence rejection is handled immediately and becomes a bounded failure", async () => {
  let stored = baseSnapshot();
  let rejectProgress = true;
  const store = {
    async load() { return { snapshot: clone(stored) }; },
    async save(snapshot) {
      if (rejectProgress && snapshot.stage === "downloading-chroma" && snapshot.progress !== null) {
        rejectProgress = false;
        throw Object.assign(new Error("/Users/private token=secret"), { code: "EACCES" });
      }
      stored = clone(snapshot);
    },
  };
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    const { coordinator } = fixture({
      store,
      chromaPipeline: {
        download: (_signal, onProgress) => {
          onProgress({ receivedBytes: 7, totalBytes: 10, percent: 70, currentItem: "chroma.bin" });
          return new Promise((resolve) => setImmediate(() => resolve({ path: "/chroma.part", receivedBytes: 10 })));
        },
      },
    });
    const operation = coordinator.start();
    await waitFor(() => coordinator.getSnapshot().stage === "awaiting-consent");
    await coordinator.provideConsent(true);
    const result = await operation;
    assert.equal(result.stage, "failed");
    assert.equal(result.error.code, "LOCAL_DATA_ROOT_UNAVAILABLE");
    assert.doesNotMatch(result.error.technicalMessage, /Users|secret/);
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("the first progress persistence error wins over a later dependency rejection", async () => {
  let stored = baseSnapshot();
  let rejectProgress = true;
  const store = {
    async load() { return { snapshot: clone(stored) }; },
    async save(snapshot) {
      if (rejectProgress && snapshot.stage === "downloading-chroma" && snapshot.progress !== null) {
        rejectProgress = false;
        throw Object.assign(new Error("/Users/private token=secret"), { code: "EACCES" });
      }
      stored = clone(snapshot);
    },
  };
  const { coordinator } = fixture({
    store,
    chromaPipeline: {
      download: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        throw Object.assign(new Error("network failed"), { code: "DOWNLOAD_NETWORK_ERROR" });
      },
    },
  });
  const operation = coordinator.start();
  await waitFor(() => coordinator.getSnapshot().stage === "awaiting-consent");
  await coordinator.provideConsent(true);
  const result = await operation;
  assert.equal(result.stage, "failed");
  assert.equal(result.error.code, "LOCAL_DATA_ROOT_UNAVAILABLE");
});

test("retry invalidates old evidence when the fresh detector reports a corrupt runtime", async () => {
  let detectAttempt = 0;
  let modelAttempt = 0;
  const { coordinator, calls } = fixture({
    detect: async () => {
      detectAttempt += 1;
      return detectAttempt === 1 ? environment() : environment({
        chroma: "corrupt", embeddingRuntime: "ready", embeddingModel: "missing", index: "ready",
      });
    },
    initializeModel: async (_progress, ready) => {
      modelAttempt += 1;
      if (modelAttempt === 1) {
        throw Object.assign(new Error("model failed"), { code: "EMBEDDING_MODEL_WARMUP_FAILED" });
      }
      ready();
    },
  });
  const first = coordinator.start();
  await waitFor(() => coordinator.getSnapshot().stage === "awaiting-consent");
  await coordinator.provideConsent(true);
  assert.equal((await first).stage, "failed");
  assert.equal((await coordinator.retry()).stage, "ready");
  assert.equal(calls.filter((entry) => entry === "chroma.download").length, 2);
  assert.equal(calls.filter((entry) => entry === "chroma.start").length, 2);
});

test("model download and warm-up are separate persisted side effects", async () => {
  const events = [];
  let ready = false;
  const { coordinator } = fixture({
    embeddingModel: {
      isReady: () => ready,
      async download(_signal, onProgress) {
        events.push("model.download");
        onProgress({ phase: "downloading", file: "model.onnx", loadedBytes: 5, totalBytes: 10, percent: 50 });
      },
      async warmUp(_signal, onProgress) {
        events.push("model.warm");
        onProgress({ phase: "loading", file: null, loadedBytes: null, totalBytes: null, percent: 100 });
        ready = true;
      },
      async cancel() { events.push("model.cancel"); },
    },
    initializeModel: async () => { throw new Error("combined initialize must not run"); },
    store: {
      async load() { return { snapshot: baseSnapshot() }; },
      async save(snapshot) {
        if (snapshot.stage === "downloading-embedding-model" && snapshot.progress === null) {
          events.push("save:downloading-embedding-model");
        }
        if (snapshot.stage === "warming-up-model" && snapshot.progress === null) {
          events.push("save:warming-up-model");
        }
      },
    },
  });
  const operation = coordinator.start();
  await waitFor(() => coordinator.getSnapshot().stage === "awaiting-consent");
  await coordinator.provideConsent(true);
  await waitFor(() => coordinator.getSnapshot().stage === "selecting-index-scope");
  await coordinator.selectIndexScope({ type: "recent", limit: 30 });
  assert.equal((await operation).stage, "ready");
  assert.deepEqual(events.filter((event) => event !== "model.cancel"), [
    "save:downloading-embedding-model", "model.download",
    "save:warming-up-model", "model.warm",
  ]);
});

test("retry fails closed from the persisted nonrecoverable snapshot before checking", async () => {
  const persisted = baseSnapshot("failed", {
    startedAt: 1,
    error: {
      code: "UNSUPPORTED_PLATFORM", stage: "checking",
      userMessageKey: "onboarding.error.unsupported_platform", technicalMessage: "UNSUPPORTED_PLATFORM",
      recoverable: false, action: "open-help",
    },
  });
  const { coordinator, calls } = fixture({ snapshot: persisted });
  const operation = coordinator.retry();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const detectorCalls = calls.filter((entry) => entry === "detect").length;
  await coordinator.cancel();
  const result = await operation;
  assert.equal(detectorCalls, 0);
  assert.equal(result.stage, "failed");
  assert.equal(calls.some((entry) => entry.startsWith("save:")), false);
});

test("adopting a persisted nonrecoverable failure publishes it before fail-closed return", async () => {
  const persisted = baseSnapshot("failed", {
    startedAt: 1,
    error: {
      code: "UNSUPPORTED_PLATFORM", stage: "checking",
      userMessageKey: "onboarding.error.unsupported_platform", technicalMessage: "UNSUPPORTED_PLATFORM",
      recoverable: false, action: "open-help",
    },
  });
  const { coordinator } = fixture({ snapshot: persisted });
  const observed = [];
  coordinator.subscribe((value) => observed.push(value));

  const result = await coordinator.retry();

  assert.equal(result.stage, "failed");
  assert.equal(observed.length, 1, "the adopted store snapshot must be observable even when retry fails closed");
  assert.equal(observed[0].error.code, "UNSUPPORTED_PLATFORM");
});
