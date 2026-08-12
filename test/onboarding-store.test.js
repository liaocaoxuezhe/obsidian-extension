"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

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

function modules() {
  return {
    ...loadTypeScriptFile(path.join(process.cwd(), "src/runtime/runtime-paths.ts")),
    ...loadTypeScriptFile(path.join(process.cwd(), "src/onboarding/onboarding-types.ts")),
    ...loadTypeScriptFile(path.join(process.cwd(), "src/onboarding/onboarding-store.ts")),
  };
}

async function fixture(t, options = {}) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "Analogy onboarding 中文 "));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const paths = modules().createRuntimePaths(root, "vault-v2-0123456789abcdef");
  const store = new (modules().OnboardingStore)({ paths, ...options });
  return { root, paths, store };
}

function snapshot(stage, overrides = {}) {
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
    startedAt: null,
    updatedAt: 10,
    completedAt: null,
    dismissedAt: null,
    error: null,
    ...overrides,
  };
}

async function readState(filename) {
  return JSON.parse(await fs.promises.readFile(filename, "utf8"));
}

async function waitForState(filename, predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readState(filename);
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for persisted onboarding state");
}

async function createPrivateVaultDirectories(paths) {
  await fs.promises.mkdir(path.join(paths.root, "vaults"), { mode: 0o700 });
  await fs.promises.chmod(path.join(paths.root, "vaults"), 0o700);
  await fs.promises.mkdir(paths.vaultRoot, { mode: 0o700 });
  await fs.promises.chmod(paths.vaultRoot, 0o700);
}

test("missing and partial legacy state normalize to deterministic recovery actions", async (t) => {
  const { paths, store } = await fixture(t);
  const missing = await store.load();
  assert.equal(missing.snapshot.stage, "not-started");
  assert.equal(missing.recommendedAction, "setup");

  await createPrivateVaultDirectories(paths);
  await fs.promises.writeFile(
    paths.onboardingState,
    JSON.stringify({ stage: "downloading-chroma", progress: 12 }),
    { encoding: "utf8", mode: 0o600 },
  );
  const partial = await store.load();
  assert.equal(partial.snapshot.schemaVersion, 1);
  assert.equal(partial.snapshot.stage, "downloading-chroma");
  assert.equal(partial.snapshot.progress, 12);
  assert.equal(partial.snapshot.completedBytes, null);
  assert.equal(partial.recommendedAction, "resume");
});

test("a not-yet-created local data root loads read-only and is created privately only on save", async (t) => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), "Analogy absent root "));
  t.after(() => fs.promises.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "Analogy 本地数据");
  const paths = modules().createRuntimePaths(root, "vault-v2-0123456789abcdef");
  const store = new (modules().OnboardingStore)({ paths });
  assert.equal((await store.load()).snapshot.stage, "not-started");
  assert.equal(fs.existsSync(root), false);
  await store.reset();
  assert.equal(fs.existsSync(root), false);
  await store.save(snapshot("checking"));
  assert.equal((await fs.promises.stat(root)).mode & 0o777, 0o700);
  assert.equal((await fs.promises.stat(paths.vaultRoot)).mode & 0o777, 0o700);
});

test("schema 1 restart states map failed, ready, and cancelled deterministically", async (t) => {
  const { paths, store } = await fixture(t);
  await store.save(snapshot("failed", {
    error: {
      code: "DOWNLOAD_NETWORK_ERROR", stage: "downloading-chroma",
      userMessageKey: "onboarding.error.network", technicalMessage: "network failed",
      recoverable: true, action: "retry",
    },
  }));
  assert.equal((await store.load()).recommendedAction, "repair");
  await store.save(snapshot("ready", { progress: 100, completedAt: 20 }));
  assert.equal((await store.load()).recommendedAction, "start-services");
  await store.save(snapshot("cancelled"));
  assert.equal((await store.load()).recommendedAction, "setup");
  assert.equal((await readState(paths.onboardingState)).stage, "cancelled");
});

test("persisted legacy migration failures from older builds are upgraded to retryable", async (t) => {
  const { paths, store } = await fixture(t);
  await createPrivateVaultDirectories(paths);
  await fs.promises.writeFile(paths.onboardingState, JSON.stringify(snapshot("failed", {
    error: {
      code: "LEGACY_INDEX_MIGRATION_FAILED",
      stage: "reconciling-legacy-index",
      userMessageKey: "onboarding.error.legacy_index_migration_failed",
      technicalMessage: "LEGACY_INDEX_MIGRATION_FAILED",
      recoverable: false,
      action: "none",
    },
  })), { encoding: "utf8", mode: 0o600 });

  const loaded = await store.load();

  assert.equal(loaded.recommendedAction, "repair");
  assert.equal(loaded.snapshot.error.recoverable, true);
  assert.equal(loaded.snapshot.error.action, "retry");
});

test("unknown future schema and corrupt JSON fail closed without deleting source", async (t) => {
  const { paths, store } = await fixture(t);
  await createPrivateVaultDirectories(paths);
  const future = '{"schemaVersion":2,"stage":"ready","future":"keep me"}\n';
  await fs.promises.writeFile(paths.onboardingState, future, { encoding: "utf8", mode: 0o600 });
  await assert.rejects(store.load(), /ONBOARDING_STATE_UNSUPPORTED_SCHEMA/);
  assert.equal(await fs.promises.readFile(paths.onboardingState, "utf8"), future);

  await fs.promises.writeFile(paths.onboardingState, "{broken", "utf8");
  await assert.rejects(store.load(), /ONBOARDING_STATE_CORRUPT/);
  assert.equal(await fs.promises.readFile(paths.onboardingState, "utf8"), "{broken");
});

test("save uses a private regular file and never persists secrets or device-specific fields", async (t) => {
  const { paths, store } = await fixture(t);
  await store.save(snapshot("downloading-embedding-model", {
    progress: 50,
    completedBytes: 5,
    totalBytes: 10,
    currentItem: "https://models.example/%2FUsers%2Fprivate%2Ffile.onnx?token=super-secret",
    selectedIndexScope: { type: "folder", path: "/Users/private/Vault/Secret" },
    error: {
      code: "EMBEDDING_MODEL_DOWNLOAD_FAILED", stage: "downloading-embedding-model",
      userMessageKey: "onboarding.error.model", technicalMessage: "PID 42 /Users/private token=super-secret port 8000",
      recoverable: true, action: "retry",
    },
    runtimePath: "/Users/private/runtime",
    port: 8000,
    pid: 42,
  }));

  const body = await fs.promises.readFile(paths.onboardingState, "utf8");
  const state = JSON.parse(body);
  const mode = (await fs.promises.stat(paths.onboardingState)).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal(state.currentItem, "");
  assert.equal(state.selectedIndexScope, null);
  assert.equal(state.error.technicalMessage, "EMBEDDING_MODEL_DOWNLOAD_FAILED");
  assert.doesNotMatch(body, /super-secret|\/Users\/private|8000|"pid"|"port"|runtimePath/);
});

test("load, save, and reset reject symlink or non-regular state targets", async (t) => {
  const { root, paths, store } = await fixture(t);
  await createPrivateVaultDirectories(paths);
  const outside = path.join(root, "outside.json");
  await fs.promises.writeFile(outside, JSON.stringify(snapshot("ready")), "utf8");
  await fs.promises.symlink(outside, paths.onboardingState);
  await assert.rejects(store.load(), /ONBOARDING_STATE_UNSAFE_PATH/);
  await assert.rejects(store.save(snapshot("ready")), /ONBOARDING_STATE_UNSAFE_PATH/);
  await assert.rejects(store.reset(), /ONBOARDING_STATE_UNSAFE_PATH/);
  assert.equal((await readState(outside)).stage, "ready");
});

test("atomic rename failure preserves the previous JSON and removes private temp files", async (t) => {
  const first = await fixture(t);
  await first.store.save(snapshot("awaiting-consent"));
  const previous = await fs.promises.readFile(first.paths.onboardingState, "utf8");
  const failing = new (modules().OnboardingStore)({
    paths: first.paths,
    rename: async () => { throw new Error("simulated rename failure"); },
  });
  await assert.rejects(failing.save(snapshot("downloading-chroma")), /simulated rename failure/);
  assert.equal(await fs.promises.readFile(first.paths.onboardingState, "utf8"), previous);
  assert.deepEqual((await fs.promises.readdir(first.paths.vaultRoot)).sort(), ["onboarding-state.json"]);
});

test("a failed immediate stage write remains an immediate write when retried", async (t) => {
  const { paths } = await fixture(t);
  let failRename = true;
  const store = new (modules().OnboardingStore)({
    paths,
    progressThrottleMs: 5_000,
    rename: async (source, target) => {
      if (failRename) throw new Error("stage write failed");
      await fs.promises.rename(source, target);
    },
  });
  await assert.rejects(store.save(snapshot("checking")), /stage write failed/);
  failRename = false;
  await store.save(snapshot("checking"));
  assert.equal((await readState(paths.onboardingState)).stage, "checking");
});

test("progress writes are trailing-edge throttled and flush persists the last update", async (t) => {
  const { paths, store } = await fixture(t, { progressThrottleMs: 80 });
  await store.save(snapshot("downloading-chroma", { progress: 1, updatedAt: 1 }));
  await store.save(snapshot("downloading-chroma", { progress: 2, updatedAt: 2 }));
  await store.save(snapshot("downloading-chroma", { progress: 3, updatedAt: 3 }));
  assert.equal((await readState(paths.onboardingState)).progress, 1);
  await store.flush();
  assert.equal((await readState(paths.onboardingState)).progress, 3);

  await store.save(snapshot("downloading-chroma", { progress: 4, updatedAt: 4 }));
  assert.equal((await readState(paths.onboardingState)).progress, 3);
  assert.equal((await waitForState(paths.onboardingState, (state) => state.progress === 4)).progress, 4);
});

test("timer persistence failures remain observable and retryable without losing pending progress", async (t) => {
  const { paths, store: initial } = await fixture(t);
  await initial.save(snapshot("downloading-chroma", { progress: 1, updatedAt: 1 }));
  let failRename = true;
  const store = new (modules().OnboardingStore)({
    paths,
    progressThrottleMs: 25,
    rename: async (source, target) => {
      if (failRename) throw new Error("simulated progress persistence failure");
      await fs.promises.rename(source, target);
    },
  });
  await store.load();
  await store.save(snapshot("downloading-chroma", { progress: 90, updatedAt: 2 }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(store.dispose(), /simulated progress persistence failure/);
  assert.equal((await readState(paths.onboardingState)).progress, 1);
  await assert.rejects(store.save(snapshot("ready")), /ONBOARDING_STORE_DISPOSED/);
  await assert.rejects(store.reset(), /ONBOARDING_STORE_DISPOSED/);
  await assert.rejects(store.load({
    legacySettings: { onboardingStage: "ready" },
  }), /ONBOARDING_STORE_DISPOSED/);

  failRename = false;
  await store.flush();
  assert.equal((await readState(paths.onboardingState)).progress, 90);
  await store.dispose();
});

test("dispose closes writes synchronously before its first await and cannot publish a late save", async (t) => {
  const { paths, store: initial } = await fixture(t);
  await initial.save(snapshot("downloading-chroma", { progress: 1, updatedAt: 1 }));
  let releaseRename;
  const releaseRenamePromise = new Promise((resolve) => { releaseRename = resolve; });
  const store = new (modules().OnboardingStore)({
    paths,
    progressThrottleMs: 5_000,
    rename: async (source, target) => {
      await releaseRenamePromise;
      await fs.promises.rename(source, target);
    },
  });
  await store.load();
  await store.save(snapshot("downloading-chroma", { progress: 90, updatedAt: 2 }));

  const disposing = store.dispose();
  const lateSave = store.save(snapshot("ready", { progress: 100, completedAt: 3, updatedAt: 3 }));
  const lateReset = store.reset();
  let saveError = null;
  let resetError = null;
  void lateSave.catch((error) => { saveError = error; });
  void lateReset.catch((error) => { resetError = error; });
  await Promise.resolve();
  releaseRename();
  await Promise.allSettled([disposing, lateSave, lateReset]);

  assert.match(saveError?.message ?? "", /ONBOARDING_STORE_DISPOSED/);
  assert.match(resetError?.message ?? "", /ONBOARDING_STORE_DISPOSED/);

  const persisted = await readState(paths.onboardingState);
  assert.equal(persisted.stage, "downloading-chroma");
  assert.equal(persisted.progress, 90);
});

test("dispose cancels an entered terminal save waiting on pending progress before it can publish", async (t) => {
  const { paths, store: initial } = await fixture(t);
  await initial.save(snapshot("downloading-chroma", { progress: 1, updatedAt: 1 }));
  let renameCalls = 0;
  let releasePendingRename;
  let pendingRenameStarted;
  let disposalResolved = false;
  const stagesRenamedAfterDispose = [];
  const releasePendingRenamePromise = new Promise((resolve) => { releasePendingRename = resolve; });
  const pendingRenameStartedPromise = new Promise((resolve) => { pendingRenameStarted = resolve; });
  const store = new (modules().OnboardingStore)({
    paths,
    progressThrottleMs: 5_000,
    rename: async (source, target) => {
      renameCalls += 1;
      const state = await readState(source);
      if (renameCalls === 1) {
        pendingRenameStarted();
        await releasePendingRenamePromise;
      }
      if (disposalResolved) stagesRenamedAfterDispose.push(state.stage);
      await fs.promises.rename(source, target);
    },
  });
  await store.load();
  await store.save(snapshot("downloading-chroma", { progress: 90, updatedAt: 2 }));

  let terminalSettled = false;
  const terminalSave = store.save(snapshot("ready", {
    progress: 100, completedAt: 3, updatedAt: 3,
  }));
  const terminalResult = terminalSave.then(
    () => ({ status: "fulfilled" }),
    (error) => ({ status: "rejected", error }),
  ).finally(() => { terminalSettled = true; });
  await pendingRenameStartedPromise;
  const disposal = store.dispose();
  const markedDisposal = disposal.then(() => { disposalResolved = true; });
  releasePendingRename();

  await markedDisposal;
  const terminalWasSettledAtDisposal = terminalSettled;
  const result = await terminalResult;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(terminalWasSettledAtDisposal, true);
  assert.equal(result.status, "rejected");
  assert.match(result.error?.message ?? "", /ONBOARDING_STORE_DISPOSED/);
  assert.equal(renameCalls, 1);
  assert.deepEqual(stagesRenamedAfterDispose, []);
  assert.equal((await readState(paths.onboardingState)).stage, "downloading-chroma");
  assert.equal((await readState(paths.onboardingState)).progress, 90);
});

test("dispose waits for an entered legacy load and cancels migration before its asynchronous write", async (t) => {
  const { paths } = await fixture(t);
  let renameAfterDispose = false;
  const store = new (modules().OnboardingStore)({
    paths,
    rename: async (source, target) => {
      if (disposalResolved) renameAfterDispose = true;
      await fs.promises.rename(source, target);
    },
  });
  const originalOpen = fs.promises.open;
  let releaseRead;
  let readStarted;
  let blockStateRead = true;
  let disposalResolved = false;
  const releaseReadPromise = new Promise((resolve) => { releaseRead = resolve; });
  const readStartedPromise = new Promise((resolve) => { readStarted = resolve; });
  fs.promises.open = async function blockedOpen(filename, ...args) {
    if (blockStateRead && filename === paths.onboardingState) {
      blockStateRead = false;
      readStarted();
      await releaseReadPromise;
    }
    return originalOpen.call(this, filename, ...args);
  };
  t.after(() => { fs.promises.open = originalOpen; });

  const migration = store.load({
    legacySettings: { onboardingStage: "checking", uiLanguage: "zh" },
  });
  const migrationResult = migration.then(
    () => ({ status: "fulfilled" }),
    (error) => ({ status: "rejected", error }),
  );
  await readStartedPromise;
  const disposal = store.dispose().then(
    () => { disposalResolved = true; return { status: "fulfilled" }; },
    (error) => ({ status: "rejected", error }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const disposalSettledWhileReadWasBlocked = disposalResolved;
  releaseRead();

  const [migrationOutcome, disposalOutcome] = await Promise.all([migrationResult, disposal]);
  assert.equal(disposalSettledWhileReadWasBlocked, false);
  assert.equal(disposalOutcome.status, "fulfilled");
  assert.equal(migrationOutcome.status, "rejected");
  assert.match(migrationOutcome.error?.message ?? "", /ONBOARDING_STORE_DISPOSED/);
  assert.equal(renameAfterDispose, false);
  assert.equal(fs.existsSync(paths.onboardingState), false);
});

test("concurrent dispose and disposing flush calls share one atomic publication", async (t) => {
  const { paths, store: initial } = await fixture(t);
  await initial.save(snapshot("downloading-chroma", { progress: 1, updatedAt: 1 }));
  let renameCalls = 0;
  let releaseRename;
  let renameStarted;
  const releaseRenamePromise = new Promise((resolve) => { releaseRename = resolve; });
  const renameStartedPromise = new Promise((resolve) => { renameStarted = resolve; });
  const store = new (modules().OnboardingStore)({
    paths,
    progressThrottleMs: 5_000,
    rename: async (source, target) => {
      renameCalls += 1;
      renameStarted();
      await releaseRenamePromise;
      await fs.promises.rename(source, target);
    },
  });
  await store.load();
  await store.save(snapshot("downloading-chroma", { progress: 90, updatedAt: 2 }));

  const firstDispose = store.dispose();
  const secondDispose = store.dispose();
  const disposingFlush = store.flush();
  const sharedPromise = firstDispose === secondDispose && firstDispose === disposingFlush;
  await renameStartedPromise;
  assert.equal(renameCalls, 1);
  releaseRename();
  await Promise.all([firstDispose, secondDispose, disposingFlush]);

  assert.equal(sharedPromise, true);
  assert.equal(renameCalls, 1);
  assert.equal((await readState(paths.onboardingState)).progress, 90);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renameCalls, 1);
});

test("a failed disposal flight is cleared once and concurrent retry callers share one retry", async (t) => {
  const { paths, store: initial } = await fixture(t);
  await initial.save(snapshot("downloading-chroma", { progress: 1, updatedAt: 1 }));
  let renameCalls = 0;
  let failRename = true;
  const store = new (modules().OnboardingStore)({
    paths,
    progressThrottleMs: 5_000,
    rename: async (source, target) => {
      renameCalls += 1;
      if (failRename) throw new Error("single-flight disposal failure");
      await fs.promises.rename(source, target);
    },
  });
  await store.load();
  await store.save(snapshot("downloading-chroma", { progress: 90, updatedAt: 2 }));

  const firstDispose = store.dispose();
  const secondDispose = store.dispose();
  const firstFlush = store.flush();
  const firstResults = await Promise.allSettled([firstDispose, secondDispose, firstFlush]);
  assert.equal(firstDispose === secondDispose && firstDispose === firstFlush, true);
  assert.equal(firstResults.every((result) => result.status === "rejected"), true);
  assert.equal(renameCalls, 1);
  await assert.rejects(store.save(snapshot("ready")), /ONBOARDING_STORE_DISPOSED/);

  failRename = false;
  const retryFlush = store.flush();
  const retryDispose = store.dispose();
  assert.equal(retryFlush, retryDispose);
  await Promise.all([retryFlush, retryDispose]);
  assert.equal(renameCalls, 2);
  assert.equal((await readState(paths.onboardingState)).progress, 90);
});

test("stage transitions bypass progress throttling and dispose never loses terminal state", async (t) => {
  const { paths, store } = await fixture(t, { progressThrottleMs: 5_000 });
  await store.save(snapshot("downloading-chroma", { progress: 1, updatedAt: 1 }));
  await store.save(snapshot("downloading-chroma", { progress: 90, updatedAt: 2 }));
  await store.save(snapshot("verifying-chroma", { progress: null, updatedAt: 3 }));
  assert.equal((await readState(paths.onboardingState)).stage, "verifying-chroma");
  await store.save(snapshot("ready", { progress: 100, updatedAt: 4, completedAt: 4 }));
  await store.dispose();
  assert.equal((await readState(paths.onboardingState)).stage, "ready");
});

test("concurrent saves remain complete and reset cannot resurrect queued progress", async (t) => {
  const { paths, store } = await fixture(t, { progressThrottleMs: 30 });
  const writes = ["checking", "awaiting-consent", "downloading-chroma", "verifying-chroma"]
    .map((stage, index) => store.save(snapshot(stage, { updatedAt: index + 1 })));
  await Promise.all(writes);
  assert.equal((await readState(paths.onboardingState)).stage, "verifying-chroma");

  await store.save(snapshot("verifying-chroma", { progress: 60, updatedAt: 10 }));
  await store.reset();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fs.existsSync(paths.onboardingState), false);
  await store.save(snapshot("not-started", { updatedAt: 20 }));
  assert.equal((await readState(paths.onboardingState)).stage, "not-started");
});

test("disposed stores consistently reject save and reset", async (t) => {
  const { store } = await fixture(t);
  await store.save(snapshot("checking"));
  await store.dispose();
  await assert.rejects(store.save(snapshot("ready")), /ONBOARDING_STORE_DISPOSED/);
  await assert.rejects(store.reset(), /ONBOARDING_STORE_DISPOSED/);
});

test("POSIX state and pre-existing directories must be private and owned", async (t) => {
  if (process.platform === "win32") return;
  const value = await fixture(t);
  await value.store.save(snapshot("checking"));
  await fs.promises.chmod(value.paths.onboardingState, 0o644);
  await assert.rejects(value.store.load(), /ONBOARDING_STATE_UNSAFE_(MODE|OWNER)/);

  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), "Analogy insecure dirs "));
  t.after(() => fs.promises.rm(parent, { recursive: true, force: true }));
  await fs.promises.chmod(parent, 0o700);
  const root = path.join(parent, "Analogy");
  const paths = modules().createRuntimePaths(root, "vault-v2-0123456789abcdef");
  await fs.promises.mkdir(path.join(root, "vaults"), { recursive: true, mode: 0o755 });
  await fs.promises.chmod(path.join(root, "vaults"), 0o755);
  const store = new (modules().OnboardingStore)({ paths });
  await assert.rejects(store.save(snapshot("checking")), /ONBOARDING_STATE_UNSAFE_MODE/);
  assert.equal((await fs.promises.stat(path.join(root, "vaults"))).mode & 0o777, 0o755);
});

test("Windows policy rejects symlinks without applying POSIX mode assumptions", async (t) => {
  const { root, paths } = await fixture(t);
  await fs.promises.mkdir(paths.vaultRoot, { recursive: true });
  await fs.promises.chmod(paths.vaultRoot, 0o755);
  await fs.promises.writeFile(paths.onboardingState, `${JSON.stringify(snapshot("ready"))}\n`, { mode: 0o644 });
  const windowsStore = new (modules().OnboardingStore)({ paths, platform: "win32" });
  assert.equal((await windowsStore.load()).snapshot.stage, "ready");

  const outside = path.join(root, "windows-outside.json");
  await fs.promises.writeFile(outside, `${JSON.stringify(snapshot("ready"))}\n`);
  await fs.promises.unlink(paths.onboardingState);
  await fs.promises.symlink(outside, paths.onboardingState);
  await assert.rejects(windowsStore.load(), /ONBOARDING_STATE_UNSAFE_PATH/);
});

test("recognized legacy settings migrate once, only after local atomic persistence succeeds", async (t) => {
  const { paths, store } = await fixture(t);
  const legacy = {
    uiLanguage: "zh",
    embeddingModel: "bge-small-zh",
    onboardingStage: "downloading-embedding-runtime",
    onboardingProgress: 40,
    onboardingRuntimePlatform: "darwin-arm64",
    onboardingChromaRuntimeId: "chroma-cli-1.4.4-darwin-arm64",
    onboardingCurrentItem: "runtime.zip?token=secret",
    unrelatedFuturePreference: { keep: true },
  };
  let persistedSettings = null;
  const result = await store.load({
    legacySettings: legacy,
    persistSanitizedSettings: async (settings) => { persistedSettings = settings; },
  });
  assert.equal(result.migrated, true);
  assert.equal(result.snapshot.stage, "downloading-embedding-runtime");
  assert.equal(result.recommendedAction, "resume");
  assert.deepEqual(result.removedLegacyKeys.sort(), [
    "onboardingChromaRuntimeId", "onboardingCurrentItem", "onboardingProgress",
    "onboardingRuntimePlatform", "onboardingStage",
  ]);
  assert.deepEqual(persistedSettings, {
    uiLanguage: "zh", embeddingModel: "bge-small-zh", unrelatedFuturePreference: { keep: true },
  });
  assert.equal((await readState(paths.onboardingState)).currentItem, "");

  const second = await store.load({ legacySettings: persistedSettings });
  assert.equal(second.migrated, false);
  assert.equal(second.snapshot.stage, "downloading-embedding-runtime");
});

test("platform-only legacy fields become a resumable local checking snapshot", async (t) => {
  const { paths, store } = await fixture(t);
  const result = await store.load({
    legacySettings: {
      uiLanguage: "en",
      onboardingRuntimePlatform: "win32-x64",
      onboardingEmbeddingRuntimeId: "embedding-node22-v1-win32-x64",
    },
  });
  assert.equal(result.migrated, true);
  assert.equal(result.snapshot.stage, "checking");
  assert.equal(result.snapshot.runtimePlatform, "win32-x64");
  assert.equal(result.snapshot.embeddingRuntimeId, "embedding-node22-v1-win32-x64");
  assert.equal(result.recommendedAction, "resume");
  assert.equal((await readState(paths.onboardingState)).stage, "checking");
});

test("legacy source is not sanitized when the local atomic migration write fails", async (t) => {
  const { paths } = await fixture(t);
  const store = new (modules().OnboardingStore)({
    paths,
    rename: async () => { throw new Error("disk unavailable"); },
  });
  const legacy = { uiLanguage: "en", onboardingStage: "checking" };
  let callbackCalls = 0;
  await assert.rejects(store.load({
    legacySettings: legacy,
    persistSanitizedSettings: async () => { callbackCalls += 1; },
  }), /disk unavailable/);
  assert.equal(callbackCalls, 0);
  assert.deepEqual(legacy, { uiLanguage: "en", onboardingStage: "checking" });
});

test("credential markers, residual encoded separators, and unsafe basenames are never persisted", async (t) => {
  const cases = [
    "weights.onnx%25253Ftoken%25253Dsuper-secret",
    "weights-token-super-secret.onnx",
    "unsafe model name.onnx",
    "signature=private.onnx",
  ];
  for (const currentItem of cases) {
    await t.test(currentItem, async (subtest) => {
      const { paths, store } = await fixture(subtest);
      await store.save(snapshot("downloading-embedding-model", { currentItem }));
      const state = await readState(paths.onboardingState);
      assert.equal(state.currentItem, "");
      assert.doesNotMatch(JSON.stringify(state), /super-secret|private|token|signature/i);
    });
  }
});
