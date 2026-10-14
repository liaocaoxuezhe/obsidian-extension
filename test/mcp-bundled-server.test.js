"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");
const esbuild = require("esbuild");
const builtins = require("builtin-modules");
const { DatabaseSync } = require("node:sqlite");

const repositoryRoot = path.resolve(__dirname, "..");

async function loadModule(source) {
  const result = await esbuild.build({
    entryPoints: [path.join(repositoryRoot, source)],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    external: [...builtins],
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", "__filename", result.outputFiles[0].text)(
    module, module.exports, require, path.join(repositoryRoot, source),
  );
  return module.exports;
}

async function bundleServer() {
  const result = await esbuild.build({
    entryPoints: [path.join(repositoryRoot, "src/mcp/server/index.ts")],
    bundle: true, platform: "node", format: "cjs", target: "es2020", write: false,
    external: [...builtins], define: { __ANALOGY_MCP_SERVER_VERSION__: "\"test\"" },
  });
  return result.outputFiles[0].text;
}

test("the minimal MCP protocol negotiates versions and serves tools", async () => {
  const { StdioMcpServer, negotiateProtocolVersion } = await loadModule("src/mcp/server/protocol.ts");
  assert.equal(negotiateProtocolVersion("2024-11-05"), "2024-11-05");
  assert.equal(negotiateProtocolVersion("1999-01-01"), "2025-06-18");
  const server = new StdioMcpServer({ name: "t", version: "1" }, () => undefined);
  server.addTool({ name: "echo", description: "e", inputSchema: { type: "object" },
    handler: async (args) => ({ content: [{ type: "text", text: String(args.value) }] }) });
  server.addTool({ name: "boom", description: "b", inputSchema: { type: "object" }, handler: async () => { throw new Error("nope"); } });
  const init = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  assert.deepEqual(init.result, { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "t", version: "1" } });
  assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.deepEqual((await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })).result.tools.map((tool) => tool.name), ["echo", "boom"]);
  assert.equal((await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { value: 7 } } })).result.content[0].text, "7");
  const failed = await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "boom" } });
  assert.equal(failed.result.isError, true);
  assert.equal((await server.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "missing" } })).error.code, -32602);
  assert.equal((await server.handle({ jsonrpc: "2.0", id: 6, method: "resources/list" })).error.code, -32601);
  assert.equal((await server.handle({ id: 7, method: "ping" })).error.code, -32600);
});

test("hybrid fusion in the MCP server loads keyword-only chunks and labels their source", async () => {
  const { fuseHybridResults } = await loadModule("src/mcp/server/index.ts");
  const vector = [{ chunkId: "a", content: "A", distance: 0.1, metadata: {} }, { chunkId: "b", content: "B", distance: 0.2, metadata: {} }];
  const loaded = [];
  const fused = fuseHybridResults(vector, { fts: ["c", "a"], like: [] }, (ids) => {
    loaded.push(...ids);
    return ids.map((chunkId) => ({ chunkId, content: chunkId.toUpperCase(), distance: 1.5, metadata: {} }));
  }, 3);
  assert.deepEqual(fused.map((result) => [result.chunkId, result.matched_by]), [["a", ["vector", "keyword"]], ["c", ["keyword"]], ["b", ["vector"]]]);
  assert.deepEqual(loaded, ["c"]);
  assert.deepEqual(fuseHybridResults(vector, { fts: [], like: [] }, () => [], 1).map((result) => result.chunkId), ["a"]);
});

const SPEC = {
  serverName: "analogy-vault",
  command: "C:\\Users\\测试 用户\\AppData\\Local\\Analogy\\node.exe",
  args: ["C:\\Users\\测试 用户\\AppData\\Local\\Analogy\\mcp\\analogy-mcp-server.cjs"],
  env: { ANALOGY_VAULT_PATH: "D:\\笔记", ANALOGY_MODEL: "bge-small-zh" },
};

test("client configuration plans add only the Analogy entry and detect configured or outdated state", async () => {
  const config = await loadModule("src/mcp/mcp-client-config.ts");
  const files = new Map();
  const options = { platform: "win32", home: "C:\\Users\\u", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, readFile: (file) => files.get(file) ?? null };
  const desktop = config.MCP_CLIENTS.find((client) => client.id === "claude-desktop");
  const desktopPath = path.join("C:\\Users\\u\\AppData\\Roaming", "Claude", "claude_desktop_config.json");

  let plan = config.planMcpClientConfig(desktop, SPEC, options);
  assert.equal(plan.configPath, desktopPath);
  assert.equal(plan.status, "missing");
  assert.deepEqual(JSON.parse(plan.nextContent).mcpServers["analogy-vault"], { command: SPEC.command, args: SPEC.args, env: SPEC.env });

  files.set(desktopPath, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }, null, 4));
  plan = config.planMcpClientConfig(desktop, SPEC, options);
  const next = JSON.parse(plan.nextContent);
  assert.equal(next.theme, "dark");
  assert.deepEqual(next.mcpServers.other, { command: "x" }, "other servers are untouched");
  assert.match(plan.nextContent, /\n {4}"theme"/, "indentation is preserved");
  assert.match(plan.diff, /^\+ /m);
  assert.doesNotMatch(plan.diff, /^- /m, "adding the entry never rewrites existing lines");

  files.set(desktopPath, plan.nextContent);
  assert.equal(config.planMcpClientConfig(desktop, SPEC, options).status, "configured");
  assert.equal(config.planMcpClientConfig(desktop, { ...SPEC, command: "C:\\new\\node.exe" }, options).status, "outdated");
  files.set(desktopPath, "{ broken");
  const unreadable = config.planMcpClientConfig(desktop, SPEC, options);
  assert.equal(unreadable.status, "unreadable");
  assert.equal(unreadable.nextContent, null);

  const opencode = config.MCP_CLIENTS.find((client) => client.id === "opencode");
  const opencodePath = path.join("C:\\Users\\u", ".config", "opencode", "opencode.jsonc");
  files.set(opencodePath, "{\n  // my settings\n  \"theme\": \"x\", /* keep */\n  \"url\": \"http://a//b\",\n}\n");
  const opencodePlan = config.planMcpClientConfig(opencode, SPEC, options);
  assert.match(opencodePlan.nextContent, /\/\/ my settings/, "comments are kept");
  assert.match(opencodePlan.nextContent, /\/\* keep \*\//);
  const opencodeNext = JSON.parse(config.stripJsonComments(opencodePlan.nextContent));
  assert.equal(opencodeNext.url, "http://a//b", "// inside strings is not a comment");
  assert.deepEqual(opencodeNext.mcp["analogy-vault"], { type: "local", command: [SPEC.command, ...SPEC.args], enabled: true, environment: SPEC.env });

  const codex = config.MCP_CLIENTS.find((client) => client.id === "codex");
  const codexPath = path.join("C:\\Users\\u", ".codex", "config.toml");
  files.set(codexPath, "model = \"o3\"\n\n[mcp_servers.analogy-vault]\ncommand = \"old\"\n\n[mcp_servers.analogy-vault.env]\nA = \"1\"\n\n[mcp_servers.other]\ncommand = \"keep\"\n");
  const codexPlan = config.planMcpClientConfig(codex, SPEC, options);
  assert.equal(codexPlan.status, "outdated");
  assert.equal((codexPlan.nextContent.match(/\[mcp_servers\.analogy-vault\]/g) || []).length, 1);
  assert.match(codexPlan.nextContent, /\[mcp_servers\.other\]\ncommand = "keep"/);
  assert.match(codexPlan.nextContent, /command = "C:\\\\Users\\\\测试 用户/, "TOML strings escape Windows backslashes");
  files.set(codexPath, codexPlan.nextContent);
  assert.equal(config.planMcpClientConfig(codex, SPEC, options).status, "configured");
});

test("applying a client plan keeps a backup and replaces the file atomically", async (t) => {
  const config = await loadModule("src/mcp/mcp-client-config.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-mcp-client-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cursor = config.MCP_CLIENTS.find((client) => client.id === "cursor");
  const file = path.join(root, ".cursor", "mcp.json");
  const fresh = config.planMcpClientConfig(cursor, SPEC, { home: root });
  assert.equal(config.applyMcpClientPlan(fresh, 1), null, "no backup when the file did not exist");
  fs.writeFileSync(file, "{\"mcpServers\":{}}\n");
  const update = config.planMcpClientConfig(cursor, SPEC, { home: root });
  const backup = config.applyMcpClientPlan(update, 2);
  assert.equal(fs.readFileSync(backup, "utf8"), "{\"mcpServers\":{}}\n");
  assert.equal(config.planMcpClientConfig(cursor, SPEC, { home: root }).status, "configured");
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ["mcp.json", "mcp.json.analogy-backup-2"]);
});

test("the bundled server is materialized once to a stable path and rewritten when it changes", async (t) => {
  const { materializeMcpServer, readMcpLastQuery } = await loadModule("src/mcp/mcp-bundle.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-mcp-bundle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = materializeMcpServer(root, "console.log(1)");
  assert.equal(first.written, true);
  assert.equal(first.entry, path.join(root, "mcp", "analogy-mcp-server.cjs"));
  assert.equal(materializeMcpServer(root, "console.log(1)").written, false);
  assert.equal(materializeMcpServer(root, "console.log(2)").written, true);
  assert.equal(fs.readFileSync(first.entry, "utf8"), "console.log(2)");
  assert.throws(() => materializeMcpServer(root, "  "), /MCP_SERVER_BUNDLE_MISSING/);
  fs.writeFileSync(path.join(root, "mcp", "last-query.json"), JSON.stringify({ schemaVersion: 1, at: 5, vaultId: "v", tool: "vault_semantic_search", results: 3 }));
  assert.deepEqual(readMcpLastQuery(root, "v"), { at: 5, tool: "vault_semantic_search", results: 3 });
  assert.equal(readMcpLastQuery(root, "other"), null, "another vault's activity is not shown");
});

function rpc(child) {
  let buffer = "";
  const waiting = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      waiting.get(message.id)?.(message);
    }
  });
  let id = 0;
  return (method, params) => new Promise((resolve) => {
    id += 1;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

async function prepareVault(root, { modelShortName, embeddingFor }) {
  const identity = await loadModule("mcp-server/src/runtime-vault-identity.ts");
  const { VectorStoreEngine } = await loadModule("src/local-vector/vector-store-engine.ts");
  const vaultPath = path.join(root, "测试 Vault");
  const pluginDir = path.join(vaultPath, ".obsidian", "plugins", "analogy-rag-in-your-vault");
  fs.mkdirSync(pluginDir, { recursive: true });
  const platform = process.platform === "win32" ? "win32-x64" : "darwin-arm64";
  const runtimeVaultId = identity.deriveRuntimeVaultId(vaultPath, platform);
  const localDataRoot = path.join(root, "local-data");
  const storeRoot = path.join(localDataRoot, "vaults", runtimeVaultId, "vector-store");
  fs.mkdirSync(storeRoot, { recursive: true });
  const collectionName = `analogy_${runtimeVaultId}_${modelShortName}`;
  fs.writeFileSync(path.join(storeRoot, "runtime-state.json"), JSON.stringify({
    schemaVersion: 1, revision: 1, runtimeVaultId, activeGeneration: "v2", previousGeneration: null, pendingGeneration: null,
    runtimeId: "chroma-cli-1.4.4", port: 8000, modelShortName, collectionName, rebuildCompletedAt: 1700000000123,
    scopeCompletion: { schemaVersion: 1, evidenceId: "f".repeat(32), scopeType: "vault", selectionDigest: "a".repeat(64), fileCount: 2, chunkCount: 2, completedAt: 1700000000123 },
  }));
  const engine = new VectorStoreEngine(new DatabaseSync(path.join(storeRoot, "vectors.sqlite")));
  engine.ensureCollection(collectionName);
  const notes = [["hooks", "React 里 useEffect 的依赖数组要写全"], ["garden", "春天适合在阳台种番茄和罗勒"]];
  engine.upsert(collectionName, await Promise.all(notes.map(async ([id, text]) => ({
    id, document: text, embedding: await embeddingFor(text), metadata: { doc_id: `${id}.md`, path: `${id}.md`, title: id },
  }))));
  engine.close();
  return { vaultPath, pluginDir, localDataRoot, runtimeVaultId };
}

function startServer(t, entry, env) {
  const child = spawn(process.execPath, ["--no-warnings", entry], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  return rpc(child);
}

test("the bundled server answers MCP clients from the read-only store without the plugin running", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-mcp-e2e-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = await prepareVault(root, { modelShortName: "bge-small-en-v1.5", embeddingFor: async () => [1, 0, 0, 0] });
  const entry = path.join(root, "analogy-mcp-server.cjs");
  fs.writeFileSync(entry, await bundleServer());
  const call = startServer(t, entry, {
    ANALOGY_VAULT_PATH: vault.vaultPath, ANALOGY_PLUGIN_DIR: vault.pluginDir, ANALOGY_LOCAL_DATA_ROOT: vault.localDataRoot,
    ANALOGY_RUNTIME_MODULE_ROOT: path.join(repositoryRoot, "node_modules"),
  });
  assert.equal((await call("initialize", { protocolVersion: "2024-11-05" })).result.protocolVersion, "2024-11-05");
  assert.deepEqual((await call("tools/list")).result.tools.map((tool) => tool.name), ["vault_semantic_search", "vault_index_status"]);
  const status = JSON.parse((await call("tools/call", { name: "vault_index_status", arguments: {} })).result.content[0].text);
  assert.equal(status.status, "ready");
  assert.equal(status.total_chunks, 2);
  assert.equal(status.keyword_index, "ready");
  assert.equal(JSON.stringify(status).includes(vault.vaultPath), false, "the vault path is never echoed");
  const missingModel = (await call("tools/call", { name: "vault_semantic_search", arguments: { query: "useEffect" } })).result;
  assert.equal(missingModel.isError, true);
  assert.match(missingModel.content[0].text, /not downloaded yet/);
});

const modelCache = process.env.ANALOGY_TEST_MODEL_CACHE;
test("vault_semantic_search embeds offline with the managed runtime and finds identifiers by keyword", { skip: !modelCache && "set ANALOGY_TEST_MODEL_CACHE to a bge-small-en-v1.5 cache" }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-mcp-search-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transformers = require(path.join(repositoryRoot, "node_modules", "@huggingface", "transformers"));
  transformers.env.allowRemoteModels = false;
  transformers.env.localModelPath = modelCache;
  const extractor = await transformers.pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype: "q8", local_files_only: true });
  const vault = await prepareVault(root, {
    modelShortName: "bge-small-en-v1.5",
    embeddingFor: async (text) => Array.from((await extractor(text, { pooling: "mean", normalize: true })).data),
  });
  const cacheTarget = path.join(vault.localDataRoot, "models", "transformers-cache", "bge-small-en-v1.5");
  fs.mkdirSync(path.dirname(cacheTarget), { recursive: true });
  fs.symlinkSync(modelCache, cacheTarget, "dir");
  const entry = path.join(root, "analogy-mcp-server.cjs");
  fs.writeFileSync(entry, await bundleServer());
  const call = startServer(t, entry, {
    ANALOGY_VAULT_PATH: vault.vaultPath, ANALOGY_PLUGIN_DIR: vault.pluginDir, ANALOGY_LOCAL_DATA_ROOT: vault.localDataRoot,
    ANALOGY_RUNTIME_MODULE_ROOT: path.join(repositoryRoot, "node_modules"),
  });
  await call("initialize", {});
  const response = (await call("tools/call", { name: "vault_semantic_search", arguments: { query: "useEffect", top_k: 1 } })).result;
  const body = JSON.parse(response.content[0].text);
  assert.equal(body.results[0].path, "hooks.md");
  assert.ok(body.results[0].matched_by.includes("keyword"));
  const lastQuery = JSON.parse(fs.readFileSync(path.join(vault.localDataRoot, "mcp", "last-query.json"), "utf8"));
  assert.equal(lastQuery.tool, "vault_semantic_search");
  assert.equal(JSON.stringify(lastQuery).includes("useEffect"), false, "query text is never written to disk");
});
