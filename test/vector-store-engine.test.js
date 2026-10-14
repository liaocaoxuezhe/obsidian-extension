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

async function loadModule(source) {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, "..", "src", source)],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", "__filename", result.outputFiles[0].text)(
    module, module.exports, require, __filename,
  );
  return module.exports;
}

function tempDatabase(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-vector-engine-"));
  deferCleanup(t, () => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "向量 数据", "vectors.sqlite");
}

function unit(values) {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / norm);
}

function record(id, docId, embedding, extra = {}) {
  return {
    id,
    document: `${id} 的内容`,
    metadata: {
      doc_id: docId,
      path: `${docId}.md`,
      title: docId,
      mtime: 10,
      chunk_index: Number(id.split("#")[1] || 0),
      chunk_count: 2,
      section_label: "主题",
      ...extra,
    },
    embedding,
  };
}

function squaredL2(left, right) {
  return left.reduce((sum, value, index) => sum + (Math.fround(value) - Math.fround(right[index])) ** 2, 0);
}

async function openEngine(t, filename = tempDatabase(t)) {
  const { VectorStoreEngine } = await loadModule("local-vector/vector-store-engine.ts");
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const engine = new VectorStoreEngine(new DatabaseSync(filename));
  deferCleanup(t, () => { try { engine.close(); } catch { /* already closed */ } });
  return { engine, filename, VectorStoreEngine };
}

test("upsert keeps insertion order, replaces in place and rejects dimension changes", async (t) => {
  const { engine } = await openEngine(t);
  engine.ensureCollection("analogy_vault-v2-0123456789abcdef_bge");
  const name = "analogy_vault-v2-0123456789abcdef_bge";
  engine.upsert(name, [
    record("a#0", "a", unit([1, 0, 0])),
    record("b#0", "b", unit([0, 1, 0])),
    record("c#0", "c", unit([0, 0, 1])),
  ]);
  engine.upsert(name, [record("a#0", "a", unit([1, 1, 0]), { title: "更新后" })]);
  assert.equal(engine.count(name), 3);
  assert.deepEqual(engine.identityPage(name, 0, 10), ["a#0", "b#0", "c#0"]);
  const stored = engine.get(name, { ids: ["a#0"], includeEmbeddings: true });
  assert.equal(stored.metadatas[0].title, "更新后");
  assert.deepEqual(stored.embeddings[0], unit([1, 1, 0]).map(Math.fround));
  assert.throws(() => engine.upsert(name, [record("d#0", "d", [1, 0])]), /CHROMA_VECTOR_DIMENSION_MISMATCH/);
  assert.throws(() => engine.upsert(name, [record("e#0", "e", [1, Number.NaN, 0])]), /CHROMA_VECTOR_RECORD_INVALID/);
  assert.equal(engine.count(name), 3, "rejected batches must not partially apply");
});

test("query returns exact squared-L2 nearest neighbours with documents and metadata", async (t) => {
  const { engine } = await openEngine(t);
  const name = "analogy_vault-v2-0123456789abcdef_bge";
  engine.ensureCollection(name);
  const vectors = [];
  for (let index = 0; index < 300; index += 1) {
    const vector = unit([Math.sin(index), Math.cos(index * 1.3), Math.sin(index * 0.7), 0.25]);
    vectors.push(vector);
    engine.upsert(name, [record(`doc${index}#0`, `doc${index}`, vector)]);
  }
  const query = unit([0.3, -0.2, 0.9, 0.1]);
  const expected = vectors
    .map((vector, index) => ({ id: `doc${index}#0`, distance: squaredL2(vector, query) }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 7);
  const actual = engine.query(name, query, 7);
  assert.deepEqual(actual.map((item) => item.id), expected.map((item) => item.id));
  for (let index = 0; index < actual.length; index += 1) {
    assert.ok(Math.abs(actual[index].distance - expected[index].distance) < 1e-5);
  }
  assert.equal(actual[0].document, `${actual[0].id} 的内容`);
  assert.equal(actual[0].metadata.section_label, "主题");
  assert.throws(() => engine.query(name, [1, 0], 3), /CHROMA_VECTOR_DIMENSION_MISMATCH/);
});

test("deleting a document updates counts, filters and the in-memory search matrix", async (t) => {
  const { engine } = await openEngine(t);
  const name = "analogy_vault-v2-0123456789abcdef_bge";
  engine.ensureCollection(name);
  engine.upsert(name, [
    record("a#0", "a", unit([1, 0, 0])),
    record("a#1", "a", unit([0.9, 0.1, 0])),
    record("b#0", "b", unit([0, 1, 0])),
  ]);
  assert.equal(engine.query(name, unit([1, 0, 0]), 1)[0].id, "a#0", "warm the matrix cache");
  assert.deepEqual(engine.deleteByDocId(name, "a"), { deleted: 2 });
  assert.equal(engine.count(name), 1);
  assert.deepEqual(engine.query(name, unit([1, 0, 0]), 5).map((item) => item.id), ["b#0"]);
  assert.deepEqual(engine.get(name, { where: { doc_id: "a" } }).ids, []);
  assert.deepEqual(engine.get(name, { where: { title: "b" } }).ids, ["b#0"]);
  engine.upsert(name, [record("c#0", "c", unit([1, 0, 0]))]);
  assert.equal(engine.query(name, unit([1, 0, 0]), 1)[0].id, "c#0", "appends after deletes stay searchable");
});

test("document entries match the former Chroma listing semantics", async (t) => {
  const { engine } = await openEngine(t);
  const name = "analogy_vault-v2-0123456789abcdef_bge";
  engine.ensureCollection(name);
  engine.upsert(name, [
    record("a#0", "a", unit([1, 0, 0]), { mtime: 5 }),
    record("a#1", "a", unit([0, 1, 0]), { mtime: 9 }),
    { id: "legacy#0", document: "旧", metadata: { doc_id: "legacy", path: "legacy.md" }, embedding: unit([0, 0, 1]) },
  ]);
  const entries = engine.documentEntries(name).sort((left, right) => left.docId.localeCompare(right.docId));
  assert.deepEqual(entries, [
    { docId: "a", path: "a.md", mtime: 9, chunkCount: 2 },
    { docId: "legacy", path: "legacy.md", mtime: 0, chunkCount: 1, needsReindex: true },
  ]);
});

test("collections are isolated, deletable, and persist across reopen", async (t) => {
  const { engine, filename, VectorStoreEngine } = await openEngine(t);
  const active = "analogy_vault-v2-0123456789abcdef_bge";
  const staging = "analogy_vault-v2-0123456789abcdef_bge_0123456789ab";
  engine.ensureCollection(active);
  engine.ensureCollection(staging);
  engine.upsert(active, [record("a#0", "a", unit([1, 0]))]);
  engine.upsert(staging, [record("b#0", "b", unit([0, 1])), record("c#0", "c", unit([1, 1]))]);
  assert.equal(engine.count(active), 1);
  assert.equal(engine.count(staging), 2);
  assert.deepEqual(engine.deleteCollection(staging), { deleted: true });
  assert.deepEqual(engine.deleteCollection(staging), { deleted: false });
  assert.equal(engine.hasCollection(staging), false);
  engine.close();

  const reopened = new VectorStoreEngine(new DatabaseSync(filename));
  deferCleanup(t, () => reopened.close());
  assert.equal(reopened.count(active), 1);
  assert.equal(reopened.query(active, unit([1, 0]), 1)[0].id, "a#0");
});

test("a read-only connection sees committed writes while the writer stays open", async (t) => {
  const { engine, filename } = await openEngine(t);
  const name = "analogy_vault-v2-0123456789abcdef_bge";
  engine.ensureCollection(name);
  engine.upsert(name, [record("a#0", "a", unit([1, 0]))]);
  const reader = new DatabaseSync(filename, { readOnly: true });
  deferCleanup(t, () => reader.close());
  const countRows = () => reader.prepare("SELECT COUNT(*) AS total FROM records").get().total;
  assert.equal(countRows(), 1);
  engine.upsert(name, [record("b#0", "b", unit([0, 1]))]);
  assert.equal(countRows(), 2);
});
