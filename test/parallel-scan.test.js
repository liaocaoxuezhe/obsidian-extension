"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const esbuild = require("esbuild");
const { DatabaseSync } = require("node:sqlite");

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

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32 - 0.5;
  };
}

const COLLECTION = "analogy_vault-v2-0123456789abcdef_bge-small-en-v1.5";

test("thread count leaves one core free and caps at four", async () => {
  const { parallelScanThreads } = await loadModule("local-vector/parallel-scan.ts");
  assert.deepEqual([1, 2, 3, 4, 8, 16].map(parallelScanThreads), [0, 1, 2, 3, 4, 4]);
});

test("sharded scans return exactly the single-threaded top results, ties and updates included", async (t) => {
  const { ParallelVectorScanner } = await loadModule("local-vector/parallel-scan.ts");
  const { VectorStoreEngine } = await loadModule("local-vector/vector-store-engine.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-parallel-scan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scanner = new ParallelVectorScanner(3);
  t.after(() => scanner.dispose());
  const random = seededRandom(7);
  const dimension = 48;
  const vector = () => Array.from({ length: dimension }, random);
  const records = Array.from({ length: 3000 }, (_, index) => ({
    id: `chunk-${index}`,
    document: `内容 ${index}`,
    embedding: index % 500 === 0 ? new Array(dimension).fill(0.25) : vector(),
    metadata: { doc_id: `note-${index}.md` },
  }));
  const parallel = new VectorStoreEngine(new DatabaseSync(path.join(root, "parallel.sqlite")), { scanner, parallelThreshold: 100 });
  const inline = new VectorStoreEngine(new DatabaseSync(path.join(root, "inline.sqlite")));
  t.after(() => { parallel.close(); inline.close(); });
  for (const engine of [parallel, inline]) {
    engine.ensureCollection(COLLECTION);
    for (let offset = 0; offset < records.length; offset += 1000) engine.upsert(COLLECTION, records.slice(offset, offset + 1000));
  }
  const check = async () => {
    for (let index = 0; index < 20; index += 1) {
      const query = index === 0 ? new Array(dimension).fill(0.25) : vector();
      const expected = inline.query(COLLECTION, query, 10).map((match) => [match.id, match.distance]);
      const actual = (await parallel.queryAsync(COLLECTION, query, 10)).map((match) => [match.id, match.distance]);
      assert.deepEqual(actual, expected);
    }
  };
  await check();
  // Growth reallocates the shared matrix; deletes move the last row into the hole.
  const extra = Array.from({ length: 700 }, (_, index) => ({ id: `extra-${index}`, document: null, embedding: vector(), metadata: { doc_id: "extra.md" } }));
  for (const engine of [parallel, inline]) {
    engine.upsert(COLLECTION, extra);
    engine.deleteByDocId(COLLECTION, "note-42.md");
  }
  await check();
  const hybrid = await parallel.hybridQueryAsync(COLLECTION, vector(), "内容 7", 5, 1);
  assert.equal(hybrid.length, 5);
});
