"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
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

function vectorStoreModule() {
  return loadTypeScriptFile(path.join(process.cwd(), "src/local-vector/vector-store.ts"));
}

function migrationModule() {
  return loadTypeScriptFile(path.join(process.cwd(), "src/runtime/legacy-vector-migration.ts"));
}

async function startVectorServer(t) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = body ? JSON.parse(body) : undefined;
      requests.push({ method: request.method, url: request.url, body: parsed });
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/api/v2/heartbeat") response.end(JSON.stringify({ nanosecond_heartbeat: 1 }));
      else if (request.method === "POST" && request.url.endsWith("/collections")) {
        response.end(JSON.stringify({ id: "destination-id", name: parsed.name }));
      } else if (request.method === "POST" && request.url.endsWith("/upsert")) response.end("{}");
      else if (request.method === "POST" && request.url.endsWith("/get")) {
        response.end(JSON.stringify({ ids: ["chunk-a", "chunk-b"] }));
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "missing" }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, requests };
}

async function startPagedMetadataServer(t, records) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = body ? JSON.parse(body) : undefined;
      requests.push({ method: request.method, url: request.url, body: parsed });
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/api/v2/heartbeat") response.end(JSON.stringify({ nanosecond_heartbeat: 1 }));
      else if (request.method === "POST" && request.url.endsWith("/collections")) {
        response.end(JSON.stringify({ id: "destination-id", name: parsed.name }));
      } else if (request.method === "GET" && request.url.endsWith("/count")) {
        response.end(JSON.stringify(records.length));
      } else if (request.method === "POST" && request.url.endsWith("/get")) {
        if (!Number.isSafeInteger(parsed.offset) || !Number.isSafeInteger(parsed.limit) || parsed.limit > 1024) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: "unbounded get rejected" }));
          return;
        }
        const page = records.slice(parsed.offset, parsed.offset + parsed.limit);
        response.end(JSON.stringify({ ids: page.map((item) => item.id), metadatas: page.map((item) => item.metadata) }));
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "missing" }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, requests };
}

test("v2 raw migration upsert preserves exact legacy record payload", async (t) => {
  const endpoint = await startVectorServer(t);
  const { LocalVectorStore } = vectorStoreModule();
  const store = new LocalVectorStore();
  await store.initialize(endpoint.port, "vault", "model", "analogy_vault_model_0123456789ab");
  const records = [{
    id: "chunk-a",
    document: "第一段 UTF-8",
    metadata: { doc_id: "笔记.md", mtime: 123, retained: true },
    embedding: [0.125, -0.25, 0.3333333333333333],
  }, {
    id: "chunk-b",
    document: null,
    metadata: null,
    embedding: [-1, 0, 1],
  }];

  await store.upsertRecords(records);

  const upsert = endpoint.requests.find(({ url }) => url.endsWith("/upsert"));
  assert.deepEqual(upsert.body, {
    ids: ["chunk-a", "chunk-b"],
    documents: ["第一段 UTF-8", null],
    metadatas: [{ doc_id: "笔记.md", mtime: 123, retained: true }, null],
    embeddings: [[0.125, -0.25, 0.3333333333333333], [-1, 0, 1]],
  });
});

test("v2 record identity pages use bounded offset and omit user content", async (t) => {
  const endpoint = await startVectorServer(t);
  const { LocalVectorStore } = vectorStoreModule();
  const store = new LocalVectorStore();
  await store.initialize(endpoint.port, "vault", "model", "analogy_vault_model_0123456789ab");

  assert.deepEqual(await store.getRecordIdentityPage(256, 128), { ids: ["chunk-a", "chunk-b"] });

  const get = endpoint.requests.find(({ url }) => url.endsWith("/get"));
  assert.deepEqual(get.body, { offset: 256, limit: 128, include: [] });
});

test("large migrated collections aggregate document metadata through bounded pages", async (t) => {
  const records = Array.from({ length: 2050 }, (_, index) => ({
    id: `chunk-${index}`,
    metadata: {
      doc_id: `笔记-${Math.floor(index / 2)}.md`,
      path: `笔记-${Math.floor(index / 2)}.md`,
      mtime: 100 + Math.floor(index / 2),
    },
  }));
  const endpoint = await startPagedMetadataServer(t, records);
  const { LocalVectorStore } = vectorStoreModule();
  const store = new LocalVectorStore();
  await store.initialize(endpoint.port, "vault", "model", "analogy_vault_model_0123456789ab");

  const entries = await store.listIndexedDocumentEntries();

  assert.equal(entries.length, 1025);
  assert.equal(entries[0].chunkCount, 2);
  assert.equal(entries.at(-1).chunkCount, 2);
  const gets = endpoint.requests.filter(({ url }) => url.endsWith("/get"));
  assert.deepEqual(gets.map(({ body }) => [body.offset, body.limit]), [[0, 1024], [1024, 1024], [2048, 2]]);
  assert.equal(gets.every(({ body }) => JSON.stringify(body.include) === JSON.stringify(["metadatas"])), true);
});

for (const [name, records, code] of [
  ["empty id", [{ id: "", document: "x", metadata: null, embedding: [1] }], "CHROMA_VECTOR_RECORD_INVALID"],
  ["non-finite vector", [{ id: "a", document: "x", metadata: null, embedding: [Number.NaN] }], "CHROMA_VECTOR_RECORD_INVALID"],
  ["dimension mismatch", [
    { id: "a", document: "x", metadata: null, embedding: [1, 2] },
    { id: "b", document: "y", metadata: null, embedding: [1] },
  ], "CHROMA_VECTOR_DIMENSION_MISMATCH"],
  ["nested metadata", [{ id: "a", document: "x", metadata: { nested: { unsafe: true } }, embedding: [1] }], "CHROMA_VECTOR_RECORD_INVALID"],
]) {
  test(`v2 raw migration rejects ${name} before sending an upsert`, async (t) => {
    const endpoint = await startVectorServer(t);
    const { LocalVectorStore } = vectorStoreModule();
    const store = new LocalVectorStore();
    await store.initialize(endpoint.port, "vault", "model", "analogy_vault_model_0123456789ab");

    await assert.rejects(store.upsertRecords(records), new RegExp(code));
    assert.equal(endpoint.requests.some(({ url }) => url.endsWith("/upsert")), false);
  });
}

function migrationRecords(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `chunk-${String(index).padStart(4, "0")}`,
    document: index === 0 ? "绝密中文正文" : `document ${index}`,
    metadata: { doc_id: `note-${Math.floor(index / 2)}.md`, mtime: index, retained: true },
    embedding: [index + 0.125, index + 0.25, index + 0.5],
  }));
}

function legacyBatch(records) {
  return {
    ids: records.map(({ id }) => id),
    documents: records.map(({ document }) => document),
    metadatas: records.map(({ metadata }) => metadata),
    embeddings: records.map(({ embedding }) => embedding),
  };
}

async function migrationFixture(t, count = 513) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "Analogy vector migration "));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const records = migrationRecords(count);
  const destinationRecords = new Map();
  const readOffsets = [];
  const upsertSizes = [];
  const source = {
    port: 8123,
    collectionId: "legacy-collection-id",
    collectionName: "analogy_legacy-vault_bge-small-en-v1.5",
    snapshot: {
      snapshotPath: path.join(root, "private-snapshot"),
      sourceIdentity: { digest: "c".repeat(64), totalBytes: 1000, newestMtimeMs: 1, fileCount: 2 },
    },
    count: async () => records.length,
    readBatch: async (offset, limit) => {
      readOffsets.push(offset);
      return legacyBatch(records.slice(offset, offset + limit));
    },
    query: async (_embedding, topK) => ({
      ids: [records.slice(0, topK).map(({ id }) => id)],
      distances: [records.slice(0, topK).map((_, index) => index / 100)],
    }),
    close: async () => undefined,
  };
  const destination = {
    upsertRecords: async (batch) => {
      upsertSizes.push(batch.length);
      for (const record of batch) destinationRecords.set(record.id, structuredClone(record));
    },
    getRecordIdentityPage: async (offset, limit) => ({
      ids: [...destinationRecords.keys()].slice(offset, offset + limit),
    }),
    count: async () => destinationRecords.size,
    queryIds: async (_embedding, topK) => records.slice(0, topK).map(({ id }) => id),
  };
  return {
    root,
    records,
    source,
    destination,
    destinationRecords,
    readOffsets,
    upsertSizes,
    checkpointPath: path.join(root, "legacy-vector-migration.json"),
  };
}

function migrationOptions(input, overrides = {}) {
  return {
    checkpointPath: input.checkpointPath,
    source: input.source,
    destination: input.destination,
    sourceModel: { id: "Xenova/bge-small-en-v1.5", shortName: "bge-small-en-v1.5" },
    expectedCollectionNames: [input.source.collectionName],
    targetModel: {
      id: "Xenova/bge-small-en-v1.5",
      shortName: "bge-small-en-v1.5",
      smokeEmbedding: async () => [0.1, 0.2, 0.3],
    },
    transition: {
      transitionToken: "d".repeat(32),
      collectionName: "analogy_vault-v2_bge-small-en-v1.5_dddddddddddd",
    },
    batchSize: 256,
    now: (() => { let value = 1000; return () => ++value; })(),
    ...overrides,
  };
}

test("legacy migration copies 513 exact records in three committed batches and persists no user payload", async (t) => {
  const input = await migrationFixture(t);
  const { LegacyVectorMigration } = migrationModule();
  const progress = [];
  const migration = new LegacyVectorMigration(migrationOptions(input));
  migration.subscribe((snapshot) => progress.push(snapshot));

  const evidence = await migration.start(new AbortController().signal);

  assert.deepEqual(input.readOffsets, [0, 256, 512]);
  assert.deepEqual(input.upsertSizes, [256, 256, 1]);
  assert.deepEqual(input.destinationRecords.get("chunk-0000"), input.records[0]);
  assert.deepEqual(input.destinationRecords.get("chunk-0512"), input.records[512]);
  assert.equal(evidence.recordCount, 513);
  assert.equal(evidence.vectorDimension, 3);
  assert.match(evidence.recordDigest, /^[0-9a-f]{64}$/);
  assert.equal(progress.at(-1).state, "completed");
  assert.equal(progress.at(-1).copiedRecords, 513);
  const checkpoint = await fs.promises.readFile(input.checkpointPath, "utf8");
  assert.equal(checkpoint.includes("绝密中文正文"), false);
  assert.equal(checkpoint.includes("document 512"), false);
  assert.equal(checkpoint.includes("embedding"), false);
  assert.equal(checkpoint.includes(input.source.snapshot.snapshotPath), false);
});

test("legacy migration resumes from the last committed batch without duplicate records", async (t) => {
  const input = await migrationFixture(t);
  const { LegacyVectorMigration } = migrationModule();
  const originalUpsert = input.destination.upsertRecords;
  let attempts = 0;
  input.destination.upsertRecords = async (batch) => {
    attempts += 1;
    if (attempts === 3) throw new Error("SECRET destination failure /Users/private/note.md");
    await originalUpsert(batch);
  };
  const first = new LegacyVectorMigration(migrationOptions(input));

  await assert.rejects(first.start(new AbortController().signal), /LEGACY_VECTOR_COPY_FAILED/);
  const failedCheckpoint = JSON.parse(await fs.promises.readFile(input.checkpointPath, "utf8"));
  assert.equal(failedCheckpoint.state, "failed");
  assert.equal(failedCheckpoint.copiedRecords, 512);
  assert.equal(JSON.stringify(failedCheckpoint).includes("SECRET"), false);
  assert.equal(JSON.stringify(failedCheckpoint).includes("/Users/private"), false);

  input.destination.upsertRecords = originalUpsert;
  const resumed = new LegacyVectorMigration(migrationOptions(input));
  const evidence = await resumed.resume(new AbortController().signal);

  assert.equal(evidence.recordCount, 513);
  assert.deepEqual(input.readOffsets, [0, 256, 512, 512]);
  assert.equal(input.destinationRecords.size, 513);
});

test("legacy migration rejects model identity mismatch before destination writes", async (t) => {
  const input = await migrationFixture(t, 2);
  const { LegacyVectorMigration } = migrationModule();
  const migration = new LegacyVectorMigration(migrationOptions(input, {
    targetModel: {
      id: "different/model",
      shortName: "bge-small-en-v1.5",
      smokeEmbedding: async () => [0.1, 0.2, 0.3],
    },
  }));

  await assert.rejects(migration.start(new AbortController().signal), /LEGACY_MODEL_MISMATCH/);
  assert.deepEqual(input.upsertSizes, []);
});

test("legacy migration rejects a checkpoint from another source snapshot", async (t) => {
  const input = await migrationFixture(t, 2);
  const { LegacyVectorMigration } = migrationModule();
  await fs.promises.writeFile(input.checkpointPath, JSON.stringify({
    schemaVersion: 1,
    migrationId: "e".repeat(32),
    state: "failed",
    sourceIdentity: "f".repeat(64),
    sourceCollectionName: input.source.collectionName,
    sourceModelId: "Xenova/bge-small-en-v1.5",
    sourceModelShortName: "bge-small-en-v1.5",
    targetTransitionToken: "d".repeat(32),
    targetCollectionName: "analogy_vault-v2_bge-small-en-v1.5_dddddddddddd",
    vectorDimension: 3,
    totalRecords: 2,
    copiedRecords: 1,
    batchSize: 256,
    recordDigest: "0".repeat(64),
    startedAt: 1,
    updatedAt: 2,
    completedAt: null,
    errorCode: "LEGACY_VECTOR_COPY_FAILED",
    action: "retry",
  }), "utf8");
  const migration = new LegacyVectorMigration(migrationOptions(input));

  await assert.rejects(migration.resume(new AbortController().signal), /LEGACY_MIGRATION_CHECKPOINT_MISMATCH/);
  assert.deepEqual(input.upsertSizes, []);
});

test("legacy migration rejects an unexpected Analogy collection before destination writes", async (t) => {
  const input = await migrationFixture(t, 2);
  input.source.collectionName = "analogy_another-vault_bge-small-en-v1.5";
  const { LegacyVectorMigration } = migrationModule();
  const migration = new LegacyVectorMigration(migrationOptions(input, {
    expectedCollectionNames: ["analogy_legacy-vault_bge-small-en-v1.5"],
  }));

  await assert.rejects(migration.start(new AbortController().signal), /LEGACY_COLLECTION_UNTRUSTED/);
  assert.deepEqual(input.upsertSizes, []);
});

test("legacy migration cancels between committed batches and can resume", async (t) => {
  const input = await migrationFixture(t);
  const { LegacyVectorMigration } = migrationModule();
  const controller = new AbortController();
  const originalUpsert = input.destination.upsertRecords;
  input.destination.upsertRecords = async (batch) => {
    await originalUpsert(batch);
    controller.abort();
  };
  const migration = new LegacyVectorMigration(migrationOptions(input));

  await assert.rejects(migration.start(controller.signal), /LEGACY_MIGRATION_CANCELLED/);
  const cancelled = JSON.parse(await fs.promises.readFile(input.checkpointPath, "utf8"));
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.copiedRecords, 256);

  input.destination.upsertRecords = originalUpsert;
  const resumed = new LegacyVectorMigration(migrationOptions(input));
  const evidence = await resumed.resume(new AbortController().signal);
  assert.equal(evidence.recordCount, 513);
  assert.deepEqual(input.readOffsets, [0, 256, 512]);
});

test("legacy migration refuses activation evidence when destination identity digest differs", async (t) => {
  const input = await migrationFixture(t, 2);
  input.destination.getRecordIdentityPage = async () => ({ ids: ["chunk-0000", "tampered"] });
  const { LegacyVectorMigration } = migrationModule();
  const migration = new LegacyVectorMigration(migrationOptions(input));

  await assert.rejects(migration.start(new AbortController().signal), /LEGACY_VECTOR_COPY_FAILED/);
  assert.equal(migration.getSnapshot().state, "failed");
  assert.equal(migration.getSnapshot().completedAt, null);
});

test("legacy migration accepts overlapping ANN results when old and new Chroma rank the same vectors differently", async (t) => {
  const input = await migrationFixture(t, 5);
  input.source.query = async () => ({
    ids: [["chunk-0001", "chunk-0002", "chunk-0004"]],
    distances: [[0.94, 0.95, 1.02]],
  });
  input.destination.queryIds = async () => ["chunk-0000", "chunk-0001", "chunk-0002"];
  const { LegacyVectorMigration } = migrationModule();
  const migration = new LegacyVectorMigration(migrationOptions(input));

  const evidence = await migration.start(new AbortController().signal);

  assert.equal(evidence.recordCount, 5);
  assert.deepEqual(evidence.sourceTopIds, ["chunk-0001", "chunk-0002", "chunk-0004"]);
  assert.deepEqual(evidence.targetTopIds, ["chunk-0000", "chunk-0001", "chunk-0002"]);
  assert.equal(migration.getSnapshot().state, "completed");
});

test("legacy migration still rejects disjoint ANN results after exact count and identity checks", async (t) => {
  const input = await migrationFixture(t, 5);
  input.source.query = async () => ({ ids: [["chunk-0000", "chunk-0001", "chunk-0002"]] });
  input.destination.queryIds = async () => ["chunk-0003", "chunk-0004", "missing-result"];
  const { LegacyVectorMigration } = migrationModule();
  const migration = new LegacyVectorMigration(migrationOptions(input));

  await assert.rejects(migration.start(new AbortController().signal), /LEGACY_VECTOR_COPY_FAILED/);

  assert.equal(migration.getSnapshot().errorCode, "LEGACY_MIGRATION_SMOKE_MISMATCH");
  assert.equal(migration.getSnapshot().completedAt, null);
});

test("legacy migration checks current-model vector dimension before destination writes", async (t) => {
  const input = await migrationFixture(t, 2);
  const { LegacyVectorMigration } = migrationModule();
  const migration = new LegacyVectorMigration(migrationOptions(input, {
    targetModel: {
      id: "Xenova/bge-small-en-v1.5",
      shortName: "bge-small-en-v1.5",
      smokeEmbedding: async () => [0.1, 0.2],
    },
  }));

  await assert.rejects(migration.start(new AbortController().signal), /LEGACY_VECTOR_DIMENSION_MISMATCH/);
  assert.deepEqual(input.upsertSizes, []);
});

test("legacy migration rejects checkpoint fields that could persist user payload", async (t) => {
  const input = await migrationFixture(t, 2);
  const { LegacyVectorMigration } = migrationModule();
  await fs.promises.writeFile(input.checkpointPath, JSON.stringify({
    schemaVersion: 1,
    migrationId: "e".repeat(32),
    state: "failed",
    sourceIdentity: input.source.snapshot.sourceIdentity.digest,
    sourceCollectionName: input.source.collectionName,
    sourceModelId: "Xenova/bge-small-en-v1.5",
    sourceModelShortName: "bge-small-en-v1.5",
    targetTransitionToken: "d".repeat(32),
    targetCollectionName: "analogy_vault-v2_bge-small-en-v1.5_dddddddddddd",
    vectorDimension: 3,
    totalRecords: 2,
    copiedRecords: 0,
    batchSize: 256,
    recordDigest: "0".repeat(64),
    startedAt: 1,
    updatedAt: 2,
    completedAt: null,
    errorCode: "LEGACY_VECTOR_COPY_FAILED",
    action: "retry",
    document: "不应进入 checkpoint 的正文",
  }), "utf8");
  const migration = new LegacyVectorMigration(migrationOptions(input));

  await assert.rejects(migration.resume(new AbortController().signal), /LEGACY_MIGRATION_CHECKPOINT_INVALID/);
  assert.deepEqual(input.upsertSizes, []);
});

test("legacy migration inspection reports reusable count, bytes, and dimension without writing destination", async (t) => {
  const input = await migrationFixture(t, 2);
  const { LegacyVectorMigration } = migrationModule();
  const migration = new LegacyVectorMigration(migrationOptions(input));

  assert.deepEqual(await migration.inspect(new AbortController().signal), {
    reusable: true,
    recordCount: 2,
    sourceBytes: 1000,
    vectorDimension: 3,
    sourceCollectionName: "analogy_legacy-vault_bge-small-en-v1.5",
    modelShortName: "bge-small-en-v1.5",
  });
  assert.deepEqual(input.upsertSizes, []);
  assert.equal(fs.existsSync(input.checkpointPath), false);
});

test("migration metadata evidence marks incomplete documents for selective re-embedding", () => {
  const { deriveMigratedDocumentEvidence } = migrationModule();
  const evidence = deriveMigratedDocumentEvidence({
    ids: ["a-0", "a-1", "b-0", "missing-doc"],
    metadatas: [
      { doc_id: "完整.md", path: "完整.md", mtime: 12, chunk_index: 0, chunk_count: 2, section_label: "A", title: "完整" },
      { doc_id: "完整.md", path: "完整.md", mtime: 12, chunk_index: 1, chunk_count: 2, section_label: "B", title: "完整" },
      { doc_id: "待补全.md", path: "待补全.md", mtime: 13, chunk_index: 0, chunk_count: 1 },
      { path: "无标识.md", mtime: 14, chunk_index: 0, chunk_count: 1 },
    ],
  });

  assert.deepEqual(evidence, [
    { docId: "完整.md", path: "完整.md", mtime: 12, chunkCount: 2, metadataComplete: true },
    { docId: "待补全.md", path: "待补全.md", mtime: 13, chunkCount: 1, metadataComplete: false },
  ]);
});
