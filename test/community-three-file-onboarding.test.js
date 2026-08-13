"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {pathToFileURL} = require("node:url");
const ts = require("typescript");

const extensionRoot = process.cwd();
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
    if (!specifier.startsWith(".")) {
      try { return require(specifier); }
      catch (error) {
        if (error?.code !== "MODULE_NOT_FOUND") throw error;
        return require(path.join(extensionRoot, "node_modules", specifier));
      }
    }
    const resolved = path.resolve(path.dirname(filename), specifier);
    for (const suffix of [".ts", ".tsx", ".js"]) {
      if (fs.existsSync(`${resolved}${suffix}`)) return loadTypeScriptFile(`${resolved}${suffix}`);
    }
    return require(resolved);
  };
  Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports, localRequire, module, filename, path.dirname(filename),
  );
  loaded.set(filename, module.exports);
  return module.exports;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function snapshot(stage = "not-started", overrides = {}) {
  return {
    schemaVersion: 1, stage, progress: null, completedBytes: null, totalBytes: null,
    currentItem: "", runtimePlatform: null, chromaRuntimeId: null,
    embeddingRuntimeId: null, selectedIndexScope: null, startedAt: null,
    updatedAt: 0, completedAt: null, dismissedAt: null, error: null, ...overrides,
  };
}

function listRelativeFiles(root) {
  return fs.readdirSync(root, {recursive: true})
    .map((entry) => String(entry))
    .filter((entry) => fs.statSync(path.join(root, entry)).isFile())
    .sort();
}

test("runtime setup diagnostics accept only the documented allowlist", async () => {
  global.window = globalThis;
  const {sanitizeRuntimeSetupContext} = loadTypeScriptFile(path.join(
    extensionRoot, "src/diagnostics/diagnostic-redaction.ts",
  ));
  assert.deepEqual(sanitizeRuntimeSetupContext({
    stage: "downloading-chroma", errorCode: "PORT_CONFLICT", platform: "darwin",
    arch: "arm64", runtimeId: "chroma-cli-1.4.4-darwin-arm64", durationMs: 123.9,
    receivedBytes: 456, retryCount: 2, portConflict: true,
    copiedRecords: 40, totalRecords: 100, sourceBytes: 8000,
  }), {
    stage: "downloading-chroma", errorCode: "PORT_CONFLICT", platform: "darwin",
    arch: "arm64", runtimeId: "chroma-cli-1.4.4-darwin-arm64", durationMs: 123,
    receivedBytes: 456, retryCount: 2, portConflict: true,
    copiedRecords: 40, totalRecords: 100, sourceBytes: 8000,
  });
  for (const forbidden of [
    "pluginDir", "vaultPath", "fileName", "url", "noteContent", "modelInput", "stderr",
    "query", "embeddings", "documents", "rawError",
  ]) {
    assert.throws(
      () => sanitizeRuntimeSetupContext({stage: "checking", [forbidden]: "绝密 note?token=secret"}),
      /DIAGNOSTIC_CONTEXT_FIELD_REJECTED/,
    );
  }
  assert.equal(sanitizeRuntimeSetupContext({
    stage: "checking", runtimeId: "https://host/asset?token=secret",
  }).runtimeId, undefined);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-diagnostic-"));
  try {
    const {DiagnosticRecorder} = loadTypeScriptFile(path.join(
      extensionRoot, "src/diagnostics/diagnostic-recorder.ts",
    ));
    const recorder = new DiagnosticRecorder({
      pluginDir: tempRoot, pluginVersion: "1.1.9", buildId: "test",
      obsidianVersion: "1.9.0", platform: "darwin", arch: "arm64", locale: "zh",
    });
    recorder.recordRuntimeSetup({stage: "warming-up-model", durationMs: 80});
    recorder.recordRuntimeSetup({stage: "failed", errorCode: "MODEL_LOAD_FAILED", portConflict: false});
    recorder.recordRuntimeSetup({stage: "checking", vaultPath: "/Users/private/Vault"});
    const events = recorder.getEvents();
    assert.deepEqual(events.map((event) => event.code), [
      "onboarding.warming-up-model", "runtime.model_load_failed",
    ]);
    assert.equal(JSON.stringify(events).includes("/Users/private"), false);
    await recorder.flush();
  } finally {
    fs.rmSync(tempRoot, {recursive: true, force: true});
  }
});

test("Community three-file install completes managed onboarding outside the plugin directory", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-community-") );
  const vaultRoot = path.join(tempRoot, "测试 用户 Vault");
  const pluginDir = path.join(vaultRoot, ".obsidian", "plugins", "analogy-rag-in-your-vault");
  const localRoot = path.join(tempRoot, "system-local-data", "Analogy");
  fs.mkdirSync(pluginDir, {recursive: true});
  fs.mkdirSync(localRoot, {recursive: true});
  const communityFiles = ["main.js", "manifest.json", "styles.css"];
  for (const file of communityFiles) fs.copyFileSync(path.join(extensionRoot, file), path.join(pluginDir, file));
  assert.deepEqual(listRelativeFiles(pluginDir), communityFiles.sort());
  const {verifyCommunityPluginDirectory} = await import(pathToFileURL(
    path.join(extensionRoot, "scripts/prepare-release.mjs"),
  ).href);
  assert.deepEqual(verifyCommunityPluginDirectory(pluginDir), communityFiles.sort());

  const assets = new Map([
    ["/chroma.bin", Buffer.from("fixture-chroma-cli-1.4.4")],
    ["/embedding.bin", Buffer.from("fixture-node22-transformers-onnxruntime")],
    ["/model.onnx", Buffer.from("fixture-multilingual-e5-model")],
  ]);
  const server = http.createServer((request, response) => {
    const body = assets.get(request.url);
    if (!body) { response.writeHead(404).end(); return; }
    response.writeHead(200, {"content-length": body.length});
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `http://127.0.0.1:${server.address().port}`;

  let stored = snapshot();
  let now = 1_000;
  const stages = [];
  const makePipeline = (kind, route) => {
    const payload = assets.get(route);
    const runtimeId = kind === "chroma" ? "chroma-cli-1.4.4-darwin-arm64" : "embedding-runtime-node22-v1-darwin-arm64";
    return {
      asset: {
        id: runtimeId, kind, platform: "darwin-arm64", version: kind === "chroma" ? "cli-1.4.4" : "node22-v1",
        url: `${host}${route}`, fileName: path.basename(route), archive: "none", size: payload.length,
        sha256: sha256(payload), executableRelativePath: path.basename(route), licenseName: "fixture",
        licenseUrl: `${host}/license`, source: "published",
        ...(kind === "embedding-runtime" ? {runtimeVersions: {
          node: "22.23.2", transformers: "4.2.0", onnxruntime: "1.26.0",
        }} : {}),
      },
      async download(signal, onProgress) {
        const response = await fetch(`${host}${route}`, {signal});
        const bytes = Buffer.from(await response.arrayBuffer());
        const target = path.join(localRoot, "downloads", `${kind}.part`);
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.writeFileSync(target, bytes);
        onProgress({receivedBytes: bytes.length, totalBytes: bytes.length, percent: 100, currentItem: path.basename(route)});
        return {path: target, receivedBytes: bytes.length};
      },
      async verify(downloaded) {
        const bytes = fs.readFileSync(downloaded.path);
        return {ok: bytes.length === payload.length && sha256(bytes) === sha256(payload), actualSize: bytes.length,
          actualSha256: sha256(bytes), errorCode: null};
      },
      async install(downloaded) {
        const target = path.join(localRoot, "runtimes", runtimeId, path.basename(route));
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.copyFileSync(downloaded.path, target);
        return {runtimeId, executablePath: target};
      },
    };
  };

  const {OnboardingCoordinator} = loadTypeScriptFile(path.join(
    extensionRoot, "src/onboarding/onboarding-coordinator.ts",
  ));
  const coordinator = new OnboardingCoordinator({
    detectEnvironment: async () => ({
      platform: "darwin-arm64", chroma: "missing", embeddingRuntime: "missing",
      embeddingModel: "missing", index: "empty", recommendedAction: "setup",
    }),
    store: {
      async load() { return {snapshot: structuredClone(stored), recommendedAction: "setup", migrated: false, removedLegacyKeys: []}; },
      async save(next) {
        stored = structuredClone(next);
        fs.writeFileSync(path.join(localRoot, "onboarding-state.json"), JSON.stringify(next));
      },
      async flush() {},
    },
    runtimes: {
      chroma: makePipeline("chroma", "/chroma.bin"),
      embedding: makePipeline("embedding-runtime", "/embedding.bin"),
    },
    chromaManager: {
      getState: () => ({ownership: "none", pid: null, executablePath: null, port: 8000, runtimeVersion: null, startedAt: null}),
      async start(options) {
        fs.mkdirSync(options.dataPath, {recursive: true});
        return {ownership: "analogy", pid: 42001, executablePath: options.executablePath,
          port: 8123, runtimeVersion: options.runtimeVersion, startedAt: ++now};
      },
      async stopOwnedProcess() {},
    },
    chromaStartOptions: (installed) => ({
      executablePath: installed.executablePath,
      dataPath: path.join(localRoot, "vaults", "vault-v2-fixture", "chroma_data_v2"),
      runtimeVersion: "cli-1.4.4", preferredPort: 8123,
    }),
    embeddingRuntimeManager: {async resolve() { return {runtimeId: "embedding-runtime-node22-v1-darwin-arm64"}; }},
    embeddingModel: {
      isReady: () => false,
      async download(signal, onProgress) {
        const response = await fetch(`${host}/model.onnx`, {signal});
        const bytes = Buffer.from(await response.arrayBuffer());
        const target = path.join(localRoot, "models", "multilingual-e5-small", "model.onnx");
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.writeFileSync(target, bytes);
        onProgress({phase: "downloading", file: "model.onnx", loadedBytes: bytes.length,
          totalBytes: bytes.length, percent: 100});
      },
      async warmUp(_signal, onProgress) {
        const worker = path.join(localRoot, "workers", "embedding-worker.cjs");
        fs.mkdirSync(path.dirname(worker), {recursive: true});
        fs.writeFileSync(worker, "// fixture worker");
        onProgress({phase: "loading", file: null, loadedBytes: null, totalBytes: null, percent: 100});
      },
      async cancel() {},
    },
    quickIndex: {
      async run(scope, onProgress, options) {
        const result = {requested: 1, scopeType: scope.type, selectedFileCount: 1,
          indexed: 1, skipped: 0, failed: 0, chunkCount: 1,
          selectedDocuments: [{docId: "欢迎.md", path: "欢迎.md", mtime: 1}]};
        onProgress({current: 1, total: 1, currentFileName: "欢迎.md"});
        const collection = path.join(localRoot, "vaults", "vault-v2-fixture", "chroma_data_v2", "collection.json");
        fs.mkdirSync(path.dirname(collection), {recursive: true});
        fs.writeFileSync(collection, JSON.stringify(result));
        await options.finalize(result);
        return result;
      },
    },
    finalizeQuickIndex: async (result) => {
      fs.writeFileSync(path.join(localRoot, "vaults", "runtime-state.json"), JSON.stringify({
        schemaVersion: 1, activeGeneration: "v2", indexed: result.indexed, port: 8123,
      }));
    },
    now: () => ++now,
  });
  coordinator.subscribe((value) => stages.push(value.stage));
  try {
    const operation = coordinator.start();
    await waitFor(() => coordinator.getSnapshot().stage === "awaiting-consent", "consent");
    assert.equal(await coordinator.provideConsent(true), true);
    await waitFor(() => coordinator.getSnapshot().stage === "selecting-index-scope", "scope selection");
    assert.equal(await coordinator.selectIndexScope({type: "recent", limit: 30}), true);
    assert.equal((await operation).stage, "ready");

    assert.deepEqual(listRelativeFiles(pluginDir), communityFiles.sort());
    assert.equal(listRelativeFiles(pluginDir).some((file) => /package|scripts|node_modules|worker|runtime|python/i.test(file)), false);
    const localFiles = listRelativeFiles(localRoot).map((file) => file.split(path.sep).join("/"));
    assert.ok(localFiles.some((file) => file.includes("runtimes/chroma-cli-1.4.4")));
    assert.ok(localFiles.some((file) => file.includes("runtimes/embedding-runtime-node22-v1")));
    assert.ok(localFiles.includes("models/multilingual-e5-small/model.onnx"));
    assert.ok(localFiles.includes("workers/embedding-worker.cjs"));
    assert.ok(localFiles.some((file) => file.endsWith("chroma_data_v2/collection.json")));
    assert.equal(stages.at(-1), "ready");
  } finally {
    await coordinator.dispose();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempRoot, {recursive: true, force: true});
  }
});
