"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const loaded = new Map();
function loadTypeScriptFile(filename) {
  if (loaded.has(filename)) return loaded.get(filename);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: filename,
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

function requestJson(port, method, route, body) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1", port, method, path: route, timeout: 5000,
      headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : undefined,
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
          reject(new Error(`HTTP_${response.statusCode}`)); return;
        }
        try { resolve(text ? JSON.parse(text) : undefined); } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("HTTP_TIMEOUT")));
    if (payload) request.write(payload);
    request.end();
  });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startChroma(binary, dataPath, version) {
  await fs.promises.mkdir(dataPath, { recursive: true });
  const port = await freePort();
  const child = spawn(binary, ["run", "--path", dataPath, "--host", "127.0.0.1", "--port", String(port)], {
    shell: false, cwd: dataPath, stdio: ["ignore", "ignore", "ignore"],
  });
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`CHROMA_${version}_EXITED`);
    try {
      await requestJson(port, "GET", version.startsWith("0.5") ? "/api/v1/heartbeat" : "/api/v2/heartbeat");
      return { child, port };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill("SIGTERM");
  throw new Error(`CHROMA_${version}_START_TIMEOUT`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

test("real Chroma 0.5.23 vectors migrate exactly into pinned Chroma 1.4.4", { timeout: 180000 }, async (t) => {
  const legacyBinary = process.env.ANALOGY_LEGACY_CHROMA_BIN;
  if (!legacyBinary) {
    t.skip("ANALOGY_LEGACY_CHROMA_BIN is not configured; real cross-version contract did not run");
    return;
  }
  const v2Binary = process.env.ANALOGY_CHROMA_BIN;
  assert.ok(v2Binary, "ANALOGY_CHROMA_BIN is required when the legacy binary is supplied");
  for (const [label, filename] of [["legacy", legacyBinary], ["v2", v2Binary]]) {
    const stat = await fs.promises.stat(filename).catch(() => null);
    assert.ok(stat?.isFile(), `${label} Chroma binary must be a real file`);
  }

  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy-real-legacy-migration-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const legacyData = path.join(root, "legacy-data");
  const v2Data = path.join(root, "v2-data");
  const collectionName = "analogy_real-vault_bge-small-en-v1.5";
  const records = [
    { id: "中文-0", document: "苹果是一种水果", metadata: { doc_id: "中文.md", path: "中文.md", mtime: 1, chunk_index: 0, chunk_count: 1, title: "中文", section_label: "水果" }, embedding: [1, 0, 0] },
    { id: "english-0", document: "Trains connect distant cities", metadata: { doc_id: "english.md", path: "english.md", mtime: 2, chunk_index: 0, chunk_count: 1, title: "English", section_label: "Travel" }, embedding: [0, 1, 0] },
  ];

  const sourceWriter = await startChroma(legacyBinary, legacyData, "0.5.23");
  t.after(() => stop(sourceWriter.child));
  const collection = await requestJson(sourceWriter.port, "POST", "/api/v1/collections", {
    name: collectionName, get_or_create: true,
  });
  await requestJson(sourceWriter.port, "POST", `/api/v1/collections/${collection.id}/upsert`, {
    ids: records.map((item) => item.id), documents: records.map((item) => item.document),
    metadatas: records.map((item) => item.metadata), embeddings: records.map((item) => item.embedding),
  });
  await stop(sourceWriter.child);

  const destinationProcess = await startChroma(v2Binary, v2Data, "1.4.4");
  t.after(() => stop(destinationProcess.child));
  const { LegacyChromaRuntimeBridge } = loadTypeScriptFile(path.join(
    process.cwd(), "src/runtime/legacy-chroma-runtime-bridge.ts",
  ));
  const { LegacyVectorMigration } = loadTypeScriptFile(path.join(
    process.cwd(), "src/runtime/legacy-vector-migration.ts",
  ));
  const { LocalVectorStore } = loadTypeScriptFile(path.join(
    process.cwd(), "src/local-vector/vector-store.ts",
  ));
  const bridge = new LegacyChromaRuntimeBridge({
    candidate: { executablePath: legacyBinary, legacyDataPath: legacyData, versionRange: ">=0.5.23 <0.6.0" },
    stagingRoot: path.join(root, "snapshot"), migrationId: "a".repeat(32), collectionName,
    platform: process.platform === "win32" ? "win32-x64" : process.arch === "arm64" ? "darwin-arm64" : "darwin-x64",
  });
  const source = await bridge.prepare(new AbortController().signal);
  t.after(() => source.close());
  const destination = new LocalVectorStore();
  const targetCollection = "analogy_vault-v2-real_bge-small-en-v1.5_bbbbbbbbbbbb";
  await destination.initialize(destinationProcess.port, "vault-v2-real", "bge-small-en-v1.5", targetCollection);
  const migration = new LegacyVectorMigration({
    checkpointPath: path.join(root, "legacy-vector-migration.json"), source,
    destination: {
      upsertRecords: (items) => destination.upsertRecords(items),
      getRecordIdentityPage: (offset, limit) => destination.getRecordIdentityPage(offset, limit),
      count: () => destination.count(),
      queryIds: async (embedding, topK) => (await destination.search([...embedding], topK)).map((item) => item.chunkId),
    },
    sourceModel: { id: "Xenova/bge-small-en-v1.5", shortName: "bge-small-en-v1.5" },
    expectedCollectionNames: [collectionName],
    targetModel: { id: "Xenova/bge-small-en-v1.5", shortName: "bge-small-en-v1.5", smokeEmbedding: async () => [1, 0, 0] },
    transition: { transitionToken: "b".repeat(32), collectionName: targetCollection }, batchSize: 1,
  });
  const evidence = await migration.start(new AbortController().signal);
  assert.equal(evidence.recordCount, records.length);
  assert.deepEqual(evidence.sourceTopIds, evidence.targetTopIds);
  const copied = await destination.getChunks({ includeEmbedding: true });
  assert.deepEqual(copied.ids, records.map((item) => item.id));
  assert.deepEqual(copied.documents, records.map((item) => item.document));
  assert.deepEqual(copied.metadatas, records.map((item) => item.metadata));
  assert.deepEqual(copied.embeddings, records.map((item) => item.embedding));
  assert.equal((await destination.search([1, 0, 0], 1))[0].chunkId, "中文-0");
});
