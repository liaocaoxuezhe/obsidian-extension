"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const esbuild = require("esbuild");
const { DatabaseSync } = require("node:sqlite");

/**
 * Cleanup in reverse order of registration (close handles and child processes before deleting
 * their files). node:test runs t.after hooks first-registered-first, and Windows refuses to
 * delete open files; a failing delete would also skip every later hook.
 */
const cleanupStacks = new WeakMap();
function deferCleanup(t, fn) {
  let stack = cleanupStacks.get(t);
  if (!stack) {
    stack = [];
    cleanupStacks.set(t, stack);
    t.after(async () => {
      while (stack.length) await stack.pop()();
    });
  }
  stack.push(fn);
}

async function loadModule(entry) {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, "..", entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["obsidian", "electron"],
    write: false,
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", "__filename", result.outputFiles[0].text)(
    module, module.exports, require, __filename,
  );
  return module.exports;
}

function tempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  deferCleanup(t, () => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const VAULT = "vault-v2-0123456789abcdef";

test("environment detection with the SQLite backend never probes Chroma", async (t) => {
  const { detectEnvironment } = await loadModule("src/runtime/environment-detector.ts");
  const { createRuntimePaths } = await loadModule("src/runtime/runtime-paths.ts");
  const paths = createRuntimePaths(tempRoot(t, "analogy-env-"), VAULT);
  const forbidden = async () => assert.fail("Chroma must not be inspected");
  const ready = await detectEnvironment({
    platform: "darwin-arm64",
    paths,
    vectorBackend: "sqlite",
    chromaPort: 8000,
    inspectors: {
      chromaRuntime: forbidden,
      chromaHealth: forbidden,
      embeddingRuntime: async () => "ready",
      embeddingModel: async () => "ready",
      index: async () => "ready",
    },
  });
  assert.equal(ready.chroma, "not-required");
  assert.equal(ready.recommendedAction, "start-services");

  const fresh = await detectEnvironment({
    platform: "darwin-arm64",
    paths,
    vectorBackend: "sqlite",
    inspectors: {
      chromaRuntime: forbidden,
      embeddingRuntime: async () => "missing",
      embeddingModel: async () => "missing",
      index: async () => "empty",
    },
  });
  assert.equal(fresh.recommendedAction, "setup");
});

function bootstrapOptions(overrides = {}) {
  const calls = [];
  const chromaManager = new Proxy({}, {
    get: (_, property) => () => assert.fail(`Chroma manager ${String(property)} must not be used`),
  });
  const options = {
    resolveVerifiedRuntimes: async () => ({ chroma: null, embedding: { runtimeId: "embedding-fixture" } }),
    chromaManager,
    sqliteBackend: {
      healthy: async () => { calls.push("store.healthy"); return overrides.healthy ?? true; },
      describe: () => ({ ownership: "analogy", pid: 99, executablePath: "/node", port: 8000,
        runtimeVersion: "sqlite-v1", startedAt: null }),
      controller: () => ({
        isHealthy: async () => true,
        stop: async () => undefined,
        getLastError: () => "",
        getPort: () => 8000,
        getDbPath: () => "/data/vector-store/vectors.sqlite",
        getProcessState: () => ({ ownership: "analogy", pid: 99, executablePath: "/node", port: 8000,
          runtimeVersion: "sqlite-v1", startedAt: null }),
      }),
    },
    vaultId: VAULT,
    modelShortName: "bge-small",
    maxInputChars: 512,
    createVectorStore: () => ({
      initialize: async (...args) => { calls.push(["store.initialize", ...args]); },
    }),
    createEmbeddingService: () => ({
      initialize: async () => { calls.push("embedding.initialize"); },
      isReady: () => true,
      dispose: async () => { calls.push("embedding.dispose"); },
    }),
    createSummarizer: () => null,
    createDocumentIndexer: () => ({
      loadState: async () => { calls.push("indexer.load"); },
      watchVault: () => calls.push("indexer.watch"),
      stop: async () => calls.push("indexer.stop"),
      shutdown: () => calls.push("indexer.shutdown"),
      flushState: async () => calls.push("indexer.flush"),
    }),
    publishServices: (ready) => { calls.push(ready ? "publish:ready" : "publish:null"); },
    updateSearchState: (patch) => { calls.push({ state: patch.status, dbPath: patch.dbPath }); },
    ...overrides.options,
  };
  return { options, calls };
}

test("LocalServiceBootstrap runs on the SQLite store without touching Chroma", async () => {
  const { LocalServiceBootstrap } = await loadModule("src/local-vector/local-service-bootstrap.ts");
  const { options, calls } = bootstrapOptions();
  const bootstrap = new LocalServiceBootstrap(options);
  const ready = await bootstrap.start();
  assert.equal(ready.lease.runtimeVersion, "sqlite-v1");
  assert.equal(ready.chromaManager.getDbPath(), "/data/vector-store/vectors.sqlite");
  assert.deepEqual(calls.find((call) => Array.isArray(call)), ["store.initialize", 8000, VAULT, "bge-small", undefined]);
  assert.ok(calls.some((call) => call?.state === "ready" && call.dbPath === "/data/vector-store/vectors.sqlite"));
  await bootstrap.stop();
  assert.ok(calls.includes("embedding.dispose"));
});

test("an unhealthy SQLite store fails bootstrap with a dedicated error", async () => {
  const { LocalServiceBootstrap } = await loadModule("src/local-vector/local-service-bootstrap.ts");
  const { options } = bootstrapOptions({ healthy: false });
  await assert.rejects(new LocalServiceBootstrap(options).start(), /LOCAL_SERVICE_VECTOR_STORE_NOT_READY/);
});

test("generation state can live in the isolated vector-store directory", async (t) => {
  const { ChromaDataMigration, createChromaDataGeneration } = await loadModule("src/runtime/chroma-data-migration.ts");
  const root = tempRoot(t, "analogy-store-state-");
  const runtimeStatePath = path.join(root, "vaults", VAULT, "vector-store", "runtime-state.json");
  const migration = new ChromaDataMigration({ runtimeStatePath, runtimeVaultId: VAULT });
  const generation = createChromaDataGeneration({
    localDataRoot: root, runtimeVaultId: VAULT, modelShortName: "bge-small", port: 8000,
  });
  const pending = await migration.begin(generation);
  const state = await migration.readOptional();
  assert.equal(state.runtimeVaultId, VAULT);
  assert.equal(state.pendingGeneration.collectionName, pending.collectionName);
  assert.equal(fs.existsSync(path.join(root, "vaults", VAULT, "runtime-state.json")), false,
    "the Chroma-era state file is never written");
});

test("MCP reads the SQLite store read-only and prefers the store's runtime state", async (t) => {
  const root = tempRoot(t, "analogy-mcp-sqlite-");
  const { VectorStoreEngine } = await loadModule("src/local-vector/vector-store-engine.ts");
  const { SqliteVectorReader } = await loadModule("mcp-server/src/sqlite-vector-reader.ts");
  const databasePath = path.join(root, "vectors.sqlite");
  const engine = new VectorStoreEngine(new DatabaseSync(databasePath));
  deferCleanup(t, () => engine.close());
  const name = `analogy_${VAULT}_bge-small`;
  engine.ensureCollection(name);
  const unit = (values) => {
    const norm = Math.hypot(...values);
    return values.map((value) => value / norm);
  };
  engine.upsert(name, [
    { id: "a#0", document: "甲", metadata: { path: "a.md", title: "甲" }, embedding: unit([1, 0, 0]) },
    { id: "b#0", document: "乙", metadata: { path: "b.md", title: "乙" }, embedding: unit([0, 1, 0]) },
  ]);
  const reader = new SqliteVectorReader(databasePath);
  deferCleanup(t, () => reader.close());
  assert.equal(reader.count(name), 2);
  assert.deepEqual(reader.search(name, unit([0.9, 0.1, 0]), 2).map((item) => item.chunkId), ["a#0", "b#0"]);
  engine.upsert(name, [{ id: "c#0", document: "丙", metadata: { path: "c.md" }, embedding: unit([0.95, 0.05, 0]) }]);
  assert.equal(reader.search(name, unit([0.95, 0.05, 0]), 1)[0].chunkId, "c#0", "cache refreshes after writes");
  assert.throws(() => new SqliteVectorReader(path.join(root, "missing.sqlite")), /Vector database not found/);
});
