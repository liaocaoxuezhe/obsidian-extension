"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const esbuild = require("esbuild");
const builtins = require("builtin-modules");

const external = [
  "obsidian",
  "electron",
  "@huggingface/transformers",
  "onnxruntime-common",
  "onnxruntime-node",
  ...builtins,
];

async function bundleWorkerSource() {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, "..", "src", "local-vector", "embedding-worker.ts")],
    bundle: true,
    external,
    format: "cjs",
    platform: "node",
    target: "es2020",
    write: false,
  });
  return result.outputFiles[0].text;
}

async function loadModule(source) {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, "..", "src", source)],
    bundle: true,
    external,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", "__filename", result.outputFiles[0].text)(
    module, module.exports, require, __filename,
  );
  return { exports: module.exports, source: result.outputFiles[0].text };
}

async function createHost(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-vector-process-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, "runtime");
  const moduleRoot = path.join(root, "modules");
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(moduleRoot, { recursive: true });
  const { exports } = await loadModule("local-vector/vector-store-host.ts");
  const host = new exports.VectorStoreHost({
    databasePath: path.join(root, "vaults", "中文 vault", "vector-store", "vectors.sqlite"),
    execPath: process.execPath,
    moduleRoot,
    pluginDir: root,
    workerRoot: runtimeRoot,
    workerDir: path.join(runtimeRoot, "worker"),
    buildId: "1.2.5+test",
    workerBundleSource: await bundleWorkerSource(),
    timeoutMs: 20_000,
  });
  t.after(() => host.dispose());
  return { host, root };
}

const COLLECTION = "analogy_vault-v2-0123456789abcdef_bge-small";

function chunk(id, index, embedding) {
  return {
    chunkId: id,
    content: `第 ${index} 段`,
    embedding,
    chunkIndex: index,
    chunkCount: 2,
    sectionLabel: "标题",
  };
}

test("SqliteVectorStore round-trips documents through the vector-store child process", async (t) => {
  const { host } = await createHost(t);
  const { exports } = await loadModule("local-vector/sqlite-vector-store.ts");
  const store = new exports.SqliteVectorStore(host);
  await store.initialize(8000, "vault-v2-0123456789abcdef", "bge-small");
  assert.equal(store.getCollectionName(), COLLECTION);
  await store.upsertDocument("笔记/a.md", [chunk("a#0", 0, [1, 0, 0]), chunk("a#1", 1, [0.8, 0.6, 0])], {
    title: "甲", path: "笔记/a.md", mtime: 123,
  });
  await store.upsertDocument("b.md", [chunk("b#0", 0, [0, 1, 0])], { title: "乙", path: "b.md", mtime: 7 });
  assert.equal(await store.count(), 3);

  const results = await store.search([1, 0, 0], 2);
  assert.deepEqual(results.map((item) => item.chunkId), ["a#0", "a#1"]);
  assert.equal(results[0].metadata.doc_id, "笔记/a.md");
  assert.equal(results[0].metadata.section_label, "标题");
  assert.equal(results[0].distance, results[0].score);
  assert.ok(results[0].distance < results[1].distance);

  const byDocument = await store.getChunks({ where: { doc_id: "笔记/a.md" } });
  assert.deepEqual(byDocument.ids, ["a#0", "a#1"]);
  assert.deepEqual(byDocument.documents, ["第 0 段", "第 1 段"]);
  const withEmbedding = await store.getChunks({ ids: ["b#0"], includeEmbedding: true });
  assert.deepEqual(withEmbedding.embeddings, [[0, 1, 0]]);

  const entries = (await store.listIndexedDocumentEntries()).sort((l, r) => l.docId.localeCompare(r.docId));
  assert.deepEqual(entries.map(({ docId, chunkCount, mtime }) => ({ docId, chunkCount, mtime })), [
    { docId: "b.md", chunkCount: 1, mtime: 7 },
    { docId: "笔记/a.md", chunkCount: 2, mtime: 123 },
  ]);

  await store.deleteDocument("笔记/a.md");
  assert.deepEqual(await store.listIndexedDocs(), ["b.md"]);
  await store.deleteCollectionByName(8000, COLLECTION);
  await assert.rejects(() => store.count(), /VECTOR_STORE_COLLECTION_NOT_FOUND/);
});

test("the store process restarts after an unexpected exit and keeps committed data", async (t) => {
  const { host } = await createHost(t);
  const { exports } = await loadModule("local-vector/sqlite-vector-store.ts");
  const store = new exports.SqliteVectorStore(host);
  await store.initialize(8000, "vault-v2-0123456789abcdef", "bge-small");
  await store.upsertDocument("a.md", [chunk("a#0", 0, [1, 0])], { title: "a", path: "a.md", mtime: 1 });
  const firstPid = host.getPid();
  assert.ok(firstPid);
  process.kill(firstPid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await store.count(), 1);
  assert.notEqual(host.getPid(), firstPid);
  assert.equal(await host.healthy(), true);
});

test("renderer-side store code never loads node:sqlite", async () => {
  for (const source of ["local-vector/sqlite-vector-store.ts", "local-vector/vector-store-host.ts"]) {
    const { source: bundled } = await loadModule(source);
    assert.equal(bundled.includes("node:sqlite"), false, `${source} must stay a pure IPC client`);
  }
  const worker = await bundleWorkerSource();
  assert.ok(worker.includes("node:sqlite"), "the worker bundle carries the SQLite engine");
  assert.ok(worker.includes("ANALOGY_WORKER_ROLE"), "the worker bundle selects its role at startup");
});
