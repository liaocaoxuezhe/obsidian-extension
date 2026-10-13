"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const esbuild = require("esbuild");

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

const VAULT = "vault-v2-0123456789abcdef";
const ACTIVE = `analogy_${VAULT}_bge-small_aaaaaaaaaaaa`;
const PREVIOUS = `analogy_${VAULT}_bge-small`;

function unit(seed, dimension = 8) {
  const values = Array.from({ length: dimension }, (_, index) => Math.sin(seed * 7.13 + index * 1.7));
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / norm);
}

function records(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${index}#0`,
    document: `${prefix} 第 ${index} 段`,
    metadata: {
      doc_id: `${prefix}${index}.md`,
      path: `${prefix}${index}.md`,
      title: `笔记 ${index}`,
      mtime: 1000 + index,
      chunk_index: 0,
      chunk_count: 1,
      section_label: "",
    },
    embedding: unit(index + prefix.length * 31),
  }));
}

function hashTree(root, excluded = []) {
  const hash = crypto.createHash("sha256");
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      if (excluded.includes(target)) continue;
      const stat = fs.statSync(target);
      hash.update(path.relative(root, target));
      if (stat.isDirectory()) visit(target);
      else hash.update(fs.readFileSync(target));
    }
  };
  visit(root);
  return hash.digest("hex");
}

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-chroma-import-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacyRoot = path.join(root, "vaults", VAULT);
  const storeRoot = path.join(legacyRoot, "vector-store");
  fs.mkdirSync(path.join(legacyRoot, "chroma_data_v2"), { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, "chroma_data_v2", "chroma.sqlite3"), "chroma bytes");
  if (options.state !== null) {
    fs.writeFileSync(path.join(legacyRoot, "runtime-state.json"), JSON.stringify(options.state ?? {
      schemaVersion: 1,
      runtimeVaultId: VAULT,
      activeGeneration: "v2",
      collectionName: ACTIVE,
      previousGeneration: { generation: "v2", collectionName: PREVIOUS },
      pendingGeneration: null,
    }));
    fs.mkdirSync(path.join(legacyRoot, "index-states", "v2", "bge-small"), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, "index-states", "v2", "bge-small", "e.json"), "{\"a.md\":{}}");
    fs.mkdirSync(path.join(legacyRoot, "generation-evidence"), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, "generation-evidence", "e.json"), "{}");
  }
  const worker = await loadModule("local-vector/vector-store-worker.ts");
  const databasePath = path.join(storeRoot, "vectors.sqlite");
  worker.handleVectorStoreRequest({ id: "open", op: "open", params: { databasePath } });
  t.after(() => worker.handleVectorStoreRequest({ id: "close", op: "close", params: {} }));
  const destination = {
    request: async (op, params) => worker.handleVectorStoreRequest({ id: op, op, params }),
  };
  const collections = options.collections ?? { [ACTIVE]: records("act", 600), [PREVIOUS]: records("old", 5) };
  const calls = [];
  const withChromaSource = async (run) => {
    calls.push("chroma.start");
    if (options.runtimeUnavailable) {
      throw Object.assign(new Error("CHROMA_IMPORT_RUNTIME_UNAVAILABLE"), { code: "CHROMA_IMPORT_RUNTIME_UNAVAILABLE" });
    }
    try {
      return await run(() => {
        let data = null;
        return {
          openCollection: async (name) => {
            data = collections[name] ?? null;
            return data !== null;
          },
          count: async () => data.length,
          readPage: async (offset, limit) => {
            calls.push(`read:${offset}`);
            if (options.mutateAt === offset) data = data.slice(1);
            return data.slice(offset, offset + limit).map((item) => JSON.parse(JSON.stringify(item)));
          },
        };
      });
    } finally {
      calls.push("chroma.stop");
    }
  };
  const importer = await loadModule("runtime/chroma-sqlite-import.ts");
  return { root, legacyRoot, storeRoot, destination, withChromaSource, calls, importer, worker };
}

test("imports every referenced v2 collection by direct vector copy and keeps Chroma files untouched", async (t) => {
  const context = await fixture(t);
  const before = hashTree(context.legacyRoot, [context.storeRoot]);
  const progress = [];
  const marker = await context.importer.runChromaImportIfNeeded({
    legacyRoot: context.legacyRoot,
    storeRoot: context.storeRoot,
    destination: context.destination,
    withChromaSource: context.withChromaSource,
    onProgress: (item) => progress.push(item),
  });
  assert.equal(marker.status, "completed");
  assert.deepEqual(marker.collections.map(({ name, records: count }) => ({ name, count })), [
    { name: ACTIVE, count: 600 },
    { name: PREVIOUS, count: 5 },
  ]);
  assert.deepEqual(context.calls.filter((call) => call.startsWith("chroma.")), ["chroma.start", "chroma.stop"]);
  assert.equal(progress.at(-1).copied, 5);

  const count = await context.destination.request("count", { collection: ACTIVE });
  assert.equal(count, 600);
  const source = records("act", 600);
  const nearest = await context.destination.request("query", { collection: ACTIVE, embedding: source[123].embedding, topK: 1 });
  assert.equal(nearest[0].id, source[123].id);
  assert.equal(nearest[0].document, source[123].document);
  assert.deepEqual(nearest[0].metadata, source[123].metadata);

  for (const relative of ["runtime-state.json", "index-states/v2/bge-small/e.json", "generation-evidence/e.json"]) {
    assert.equal(
      fs.readFileSync(path.join(context.storeRoot, relative), "utf8"),
      fs.readFileSync(path.join(context.legacyRoot, relative), "utf8"),
    );
  }
  assert.equal(hashTree(context.legacyRoot, [context.storeRoot]), before, "Chroma-era files are byte-identical");
  for (const relative of ["runtime-state.json", "chroma_data_v2/chroma.sqlite3", "index-states/v2/bge-small/e.json"]) {
    assert.ok(fs.existsSync(path.join(context.legacyRoot, relative)), `${relative} must be preserved`);
  }
  assert.equal(fs.readFileSync(path.join(context.legacyRoot, "chroma_data_v2", "chroma.sqlite3"), "utf8"), "chroma bytes");

  const again = await context.importer.runChromaImportIfNeeded({
    legacyRoot: context.legacyRoot,
    storeRoot: context.storeRoot,
    destination: context.destination,
    withChromaSource: async () => assert.fail("a settled import must not start Chroma again"),
  });
  assert.equal(again.status, "completed");
});

test("a vault without Chroma-era state needs no import and never starts Chroma", async (t) => {
  const context = await fixture(t, { state: null });
  const marker = await context.importer.runChromaImportIfNeeded({
    legacyRoot: context.legacyRoot,
    storeRoot: context.storeRoot,
    destination: context.destination,
    withChromaSource: async () => assert.fail("Chroma must not start for new vaults"),
  });
  assert.equal(marker.status, "not-needed");
  assert.equal(fs.existsSync(path.join(context.storeRoot, "runtime-state.json")), false);
});

test("a changing source fails verification, retries once, then falls back to rebuild without partial data", async (t) => {
  const context = await fixture(t, { mutateAt: 256 });
  const options = {
    legacyRoot: context.legacyRoot,
    storeRoot: context.storeRoot,
    destination: context.destination,
    withChromaSource: context.withChromaSource,
  };
  await assert.rejects(context.importer.runChromaImportIfNeeded(options), /CHROMA_IMPORT_SOURCE_CHANGED/);
  const failed = await context.importer.readChromaImportMarker(context.storeRoot);
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts, 1);
  assert.equal(fs.existsSync(path.join(context.storeRoot, "runtime-state.json")), false, "state is copied only after success");

  const second = await context.importer.runChromaImportIfNeeded(options);
  assert.equal(second.status, "rebuild-required");
  assert.equal(second.errorCode, "CHROMA_IMPORT_SOURCE_CHANGED");
  assert.equal(await context.destination.request("hasCollection", { name: ACTIVE }), false);
  assert.ok(fs.existsSync(path.join(context.legacyRoot, "runtime-state.json")), "Chroma-era state survives failure");
});

test("a missing active collection fails while a missing previous collection is tolerated", async (t) => {
  const missingPrevious = await fixture(t, { collections: { [ACTIVE]: records("act", 3) } });
  const tolerated = await missingPrevious.importer.runChromaImportIfNeeded({
    legacyRoot: missingPrevious.legacyRoot,
    storeRoot: missingPrevious.storeRoot,
    destination: missingPrevious.destination,
    withChromaSource: missingPrevious.withChromaSource,
  });
  assert.equal(tolerated.status, "completed");
  assert.deepEqual(tolerated.collections.map((item) => item.name), [ACTIVE]);

  const missingActive = await fixture(t, { collections: { [PREVIOUS]: records("old", 3) } });
  await assert.rejects(missingActive.importer.runChromaImportIfNeeded({
    legacyRoot: missingActive.legacyRoot,
    storeRoot: missingActive.storeRoot,
    destination: missingActive.destination,
    withChromaSource: missingActive.withChromaSource,
  }), /CHROMA_IMPORT_COLLECTION_MISSING/);
});

test("an unavailable Chroma runtime goes straight to rebuild-required", async (t) => {
  const context = await fixture(t, { runtimeUnavailable: true });
  const marker = await context.importer.runChromaImportIfNeeded({
    legacyRoot: context.legacyRoot,
    storeRoot: context.storeRoot,
    destination: context.destination,
    withChromaSource: context.withChromaSource,
  });
  assert.equal(marker.status, "rebuild-required");
  assert.equal(marker.errorCode, "CHROMA_IMPORT_RUNTIME_UNAVAILABLE");
  assert.equal(context.importer.isChromaImportSettled(marker), true);
});

test("legacy-generation state is carried over without starting Chroma", async (t) => {
  const context = await fixture(t, {
    state: { schemaVersion: 1, activeGeneration: "legacy", collectionName: `analogy_0123456789ab_bge-small`,
      previousGeneration: null, pendingGeneration: null },
  });
  const marker = await context.importer.runChromaImportIfNeeded({
    legacyRoot: context.legacyRoot,
    storeRoot: context.storeRoot,
    destination: context.destination,
    withChromaSource: async () => assert.fail("no v2 collection means no Chroma read"),
  });
  assert.equal(marker.status, "completed");
  assert.ok(fs.existsSync(path.join(context.storeRoot, "runtime-state.json")));
});

test("an already initialized SQLite store is never overwritten by Chroma-era state", async (t) => {
  const context = await fixture(t);
  fs.mkdirSync(context.storeRoot, { recursive: true });
  fs.writeFileSync(path.join(context.storeRoot, "runtime-state.json"), "{\"fresh\":true}");
  const marker = await context.importer.runChromaImportIfNeeded({
    legacyRoot: context.legacyRoot,
    storeRoot: context.storeRoot,
    destination: context.destination,
    withChromaSource: async () => assert.fail("an initialized store must not trigger a Chroma read"),
  });
  assert.equal(marker.status, "not-needed");
  assert.equal(fs.readFileSync(path.join(context.storeRoot, "runtime-state.json"), "utf8"), "{\"fresh\":true}");
});

test("a cancelled import does not count toward the rebuild fallback", async (t) => {
  const context = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  const options = {
    legacyRoot: context.legacyRoot,
    storeRoot: context.storeRoot,
    destination: context.destination,
    withChromaSource: context.withChromaSource,
  };
  await assert.rejects(context.importer.runChromaImportIfNeeded({ ...options, signal: controller.signal }),
    /CHROMA_IMPORT_CANCELLED/);
  assert.equal((await context.importer.readChromaImportMarker(context.storeRoot)).attempts, 0);
  const completed = await context.importer.runChromaImportIfNeeded(options);
  assert.equal(completed.status, "completed");
});
