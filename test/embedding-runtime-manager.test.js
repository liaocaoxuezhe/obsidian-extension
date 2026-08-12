"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const esbuild = require("esbuild");

const extensionRoot = path.join(__dirname, "..");

async function loadManagerModule() {
  const result = await esbuild.build({
    entryPoints: [path.join(extensionRoot, "src", "runtime", "embedding-runtime-manager.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    write: false,
    logLevel: "silent",
  });
  const module = { exports: {} };
  Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function writeFile(filename, body, mode = 0o600) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, body, { mode });
}

function fixtureAsset(platform) {
  const executableName = platform === "win32-x64" ? "node.exe" : "node";
  return {
    id: `embedding-runtime-node22-v1-${platform}`,
    kind: "embedding-runtime",
    platform,
    version: "node22-v1",
    url: `https://example.invalid/runtime-${platform}`,
    fileName: `runtime-${platform}`,
    archive: platform === "win32-x64" ? "zip" : "tar.gz",
    size: 123,
    sha256: sha256(Buffer.from(`archive:${platform}`)),
    executableRelativePath: `analogy-embedding-runtime-node22-v1/node/bin/${executableName}`,
    licenseName: "fixture",
    licenseUrl: "https://example.invalid/license",
    source: "published",
    runtimeVersions: {
      node: "22.23.2",
      transformers: "4.2.0",
      onnxruntime: "1.26.0",
    },
  };
}

function createFixture(platform = "darwin-arm64") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-managed-embedding-"));
  const runtimeVaultId = "vault-v2-0123456789abcdef";
  const vaultRoot = path.join(root, "vaults", runtimeVaultId);
  const paths = {
    root,
    runtimeVaultId,
    downloads: path.join(root, "runtime", "downloads"),
    staging: path.join(root, "runtime", "staging"),
    chromaVersions: path.join(root, "runtime", "chroma"),
    embeddingVersions: path.join(root, "runtime", "embedding"),
    workerVersions: path.join(root, "runtime", "worker"),
    current: path.join(vaultRoot, "current"),
    legacyCurrent: path.join(root, "runtime", "current"),
    installRecords: path.join(root, "runtime", "installations"),
    modelCache: path.join(root, "models", "transformers-cache"),
    vaultRoot,
    onboardingState: path.join(vaultRoot, "onboarding-state.json"),
    runtimeState: path.join(vaultRoot, "runtime-state.json"),
    chromaProcessLease: path.join(vaultRoot, "chroma-process-lease.json"),
    chromaDataV2: path.join(vaultRoot, "chroma_data_v2"),
  };
  const asset = fixtureAsset(platform);
  const installedPath = path.join(paths.embeddingVersions, asset.id);
  const packRoot = path.join(installedPath, "analogy-embedding-runtime-node22-v1");
  const executableName = platform === "win32-x64" ? "node.exe" : "node";
  const executablePath = path.join(packRoot, "node", "bin", executableName);
  const moduleRoot = path.join(packRoot, "node_modules");
  const nativeRoot = path.join(
    moduleRoot,
    "onnxruntime-node",
    "bin",
    "napi-v6",
    platform.startsWith("win32") ? "win32" : "darwin",
    platform.endsWith("x64") ? "x64" : "arm64",
  );

  const nodeBody = platform === `${process.platform}-${process.arch}`
    ? fs.readFileSync(process.execPath)
    : Buffer.from(`fixture executable for ${platform}`);
  writeFile(executablePath, nodeBody, 0o700);
  writeFile(path.join(moduleRoot, "package.json"), "{\"private\":true}\n");
  writeFile(
    path.join(moduleRoot, "@huggingface", "transformers", "package.json"),
    "{\"name\":\"@huggingface/transformers\",\"version\":\"4.2.0\",\"main\":\"index.js\"}\n",
  );
  writeFile(path.join(moduleRoot, "@huggingface", "transformers", "index.js"), `
    exports.env = {};
    exports.pipeline = async () => {
      const extractor = async (texts) => ({
        data: new Float32Array(texts.length * 3).fill(0.25),
        dims: [texts.length, 3],
      });
      extractor.dispose = async () => {};
      return extractor;
    };
  `);
  writeFile(
    path.join(moduleRoot, "onnxruntime-node", "package.json"),
    "{\"name\":\"onnxruntime-node\",\"version\":\"1.26.0\",\"main\":\"index.js\"}\n",
  );
  writeFile(path.join(moduleRoot, "onnxruntime-node", "index.js"), "module.exports = {};\n");
  writeFile(path.join(nativeRoot, "onnxruntime_binding.node"), "binding");
  writeFile(
    path.join(nativeRoot, platform.startsWith("win32") ? "onnxruntime.dll" : "libonnxruntime.dylib"),
    "native",
  );
  writeFile(path.join(packRoot, "THIRD_PARTY_NOTICES.txt"), "fixture notices\n");

  const relativeFiles = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile() && filename !== path.join(packRoot, "manifest.json")) {
        const body = fs.readFileSync(filename);
        relativeFiles.push({
          path: path.relative(packRoot, filename).split(path.sep).join("/"),
          size: body.length,
          sha256: sha256(body),
        });
      }
    }
  };
  visit(packRoot);
  relativeFiles.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    schemaVersion: 1,
    id: asset.id,
    kind: "embedding-runtime",
    platform,
    version: "node22-v1",
    runtimeVersions: asset.runtimeVersions,
    executableRelativePath: `node/bin/${executableName}`,
    moduleRootRelativePath: "node_modules",
    noticesRelativePath: "THIRD_PARTY_NOTICES.txt",
    files: relativeFiles,
  };
  const manifestPath = path.join(packRoot, "manifest.json");
  const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFile(manifestPath, manifestBody);
  asset.internalManifestSha256 = sha256(Buffer.from(manifestBody));

  fs.mkdirSync(paths.current, { recursive: true });
  const pointer = {
    schemaVersion: 1,
    kind: "embedding-runtime",
    runtimeId: asset.id,
    installedPath,
    assetSha256: asset.sha256,
    installedAt: 1_785_800_000_000,
    previousRuntimeId: null,
  };
  fs.writeFileSync(
    path.join(paths.current, "embedding-runtime.json"),
    `${JSON.stringify(pointer, null, 2)}\n`,
    "utf8",
  );
  return { root, paths, asset, pointer, installedPath, packRoot, executablePath, moduleRoot, nativeRoot, manifestPath };
}

async function withFixture(t, platform = "darwin-arm64") {
  const fixture = createFixture(platform);
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const { EmbeddingRuntimeManager } = await loadManagerModule();
  const manager = new EmbeddingRuntimeManager({
    paths: fixture.paths,
    platform,
    getAsset: () => fixture.asset,
  });
  return { ...fixture, manager };
}

test("resolve returns only the pinned immutable current embedding install", async (t) => {
  const { manager, asset, installedPath, executablePath, moduleRoot } = await withFixture(t);
  const runtime = await manager.resolve();
  assert.equal(runtime.runtimeId, asset.id);
  assert.equal(runtime.root, installedPath);
  assert.equal(runtime.nodeExecutable, executablePath);
  assert.equal(runtime.moduleRoot, moduleRoot);
  assert.deepEqual(runtime.versions, {
    node: "22.23.2",
    transformers: "4.2.0",
    onnxruntime: "1.26.0",
  });
  assert.deepEqual(runtime.verification, {
    assetId: asset.id,
    assetSha256: asset.sha256,
    internalManifestPath: path.join(installedPath, "analogy-embedding-runtime-node22-v1", "manifest.json"),
    internalManifestSha256: asset.internalManifestSha256,
  });
  assert.equal(typeof runtime.revalidate, "function");
  assert.deepEqual(await runtime.revalidate(), {
    nodeExecutable: executablePath,
    moduleRoot,
    verification: runtime.verification,
  });
});

test("resolve migrates an exact legacy pointer only into the requesting Vault", async (t) => {
  const fixture = await withFixture(t);
  const localPointer = path.join(fixture.paths.current, "embedding-runtime.json");
  const legacyPointer = path.join(fixture.paths.legacyCurrent, "embedding-runtime.json");
  const pointerBody = fs.readFileSync(localPointer, "utf8");
  writeFile(legacyPointer, pointerBody);
  fs.unlinkSync(localPointer);

  const runtime = await fixture.manager.resolve();

  assert.equal(runtime.root, fixture.installedPath);
  assert.deepEqual(JSON.parse(fs.readFileSync(localPointer, "utf8")), JSON.parse(pointerBody));
  assert.equal(fs.readFileSync(legacyPointer, "utf8"), pointerBody);
});

test("resolve fails closed when the selected asset omits its internal manifest binding", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  delete fixture.asset.internalManifestSha256;
  const { EmbeddingRuntimeManager } = await loadManagerModule();
  const manager = new EmbeddingRuntimeManager({
    paths: fixture.paths,
    platform: fixture.asset.platform,
    getAsset: () => fixture.asset,
  });
  await assert.rejects(manager.resolve(), /EMBEDDING_RUNTIME_MANIFEST_BINDING_MISSING/);
});

test("resolved runtime revalidation catches node, manifest, module, and native replacement", async (t) => {
  const mutations = [
    ["node", (fixture) => fs.appendFileSync(fixture.executablePath, "tampered")],
    ["manifest", (fixture) => fs.appendFileSync(fixture.manifestPath, " ")],
    ["module", (fixture) => fs.appendFileSync(path.join(fixture.moduleRoot, "@huggingface", "transformers", "package.json"), " ")],
    ["native", (fixture) => fs.appendFileSync(path.join(fixture.nativeRoot, "onnxruntime_binding.node"), "tampered")],
  ];
  for (const [label, mutate] of mutations) {
    const fixture = await withFixture(t);
    const runtime = await fixture.manager.resolve();
    mutate(fixture);
    await assert.rejects(
      runtime.revalidate(),
      /EMBEDDING_RUNTIME_(HASH_MISMATCH|VERSION_MISMATCH|MANIFEST_INVALID)/,
      `${label} replacement must invalidate the resolved runtime snapshot`,
    );
  }
});

test("manager derives canonical runtime paths from the local root and runtime Vault ID", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const { EmbeddingRuntimeManager } = await loadManagerModule();
  const manager = new EmbeddingRuntimeManager({
    localDataRoot: fixture.root,
    runtimeVaultId: "vault-v2-0123456789abcdef",
    platform: fixture.asset.platform,
    getAsset: () => fixture.asset,
  });
  assert.equal((await manager.resolve()).root, fixture.installedPath);
});

test("resolve fails closed for missing or tampered current pointers", async (t) => {
  const fixture = await withFixture(t);
  const pointerFile = path.join(fixture.paths.current, "embedding-runtime.json");
  fs.unlinkSync(pointerFile);
  await assert.rejects(fixture.manager.resolve(), /EMBEDDING_RUNTIME_NOT_INSTALLED/);

  fs.writeFileSync(pointerFile, `${JSON.stringify({ ...fixture.pointer, assetSha256: "f".repeat(64) })}\n`);
  await assert.rejects(fixture.manager.resolve(), /EMBEDDING_RUNTIME_POINTER_MISMATCH/);
});

test("resolve rejects executable and module-root symlink escapes", async (t) => {
  const executableFixture = await withFixture(t);
  const outsideNode = path.join(executableFixture.root, "outside-node");
  fs.writeFileSync(outsideNode, "outside");
  fs.unlinkSync(executableFixture.executablePath);
  fs.symlinkSync(outsideNode, executableFixture.executablePath);
  await assert.rejects(executableFixture.manager.resolve(), /EMBEDDING_RUNTIME_UNSAFE_PATH/);

  const moduleFixture = await withFixture(t);
  const outsideModules = path.join(moduleFixture.root, "outside-modules");
  fs.mkdirSync(outsideModules);
  fs.rmSync(moduleFixture.moduleRoot, { recursive: true, force: true });
  fs.symlinkSync(outsideModules, moduleFixture.moduleRoot);
  await assert.rejects(moduleFixture.manager.resolve(), /EMBEDDING_RUNTIME_UNSAFE_PATH/);
});

test("resolve rejects missing files, wrong dependency versions, and modified immutable files", async (t) => {
  const missingFixture = await withFixture(t);
  fs.unlinkSync(path.join(missingFixture.moduleRoot, "@huggingface", "transformers", "index.js"));
  await assert.rejects(missingFixture.manager.resolve(), /EMBEDDING_RUNTIME_FILE_INVALID/);

  const versionFixture = await withFixture(t);
  fs.writeFileSync(
    path.join(versionFixture.moduleRoot, "onnxruntime-node", "package.json"),
    "{\"name\":\"onnxruntime-node\",\"version\":\"1.25.0\"}\n",
  );
  await assert.rejects(versionFixture.manager.resolve(), /EMBEDDING_RUNTIME_VERSION_MISMATCH/);

  const tamperedFixture = await withFixture(t);
  fs.appendFileSync(path.join(tamperedFixture.packRoot, "THIRD_PARTY_NOTICES.txt"), "tampered\n");
  await assert.rejects(tamperedFixture.manager.resolve(), /EMBEDDING_RUNTIME_HASH_MISMATCH/);
});

test("resolve requires the native ONNX payload for the selected platform only", async (t) => {
  const fixture = await withFixture(t, "darwin-arm64");
  const wrongNativeRoot = path.join(
    fixture.moduleRoot,
    "onnxruntime-node",
    "bin",
    "napi-v6",
    "darwin",
    "x64",
  );
  fs.mkdirSync(wrongNativeRoot, { recursive: true });
  fs.renameSync(
    path.join(fixture.nativeRoot, "onnxruntime_binding.node"),
    path.join(wrongNativeRoot, "onnxruntime_binding.node"),
  );
  fs.renameSync(
    path.join(fixture.nativeRoot, "libonnxruntime.dylib"),
    path.join(wrongNativeRoot, "libonnxruntime.dylib"),
  );
  await assert.rejects(fixture.manager.resolve(), /EMBEDDING_RUNTIME_NATIVE_LAYOUT_INVALID/);
});

test("resolve maps the Windows runtime to its managed node.exe", async (t) => {
  const { manager, executablePath } = await withFixture(t, "win32-x64");
  const runtime = await manager.resolve();
  assert.equal(runtime.nodeExecutable, executablePath);
  assert.equal(path.basename(runtime.nodeExecutable), "node.exe");
});

test("resolve rejects an internally re-signed manifest that omits or adds runtime files", async (t) => {
  const omitted = await withFixture(t);
  const omittedManifest = JSON.parse(fs.readFileSync(omitted.manifestPath, "utf8"));
  omittedManifest.files = omittedManifest.files.filter((entry) => entry.path !== "node/bin/node");
  const omittedBody = `${JSON.stringify(omittedManifest, null, 2)}\n`;
  fs.writeFileSync(omitted.manifestPath, omittedBody);
  omitted.asset.internalManifestSha256 = sha256(Buffer.from(omittedBody));
  await assert.rejects(omitted.manager.resolve(), /EMBEDDING_RUNTIME_MANIFEST_INVALID/);

  const extra = await withFixture(t);
  fs.writeFileSync(path.join(extra.packRoot, "unreviewed-addon.js"), "module.exports = 'unreviewed';\n");
  await assert.rejects(extra.manager.resolve(), /EMBEDDING_RUNTIME_MANIFEST_INVALID/);
});

test("smokeTest runs the embedded worker on managed Node through initialize, health, embed, and dispose", async (t) => {
  const fixture = createFixture(`${process.platform}-${process.arch}`);
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const workerBuild = await esbuild.build({
    entryPoints: [path.join(extensionRoot, "src", "local-vector", "embedding-worker.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    external: ["@huggingface/transformers", "onnxruntime-node"],
    write: false,
    logLevel: "silent",
  });
  const { EmbeddingRuntimeManager } = await loadManagerModule();
  const manager = new EmbeddingRuntimeManager({
    paths: fixture.paths,
    platform: fixture.asset.platform,
    getAsset: () => fixture.asset,
    buildId: "task7-smoke-中文",
    workerBundleSource: workerBuild.outputFiles[0].text,
    smokeModelId: "fixture/model",
  });
  const result = await manager.smokeTest();
  assert.equal(result.runtimeId, fixture.asset.id);
  assert.equal(result.vectorLength, 3);
  assert.equal(result.memoryUsage.rss > 0, true);
  assert.equal(
    fs.readdirSync(fixture.paths.workerVersions, { recursive: true }).some((name) => String(name).endsWith(".cjs")),
    true,
    "the embedded worker must materialize in the user-local managed worker directory",
  );
});
