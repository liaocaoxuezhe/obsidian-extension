"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { requestJson, startPinnedChroma } = require("./chroma-standalone-integration.test.js");

function loadTypeScriptModule(filename) {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports,
    require,
    module,
    filename,
    path.dirname(filename),
  );
  return module.exports;
}

const recursiveLoaded = new Map();
function loadTypeScriptTree(filename) {
  filename = path.resolve(filename);
  if (recursiveLoaded.has(filename)) return recursiveLoaded.get(filename);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  recursiveLoaded.set(filename, module.exports);
  const localRequire = (specifier) => {
    if (!specifier.startsWith(".")) return require(specifier);
    const resolved = path.resolve(path.dirname(filename), specifier);
    return fs.existsSync(`${resolved}.ts`) ? loadTypeScriptTree(`${resolved}.ts`) : require(resolved);
  };
  Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports, localRequire, module, filename, path.dirname(filename),
  );
  recursiveLoaded.set(filename, module.exports);
  return module.exports;
}

async function startLegacyOnlyServer(t) {
  const server = http.createServer((request, response) => {
    const isLegacy = request.url === "/api/v1/heartbeat" || request.url === "/api/v1/collections";
    response.writeHead(isLegacy ? 200 : 404, { "Content-Type": "application/json" });
    response.end(JSON.stringify(request.url === "/api/v1/collections" ? { id: "legacy-collection" } : 1));
  });
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).on("error", reject));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return server.address().port;
}

test("MCP raw HTTP client queries the pinned Chroma v2 collection contract", async (t) => {
  const server = await startPinnedChroma(t, process.env.ANALOGY_CHROMA_BIN);
  const collection = await requestJson(
    server.baseUrl,
    "POST",
    "/api/v2/tenants/default_tenant/databases/default_database/collections",
    { name: "analogy-mcp-contract", configuration: null, get_or_create: true },
  );
  const collectionPath = `/api/v2/tenants/default_tenant/databases/default_database/collections/${collection.id}`;
  await requestJson(server.baseUrl, "POST", `${collectionPath}/upsert`, {
    ids: ["doc-a#0"],
    documents: ["MCP-compatible Chroma document"],
    embeddings: [[1, 0, 0]],
    metadatas: [{ doc_id: "doc-a" }],
  });

  const { ChromaClient } = loadTypeScriptModule(
    path.join(process.cwd(), "mcp-server/src/chroma-client.ts"),
  );
  const client = new ChromaClient(server.port);
  assert.equal(await client.healthCheck(), true);
  assert.ok((await client.listCollections()).some(({ id, name }) => id === collection.id && name === "analogy-mcp-contract"));
  const found = await client.getCollectionByName("analogy-mcp-contract");
  assert.equal(found?.id, collection.id);
  assert.equal(found?.name, "analogy-mcp-contract");
  assert.equal(found?.metadata, null);
  assert.equal(await client.countCollection(collection.id), 1);
  assert.deepEqual(
    await client.searchCollection(collection.id, [1, 0, 0], 1),
    [{ chunkId: "doc-a#0", content: "MCP-compatible Chroma document", score: 0, metadata: { doc_id: "doc-a" } }],
  );
});

test("LocalVectorStore uses the pinned Chroma v2 document contract", async (t) => {
  const server = await startPinnedChroma(t, process.env.ANALOGY_CHROMA_BIN);
  const { LocalVectorStore } = loadTypeScriptModule(
    path.join(process.cwd(), "src/local-vector/vector-store.ts"),
  );
  const store = new LocalVectorStore();
  await store.initialize(
    server.port,
    "vector-contract",
    "model",
    "analogy_vector-contract_model_0123456789ab",
  );
  await store.upsertDocument("doc-a", [{
    chunkId: "doc-a#0",
    content: "Plugin-compatible Chroma document",
    embedding: [1, 0, 0],
    chunkIndex: 0,
    chunkCount: 1,
    sectionLabel: "Body",
  }], { title: "Document A", path: "Document A.md", mtime: 1 });

  assert.equal(await store.count(), 1);
  const collections = await requestJson(
    server.baseUrl,
    "GET",
    "/api/v2/tenants/default_tenant/databases/default_database/collections",
  );
  assert.equal(collections.some(({ name }) => name === "analogy_vector-contract_model_0123456789ab"), true);
  assert.equal(collections.some(({ name }) => name === "analogy_vector-contract_model"), false);
  assert.deepEqual(
    (await store.search([1, 0, 0], 1)).map(({ chunkId, content, metadata }) => ({ chunkId, content, metadata })),
    [{
      chunkId: "doc-a#0",
      content: "Plugin-compatible Chroma document",
      metadata: {
        title: "Document A",
        path: "Document A.md",
        mtime: 1,
        doc_id: "doc-a",
        chunk_index: 0,
        chunk_count: 1,
        section_label: "Body",
      },
    }],
  );
  assert.deepEqual((await store.getChunks({ ids: ["doc-a#0"], includeEmbedding: true })).embeddings, [[1, 0, 0]]);
  await store.deleteDocument("doc-a");
  assert.equal(await store.count(), 0);
  await store.deleteCollectionByName(server.port, "analogy_vector-contract_model_0123456789ab");
  const afterDelete = await requestJson(
    server.baseUrl,
    "GET",
    "/api/v2/tenants/default_tenant/databases/default_database/collections",
  );
  assert.equal(afterDelete.some(({ name }) => name === "analogy_vector-contract_model_0123456789ab"), false);
});

test("plugin and MCP clients reject a legacy-only Chroma endpoint", async (t) => {
  const port = await startLegacyOnlyServer(t);
  const { ChromaClient } = loadTypeScriptModule(
    path.join(process.cwd(), "mcp-server/src/chroma-client.ts"),
  );
  const { LocalVectorStore } = loadTypeScriptModule(
    path.join(process.cwd(), "src/local-vector/vector-store.ts"),
  );

  const mcpClient = new ChromaClient(port);
  assert.equal(await mcpClient.healthCheck(), false);
  await assert.rejects(
    new LocalVectorStore().initialize(port, "legacy-fixture", "model"),
    /\/api\/v2\/heartbeat/,
  );
});

test("managed v2 rebuild publishes the exact child-owned Chroma port and collection consumed by MCP", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(require("node:os").tmpdir(), "analogy-mcp-e2e-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, "测试 Vault");
  const pluginDir = path.join(vaultPath, ".obsidian", "plugins", "analogy-rag-in-your-vault");
  const localDataRoot = path.join(root, "local-data");
  await fs.promises.mkdir(pluginDir, { recursive: true });
  const { deriveRuntimeVaultId } = loadTypeScriptTree(path.join(
    process.cwd(), "src/runtime/vault-identity.ts",
  ));
  const runtimeVaultId = deriveRuntimeVaultId(vaultPath, `${process.platform}-${process.arch}`);
  const vaultRuntimeRoot = path.join(localDataRoot, "vaults", runtimeVaultId);
  const v2DataPath = path.join(vaultRuntimeRoot, "chroma_data_v2");
  const legacyDataPath = path.join(pluginDir, "chroma_data", "legacy-id");
  await fs.promises.mkdir(legacyDataPath, { recursive: true });
  const legacyFile = path.join(legacyDataPath, "chroma.sqlite3");
  await fs.promises.writeFile(legacyFile, "只读旧数据", "utf8");
  const legacyBefore = await fs.promises.stat(legacyFile);
  const legacyHashBefore = crypto.createHash("sha256").update(await fs.promises.readFile(legacyFile)).digest("hex");

  const server = await startPinnedChroma(t, process.env.ANALOGY_CHROMA_BIN, { dataDirectory: v2DataPath });
  assert.equal(server.dataDirectory, v2DataPath);
  const modelShortName = "bge-small-en-v1.5";
  const { ChromaDataMigration, createChromaDataGeneration } = loadTypeScriptTree(path.join(
    process.cwd(), "src/runtime/chroma-data-migration.ts",
  ));
  const migration = new ChromaDataMigration({ runtimeStatePath: path.join(vaultRuntimeRoot, "runtime-state.json") });
  const oldGeneration = createChromaDataGeneration({
    localDataRoot, runtimeVaultId, modelShortName, port: server.port, legacyDataPath,
    transitionToken: "11111111111111111111111111111111",
  });
  const oldCollection = await requestJson(server.baseUrl, "POST",
    "/api/v2/tenants/default_tenant/databases/default_database/collections",
    { name: oldGeneration.collectionName, configuration: null, get_or_create: true });
  const oldCollectionPath = `/api/v2/tenants/default_tenant/databases/default_database/collections/${oldCollection.id}`;
  await requestJson(server.baseUrl, "POST", `${oldCollectionPath}/upsert`, {
    ids: ["old.md::chunk-0"], documents: ["old active document"], embeddings: [[0, 1, 0]],
    metadatas: [{ doc_id: "old.md", path: "old.md", mtime: 1, chunk_count: 1 }],
  });
  const oldTransition = await migration.begin(oldGeneration);
  await migration.completeRebuild(oldTransition, {
    scopeType: "recent",
    selectedDocuments: [{ docId: "old.md", path: "old.md", mtime: 1 }],
    indexState: { "old.md": { path: "old.md", mtime: 1, chunkCount: 1 } },
    collectionDocuments: [{ docId: "old.md", path: "old.md", mtime: 1, chunkCount: 1 }],
    chunkCount: 1,
    smokeQuery: async () => ["old-hit"],
  });

  const generation = createChromaDataGeneration({
    localDataRoot, runtimeVaultId, modelShortName, port: server.port, legacyDataPath,
    transitionToken: "22222222222222222222222222222222",
  });
  const transition = await migration.begin(generation);
  const collection = await requestJson(server.baseUrl, "POST",
    "/api/v2/tenants/default_tenant/databases/default_database/collections",
    { name: generation.collectionName, configuration: null, get_or_create: true });
  const collectionPath = `/api/v2/tenants/default_tenant/databases/default_database/collections/${collection.id}`;
  await requestJson(server.baseUrl, "POST", `${collectionPath}/upsert`, {
    ids: ["note.md::chunk-0"], documents: ["Analogy 固定重建验证查询命中内容"], embeddings: [[1, 0, 0]],
    metadatas: [{ doc_id: "note.md", path: "note.md", mtime: 2, chunk_count: 1 }],
  });
  const smoke = await requestJson(server.baseUrl, "POST", `${collectionPath}/query`, {
    query_embeddings: [[1, 0, 0]], n_results: 1, include: ["documents", "metadatas", "distances"],
  });
  assert.deepEqual(smoke.ids, [["note.md::chunk-0"]]);
  await migration.completeRebuild(transition, {
    expectedFileCount: 1,
    scopeType: "vault",
    selectedDocuments: [{ docId: "note.md", path: "note.md", mtime: 2 }],
    indexState: { "note.md": { path: "note.md", mtime: 2, chunkCount: 1 } },
    collectionDocuments: [{ docId: "note.md", path: "note.md", mtime: 2, chunkCount: 1 }],
    chunkCount: await requestJson(server.baseUrl, "GET", `${collectionPath}/count`),
    smokeQuery: async () => smoke.ids[0],
  });

  const { loadConfig } = loadTypeScriptTree(path.join(
    process.cwd(), "mcp-server/src/config.ts",
  ));
  const config = loadConfig({
    ANALOGY_VAULT_PATH: vaultPath,
    ANALOGY_PLUGIN_DIR: pluginDir,
    ANALOGY_LOCAL_DATA_ROOT: localDataRoot,
  }, { platform: "darwin", homeDirectory: root });
  const { ChromaClient } = loadTypeScriptTree(path.join(
    process.cwd(), "mcp-server/src/chroma-client.ts",
  ));
  const mcpClient = new ChromaClient(config.chromaPort);
  const found = await mcpClient.getCollectionByName(config.collectionName);
  assert.equal(config.runtimeGeneration, "v2");
  assert.equal(config.chromaPort, server.port);
  assert.equal(config.collectionName, generation.collectionName);
  assert.equal(await mcpClient.countCollection(found.id), 1);
  assert.equal((await mcpClient.searchCollection(found.id, [1, 0, 0], 1))[0].chunkId, "note.md::chunk-0");
  assert.equal(await requestJson(server.baseUrl, "GET", `${oldCollectionPath}/count`), 1);
  const oldSmoke = await requestJson(server.baseUrl, "POST", `${oldCollectionPath}/query`, {
    query_embeddings: [[0, 1, 0]], n_results: 1, include: ["documents", "metadatas", "distances"],
  });
  assert.deepEqual(oldSmoke.ids, [["old.md::chunk-0"]], "pointer switch must retain the prior active collection");

  const legacyAfter = await fs.promises.stat(legacyFile);
  const legacyHashAfter = crypto.createHash("sha256").update(await fs.promises.readFile(legacyFile)).digest("hex");
  assert.equal(legacyHashAfter, legacyHashBefore);
  assert.equal(legacyAfter.mtimeMs, legacyBefore.mtimeMs);
});
