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

const source = (relative) => loadTypeScriptFile(path.join(process.cwd(), relative));

const WINDOWS_V1 = Object.freeze({
  id: "embedding-runtime-node22-v1-win32-x64",
  sha256: "43f45a5274dd017abafa77ad5ade36d7be87070c1be05e78c6b765073bfa4aa1",
});
const WINDOWS_V2_ASSET = Object.freeze({
  id: "embedding-runtime-node22-v2-win32-x64",
  kind: "embedding-runtime",
  platform: "win32-x64",
  version: "node22-v2",
  url: "https://github.com/liaocaoxuezhe/obsidian-extension/releases/download/runtime-node22-v2/analogy-embedding-runtime-node22-v2-win32-x64.zip",
  fileName: "analogy-embedding-runtime-node22-v2-win32-x64.zip",
  archive: "zip",
  size: 116_000_000,
  sha256: "b".repeat(64),
  executableRelativePath: "analogy-embedding-runtime-node22-v2/node/bin/node.exe",
  licenseName: "See bundled THIRD_PARTY_NOTICES.txt",
  licenseUrl: "https://example.invalid/notices",
  source: "published",
  runtimeVersions: { node: "22.23.2", transformers: "4.2.0", onnxruntime: "1.26.0" },
  internalManifestSha256: "c".repeat(64),
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readySnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    stage: "ready",
    progress: 100,
    completedBytes: null,
    totalBytes: null,
    currentItem: "",
    runtimePlatform: "win32-x64",
    chromaRuntimeId: null,
    embeddingRuntimeId: WINDOWS_V1.id,
    selectedIndexScope: { type: "vault" },
    legacyIndexChoice: null,
    legacyRecordsCopied: null,
    legacyRecordsTotal: null,
    legacySourceBytes: null,
    startedAt: 1,
    updatedAt: 2,
    completedAt: 2,
    dismissedAt: null,
    error: null,
    ...overrides,
  };
}

function upgradableReport() {
  return {
    platform: "win32-x64",
    chroma: "not-required",
    embeddingRuntime: "upgradable",
    embeddingRuntimeUpgrade: { fromRuntimeId: WINDOWS_V1.id, toRuntimeId: WINDOWS_V2_ASSET.id, downloadBytes: WINDOWS_V2_ASSET.size },
    embeddingModel: "ready",
    index: "ready",
    recommendedAction: "upgrade",
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${message}`);
}

function coordinatorFixture({ snapshot = readySnapshot(), report = upgradableReport(), install } = {}) {
  const calls = [];
  let stored = clone(snapshot);
  let now = 100;
  let currentReport = clone(report);
  const { OnboardingCoordinator } = source("src/onboarding/onboarding-coordinator.ts");
  const runtime = (label, asset) => ({
    asset,
    async download(_signal, onProgress) {
      calls.push(`${label}.download`);
      onProgress({ receivedBytes: 1, totalBytes: asset.size, percent: 1 });
      return { path: `/${label}.part`, receivedBytes: asset.size };
    },
    async verify() { calls.push(`${label}.verify`); return { ok: true, errorCode: null }; },
    async install() {
      calls.push(`${label}.install`);
      if (install) return install();
      return { runtimeId: asset.id, executablePath: `/${label}` };
    },
  });
  const coordinator = new OnboardingCoordinator({
    detectEnvironment: async () => { calls.push("detect"); return clone(currentReport); },
    store: {
      async load() { return { snapshot: clone(stored) }; },
      async save(value) { calls.push(`save:${value.stage}`); stored = clone(value); },
    },
    runtimes: { chroma: runtime("chroma", { ...WINDOWS_V2_ASSET, kind: "chroma", id: "chroma-fixture" }), embedding: runtime("embedding", WINDOWS_V2_ASSET) },
    chromaManager: {
      getState: () => ({ ownership: "none" }),
      async start() { calls.push("chroma.start"); return { ownership: "none" }; },
      async stopOwnedProcess() {},
    },
    chromaStartOptions: () => ({}),
    embeddingRuntimeManager: {
      async resolve() { calls.push("embedding.resolve"); },
      async verifyNative() { calls.push("embedding.verifyNative"); },
    },
    embeddingModel: {
      async download() { calls.push("model.download"); },
      async warmUp() { calls.push("model.warm"); },
      async cancel() {},
    },
    quickIndex: { async run() { calls.push("index.run"); return {}; } },
    now: () => ++now,
  });
  return {
    coordinator,
    calls,
    getStored: () => clone(stored),
    setReport: (value) => { currentReport = clone(value); },
  };
}

test("an installed superseded runtime asks for a dedicated upgrade consent even after setup was accepted", async () => {
  const { coordinator, calls, getStored } = coordinatorFixture();
  const operation = coordinator.resume();
  await waitFor(() => coordinator.getSnapshot().stage === "awaiting-consent", "upgrade consent");
  assert.deepEqual(coordinator.getSnapshot().runtimeUpgrade, {
    kind: "embedding-runtime",
    fromRuntimeId: WINDOWS_V1.id,
    toRuntimeId: WINDOWS_V2_ASSET.id,
    downloadBytes: WINDOWS_V2_ASSET.size,
    acceptedAt: null,
  });
  assert.equal(calls.some((entry) => entry.endsWith(".download")), false, "nothing downloads before consent");
  assert.equal(await coordinator.provideConsent(true), true);
  const result = await operation;
  assert.equal(result.stage, "ready");
  assert.equal("runtimeUpgrade" in result, false, "the upgrade descriptor is cleared once ready");
  assert.equal("runtimeUpgrade" in getStored(), false);
  assert.deepEqual(calls.filter((entry) => /\.(download|verify|install|verifyNative)$/.test(entry)), [
    "embedding.download", "embedding.verify", "embedding.install", "embedding.verifyNative",
  ], "only the embedding runtime is replaced and natively verified");
  assert.equal(calls.includes("model.download"), false, "the cached model is reused");
  assert.equal(calls.includes("index.run"), false, "the existing index is kept");
  assert.equal(result.embeddingRuntimeId, WINDOWS_V2_ASSET.id);
});

test("declining the upgrade cancels without downloading and asks again next time", async () => {
  const first = coordinatorFixture();
  const operation = first.coordinator.resume();
  await waitFor(() => first.coordinator.getSnapshot().stage === "awaiting-consent", "upgrade consent");
  await first.coordinator.provideConsent(false);
  const declined = await operation;
  assert.equal(declined.stage, "cancelled");
  assert.ok(declined.dismissedAt !== null);
  assert.equal(declined.runtimeUpgrade.acceptedAt, null);
  assert.equal(first.calls.some((entry) => entry.endsWith(".download")), false);

  const second = coordinatorFixture({ snapshot: first.getStored() });
  const again = second.coordinator.start();
  await waitFor(() => second.coordinator.getSnapshot().stage === "awaiting-consent", "repeat consent");
  assert.equal(await second.coordinator.provideConsent(true), true);
  assert.equal((await again).stage, "ready");
});

test("an accepted upgrade that fails is retried without asking for consent again", async () => {
  let attempts = 0;
  const { coordinator, calls, getStored } = coordinatorFixture({
    install: () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("RUNTIME_EXTRACT_FAILED"), { code: "RUNTIME_EXTRACT_FAILED" });
      return { runtimeId: WINDOWS_V2_ASSET.id, executablePath: "/embedding" };
    },
  });
  const operation = coordinator.resume();
  await waitFor(() => coordinator.getSnapshot().stage === "awaiting-consent", "upgrade consent");
  await coordinator.provideConsent(true);
  const failed = await operation;
  assert.equal(failed.stage, "failed");
  assert.equal(failed.error.code, "RUNTIME_EXTRACT_FAILED");
  assert.equal(typeof getStored().runtimeUpgrade.acceptedAt, "number", "acceptance survives the failure");

  const stages = [];
  coordinator.subscribe((snapshot) => stages.push(snapshot.stage));
  const retried = await coordinator.retry();
  assert.equal(retried.stage, "ready");
  assert.equal(stages.includes("awaiting-consent"), false);
  assert.equal(calls.filter((entry) => entry === "embedding.install").length, 2);
});

test("a ready runtime never shows an upgrade or downloads anything", async () => {
  const { coordinator, calls } = coordinatorFixture({
    report: { ...upgradableReport(), embeddingRuntime: "ready", embeddingRuntimeUpgrade: undefined, recommendedAction: "start-services" },
  });
  const result = await coordinator.resume();
  assert.equal(result.stage, "ready");
  assert.equal("runtimeUpgrade" in result, false);
  assert.equal(calls.some((entry) => entry.endsWith(".download")), false);
});

test("the onboarding store persists a valid upgrade and drops malformed ones", async (t) => {
  const { OnboardingStore } = source("src/onboarding/onboarding-store.ts");
  const { createRuntimePaths } = source("src/runtime/runtime-paths.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-upgrade-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = createRuntimePaths(root, "vault-v2-0123456789abcdef");
  const store = new OnboardingStore({ paths, progressThrottleMs: 0 });
  const upgrade = {
    kind: "embedding-runtime", fromRuntimeId: WINDOWS_V1.id, toRuntimeId: WINDOWS_V2_ASSET.id,
    downloadBytes: WINDOWS_V2_ASSET.size, acceptedAt: 123,
  };
  await store.save(readySnapshot({ stage: "downloading-embedding-runtime", runtimeUpgrade: upgrade }));
  await store.flush?.();
  assert.deepEqual((await new OnboardingStore({ paths }).load()).snapshot.runtimeUpgrade, upgrade);

  for (const malformed of [
    { ...upgrade, kind: "chroma" },
    { ...upgrade, toRuntimeId: upgrade.fromRuntimeId },
    { ...upgrade, fromRuntimeId: "../escape" },
    { ...upgrade, downloadBytes: -1 },
  ]) {
    await store.save(readySnapshot({ stage: "checking", runtimeUpgrade: malformed }));
    await store.flush?.();
    assert.equal("runtimeUpgrade" in (await new OnboardingStore({ paths }).load()).snapshot, false);
  }
});

function writePointer(paths, runtimeId, assetSha256) {
  fs.mkdirSync(paths.current, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(paths.current, "embedding-runtime.json"), JSON.stringify({
    schemaVersion: 1,
    kind: "embedding-runtime",
    runtimeId,
    installedPath: path.join(paths.embeddingVersions, runtimeId),
    assetSha256,
    installedAt: 1,
    previousRuntimeId: null,
  }), { mode: 0o600 });
}

test("environment detection reports a trusted superseded Windows runtime as upgradable, never corrupt", async (t) => {
  const { detectEnvironment } = source("src/runtime/environment-detector.ts");
  const { createRuntimePaths } = source("src/runtime/runtime-paths.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-upgrade-detect-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = createRuntimePaths(root, "vault-v2-0123456789abcdef");
  const detect = (platform = "win32-x64") => detectEnvironment({
    platform,
    paths,
    vectorBackend: "sqlite",
    getRuntimeAsset: () => ({ ...WINDOWS_V2_ASSET, platform }),
    inspectors: { embeddingModel: async () => "ready", index: async () => "ready" },
  });

  writePointer(paths, WINDOWS_V1.id, WINDOWS_V1.sha256);
  const report = await detect();
  assert.equal(report.embeddingRuntime, "upgradable");
  assert.equal(report.recommendedAction, "upgrade");
  assert.deepEqual(report.embeddingRuntimeUpgrade, {
    fromRuntimeId: WINDOWS_V1.id,
    toRuntimeId: WINDOWS_V2_ASSET.id,
    downloadBytes: WINDOWS_V2_ASSET.size,
  });

  // The same binding on another platform, or with another archive hash, is not trusted.
  assert.equal((await detect("darwin-arm64")).embeddingRuntime, "corrupt");
  writePointer(paths, WINDOWS_V1.id, "d".repeat(64));
  const tampered = await detect();
  assert.equal(tampered.embeddingRuntime, "corrupt");
  assert.equal(tampered.recommendedAction, "repair");
  assert.equal("embeddingRuntimeUpgrade" in tampered, false);
  writePointer(paths, "embedding-runtime-node22-v0-win32-x64", WINDOWS_V1.sha256);
  assert.equal((await detect()).embeddingRuntime, "corrupt", "unknown ids are never upgradable");
});
