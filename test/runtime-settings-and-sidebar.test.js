"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const esbuild = require("esbuild");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

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
    for (const suffix of [".ts", ".tsx", ".js", ""]) {
      const candidate = `${resolved}${suffix}`;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return suffix === ".ts" || suffix === ".tsx" ? loadTypeScriptFile(candidate) : require(candidate);
      }
    }
    throw new Error(`Cannot resolve ${specifier} from ${filename}`);
  };
  Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports, localRequire, module, filename, path.dirname(filename),
  );
  loaded.set(filename, module.exports);
  return module.exports;
}

function pointer(kind, runtimeId, installedPath, assetSha256 = "a".repeat(64)) {
  return {
    schemaVersion: 1,
    kind,
    runtimeId,
    installedPath,
    assetSha256,
    installedAt: 100,
    previousRuntimeId: null,
  };
}

async function writePointer(paths, kind, runtimeId, assetSha256) {
  const root = kind === "chroma" ? paths.chromaVersions : paths.embeddingVersions;
  const value = pointer(kind, runtimeId, path.join(root, runtimeId), assetSha256);
  await fs.promises.mkdir(paths.current, { recursive: true });
  await fs.promises.writeFile(path.join(paths.current, `${kind}.json`), JSON.stringify(value), "utf8");
  return value;
}

async function writeHistoryPointer(paths, kind, runtimeId, assetSha256) {
  const root = kind === "chroma" ? paths.chromaVersions : paths.embeddingVersions;
  const value = pointer(kind, runtimeId, path.join(root, runtimeId), assetSha256);
  const directory = path.join(paths.current, "history", kind);
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(path.join(directory, `${runtimeId}.json`), JSON.stringify(value), "utf8");
  return value;
}

function testResolver(bindings) {
  return (kind, runtimeId) => {
    const binding = bindings.find((candidate) => candidate.kind === kind && candidate.id === runtimeId);
    return binding ? { id: binding.id, sha256: binding.sha256 } : null;
  };
}

async function fixture(t, options = {}) {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-task13-"));
  t.after(() => fs.promises.rm(temporary, { recursive: true, force: true }));
  const { createRuntimePaths } = loadTypeScriptFile(path.join(extensionRoot, "src/runtime/runtime-paths.ts"));
  const { RuntimeControlSurface } = loadTypeScriptFile(path.join(extensionRoot, "src/runtime/runtime-control-surface.ts"));
  const paths = createRuntimePaths(path.join(temporary, "Analogy 数据"), "vault-v2-0123456789abcdef");
  await Promise.all([
    fs.promises.mkdir(paths.chromaVersions, { recursive: true }),
    fs.promises.mkdir(paths.embeddingVersions, { recursive: true }),
    fs.promises.mkdir(paths.current, { recursive: true }),
    fs.promises.mkdir(paths.staging, { recursive: true }),
    fs.promises.mkdir(paths.downloads, { recursive: true }),
    fs.promises.mkdir(paths.vaultRoot, { recursive: true }),
  ]);
  const currentChroma = "chroma-current";
  const currentEmbedding = "embedding-current";
  await fs.promises.mkdir(path.join(paths.chromaVersions, currentChroma));
  await fs.promises.mkdir(path.join(paths.embeddingVersions, currentEmbedding));
  await writePointer(paths, "chroma", currentChroma);
  await writePointer(paths, "embedding-runtime", currentEmbedding);

  const calls = [];
  let environment = options.environment || {
    platform: "darwin-arm64", chroma: "installed", embeddingRuntime: "ready",
    embeddingModel: "ready", index: "ready", recommendedAction: "start-services",
  };
  let stage = options.stage || "ready";
  let lease = options.lease || {
    ownership: "none", pid: null, executablePath: null, port: 8000,
    runtimeVersion: null, startedAt: null,
  };
  let detectGate = options.detectGate;
  let restartGate = options.restartGate;
  const coordinator = {
    getSnapshot: () => ({
      stage, error: stage === "failed" ? { code: "LEGACY_INDEX_MIGRATION_FAILED" } : null, progress: 40,
      legacyIndexChoice: "reuse", legacyRecordsCopied: 40, legacyRecordsTotal: 100, legacySourceBytes: 5000,
    }),
    retry: async () => { calls.push(["retry"]); return { stage }; },
    resume: async () => { calls.push(["resume"]); return { stage }; },
    cancel: async () => { calls.push(["cancel"]); },
    fallbackToLegacyRebuild: async () => { calls.push(["fallback-rebuild"]); return { stage }; },
    retryRuntime: async (kind) => { calls.push(["retry-runtime", kind]); return { stage }; },
  };
  const chromaManager = {
    getState: () => ({ ...lease }),
    health: async (port) => { calls.push(["health", port]); return true; },
    stopOwnedProcess: async (expected) => {
      calls.push(["stop", expected]);
      if (JSON.stringify(expected) !== JSON.stringify(lease) || lease.ownership !== "analogy") {
        return { stopped: false, reason: "lease-mismatch" };
      }
      lease = { ownership: "none", pid: null, executablePath: null, port: lease.port,
        runtimeVersion: null, startedAt: null };
      return { stopped: true, reason: "stopped" };
    },
  };
  const trashed = [];
  const trashAttempts = [];
  const control = new RuntimeControlSurface({
    paths,
    platform: "darwin-arm64",
    detectEnvironment: async () => {
      calls.push(["detect"]);
      if (detectGate) await detectGate;
      return environment;
    },
    coordinator,
    chromaManager,
    openOnboarding: (mode) => calls.push(["open", mode]),
    restartServices: async () => {
      calls.push(["restart-services"]);
      if (restartGate) await restartGate;
      if (options.restartFailure) throw options.restartFailure;
    },
    revealStorage: async () => calls.push(["reveal"]),
    trashItem: async (target) => {
      trashAttempts.push(target);
      calls.push(["trash", path.basename(target)]);
      if (options.beforeTrash) await options.beforeTrash(target);
      if (options.trashFailure?.(target)) throw new Error("TRASH_FAILED");
      trashed.push(target);
      await fs.promises.rename(target, `${target}.trashed-${trashed.length}`);
    },
    resolveTrustedRuntimeAsset: options.resolveTrustedRuntimeAsset
      || testResolver(options.trustedRuntimeAssets || []),
    getActiveEmbeddingRuntimeId: () => options.activeEmbeddingRuntimeId || null,
    legacyCleanup: options.legacyCleanup,
    listLegacyRecoveries: options.listLegacyRecoveries,
    retryLegacyRecovery: options.retryLegacyRecovery,
    restoreLegacyRecovery: options.restoreLegacyRecovery,
    discardLegacyMigration: async () => { calls.push(["discard-migration"]); },
  });
  return {
    paths, control, calls, trashed, trashAttempts,
    setEnvironment(next) { environment = next; },
    setStage(next) { stage = next; },
    setLease(next) { lease = next; },
  };
}

test("verify, restart and redownload operations are single-flight and preserve exact owned lease", async (t) => {
  let releaseDetect;
  const detectGate = new Promise((resolve) => { releaseDetect = resolve; });
  const f = await fixture(t, { detectGate });
  const firstVerify = f.control.verifyRuntimes();
  const secondVerify = f.control.verifyRuntimes();
  assert.strictEqual(firstVerify, secondVerify, "verify clicks must share one operation");
  releaseDetect();
  const verified = await firstVerify;
  assert.equal(verified.environment.chroma, "installed");
  assert.equal(f.calls.filter(([name]) => name === "detect").length, 1);

  const owned = {
    ownership: "analogy", pid: 9001,
    executablePath: path.join(f.paths.chromaVersions, "chroma-current", "chroma"),
    port: 8042, runtimeVersion: "cli-1.4.4", startedAt: 123,
  };
  f.setLease(owned);
  let releaseRestart;
  const restartGate = new Promise((resolve) => { releaseRestart = resolve; });
  // The fixture captures the promise through a mutable option object only at construction,
  // so use the operation itself to prove duplicate calls remain collapsed.
  const restartOne = f.control.restartOwnedChroma();
  const restartTwo = f.control.restartOwnedChroma();
  assert.strictEqual(restartOne, restartTwo, "restart clicks must share one operation");
  releaseRestart();
  await restartOne;
  assert.deepEqual(f.calls.find(([name]) => name === "stop")[1], owned);
  assert.equal(f.calls.filter(([name]) => name === "restart-services").length, 1);

  f.setEnvironment({
    platform: "darwin-arm64", chroma: "corrupt", embeddingRuntime: "ready",
    embeddingModel: "ready", index: "ready", recommendedAction: "repair",
  });
  await f.control.verifyRuntimes();
  const retryOne = f.control.redownloadRuntime("chroma");
  const retryTwo = f.control.redownloadRuntime("chroma");
  assert.strictEqual(retryOne, retryTwo, "redownload clicks must share the coordinator retry boundary");
  await retryOne;
  assert.deepEqual(f.calls.filter(([name]) => name === "retry-runtime"), [["retry-runtime", "chroma"]]);
  assert.deepEqual(f.calls.filter(([name]) => name === "retry"), []);
  assert.ok(f.calls.some((entry) => entry[0] === "open" && entry[1] === "repair"));
});

test("legacy migration controls expose path-free progress and explicit recovery actions", async (t) => {
  const f = await fixture(t, {
    stage: "migrating-legacy-index",
    environment: {
      platform: "darwin-arm64", chroma: "running", embeddingRuntime: "ready",
      embeddingModel: "ready", index: "legacy", recommendedAction: "resume",
    },
  });
  await f.control.verifyRuntimes();
  assert.deepEqual(f.control.getSnapshot().legacyMigration, {
    status: "copying", copiedRecords: 40, totalRecords: 100, sourceBytes: 5000,
    recoverable: true,
  });
  await f.control.cancelLegacyMigration();
  assert.equal(f.calls.some(([name]) => name === "cancel"), true);
  f.setStage("failed");
  await f.control.resumeLegacyMigration();
  await f.control.fallbackLegacyMigrationToRebuild();
  await f.control.discardLegacyMigration();
  assert.equal(f.calls.some(([name]) => name === "retry"), true);
  assert.equal(f.calls.some(([name]) => name === "fallback-rebuild"), true);
  assert.equal(f.calls.some(([name]) => name === "discard-migration"), true);
  assert.equal(JSON.stringify(f.control.getSnapshot()).includes(f.paths.root), false);
});

test("restart failure redetects and publishes the true stopped process snapshot", async (t) => {
  const f = await fixture(t, { restartFailure: new Error("START_FAILED") });
  f.setLease({
    ownership: "analogy", pid: 731,
    executablePath: path.join(f.paths.chromaVersions, "chroma-current", "chroma"),
    port: 8123, runtimeVersion: "cli-1.4.4", startedAt: 99,
  });
  f.setEnvironment({
    platform: "darwin-arm64", chroma: "installed", embeddingRuntime: "ready",
    embeddingModel: "ready", index: "ready", recommendedAction: "start-services",
  });
  await f.control.verifyRuntimes();

  await assert.rejects(f.control.restartOwnedChroma(), /START_FAILED/);
  const snapshot = f.control.getSnapshot();
  assert.equal(snapshot.ownership, "none");
  assert.equal(snapshot.health, "stopped");
  assert.equal(snapshot.chromaVersion, null);
  assert.equal(snapshot.environment.chroma, "installed");
  assert.equal(snapshot.lastAction, "verify", "a failed restart must preserve the last completed action");
  assert.ok(f.calls.findLastIndex(([name]) => name === "detect")
    > f.calls.findIndex(([name]) => name === "restart-services"));
});

test("restart refuses external, missing, or replacement leases without stopping anything", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.control.restartOwnedChroma(), /RUNTIME_RESTART_NOT_OWNED/);
  f.setLease({
    ownership: "external", pid: 22, executablePath: "/external/chroma", port: 8000,
    runtimeVersion: "cli-1.4.4", startedAt: 1,
  });
  await assert.rejects(f.control.restartOwnedChroma(), /RUNTIME_RESTART_NOT_OWNED/);
  assert.equal(f.calls.some(([name]) => name === "stop"), false);
});

test("runtime history cleanup never trashes current, active, symlink, staging, or root-escape targets", async (t) => {
  const trustedRuntimeAssets = [
    "chroma-old", "chroma-active", "embedding-active", "embedding-old", "forged-manifest-binding",
  ].map((id) => ({
    kind: id.startsWith("embedding") ? "embedding-runtime" : "chroma",
    id,
    sha256: "a".repeat(64),
  }));
  const f = await fixture(t, { activeEmbeddingRuntimeId: "embedding-active", trustedRuntimeAssets });
  const oldChroma = path.join(f.paths.chromaVersions, "chroma-old");
  const activeChroma = path.join(f.paths.chromaVersions, "chroma-active");
  const activeEmbedding = path.join(f.paths.embeddingVersions, "embedding-active");
  const oldEmbedding = path.join(f.paths.embeddingVersions, "embedding-old");
  await Promise.all([oldChroma, activeChroma, activeEmbedding, oldEmbedding].map((item) => fs.promises.mkdir(item)));
  await Promise.all([
    writeHistoryPointer(f.paths, "chroma", "chroma-old"),
    writeHistoryPointer(f.paths, "chroma", "chroma-active"),
    writeHistoryPointer(f.paths, "embedding-runtime", "embedding-active"),
    writeHistoryPointer(f.paths, "embedding-runtime", "embedding-old"),
  ]);
  await fs.promises.mkdir(path.join(f.paths.chromaVersions, "forged-empty"));
  const forgedRuntimeId = "forged-manifest-binding";
  await fs.promises.mkdir(path.join(f.paths.chromaVersions, forgedRuntimeId));
  const forgedPointer = pointer("chroma", forgedRuntimeId, path.join(f.paths.chromaVersions, forgedRuntimeId));
  forgedPointer.assetSha256 = "b".repeat(64);
  await fs.promises.writeFile(
    path.join(f.paths.current, "history", "chroma", `${forgedRuntimeId}.json`),
    JSON.stringify(forgedPointer),
    "utf8",
  );
  const outside = path.join(path.dirname(f.paths.root), "outside-runtime");
  await fs.promises.mkdir(outside);
  t.after(() => fs.promises.rm(outside, { recursive: true, force: true }));
  await fs.promises.symlink(outside, path.join(f.paths.chromaVersions, "chroma-link"));
  f.setLease({
    ownership: "analogy", pid: 31, executablePath: path.join(activeChroma, "chroma"),
    port: 8002, runtimeVersion: "cli-1.4.4", startedAt: 9,
  });

  const history = await f.control.listRuntimeHistory();
  assert.deepEqual(history.map((item) => `${item.kind}:${item.runtimeId}`).sort(), [
    "chroma:chroma-old", "embedding-runtime:embedding-old",
  ]);
  assert.equal(history.some((item) => item.runtimeId.includes("current")), false);
  assert.equal(history.some((item) => item.runtimeId.includes("active")), false);
  assert.equal(history.some((item) => item.runtimeId.includes("link")), false);
  assert.equal(history.some((item) => item.runtimeId === "forged-empty"), false,
    "an unbound valid-name directory is not trusted install history");
  assert.equal(history.some((item) => item.runtimeId === forgedRuntimeId), false,
    "history metadata must bind to an allowlisted manifest asset id and sha256");

  const result = await f.control.cleanRuntimeHistory(history);
  assert.deepEqual(result, { removed: 2, failed: 0, skipped: 0 });
  assert.equal(f.trashed.length, 2);
  assert.equal(fs.existsSync(oldChroma), false);
  assert.equal(fs.existsSync(oldEmbedding), false);
  assert.equal(fs.existsSync(path.join(f.paths.chromaVersions, "chroma-current")), true);
  assert.equal(fs.existsSync(activeChroma), true);
  assert.equal(fs.existsSync(activeEmbedding), true);
  assert.equal(fs.existsSync(path.join(f.paths.chromaVersions, "chroma-link")), true);
  assert.equal(f.trashed.every((item) => item.startsWith(f.paths.staging)), true);
  assert.equal(f.trashed.some((item) => path.resolve(item) === path.resolve(f.paths.root)), false);
});

test("cleanup revalidates immediately, fails closed during setup, and reports partial safe counts", async (t) => {
  const f = await fixture(t, {
    trashFailure: (target) => target.includes("old-b"),
    trustedRuntimeAssets: ["old-a", "old-b"].map((id) => ({ kind: "chroma", id, sha256: "a".repeat(64) })),
  });
  const oldA = path.join(f.paths.chromaVersions, "old-a");
  const oldB = path.join(f.paths.chromaVersions, "old-b");
  await fs.promises.mkdir(oldA);
  await fs.promises.mkdir(oldB);
  await writeHistoryPointer(f.paths, "chroma", "old-a");
  await writeHistoryPointer(f.paths, "chroma", "old-b");
  const listed = await f.control.listRuntimeHistory();

  f.setStage("downloading-chroma");
  await assert.rejects(f.control.cleanRuntimeHistory(listed), /RUNTIME_OPERATION_BUSY/);
  assert.equal(f.trashed.length, 0);

  f.setStage("ready");
  await fs.promises.rm(oldA, { recursive: true });
  await fs.promises.mkdir(oldA);
  const result = await f.control.cleanRuntimeHistory(listed);
  assert.deepEqual(result, { removed: 0, failed: 1, skipped: 1 });
  assert.equal(f.trashAttempts.length, 1);
  const recovery = JSON.parse(await fs.promises.readFile(
    path.join(f.trashAttempts[0], "recovery.json"),
    "utf8",
  ));
  assert.equal(recovery.state, "isolated");
  assert.equal(recovery.runtimeId, "old-b");
  assert.equal(fs.existsSync(oldB), false, "failed trash remains recoverable in private quarantine");
  const retained = await f.control.listRuntimeCleanupRecoveries();
  assert.equal(retained.length, 1);
  assert.deepEqual(
    { kind: retained[0].kind, runtimeId: retained[0].runtimeId, state: retained[0].state },
    { kind: "chroma", runtimeId: "old-b", state: "retained" },
  );
  assert.equal(Object.values(retained[0]).some((value) => typeof value === "string" && value.includes(f.paths.root)), false,
    "the recovery inventory must not expose device-local paths");
  assert.equal(f.calls.some((entry) => JSON.stringify(entry).includes(f.paths.root)), false,
    "operation results/calls must not expose the storage path");
});

test("cleanup fails closed when the current pointer becomes invalid after listing", async (t) => {
  const f = await fixture(t, {
    trustedRuntimeAssets: [{ kind: "chroma", id: "old-invalid-current", sha256: "a".repeat(64) }],
  });
  const historical = path.join(f.paths.chromaVersions, "old-invalid-current");
  await fs.promises.mkdir(historical);
  await writeHistoryPointer(f.paths, "chroma", "old-invalid-current");
  const listed = await f.control.listRuntimeHistory();
  await fs.promises.writeFile(path.join(f.paths.current, "chroma.json"), "{}", "utf8");

  assert.deepEqual(await f.control.cleanRuntimeHistory(listed), { removed: 0, failed: 0, skipped: 1 });
  assert.equal(fs.existsSync(historical), true);
  assert.equal(f.trashAttempts.length, 0);
});

test("cleanup isolates synchronously before async trash and parent swaps cannot touch outside data", async (t) => {
  let f;
  let versionsBackup;
  const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-task13-outside-"));
  t.after(() => fs.promises.rm(outside, { recursive: true, force: true }));
  f = await fixture(t, {
    trustedRuntimeAssets: [{ kind: "chroma", id: "old-parent-swap", sha256: "a".repeat(64) }],
    beforeTrash: async (isolatedTarget) => {
      assert.ok(isolatedTarget.startsWith(f.paths.staging), "trash receives only a quarantined path");
      versionsBackup = `${f.paths.chromaVersions}.verified-root`;
      await fs.promises.rename(f.paths.chromaVersions, versionsBackup);
      await fs.promises.symlink(outside, f.paths.chromaVersions);
    },
  });
  const runtimeId = "old-parent-swap";
  const historical = path.join(f.paths.chromaVersions, runtimeId);
  await fs.promises.mkdir(historical);
  await fs.promises.writeFile(path.join(historical, "inside.txt"), "private", "utf8");
  await writeHistoryPointer(f.paths, "chroma", runtimeId);
  const outsideRuntime = path.join(outside, runtimeId);
  await fs.promises.mkdir(outsideRuntime);
  await fs.promises.writeFile(path.join(outsideRuntime, "outside.txt"), "must-survive", "utf8");

  const listed = await f.control.listRuntimeHistory();
  try {
    assert.deepEqual(await f.control.cleanRuntimeHistory(listed), { removed: 1, failed: 0, skipped: 0 });
    assert.equal(await fs.promises.readFile(path.join(outsideRuntime, "outside.txt"), "utf8"), "must-survive");
  } finally {
    if (versionsBackup) {
      await fs.promises.unlink(f.paths.chromaVersions).catch(() => undefined);
      await fs.promises.rename(versionsBackup, f.paths.chromaVersions).catch(() => undefined);
    }
  }
});

test("production history registry resolves active plus retained bindings and cleanup rejects unknown assets", async (t) => {
  const manifestModule = loadTypeScriptFile(path.join(extensionRoot, "src/runtime/runtime-manifest.ts"));
  const platform = "darwin-arm64";
  const currentAsset = manifestModule.getRuntimeAsset("chroma", platform);
  const retainedAsset = {
    id: "chroma-cli-retained-test-fixture-darwin-arm64",
    kind: "chroma",
    platform,
    sha256: "c".repeat(64),
  };
  const wrongShaId = "chroma-cli-wrong-sha-darwin-arm64";
  const wrongShaBinding = {
    id: wrongShaId,
    kind: "chroma",
    platform,
    sha256: "f".repeat(64),
  };
  const resolveTrustedRuntimeAsset = manifestModule.createRuntimeHistoryAssetResolver(
    manifestModule.RUNTIME_MANIFEST,
    { schemaVersion: 1, retained: [retainedAsset, wrongShaBinding] },
    platform,
  );
  const f = await fixture(t, { resolveTrustedRuntimeAsset });
  await fs.promises.rm(path.join(f.paths.chromaVersions, "chroma-current"), { recursive: true, force: true });
  await fs.promises.mkdir(path.join(f.paths.chromaVersions, currentAsset.id));
  await writePointer(f.paths, "chroma", currentAsset.id, currentAsset.sha256);

  const retainedPath = path.join(f.paths.chromaVersions, retainedAsset.id);
  await fs.promises.mkdir(retainedPath);
  await writeHistoryPointer(f.paths, "chroma", retainedAsset.id, retainedAsset.sha256);
  const unknownId = "chroma-cli-unknown-darwin-arm64";
  await fs.promises.mkdir(path.join(f.paths.chromaVersions, unknownId));
  await writeHistoryPointer(f.paths, "chroma", unknownId, "d".repeat(64));
  await fs.promises.mkdir(path.join(f.paths.chromaVersions, wrongShaId));
  await writeHistoryPointer(f.paths, "chroma", wrongShaId, "e".repeat(64));

  assert.deepEqual(resolveTrustedRuntimeAsset("chroma", currentAsset.id), {
    id: currentAsset.id, sha256: currentAsset.sha256,
  });
  const history = await f.control.listRuntimeHistory();
  assert.deepEqual(history.map((item) => item.runtimeId), [retainedAsset.id]);
  assert.deepEqual(await f.control.cleanRuntimeHistory(history), { removed: 1, failed: 0, skipped: 0 });
  assert.equal(fs.existsSync(retainedPath), false);
  assert.equal(fs.existsSync(path.join(f.paths.chromaVersions, unknownId)), true);
  assert.equal(fs.existsSync(path.join(f.paths.chromaVersions, wrongShaId)), true);
});

test("legacy cleanup requires typed confirmation and remains unavailable until Task 14", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.control.cleanLegacyChromaData(""), /LEGACY_CLEANUP_CONFIRMATION_REQUIRED/);
  await assert.rejects(
    f.control.cleanLegacyChromaData("DELETE LEGACY DATA"),
    /LEGACY_CLEANUP_UNAVAILABLE/,
  );
  assert.equal(f.trashed.length, 0);
});

test("legacy cleanup recovery inventory, retry, and restore are path-free production control actions", async (t) => {
  const calls = [];
  const recovery = { id: "a".repeat(32), state: "trash-failed", updatedAt: 1700000000000 };
  const f = await fixture(t, {
    listLegacyRecoveries: async () => [recovery],
    retryLegacyRecovery: async (id) => { calls.push(["retry", id]); return { removed: 1, failed: 0 }; },
    restoreLegacyRecovery: async (id) => { calls.push(["restore", id]); return { restored: 1, failed: 0 }; },
  });

  assert.deepEqual(await f.control.listLegacyChromaRecoveries(), [recovery]);
  assert.deepEqual(await f.control.retryLegacyChromaRecovery(recovery.id), { removed: 1, failed: 0 });
  assert.deepEqual(await f.control.restoreLegacyChromaRecovery(recovery.id), { restored: 1, failed: 0 });
  assert.deepEqual(calls, [["retry", recovery.id], ["restore", recovery.id]]);
  assert.equal(JSON.stringify(await f.control.listLegacyChromaRecoveries()).includes(f.paths.root), false);
});

test("real bilingual React panels expose setup, progress, repair and ready actions without legacy UI", async () => {
  const chromeCandidates = [
    process.env.ANALOGY_TEST_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean);
  const chromePath = chromeCandidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(chromePath, "需要 Chrome/Chromium 执行 Task 13 DOM harness");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-task13-browser-"));
  try {
    const bundle = path.join(temporary, "task13.js");
    await esbuild.build({
      entryPoints: [path.join(__dirname, "runtime-settings-and-sidebar-browser-runner.tsx")],
      bundle: true,
      platform: "browser",
      format: "iife",
      nodePaths: [path.join(extensionRoot, "node_modules")],
      outfile: bundle,
      logLevel: "silent",
      plugins: [{
        name: "task13-obsidian-stub",
        setup(build) {
          build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "task13" }));
          build.onLoad({ filter: /.*/, namespace: "task13" }, () => ({ loader: "js", contents: `
            export class Notice { constructor(message) { window.__notices = [...(window.__notices || []), message]; } }
          ` }));
        },
      }],
    });
    const styles = fs.readFileSync(path.join(extensionRoot, "styles.css"), "utf8");
    const html = path.join(temporary, "index.html");
    fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
      :root { --background-primary:#f4f0e8; --background-primary-alt:#ebe4d8; --background-secondary:#e7dfd2;
      --background-modifier-border:#c9beae; --background-modifier-border-hover:#8d806e; --background-modifier-hover:#ded4c5;
      --text-normal:#25231f; --text-muted:#6c655b; --text-faint:#847b6f; --text-error:#a0392b;
      --text-on-accent:#fff; --interactive-accent:#45635b; --interactive-accent-hover:#365048;
      --font-interface:ui-sans-serif,sans-serif; --font-text:ui-serif,Georgia,serif; --radius-s:4px; --radius-m:8px; --radius-l:12px;
      --shadow-s:0 1px 3px rgb(25 22 18/.12); }
      * { box-sizing:border-box } body { margin:0; background:var(--background-primary) } .scenario { width:320px; margin:10px; }
      ${styles}
    </style></head><body><script src="${path.basename(bundle)}"></script></body></html>`, "utf8");
    const chrome = spawnSync(chromePath, [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-background-networking",
      "--disable-component-update", "--disable-default-apps", "--disable-extensions", "--no-first-run",
      "--run-all-compositor-stages-before-draw", "--virtual-time-budget=8000",
      `--user-data-dir=${path.join(temporary, "profile")}`, "--dump-dom", pathToFileURL(html).href,
    ], { encoding: "utf8", timeout: 25000 });
    assert.equal(chrome.status, 0, `Task 13 Chrome harness 启动失败：${chrome.stderr}`);
    const encoded = chrome.stdout.match(/data-task13-test-result="([^"]+)"/)?.[1];
    assert.ok(encoded, `Task 13 Chrome harness 未返回结果：${chrome.stdout.slice(-1800)}`);
    const result = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    assert.deepEqual(result.failures, [], `Task 13 DOM harness 失败：\n- ${result.failures.join("\n- ")}`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
