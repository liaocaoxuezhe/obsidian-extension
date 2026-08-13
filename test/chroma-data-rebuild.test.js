"use strict";

const assert = require("node:assert/strict");
const esbuild = require("esbuild");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const loaded = new Map();
function loadTypeScriptFile(filename) {
  filename = path.resolve(filename);
  if (loaded.has(filename)) return loaded.get(filename);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  loaded.set(filename, module.exports);
  const localRequire = (specifier) => {
    if (!specifier.startsWith(".")) return require(specifier);
    const resolved = path.resolve(path.dirname(filename), specifier);
    if (fs.existsSync(`${resolved}.ts`)) return loadTypeScriptFile(`${resolved}.ts`);
    return require(resolved);
  };
  Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports, localRequire, module, filename, path.dirname(filename),
  );
  loaded.set(filename, module.exports);
  return module.exports;
}

const migrationFile = path.join(process.cwd(), "src/runtime/chroma-data-migration.ts");

async function loadBundledModule(relativePath) {
  const result = await esbuild.build({
    entryPoints: [path.join(process.cwd(), relativePath)],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["obsidian"],
    write: false,
  });
  const module = { exports: {} };
  Function("module", "exports", "require", result.outputFiles[0].text)(
    module,
    module.exports,
    (specifier) => specifier === "obsidian"
      ? { TFile: class TFile {}, Notice: class Notice {} }
      : require(specifier),
  );
  return module.exports;
}

test("CLI 1.4.4 generation always selects device-local v2 data and runtime-vault collection", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-chroma-v2-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const legacy = path.join(root, "plugin", "chroma_data", "legacy-id");
  await fs.promises.mkdir(legacy, { recursive: true });
  await fs.promises.writeFile(path.join(legacy, "chroma.sqlite3"), "legacy", "utf8");
  const before = await fs.promises.stat(path.join(legacy, "chroma.sqlite3"));
  const { createChromaDataGeneration } = loadTypeScriptFile(migrationFile);

  const generation = createChromaDataGeneration({
    localDataRoot: root,
    runtimeVaultId: "vault-v2-0123456789abcdef",
    modelShortName: "bge-small-en-v1.5",
    port: 8123,
    legacyDataPath: legacy,
    transitionToken: "0123456789abcdef0123456789abcdef",
  });

  assert.deepEqual(generation, {
    schemaVersion: 1,
    generation: "v2",
    runtimeId: "chroma-cli-1.4.4",
    runtimeVaultId: "vault-v2-0123456789abcdef",
    modelShortName: "bge-small-en-v1.5",
    collectionName: "analogy_vault-v2-0123456789abcdef_bge-small-en-v1.5_0123456789ab",
    dataPath: path.join(root, "vaults", "vault-v2-0123456789abcdef", "chroma_data_v2"),
    port: 8123,
    rebuildCompletedAt: null,
    legacyDataPath: legacy,
    transitionToken: "0123456789abcdef0123456789abcdef",
    stateRevision: null,
  });
  const after = await fs.promises.stat(path.join(legacy, "chroma.sqlite3"));
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.size, before.size);
});

test("device-local index state isolates generation and model while preserving rollback state", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-index-state-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const { createDeviceLocalIndexStateStore } = loadTypeScriptFile(migrationFile);
  const oldStore = createDeviceLocalIndexStateStore(root, "legacy", "jina-nano");
  const nextStore = createDeviceLocalIndexStateStore(root, "v2", "jina-nano");
  const otherModel = createDeviceLocalIndexStateStore(root, "v2", "bge-small-zh");
  await oldStore.save({ "旧笔记.md": { path: "旧笔记.md", mtime: 3, chunkCount: 2 } });

  assert.equal(await nextStore.load(), undefined);
  assert.equal(await otherModel.load(), undefined);
  await nextStore.save({ "新笔记.md": { path: "新笔记.md", mtime: 4, chunkCount: 1 } });
  assert.deepEqual(await oldStore.load(), { "旧笔记.md": { path: "旧笔记.md", mtime: 3, chunkCount: 2 } });
  assert.deepEqual(await nextStore.load(), { "新笔记.md": { path: "新笔记.md", mtime: 4, chunkCount: 1 } });
  await otherModel.save({ "资料/Cafe\u0301.md": { path: "资料/Cafe\u0301.md", mtime: 5, chunkCount: 1 } });
  assert.deepEqual(await otherModel.load(), {
    "资料/Café.md": { path: "资料/Café.md", mtime: 5, chunkCount: 1 },
  });
});

test("atomic runtime-state writes remove temporary files after write and sync failures", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-atomic-cleanup-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const { ChromaDataMigration, createChromaDataGeneration } = loadTypeScriptFile(migrationFile);
  const originalOpen = fs.promises.open;
  t.after(() => { fs.promises.open = originalOpen; });

  for (const failureMethod of ["writeFile", "sync"]) {
    const stageRoot = path.join(root, failureMethod);
    const runtimeStatePath = path.join(
      stageRoot, "vaults", "vault-v2-0123456789abcdef", "runtime-state.json",
    );
    const manager = new ChromaDataMigration({ runtimeStatePath });
    const generation = createChromaDataGeneration({
      localDataRoot: stageRoot,
      runtimeVaultId: "vault-v2-0123456789abcdef",
      modelShortName: "jina-nano",
      port: 8123,
    });
    fs.promises.open = async (filename, ...args) => {
      const handle = await originalOpen.call(fs.promises, filename, ...args);
      if (String(filename).endsWith(".tmp")) {
        handle[failureMethod] = async () => { throw new Error(`forced-${failureMethod}-failure`); };
      }
      return handle;
    };
    await assert.rejects(() => manager.begin(generation), new RegExp(`forced-${failureMethod}-failure`));
    fs.promises.open = originalOpen;
    const stateDirectory = path.dirname(runtimeStatePath);
    assert.deepEqual(
      (await fs.promises.readdir(stateDirectory)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  }
});

test("synchronized plugin settings are sanitized of active port and every generation index state", () => {
  const { extractDeviceLocalSettings } = loadTypeScriptFile(migrationFile);
  const migrated = extractDeviceLocalSettings({
    uiLanguage: "zh",
    chromaPort: 8123,
    indexStates: { "jina-nano": { "私密.md": { mtime: 1, chunkCount: 1 } } },
    unrelated: "保留",
  });
  assert.deepEqual(migrated.synchronizedSettings, { uiLanguage: "zh", unrelated: "保留" });
  assert.equal(migrated.legacyPort, 8123);
  assert.deepEqual(migrated.legacyIndexStates, {
    "jina-nano": { "私密.md": { mtime: 1, chunkCount: 1 } },
  });
  assert.equal(JSON.stringify(migrated.synchronizedSettings).includes("私密.md"), false);
});

test("rebuild commits completion and path-free runtime state only after all verification gates", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-rebuild-gate-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const { ChromaDataMigration, createChromaDataGeneration } = loadTypeScriptFile(migrationFile);
  const runtimeStatePath = path.join(root, "vaults", "vault-v2-0123456789abcdef", "runtime-state.json");
  const generation = createChromaDataGeneration({
    localDataRoot: root, runtimeVaultId: "vault-v2-0123456789abcdef",
    modelShortName: "bge-small-en-v1.5", port: 8123, legacyDataPath: "/旧目录/不可写",
    transitionToken: "dddddddddddddddddddddddddddddddd",
  });
  const manager = new ChromaDataMigration({ runtimeStatePath, now: () => 1700000000123 });
  const transition = await manager.begin(generation);

  await assert.rejects(() => manager.completeRebuild(transition, {
    expectedFileCount: 2,
    indexState: { "a.md": { mtime: 1, chunkCount: 2 } },
    chunkCount: 2,
    smokeQuery: async () => [{ content: "fixed-query-result" }],
  }), /CHROMA_REBUILD_FILE_COUNT_MISMATCH/);
  assert.equal((await manager.read()).activeGeneration, null);
  assert.equal((await manager.read()).pendingGeneration.rebuildCompletedAt, null);

  const completed = await manager.completeRebuild(transition, {
    expectedFileCount: 2,
    indexState: {
      "a.md": { path: "a.md", mtime: 1, chunkCount: 2 },
      "b.md": { path: "b.md", mtime: 1, chunkCount: 1 },
    },
    chunkCount: 3,
    smokeQuery: async (query) => {
      assert.equal(query, "Analogy 固定重建验证查询");
      return [{ content: "fixed-query-result" }];
    },
  });
  assert.equal(completed.rebuildCompletedAt, 1700000000123);
  const disk = JSON.parse(await fs.promises.readFile(runtimeStatePath, "utf8"));
  assert.equal(disk.schemaVersion, 1);
  assert.equal(disk.revision, 2);
  assert.equal(disk.runtimeVaultId, "vault-v2-0123456789abcdef");
  assert.equal(disk.activeGeneration, "v2");
  assert.equal(disk.previousGeneration, null);
  assert.equal(disk.pendingGeneration, null);
  assert.equal(disk.runtimeId, "chroma-cli-1.4.4");
  assert.equal(disk.port, 8123);
  assert.equal(disk.modelShortName, "bge-small-en-v1.5");
  assert.equal(disk.collectionName, "analogy_vault-v2-0123456789abcdef_bge-small-en-v1.5_dddddddddddd");
  assert.equal(disk.rebuildCompletedAt, 1700000000123);
  assert.deepEqual({
    evidenceId: disk.scopeCompletion.evidenceId,
    scopeType: disk.scopeCompletion.scopeType,
    fileCount: disk.scopeCompletion.fileCount,
    chunkCount: disk.scopeCompletion.chunkCount,
    completedAt: disk.scopeCompletion.completedAt,
  }, {
    evidenceId: "dddddddddddddddddddddddddddddddd",
    scopeType: "vault",
    fileCount: 2,
    chunkCount: 3,
    completedAt: 1700000000123,
  });
  assert.equal(JSON.stringify(disk).includes(root), false);
  assert.equal(JSON.stringify(disk).includes("旧目录"), false);
});

test("failed smoke query retains both data directories and the previous generation pointer", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-rebuild-rollback-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const { ChromaDataMigration, createChromaDataGeneration } = loadTypeScriptFile(migrationFile);
  const legacy = path.join(root, "legacy-data");
  const v2 = path.join(root, "vaults", "vault-v2-0123456789abcdef", "chroma_data_v2");
  await fs.promises.mkdir(legacy, { recursive: true });
  await fs.promises.mkdir(v2, { recursive: true });
  await fs.promises.writeFile(path.join(legacy, "old"), "old", "utf8");
  await fs.promises.writeFile(path.join(v2, "new"), "new", "utf8");
  const generation = createChromaDataGeneration({
    localDataRoot: root, runtimeVaultId: "vault-v2-0123456789abcdef",
    modelShortName: "jina-nano", port: 8000, legacyDataPath: legacy,
  });
  const manager = new ChromaDataMigration({ runtimeStatePath: path.join(path.dirname(v2), "runtime-state.json") });
  await manager.writeLegacyPointerForMigration("legacy", 7999, "analogy_legacy_jina-nano", "jina-nano");
  const transition = await manager.begin(generation);

  await assert.rejects(() => manager.completeRebuild(transition, {
    expectedFileCount: 1,
    indexState: { "a.md": { mtime: 1, chunkCount: 1 } },
    chunkCount: 1,
    smokeQuery: async () => [],
  }), /CHROMA_REBUILD_SMOKE_FAILED/);
  assert.equal((await manager.read()).activeGeneration, "legacy");
  assert.equal(await fs.promises.readFile(path.join(legacy, "old"), "utf8"), "old");
  assert.equal(await fs.promises.readFile(path.join(v2, "new"), "utf8"), "new");
});

test("embedding, state-save, count, and smoke failures preserve one pending generation for retry", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-staging-retry-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const { ChromaDataMigration, createChromaDataGeneration } = loadTypeScriptFile(migrationFile);
  const manager = new ChromaDataMigration({
    runtimeStatePath: path.join(root, "vaults", "vault-v2-0123456789abcdef", "runtime-state.json"),
  });
  const initial = createChromaDataGeneration({
    localDataRoot: root,
    runtimeVaultId: "vault-v2-0123456789abcdef",
    modelShortName: "jina-nano",
    port: 8123,
    transitionToken: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  });
  let transition = await manager.begin(initial);
  const identity = {
    transitionToken: transition.transitionToken,
    collectionName: transition.collectionName,
  };
  const assertSamePending = async () => {
    const pending = await manager.resumePendingGeneration(root, null);
    assert.equal(pending.transitionToken, identity.transitionToken);
    assert.equal(pending.collectionName, identity.collectionName);
    transition = await manager.publishActiveLease({ ...pending, port: 8123 });
  };

  for (const stage of ["embedding", "index-state-save"]) {
    await assert.rejects(Promise.reject(new Error(`${stage}-failed`)), new RegExp(`${stage}-failed`));
    await assertSamePending();
  }
  await assert.rejects(() => manager.completeRebuild(transition, {
    expectedFileCount: 2,
    indexState: { "a.md": { path: "a.md", mtime: 1, chunkCount: 1 } },
    chunkCount: 1,
    smokeQuery: async () => [{ content: "hit" }],
  }), /CHROMA_REBUILD_FILE_COUNT_MISMATCH/);
  await assertSamePending();
  await assert.rejects(() => manager.completeRebuild(transition, {
    expectedFileCount: 1,
    indexState: { "a.md": { path: "a.md", mtime: 1, chunkCount: 1 } },
    chunkCount: 1,
    smokeQuery: async () => [],
  }), /CHROMA_REBUILD_SMOKE_FAILED/);
  await assertSamePending();

  assert.equal((await manager.read()).activeGeneration, null);
});

test("superseding pending and completing a third generation retire only unreferenced staging artifacts", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-staging-retire-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const {
    ChromaDataMigration, createChromaDataGeneration, createDeviceLocalIndexStateStore,
  } = loadTypeScriptFile(migrationFile);
  const runtimeVaultId = "vault-v2-0123456789abcdef";
  const vaultRoot = path.join(root, "vaults", runtimeVaultId);
  const manager = new ChromaDataMigration({ runtimeStatePath: path.join(vaultRoot, "runtime-state.json") });
  const removedCollections = [];
  const cleanupCollection = async (name) => { removedCollections.push(name); };
  const make = (token, model = "jina-nano") => createChromaDataGeneration({
    localDataRoot: root, runtimeVaultId, modelShortName: model, port: 8123, transitionToken: token,
  });

  const abandoned = make("11111111111111111111111111111111", "bge-small-zh");
  await manager.begin(abandoned);
  await createDeviceLocalIndexStateStore(vaultRoot, "v2", abandoned.modelShortName, abandoned.transitionToken)
    .save({ "旧.md": { path: "旧.md", mtime: 1, chunkCount: 1 } });
  const first = make("22222222222222222222222222222222");
  let transition = await manager.begin(first, cleanupCollection);
  assert.deepEqual(removedCollections, [abandoned.collectionName]);
  assert.equal(fs.existsSync(path.join(
    vaultRoot, "index-states", "v2", abandoned.modelShortName, `${abandoned.transitionToken}.json`,
  )), false);

  const verification = (name, mtime) => ({
    expectedFileCount: 1,
    selectedDocuments: [{ docId: name, path: name, mtime }],
    indexState: { [name]: { path: name, mtime, chunkCount: 1 } },
    collectionDocuments: [{ docId: name, path: name, mtime, chunkCount: 1 }],
    chunkCount: 1, smokeQuery: async () => ["hit"], cleanupCollection,
  });
  await createDeviceLocalIndexStateStore(vaultRoot, "v2", first.modelShortName, first.transitionToken)
    .save(verification("一.md", 1).indexState);
  await manager.completeRebuild(transition, verification("一.md", 1));
  const second = make("33333333333333333333333333333333");
  transition = await manager.begin(second, cleanupCollection);
  await createDeviceLocalIndexStateStore(vaultRoot, "v2", second.modelShortName, second.transitionToken)
    .save(verification("二.md", 2).indexState);
  await manager.completeRebuild(transition, verification("二.md", 2));
  const third = make("44444444444444444444444444444444");
  transition = await manager.begin(third, cleanupCollection);
  await createDeviceLocalIndexStateStore(vaultRoot, "v2", third.modelShortName, third.transitionToken)
    .save(verification("三.md", 3).indexState);
  await manager.completeRebuild(transition, verification("三.md", 3));

  assert.deepEqual(removedCollections, [abandoned.collectionName, first.collectionName]);
  assert.equal(fs.existsSync(path.join(vaultRoot, "generation-evidence", `${first.transitionToken}.json`)), false);
  assert.equal(fs.existsSync(path.join(
    vaultRoot, "index-states", "v2", first.modelShortName, `${first.transitionToken}.json`,
  )), false);
  assert.equal(fs.existsSync(path.join(vaultRoot, "generation-evidence", `${second.transitionToken}.json`)), true,
    "previous generation must remain rollback-safe");
  assert.equal((await manager.read()).collectionName, third.collectionName);
});

test("rollback atomically restores the complete legacy port, model and collection pointer", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-pointer-rollback-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const { ChromaDataMigration, createChromaDataGeneration } = loadTypeScriptFile(migrationFile);
  const manager = new ChromaDataMigration({
    runtimeStatePath: path.join(root, "vaults", "vault-v2-0123456789abcdef", "runtime-state.json"),
    now: () => 1700000000999,
  });
  await manager.writeLegacyPointerForMigration("legacy", 7999, "analogy_legacy_jina-nano", "jina-nano");
  const generation = createChromaDataGeneration({
    localDataRoot: root, runtimeVaultId: "vault-v2-0123456789abcdef",
    modelShortName: "bge-small-en-v1.5", port: 8123,
  });
  const transition = await manager.begin(generation);
  await manager.completeRebuild(transition, {
    expectedFileCount: 1,
    indexState: { "a.md": { mtime: 1, chunkCount: 1 } },
    chunkCount: 1,
    smokeQuery: async () => [{ content: "hit" }],
  });
  await manager.rollbackToLegacy();

  const rolledBack = await manager.read();
  assert.equal(rolledBack.activeGeneration, "legacy");
  assert.equal(rolledBack.runtimeId, "legacy-chroma");
  assert.equal(rolledBack.port, 7999);
  assert.equal(rolledBack.modelShortName, "jina-nano");
  assert.equal(rolledBack.collectionName, "analogy_legacy_jina-nano");
  assert.equal(rolledBack.previousGeneration.generation, "v2");
  assert.equal(rolledBack.previousGeneration.port, 8123);
});

test("legacy vector completion requires exact copy evidence before atomically replacing the legacy pointer", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-vector-pointer-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const { ChromaDataMigration, createChromaDataGeneration } = loadTypeScriptFile(migrationFile);
  let now = 1700000002000;
  const manager = new ChromaDataMigration({
    runtimeStatePath: path.join(root, "vaults", "vault-v2-0123456789abcdef", "runtime-state.json"),
    now: () => now++,
  });
  await manager.writeLegacyPointerForMigration(
    "legacy", 7999, "analogy_legacy_bge-small-en-v1.5", "bge-small-en-v1.5",
  );
  const generation = createChromaDataGeneration({
    localDataRoot: root,
    runtimeVaultId: "vault-v2-0123456789abcdef",
    modelShortName: "bge-small-en-v1.5",
    port: 8123,
    transitionToken: "77777777777777777777777777777777",
  });
  const transition = await manager.begin(generation);
  const verification = {
    expectedFileCount: 1,
    selectedDocuments: [{ docId: "a.md", path: "a.md", mtime: 1 }],
    indexState: { "a.md": { path: "a.md", mtime: 1, chunkCount: 2 } },
    collectionDocuments: [{ docId: "a.md", path: "a.md", mtime: 1, chunkCount: 2 }],
    chunkCount: 2,
    smokeQuery: async () => ["chunk-a"],
  };
  const copyEvidence = {
    sourceIdentity: "a".repeat(64),
    sourceCollectionName: "analogy_legacy_bge-small-en-v1.5",
    sourceModelId: "Xenova/bge-small-en-v1.5",
    sourceModelShortName: "bge-small-en-v1.5",
    targetTransitionToken: transition.transitionToken,
    targetCollectionName: transition.collectionName,
    recordCount: 2,
    recordDigest: "b".repeat(64),
    vectorDimension: 384,
    sourceTopIds: ["chunk-a", "chunk-b", "chunk-c"],
    targetTopIds: ["chunk-x", "chunk-a", "chunk-y"],
  };

  for (const [field, value, code] of [
    ["targetTransitionToken", "8".repeat(32), "CHROMA_MIGRATION_TRANSITION_MISMATCH"],
    ["targetCollectionName", `${transition.collectionName}-wrong`, "CHROMA_MIGRATION_TRANSITION_MISMATCH"],
    ["sourceModelShortName", "jina-nano", "CHROMA_MIGRATION_MODEL_MISMATCH"],
    ["recordCount", -1, "CHROMA_MIGRATION_COUNT_MISMATCH"],
    ["recordDigest", "invalid", "CHROMA_MIGRATION_DIGEST_INVALID"],
    ["vectorDimension", 0, "CHROMA_MIGRATION_DIMENSION_INVALID"],
    ["targetTopIds", ["different", "other", "unrelated"], "CHROMA_MIGRATION_SMOKE_MISMATCH"],
  ]) {
    await assert.rejects(
      manager.completeLegacyVectorMigration(transition, { ...copyEvidence, [field]: value }, verification),
      new RegExp(code),
    );
    const retained = await manager.read();
    assert.equal(retained.activeGeneration, "legacy");
    assert.equal(retained.port, 7999);
    assert.equal(retained.pendingGeneration.transitionToken, transition.transitionToken);
  }

  const reconciledVerification = {
    ...verification,
    indexState: { "a.md": { path: "a.md", mtime: 2, chunkCount: 3 } },
    selectedDocuments: [{ docId: "a.md", path: "a.md", mtime: 2 }],
    collectionDocuments: [{ docId: "a.md", path: "a.md", mtime: 2, chunkCount: 3 }],
    chunkCount: 3,
  };
  const completed = await manager.completeLegacyVectorMigration(transition, copyEvidence, reconciledVerification);
  assert.equal(completed.rebuildCompletedAt, 1700000002001);
  const active = await manager.read();
  assert.equal(active.activeGeneration, "v2");
  assert.equal(active.collectionName, transition.collectionName);
  assert.equal(active.previousGeneration.generation, "legacy");
  assert.equal(active.previousGeneration.port, 7999);
  assert.equal(active.previousGeneration.collectionName, "analogy_legacy_bge-small-en-v1.5");
});

test("discarding a pending legacy migration removes only its staging generation", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-vector-discard-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const { ChromaDataMigration, createChromaDataGeneration } = loadTypeScriptFile(migrationFile);
  const manager = new ChromaDataMigration({
    runtimeStatePath: path.join(root, "vaults", "vault-v2-0123456789abcdef", "runtime-state.json"),
  });
  await manager.writeLegacyPointerForMigration(
    "legacy", 7999, "analogy_legacy_bge-small-en-v1.5", "bge-small-en-v1.5",
  );
  const transition = await manager.begin(createChromaDataGeneration({
    localDataRoot: root, runtimeVaultId: "vault-v2-0123456789abcdef",
    modelShortName: "bge-small-en-v1.5", port: 8123,
  }));
  const removed = [];
  assert.equal(await manager.discardPendingGeneration(
    transition.transitionToken, async (name) => removed.push(name),
  ), true);
  const state = await manager.read();
  assert.equal(state.activeGeneration, "legacy");
  assert.equal(state.pendingGeneration, null);
  assert.deepEqual(removed, [transition.collectionName]);
  assert.equal(await manager.discardPendingGeneration(transition.transitionToken), false);
});

test("publishing a restarted completed v2 lease updates its port without reopening pending rebuild", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-v2-restart-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const { ChromaDataMigration, createChromaDataGeneration } = loadTypeScriptFile(migrationFile);
  const manager = new ChromaDataMigration({
    runtimeStatePath: path.join(root, "vaults", "vault-v2-0123456789abcdef", "runtime-state.json"),
    now: () => 1700000000999,
  });
  const initial = createChromaDataGeneration({
    localDataRoot: root, runtimeVaultId: "vault-v2-0123456789abcdef",
    modelShortName: "jina-nano", port: 8123,
  });
  const transition = await manager.begin(initial);
  await manager.completeRebuild(transition, {
    expectedFileCount: 1,
    indexState: { "a.md": { mtime: 1, chunkCount: 1 } },
    chunkCount: 1,
    smokeQuery: async () => [{ content: "hit" }],
  });
  await manager.publishActiveLease({ ...initial, port: 8124 });

  const restarted = await manager.read();
  assert.equal(restarted.activeGeneration, "v2");
  assert.equal(restarted.port, 8124);
  assert.equal(restarted.pendingGeneration, null);
  assert.equal(restarted.rebuildCompletedAt, 1700000000999);
});

test("rollback restores the previous completed v2 model collection as well as legacy", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-model-rollback-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const { ChromaDataMigration, createChromaDataGeneration } = loadTypeScriptFile(migrationFile);
  let now = 1700000000100;
  const manager = new ChromaDataMigration({
    runtimeStatePath: path.join(root, "vaults", "vault-v2-0123456789abcdef", "runtime-state.json"),
    now: () => now++,
  });
  const first = createChromaDataGeneration({
    localDataRoot: root, runtimeVaultId: "vault-v2-0123456789abcdef",
    modelShortName: "jina-nano", port: 8123,
  });
  const firstTransition = await manager.begin(first);
  await manager.completeRebuild(firstTransition, {
    expectedFileCount: 1, indexState: { "a.md": { mtime: 1, chunkCount: 1 } },
    chunkCount: 1, smokeQuery: async () => ["hit"],
  });
  const second = createChromaDataGeneration({
    localDataRoot: root, runtimeVaultId: "vault-v2-0123456789abcdef",
    modelShortName: "bge-small-en-v1.5", port: 8124,
  });
  const secondTransition = await manager.begin(second);
  await manager.completeRebuild(secondTransition, {
    expectedFileCount: 1, indexState: { "a.md": { mtime: 1, chunkCount: 2 } },
    chunkCount: 2, smokeQuery: async () => ["hit"],
  });
  await manager.rollbackToPreviousGeneration();

  const rolledBack = await manager.read();
  assert.equal(rolledBack.activeGeneration, "v2");
  assert.equal(rolledBack.modelShortName, "jina-nano");
  assert.equal(rolledBack.collectionName, first.collectionName);
  assert.equal(rolledBack.port, 8123);

  await manager.rollbackToPreviousGeneration();
  const compensated = await manager.read();
  assert.equal(compensated.activeGeneration, "v2");
  assert.equal(compensated.modelShortName, "bge-small-en-v1.5");
  assert.equal(compensated.collectionName, second.collectionName,
    "a second rollback swap must restore the generation that was active before compensation");
  assert.equal(compensated.previousGeneration.collectionName, first.collectionName);
});

test("legacy cleanup requires explicit confirmation and completed v2 pointer", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-legacy-cleanup-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const legacy = path.join(root, "plugin", "chroma_data", "legacy-id");
  await fs.promises.mkdir(legacy, { recursive: true });
  const { createLegacyCleanupCapability } = loadTypeScriptFile(migrationFile);
  let trashTarget = null;
  const cleanup = createLegacyCleanupCapability({
    legacyDataPath: legacy,
    pluginDirectory: path.join(root, "plugin"),
    trustedDataRoot: root,
    quarantineRoot: path.join(root, "vaults", "vault-v2-0123456789abcdef", "legacy-quarantine"),
    isV2Completed: async () => true,
    trashItem: async (target) => { trashTarget = target; await fs.promises.rename(target, `${target}.trash`); },
  });
  await assert.rejects(() => cleanup("wrong"), /LEGACY_CLEANUP_CONFIRMATION_REQUIRED/);
  assert.equal(fs.existsSync(legacy), true);
  assert.deepEqual(await cleanup("DELETE LEGACY DATA"), { removed: 1, failed: 0, skipped: 0 });
  assert.notEqual(trashTarget, legacy, "async trash must only receive the synchronously isolated quarantine path");
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.existsSync(`${trashTarget}.trash`), true);
});

test("legacy cleanup isolates on the source volume and exposes durable list, retry, and restore recovery", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-legacy-recovery-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const pluginDirectory = path.join(root, "plugin");
  const legacy = path.join(pluginDirectory, "chroma_data", "legacy-id");
  await fs.promises.mkdir(legacy, { recursive: true });
  await fs.promises.writeFile(path.join(legacy, "chroma.sqlite3"), "legacy", "utf8");
  const { createLegacyCleanupManager } = loadTypeScriptFile(migrationFile);
  let trashFails = true;
  const trashed = [];
  const manager = createLegacyCleanupManager({
    legacyDataPath: legacy,
    pluginDirectory,
    isV2Completed: async () => true,
    trashItem: async (target) => {
      if (trashFails) throw new Error("trash unavailable");
      trashed.push(target);
      await fs.promises.rename(target, `${target}.trash`);
    },
  });

  assert.deepEqual(await manager.cleanup("DELETE LEGACY DATA"), { removed: 1, failed: 1, skipped: 0 });
  assert.equal(fs.existsSync(legacy), false);
  const recoveries = await manager.listRecoveries();
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].state, "trash-failed");
  assert.deepEqual(Object.keys(recoveries[0]).sort(), ["id", "state", "updatedAt"]);
  assert.equal(JSON.stringify(recoveries).includes(root), false);

  assert.deepEqual(await manager.restoreRecovery(recoveries[0].id), { restored: 1, failed: 0 });
  assert.equal(await fs.promises.readFile(path.join(legacy, "chroma.sqlite3"), "utf8"), "legacy");

  await manager.cleanup("DELETE LEGACY DATA");
  trashFails = false;
  const retryable = (await manager.listRecoveries())[0];
  assert.deepEqual(await manager.retryRecovery(retryable.id), { removed: 1, failed: 0 });
  assert.equal(trashed.length, 1);
});

test("legacy cleanup fails closed on simulated EXDEV without moving or trashing the live source", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-legacy-exdev-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const pluginDirectory = path.join(root, "plugin");
  const legacy = path.join(pluginDirectory, "chroma_data", "legacy-id");
  await fs.promises.mkdir(legacy, { recursive: true });
  await fs.promises.writeFile(path.join(legacy, "chroma.sqlite3"), "legacy", "utf8");
  const { createLegacyCleanupManager } = loadTypeScriptFile(migrationFile);
  const originalRename = fs.renameSync;
  let trashCalls = 0;
  fs.renameSync = (source, target) => {
    if (source === legacy) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
    return originalRename(source, target);
  };
  t.after(() => { fs.renameSync = originalRename; });
  const manager = createLegacyCleanupManager({
    legacyDataPath: legacy, pluginDirectory,
    isV2Completed: async () => true,
    trashItem: async () => { trashCalls += 1; },
  });

  await assert.rejects(() => manager.cleanup("DELETE LEGACY DATA"), /LEGACY_CLEANUP_ISOLATION_FAILED/);
  assert.equal(fs.existsSync(legacy), true);
  assert.equal(trashCalls, 0);
  assert.deepEqual(await manager.listRecoveries(), []);
});

test("DocumentIndexer production rebuild returns independently verifiable file, chunk, state and smoke evidence", async () => {
  const { DocumentIndexer } = await loadBundledModule("src/local-vector/document-indexer.ts");
  const saved = [];
  let chunks = 0;
  let smokeQueries = 0;
  const vectorStore = {
    deleteDocument: async () => {},
    listIndexedDocumentEntries: async () => [],
    upsertDocument: async (_docId, values) => { chunks += values.length; },
    count: async () => chunks,
    search: async (embedding, topK) => {
      smokeQueries += 1;
      return embedding[0] === 0.75 && topK === 1
        ? [{ content: "smoke-hit", metadata: { path: "一.md" } }]
        : [];
    },
  };
  const indexer = new DocumentIndexer(
    {
      embedBatch: async (texts) => texts.map(() => [0.25, 0.75]),
      embedQuery: async (query) => query === "Analogy 固定重建验证查询" ? [0.75, 0.25] : [],
      getInferenceCount: () => 0,
      resetSession: async () => {},
    },
    vectorStore,
    { adapter: { read: async () => "这是一段足够长的中文测试内容，用于完成真实索引并产生至少一个文档块。" } },
    { load: async () => undefined, save: async (state) => saved.push(JSON.parse(JSON.stringify(state))) },
  );
  const file = { path: "一.md", name: "一.md", extension: "md", stat: { mtime: 5, ctime: 4, size: 50 } };

  const evidence = await indexer.rebuildIndexVerified([file], { force: true });

  assert.equal(evidence.expectedFileCount, 1);
  assert.equal(evidence.chunkCount, 1);
  assert.equal(Object.keys(evidence.indexState).length, 1);
  assert.deepEqual(evidence.smokeResults, [{ content: "smoke-hit", metadata: { path: "一.md" } }]);
  assert.deepEqual(await indexer.runSmokeQuery("Analogy 固定重建验证查询"), [
    { content: "smoke-hit", metadata: { path: "一.md" } },
  ]);
  assert.equal(smokeQueries, 2, "completion must perform a fresh query instead of replaying verification results");
  assert.deepEqual(saved.at(-1), evidence.indexState);
});

test("DocumentIndexer reconciliation re-embeds only new changed renamed or metadata-incomplete documents", async () => {
  const { DocumentIndexer } = await loadBundledModule("src/local-vector/document-indexer.ts");
  const documents = new Map([
    ["unchanged.md", { docId: "unchanged.md", path: "unchanged.md", mtime: 1, chunkCount: 1 }],
    ["changed.md", { docId: "changed.md", path: "changed.md", mtime: 1, chunkCount: 1 }],
    ["deleted.md", { docId: "deleted.md", path: "deleted.md", mtime: 1, chunkCount: 1 }],
    ["incomplete.md", { docId: "incomplete.md", path: "incomplete.md", mtime: 1, chunkCount: 1 }],
    ["old-name.md", { docId: "old-name.md", path: "old-name.md", mtime: 1, chunkCount: 1 }],
  ]);
  const deleted = [];
  const upserted = [];
  const vectorStore = {
    deleteDocument: async (docId) => { deleted.push(docId); documents.delete(docId); },
    listIndexedDocumentEntries: async () => [...documents.values()].map((item) => ({ ...item })),
    upsertDocument: async (docId, chunks, metadata) => {
      upserted.push(docId);
      documents.set(docId, { docId, path: metadata.path, mtime: metadata.mtime, chunkCount: chunks.length });
    },
    count: async () => [...documents.values()].reduce((sum, item) => sum + item.chunkCount, 0),
    search: async () => [{ content: "hit", metadata: { path: "unchanged.md" } }],
  };
  const saved = [];
  const indexer = new DocumentIndexer(
    {
      embedBatch: async (texts) => texts.map(() => [0.25, 0.75]),
      embedQuery: async () => [0.75, 0.25],
      getInferenceCount: () => 0,
      resetSession: async () => {},
    },
    vectorStore,
    { adapter: { read: async (filename) => `${filename} 这是一段足够长的中文迁移重建内容，确保生成有效文档块。` } },
    { load: async () => undefined, save: async (state) => saved.push(JSON.parse(JSON.stringify(state))) },
  );
  const file = (name, mtime) => ({
    path: name, name, extension: "md", stat: { mtime, ctime: mtime, size: 80 },
  });
  const files = [
    file("unchanged.md", 1),
    file("changed.md", 2),
    file("incomplete.md", 1),
    file("new-name.md", 2),
    file("new.md", 1),
  ];
  const migrated = [
    { docId: "unchanged.md", path: "unchanged.md", mtime: 1, chunkCount: 1, metadataComplete: true },
    { docId: "changed.md", path: "changed.md", mtime: 1, chunkCount: 1, metadataComplete: true },
    { docId: "deleted.md", path: "deleted.md", mtime: 1, chunkCount: 1, metadataComplete: true },
    { docId: "incomplete.md", path: "incomplete.md", mtime: 1, chunkCount: 1, metadataComplete: false },
    { docId: "old-name.md", path: "old-name.md", mtime: 1, chunkCount: 1, metadataComplete: true },
  ];

  const evidence = await indexer.reconcileMigratedIndex(files, migrated);

  assert.deepEqual([...new Set(upserted)].sort(), ["changed.md", "incomplete.md", "new-name.md", "new.md"]);
  assert.equal(upserted.includes("unchanged.md"), false);
  assert.deepEqual(deleted.filter((docId) => !docId.includes("::")).sort(),
    ["changed.md", "deleted.md", "incomplete.md", "old-name.md"]);
  assert.equal(deleted.includes("unchanged.md"), false);
  assert.deepEqual(evidence.selectedDocuments.map(({ docId }) => docId).sort(),
    ["changed.md", "incomplete.md", "new-name.md", "new.md", "unchanged.md"]);
  assert.equal(evidence.chunkCount, 5);
  assert.equal(Object.keys(saved.at(-1)).length, 5);
});

test("DocumentIndexer adopts copied legacy vectors without embedding and leaves only new or changed notes pending", async () => {
  const { DocumentIndexer } = await loadBundledModule("src/local-vector/document-indexer.ts");
  const collectionDocuments = [
    { docId: "current.md", path: "current.md", mtime: 10, chunkCount: 2 },
    { docId: "changed.md", path: "changed.md", mtime: 5, chunkCount: 3 },
    { docId: "deleted.md", path: "deleted.md", mtime: 3, chunkCount: 1 },
  ];
  let inferenceCount = 0;
  const saved = [];
  const indexer = new DocumentIndexer(
    {
      embedBatch: async () => { inferenceCount += 1; return []; },
      embedQuery: async () => { inferenceCount += 1; return [1, 0]; },
      getInferenceCount: () => inferenceCount,
      resetSession: async () => {},
    },
    {
      listIndexedDocumentEntries: async () => collectionDocuments.map((item) => ({ ...item })),
      count: async () => 6,
      search: async () => [{ content: "migrated hit" }],
      deleteDocument: async () => { throw new Error("adoption must not delete copied vectors"); },
      upsertDocument: async () => { throw new Error("adoption must not re-embed copied vectors"); },
    },
    { adapter: { read: async () => "not used" } },
    { load: async () => undefined, save: async (state) => saved.push(JSON.parse(JSON.stringify(state))) },
  );
  const file = (name, mtime) => ({
    path: name, name, extension: "md", stat: { mtime, ctime: mtime, size: 80 },
  });
  const files = [file("current.md", 10), file("changed.md", 8), file("new.md", 1)];

  const evidence = await indexer.adoptMigratedIndex(files);

  assert.equal(inferenceCount, 0);
  assert.equal(evidence.chunkCount, 6);
  assert.deepEqual(evidence.selectedDocuments.map(({ docId }) => docId), ["current.md", "changed.md", "deleted.md"]);
  assert.deepEqual(indexer.getAllFileStatuses(files).map(({ path, status }) => ({ path, status })), [
    { path: "current.md", status: "indexed" },
    { path: "changed.md", status: "outdated" },
    { path: "new.md", status: "unindexed" },
  ]);
  assert.deepEqual(Object.keys(saved.at(-1)), ["current.md", "changed.md", "deleted.md"]);
});

test("DocumentIndexer canonicalizes decomposed Chinese document identities to NFC across state and Chroma metadata", async () => {
  const { DocumentIndexer } = await loadBundledModule("src/local-vector/document-indexer.ts");
  const saved = [];
  const upserts = [];
  const vectorStore = {
    deleteDocument: async () => {},
    listIndexedDocumentEntries: async () => upserts.map((item) => ({
      docId: item.docId, path: item.metadata.path, mtime: item.metadata.mtime,
      chunkCount: item.chunks.length,
    })),
    upsertDocument: async (docId, chunks, metadata) => { upserts.push({ docId, chunks, metadata }); },
    count: async () => upserts.reduce((sum, item) => sum + item.chunks.length, 0),
    search: async () => [{ content: "命中" }],
  };
  const indexer = new DocumentIndexer(
    {
      embedBatch: async (texts) => texts.map(() => [0.25, 0.75]),
      embedQuery: async () => [0.75, 0.25],
      getInferenceCount: () => 0,
      resetSession: async () => {},
    },
    vectorStore,
    { adapter: { read: async () => "足够长的中文内容，用来验证 Unicode 分解路径能够完成索引和证据校验。" } },
    { load: async () => undefined, save: async (state) => saved.push(JSON.parse(JSON.stringify(state))) },
  );
  const decomposed = "资料/Cafe\u0301中文.md";
  const canonical = "资料/Café中文.md";
  const file = { path: decomposed, name: "Cafe\u0301中文.md", extension: "md", stat: { mtime: 8, ctime: 4, size: 80 } };

  const evidence = await indexer.rebuildIndexVerified([file], { force: true });

  assert.deepEqual(evidence.selectedDocuments, [{ docId: canonical, path: canonical, mtime: 8 }]);
  assert.deepEqual(Object.keys(evidence.indexState), [canonical]);
  assert.equal(upserts[0].docId, canonical);
  assert.equal(upserts[0].metadata.path, canonical);
  assert.deepEqual(Object.keys(saved.at(-1)), [canonical]);
});

test("DocumentIndexer retry clears deleted, renamed, and out-of-scope stale documents before a smaller selection", async () => {
  const { DocumentIndexer } = await loadBundledModule("src/local-vector/document-indexer.ts");
  const documents = new Map([
    ["已删除.md", 4], ["重命名前.md", 2], ["范围外.md", 1],
  ]);
  const vectorStore = {
    listIndexedDocumentEntries: async () => [...documents].map(([docId, chunkCount]) => ({
      docId, path: docId, mtime: 1, chunkCount,
    })),
    deleteDocument: async (docId) => { documents.delete(docId); },
    upsertDocument: async (docId, chunks) => { documents.set(docId, chunks.length); },
    count: async () => [...documents.values()].reduce((sum, count) => sum + count, 0),
    search: async () => [{ content: "retry-hit" }],
  };
  const indexer = new DocumentIndexer(
    {
      embedBatch: async (texts) => texts.map(() => [1, 0]),
      embedQuery: async () => [1, 0],
      getInferenceCount: () => 0,
      resetSession: async () => {},
    },
    vectorStore,
    { adapter: { read: async () => "安全重试必须删除上一次失败留下的局部向量，然后重新建立完整索引。" } },
    { load: async () => ({
      "已删除.md": { path: "已删除.md", mtime: 1, chunkCount: 4 },
      "重命名前.md": { path: "重命名前.md", mtime: 1, chunkCount: 2 },
      "范围外.md": { path: "范围外.md", mtime: 1, chunkCount: 1 },
    }), save: async () => {} },
  );
  await indexer.loadState();
  const next = { path: "重命名后.md", name: "重命名后.md", extension: "md", stat: { mtime: 2, ctime: 1, size: 50 } };

  const evidence = await indexer.rebuildIndexVerified([next], { force: true });

  assert.deepEqual([...documents.keys()], ["重命名后.md"]);
  assert.equal(evidence.chunkCount, 1);
  assert.deepEqual(Object.keys(evidence.indexState), ["重命名后.md"]);
});

test("plugin and MCP derive the same runtime Vault ID from the shared cross-platform fixture", () => {
  const fixtures = JSON.parse(fs.readFileSync(path.join(process.cwd(), "test/fixtures/runtime-vault-id.json"), "utf8"));
  const pluginIdentity = loadTypeScriptFile(path.join(process.cwd(), "src/runtime/vault-identity.ts"));
  const mcpIdentity = loadTypeScriptFile(path.join(process.cwd(), "mcp-server/src/runtime-vault-identity.ts"));
  for (const fixture of fixtures) {
    assert.equal(pluginIdentity.deriveRuntimeVaultId(fixture.vaultPath, fixture.platform), fixture.runtimeVaultId);
    assert.equal(mcpIdentity.deriveRuntimeVaultId(fixture.vaultPath, fixture.platform), fixture.runtimeVaultId);
  }
});

test("MCP discovers the active path-free device-local generation and permits a validated port override", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-mcp-state-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, "测试 Vault");
  const pluginDir = path.join(vaultPath, ".obsidian", "plugins", "analogy-rag-in-your-vault");
  await fs.promises.mkdir(pluginDir, { recursive: true });
  const hostPlatform = process.platform === "win32" ? "win32" : "darwin";
  const mcpIdentity = loadTypeScriptFile(
    path.join(process.cwd(), "mcp-server/src/runtime-vault-identity.ts"),
  );
  const runtimeVaultId = mcpIdentity.deriveRuntimeVaultId(
    vaultPath,
    hostPlatform === "win32" ? "win32-x64" : "darwin-arm64",
  );
  const runtimeStateDir = path.join(root, "local-data", "vaults", runtimeVaultId);
  await fs.promises.mkdir(runtimeStateDir, { recursive: true });
  await fs.promises.writeFile(path.join(runtimeStateDir, "runtime-state.json"), JSON.stringify({
    schemaVersion: 1,
    revision: 7,
    runtimeVaultId,
    activeGeneration: "v2",
    previousGeneration: null,
    pendingGeneration: null,
    runtimeId: "chroma-cli-1.4.4",
    port: 8123,
    modelShortName: "bge-small-en-v1.5",
    collectionName: `analogy_${runtimeVaultId}_bge-small-en-v1.5`,
    rebuildCompletedAt: 1700000000123,
    scopeCompletion: {
      schemaVersion: 1,
      evidenceId: "ffffffffffffffffffffffffffffffff",
      scopeType: "recent",
      selectionDigest: "a".repeat(64),
      fileCount: 1,
      chunkCount: 2,
      completedAt: 1700000000123,
    },
  }), "utf8");
  const { loadConfig } = loadTypeScriptFile(path.join(process.cwd(), "mcp-server/src/config.ts"));
  const config = loadConfig({
    ANALOGY_VAULT_PATH: vaultPath,
    ANALOGY_PLUGIN_DIR: pluginDir,
    ANALOGY_LOCAL_DATA_ROOT: path.join(root, "local-data"),
    ANALOGY_CHROMA_PORT: "9001",
  }, { platform: hostPlatform, homeDirectory: root });

  assert.equal(config.runtimeVaultId, runtimeVaultId);
  assert.equal(config.vaultId, runtimeVaultId);
  assert.equal(config.runtimeGeneration, "v2");
  assert.equal(config.chromaPort, 9001);
  assert.equal(config.collectionName, `analogy_${runtimeVaultId}_bge-small-en-v1.5`);
  assert.equal(config.modelConfig.shortName, "bge-small-en-v1.5");
  assert.equal(JSON.stringify({
    runtime_generation: config.runtimeGeneration,
    chroma_port: config.chromaPort,
    collection_name: config.collectionName,
  }).includes(vaultPath), false);
});

test("MCP rejects unknown state keys, partial ports, and model overrides without completed generation evidence", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-mcp-strict-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, "Windows Secret Vault");
  const pluginDir = path.join(vaultPath, ".obsidian", "plugins", "analogy-rag-in-your-vault");
  await fs.promises.mkdir(pluginDir, { recursive: true });
  const hostPlatform = process.platform === "win32" ? "win32" : "darwin";
  const mcpIdentity = loadTypeScriptFile(
    path.join(process.cwd(), "mcp-server/src/runtime-vault-identity.ts"),
  );
  const runtimeVaultId = mcpIdentity.deriveRuntimeVaultId(
    vaultPath,
    hostPlatform === "win32" ? "win32-x64" : "darwin-arm64",
  );
  const runtimeStatePath = path.join(root, "local", "vaults", runtimeVaultId, "runtime-state.json");
  await fs.promises.mkdir(path.dirname(runtimeStatePath), { recursive: true });
  const completed = (modelShortName, collectionName, completedAt) => ({
    generation: "v2", runtimeId: "chroma-cli-1.4.4", port: 8123,
    modelShortName, collectionName, rebuildCompletedAt: completedAt,
    scopeCompletion: {
      schemaVersion: 1, evidenceId: "f".repeat(32), scopeType: "vault",
      selectionDigest: "a".repeat(64), fileCount: 1, chunkCount: 1, completedAt,
    },
  });
  const active = completed(
    "jina-nano", `analogy_${runtimeVaultId}_jina-nano_0123456789ab`, 1700000004000,
  );
  const state = {
    schemaVersion: 1, revision: 3, runtimeVaultId, activeGeneration: "v2",
    previousGeneration: null, pendingGeneration: null,
    runtimeId: active.runtimeId, port: active.port, modelShortName: active.modelShortName,
    collectionName: active.collectionName, rebuildCompletedAt: active.rebuildCompletedAt,
    scopeCompletion: active.scopeCompletion,
  };
  const baseEnvironment = {
    ANALOGY_VAULT_PATH: vaultPath,
    ANALOGY_PLUGIN_DIR: pluginDir,
    ANALOGY_LOCAL_DATA_ROOT: path.join(root, "local"),
  };
  const { loadConfig, buildSafeVaultDescription } = loadTypeScriptFile(
    path.join(process.cwd(), "mcp-server/src/config.ts"),
  );

  await fs.promises.writeFile(runtimeStatePath, JSON.stringify({ ...state, maliciousVaultPath: vaultPath }), "utf8");
  assert.throws(() => loadConfig(baseEnvironment, { platform: hostPlatform, homeDirectory: root }), /runtime-state\.json is invalid/);

  await fs.promises.writeFile(runtimeStatePath, JSON.stringify(state), "utf8");
  assert.throws(() => loadConfig({ ...baseEnvironment, ANALOGY_CHROMA_PORT: "9001junk" }, {
    platform: hostPlatform, homeDirectory: root,
  }), /Invalid ANALOGY_CHROMA_PORT/);
  assert.throws(() => loadConfig({ ...baseEnvironment, ANALOGY_MODEL: "bge-small-en-v1.5" }, {
    platform: hostPlatform, homeDirectory: root,
  }), /completed generation/);

  state.previousGeneration = completed(
    "bge-small-en-v1.5",
    `analogy_${runtimeVaultId}_bge-small-en-v1.5_abcdefabcdef`,
    1700000003000,
  );
  await fs.promises.writeFile(runtimeStatePath, JSON.stringify(state), "utf8");
  const overridden = loadConfig({ ...baseEnvironment, ANALOGY_MODEL: "bge-small-en-v1.5" }, {
    platform: hostPlatform, homeDirectory: root,
  });
  assert.equal(overridden.collectionName, state.previousGeneration.collectionName);
  assert.equal(overridden.chromaPort, state.port, "model override uses the current actual server lease");
  const description = buildSafeVaultDescription(overridden);
  assert.equal(description.includes(vaultPath), false);
  assert.equal(description.includes("Windows Secret Vault"), false);
  assert.equal(description.includes(runtimeVaultId), true);
});

test("MCP Chroma client fails closed on an invalid discovered port", () => {
  const { ChromaClient } = loadTypeScriptFile(
    path.join(process.cwd(), "mcp-server/src/chroma-client.ts"),
  );
  assert.throws(() => new ChromaClient(0), /INVALID_CHROMA_PORT/);
  assert.throws(() => new ChromaClient(65536), /INVALID_CHROMA_PORT/);
});

test("runtime-state serializes lease publication with begin and preserves the pending transition", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-state-rmw-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const { ChromaDataMigration, createChromaDataGeneration } = loadTypeScriptFile(migrationFile);
  const runtimeStatePath = path.join(root, "vaults", "vault-v2-0123456789abcdef", "runtime-state.json");
  const manager = new ChromaDataMigration({ runtimeStatePath, now: () => 1700000001000 });
  const active = createChromaDataGeneration({
    localDataRoot: root, runtimeVaultId: "vault-v2-0123456789abcdef",
    modelShortName: "jina-nano", port: 8123, transitionToken: "11111111111111111111111111111111",
  });
  const activeTransition = await manager.begin(active);
  await manager.completeRebuild(activeTransition, {
    scopeType: "recent",
    selectedDocuments: [{ docId: "a.md", path: "a.md", mtime: 1 }],
    indexState: { "a.md": { path: "a.md", mtime: 1, chunkCount: 1 } },
    collectionDocuments: [{ docId: "a.md", path: "a.md", mtime: 1, chunkCount: 1 }],
    chunkCount: 1,
    smokeQuery: async () => ["hit"],
  });

  const originalRename = fs.promises.rename;
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  let gated = false;
  fs.promises.rename = async (source, target) => {
    if (!gated && target === runtimeStatePath) {
      gated = true;
      enteredResolve();
      await release;
    }
    return originalRename.call(fs.promises, source, target);
  };
  t.after(() => { fs.promises.rename = originalRename; });

  const leasePublish = manager.publishActiveLease({ ...activeTransition, port: 8124 });
  await entered;
  const next = createChromaDataGeneration({
    localDataRoot: root, runtimeVaultId: "vault-v2-0123456789abcdef",
    modelShortName: "bge-small-en-v1.5", port: 8124,
    transitionToken: "22222222222222222222222222222222",
  });
  let beginFinished = false;
  const beginNext = manager.begin(next).then((value) => { beginFinished = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(beginFinished, false, "begin must wait for the in-flight state RMW");
  releaseResolve();
  await leasePublish;
  const nextTransition = await beginNext;
  const state = await manager.read();
  assert.equal(state.port, 8124);
  assert.equal(state.pendingGeneration.transitionToken, nextTransition.transitionToken);
  assert.equal(state.revision, nextTransition.stateRevision);
});

test("complete uses revision and transition-token CAS and rejects a superseded generation", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-state-cas-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const { ChromaDataMigration, createChromaDataGeneration } = loadTypeScriptFile(migrationFile);
  const manager = new ChromaDataMigration({
    runtimeStatePath: path.join(root, "vaults", "vault-v2-0123456789abcdef", "runtime-state.json"),
  });
  const first = await manager.begin(createChromaDataGeneration({
    localDataRoot: root, runtimeVaultId: "vault-v2-0123456789abcdef",
    modelShortName: "jina-nano", port: 8123, transitionToken: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }));
  await manager.begin(createChromaDataGeneration({
    localDataRoot: root, runtimeVaultId: "vault-v2-0123456789abcdef",
    modelShortName: "bge-small-zh", port: 8123, transitionToken: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  }));
  await assert.rejects(() => manager.completeRebuild(first, {
    scopeType: "vault",
    selectedDocuments: [{ docId: "a.md", path: "a.md", mtime: 1 }],
    indexState: { "a.md": { path: "a.md", mtime: 1, chunkCount: 1 } },
    collectionDocuments: [{ docId: "a.md", path: "a.md", mtime: 1, chunkCount: 1 }],
    chunkCount: 1,
    smokeQuery: async () => ["hit"],
  }), /CHROMA_REBUILD_TRANSITION_MISMATCH/);
});

test("concurrent completion serializes evidence with CAS and a losing completion cannot overwrite it", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-complete-race-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const { ChromaDataMigration, createChromaDataGeneration } = loadTypeScriptFile(migrationFile);
  let now = 1700000000200;
  const runtimeVaultId = "vault-v2-0123456789abcdef";
  const manager = new ChromaDataMigration({
    runtimeStatePath: path.join(root, "vaults", runtimeVaultId, "runtime-state.json"),
    now: () => now++,
  });
  const transition = await manager.begin(createChromaDataGeneration({
    localDataRoot: root, runtimeVaultId, modelShortName: "jina-nano", port: 8123,
    transitionToken: "abababababababababababababababab",
  }));
  const verification = {
    expectedFileCount: 1,
    selectedDocuments: [{ docId: "中文.md", path: "中文.md", mtime: 1 }],
    indexState: { "中文.md": { path: "中文.md", mtime: 1, chunkCount: 1 } },
    collectionDocuments: [{ docId: "中文.md", path: "中文.md", mtime: 1, chunkCount: 1 }],
    chunkCount: 1,
    smokeQuery: async () => [{ content: "hit" }],
  };

  const settled = await Promise.allSettled([
    manager.completeRebuild(transition, verification),
    manager.completeRebuild(transition, verification),
  ]);
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(settled.filter((item) => item.status === "rejected"
    && /CHROMA_REBUILD_TRANSITION_MISMATCH/.test(item.reason.message)).length, 1);
  const state = await manager.read();
  const evidencePath = path.join(
    root, "vaults", runtimeVaultId, "generation-evidence", "abababababababababababababababab.json",
  );
  const evidence = JSON.parse(await fs.promises.readFile(evidencePath, "utf8"));
  assert.equal(evidence.completedAt, state.rebuildCompletedAt);
  assert.equal(await manager.isCompletedFor({ modelShortName: "jina-nano", indexState: verification.indexState }), true);
  assert.deepEqual(await fs.promises.readdir(path.dirname(evidencePath)), [path.basename(evidencePath)]);
});

test("rebuild evidence rejects failed selection and equal-count stale document substitution", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-stale-evidence-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const { ChromaDataMigration, createChromaDataGeneration } = loadTypeScriptFile(migrationFile);
  const manager = new ChromaDataMigration({
    runtimeStatePath: path.join(root, "vaults", "vault-v2-0123456789abcdef", "runtime-state.json"),
  });
  const transition = await manager.begin(createChromaDataGeneration({
    localDataRoot: root, runtimeVaultId: "vault-v2-0123456789abcdef",
    modelShortName: "jina-nano", port: 8123, transitionToken: "cccccccccccccccccccccccccccccccc",
  }));
  await assert.rejects(() => manager.completeRebuild(transition, {
    scopeType: "folder",
    selectedDocuments: [{ docId: "wanted.md", path: "wanted.md", mtime: 9 }],
    indexState: { "replacement.md": { path: "replacement.md", mtime: 9, chunkCount: 1 } },
    collectionDocuments: [{ docId: "replacement.md", path: "replacement.md", mtime: 9, chunkCount: 1 }],
    chunkCount: 1,
    smokeQuery: async () => ["hit"],
  }), /CHROMA_REBUILD_DOCUMENT_EVIDENCE_MISMATCH/);
});

test("runtime-state parser rejects unknown and path-like fields", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-state-schema-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const { ChromaDataMigration } = loadTypeScriptFile(migrationFile);
  const runtimeStatePath = path.join(root, "vaults", "vault-v2-0123456789abcdef", "runtime-state.json");
  await fs.promises.mkdir(path.dirname(runtimeStatePath), { recursive: true });
  await fs.promises.writeFile(runtimeStatePath, JSON.stringify({
    schemaVersion: 1, revision: 1, runtimeVaultId: "vault-v2-0123456789abcdef",
    activeGeneration: "legacy", previousGeneration: null, pendingGeneration: null,
    runtimeId: "legacy-chroma", port: 8000, modelShortName: "jina-nano",
    collectionName: "analogy_legacy_jina-nano", rebuildCompletedAt: null,
    scopeCompletion: null, maliciousVaultPath: "C:\\Users\\secret\\Vault",
  }), "utf8");
  const manager = new ChromaDataMigration({ runtimeStatePath });
  await assert.rejects(() => manager.read(), /RUNTIME_STATE_INVALID/);
});

test("legacy Task14 v2 state is durably upgraded to a recoverable pending transition", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-state-upgrade-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const { ChromaDataMigration } = loadTypeScriptFile(migrationFile);
  const runtimeVaultId = "vault-v2-0123456789abcdef";
  const runtimeStatePath = path.join(root, "vaults", runtimeVaultId, "runtime-state.json");
  await fs.promises.mkdir(path.dirname(runtimeStatePath), { recursive: true });
  await fs.promises.writeFile(runtimeStatePath, JSON.stringify({
    schemaVersion: 1, runtimeVaultId, activeGeneration: "v2",
    previousGeneration: null, pendingGeneration: null, runtimeId: "chroma-cli-1.4.4",
    port: 8123, modelShortName: "jina-nano",
    collectionName: `analogy_${runtimeVaultId}_jina-nano`, rebuildCompletedAt: 1700000000000,
  }), "utf8");
  const manager = new ChromaDataMigration({ runtimeStatePath, now: () => 1700000002000 });

  const upgraded = await manager.read();

  assert.equal(upgraded.revision, 1);
  assert.equal(upgraded.activeGeneration, null);
  assert.equal(upgraded.rebuildCompletedAt, null);
  assert.equal(upgraded.scopeCompletion, null);
  assert.equal(upgraded.pendingGeneration.collectionName, `analogy_${runtimeVaultId}_jina-nano`);
  assert.match(upgraded.pendingGeneration.transitionToken, /^[0-9a-f]{32}$/);
  assert.deepEqual(JSON.parse(await fs.promises.readFile(runtimeStatePath, "utf8")), upgraded);
});

test("completed scope readiness survives normal index changes but rejects tampered durable evidence", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-scope-superset-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const { ChromaDataMigration, createChromaDataGeneration } = loadTypeScriptFile(migrationFile);
  const manager = new ChromaDataMigration({
    runtimeStatePath: path.join(root, "vaults", "vault-v2-0123456789abcdef", "runtime-state.json"),
    now: () => 1700000003000,
  });
  const transition = await manager.begin(createChromaDataGeneration({
    localDataRoot: root, runtimeVaultId: "vault-v2-0123456789abcdef",
    modelShortName: "jina-nano", port: 8123,
    transitionToken: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  }));
  await manager.completeRebuild(transition, {
    scopeType: "recent",
    selectedDocuments: [{ docId: "selected.md", path: "selected.md", mtime: 10 }],
    indexState: { "selected.md": { path: "selected.md", mtime: 10, chunkCount: 1 } },
    collectionDocuments: [{ docId: "selected.md", path: "selected.md", mtime: 10, chunkCount: 1 }],
    chunkCount: 1,
    smokeQuery: async () => ["hit"],
  });

  assert.equal(await manager.isCompletedFor({
    modelShortName: "jina-nano", actualPort: 8123,
    indexState: {
      "selected.md": { path: "selected.md", mtime: 10, chunkCount: 1 },
      "later.md": { path: "later.md", mtime: 11, chunkCount: 1 },
    },
  }), true);
  assert.equal(await manager.isCompletedFor({
    modelShortName: "jina-nano", actualPort: 8123,
    indexState: { "selected.md": { path: "selected.md", mtime: 12, chunkCount: 1 } },
  }), true);
  assert.equal(await manager.isCompletedFor({
    modelShortName: "jina-nano", actualPort: 8123, indexState: {},
  }), true);

  const evidencePath = path.join(
    root, "vaults", "vault-v2-0123456789abcdef", "generation-evidence",
    "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.json",
  );
  const tampered = JSON.parse(await fs.promises.readFile(evidencePath, "utf8"));
  tampered.selectionDigest = "0".repeat(64);
  await fs.promises.writeFile(evidencePath, JSON.stringify(tampered), "utf8");
  assert.equal(await manager.isCompletedFor({
    modelShortName: "jina-nano", actualPort: 8123, indexState: {},
  }), false);
});
