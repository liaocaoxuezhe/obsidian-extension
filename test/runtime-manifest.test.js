"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const loadedTypeScriptModules = new Map();

function loadTypeScriptFile(filename) {
  if (loadedTypeScriptModules.has(filename)) return loadedTypeScriptModules.get(filename);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  loadedTypeScriptModules.set(filename, module.exports);
  const localRequire = (specifier) => {
    if (!specifier.startsWith(".")) return require(specifier);
    const resolved = path.resolve(path.dirname(filename), specifier);
    return fs.existsSync(`${resolved}.ts`) ? loadTypeScriptFile(`${resolved}.ts`) : require(resolved);
  };
  Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports,
    localRequire,
    module,
    filename,
    path.dirname(filename),
  );
  loadedTypeScriptModules.set(filename, module.exports);
  return module.exports;
}

function loadTypeScriptModule(relativePath) {
  return loadTypeScriptFile(path.join(process.cwd(), relativePath));
}

test("runtime manifest supplies exactly one verified asset of each kind for every supported platform", () => {
  const { RUNTIME_MANIFEST, getRuntimeAsset } = loadTypeScriptModule("src/runtime/runtime-manifest.ts");
  const chromaAssets = {
    "darwin-arm64": {
      fileName: "chroma-macos-arm64",
      url: "https://github.com/chroma-core/chroma/releases/download/cli-1.4.4/chroma-macos-arm64",
      size: 60527064,
      sha256: "3daa51a58f3792092e53b1a2ab574478665d07868fbd6cd6730a60a1794663e5",
    },
    "darwin-x64": {
      fileName: "chroma-macos-intel",
      url: "https://github.com/chroma-core/chroma/releases/download/cli-1.4.4/chroma-macos-intel",
      size: 63304056,
      sha256: "cdd321ef684e6b86226faae4023c7b07a68ec1363460cecf9ac3ce5a843cff57",
    },
    "win32-x64": {
      fileName: "chroma-windows.exe",
      url: "https://github.com/chroma-core/chroma/releases/download/cli-1.4.4/chroma-windows.exe",
      size: 55364096,
      sha256: "8697d3f5f55c4f982c6e114ac01cf006daa0c68d87e791d9b5558b8670f89d05",
    },
  };
  const embeddingPlatforms = RUNTIME_MANIFEST.assets
    .filter((asset) => asset.kind === "embedding-runtime")
    .map((asset) => asset.platform);
  const platforms = [...new Set(embeddingPlatforms)].sort();

  assert.equal(RUNTIME_MANIFEST.schemaVersion, 1);
  assert.deepEqual(platforms, ["darwin-arm64", "win32-x64"]);
  for (const platform of platforms) {
    const assets = RUNTIME_MANIFEST.assets.filter((asset) => asset.platform === platform);
    assert.equal(assets.filter((asset) => asset.kind === "chroma").length, 1);
    assert.equal(assets.filter((asset) => asset.kind === "embedding-runtime").length, 1);
    for (const asset of assets) {
      assert.match(asset.url, /^https:\/\//);
      assert.ok(asset.size > 0);
      assert.match(asset.sha256, /^[0-9a-f]{64}$/);
      assert.ok(!asset.fileName.includes(".."));
      assert.ok(!asset.executableRelativePath.includes(".."));
    }
    assert.deepEqual(getRuntimeAsset("chroma", platform), {
      id: `chroma-cli-1.4.4-${platform}`,
      kind: "chroma",
      platform,
      version: "cli-1.4.4",
      archive: "none",
      executableRelativePath: chromaAssets[platform].fileName,
      licenseName: "Apache-2.0",
      licenseUrl: "https://github.com/chroma-core/chroma/blob/cli-1.4.4/LICENSE",
      source: "published",
      ...chromaAssets[platform],
    });
    assert.equal(getRuntimeAsset("embedding-runtime", platform).platform, platform);
  }
});

test("checked-in embedding inputs are published and point at the public repository", () => {
  const { getRuntimeAsset } = loadTypeScriptModule("src/runtime/runtime-manifest.ts");

  const published = getRuntimeAsset("embedding-runtime", "darwin-arm64");
  assert.equal(published.source, "published");
  assert.match(published.url, /^https:\/\/github\.com\/liaocaoxuezhe\/obsidian-extension\/releases\//);
  assert.deepEqual(published.runtimeVersions, {
    node: "22.23.2",
    transformers: "4.2.0",
    onnxruntime: "1.26.0",
  });
});

test("versioned history registry starts honestly empty and resolver combines active with retained bindings", () => {
  const {
    createRuntimeHistoryAssetResolver,
    RUNTIME_HISTORY_BINDING_REGISTRY,
    RUNTIME_MANIFEST,
  } = loadTypeScriptModule("src/runtime/runtime-manifest.ts");
  assert.deepEqual(RUNTIME_HISTORY_BINDING_REGISTRY, { schemaVersion: 1, retained: [] });

  const retained = {
    id: "chroma-retained-test-fixture-darwin-arm64",
    kind: "chroma",
    platform: "darwin-arm64",
    sha256: "c".repeat(64),
  };
  const resolve = createRuntimeHistoryAssetResolver(
    RUNTIME_MANIFEST,
    { schemaVersion: 1, retained: [retained] },
    "darwin-arm64",
  );
  const current = RUNTIME_MANIFEST.assets.find((asset) => (
    asset.kind === "chroma" && asset.platform === "darwin-arm64"
  ));
  assert.deepEqual(resolve("chroma", current.id), { id: current.id, sha256: current.sha256 });
  assert.deepEqual(resolve("chroma", retained.id), { id: retained.id, sha256: retained.sha256 });
  assert.equal(resolve("chroma", "unknown"), null);

  assert.throws(() => createRuntimeHistoryAssetResolver(
    RUNTIME_MANIFEST,
    { schemaVersion: 1, retained: [{ ...current, sha256: "f".repeat(64) }] },
    "darwin-arm64",
  ), /RUNTIME_HISTORY_REGISTRY_CONFLICT/);
});

test("runtime paths stay under the user-local root and reject vault ID traversal", () => {
  const { createRuntimePaths, resolveAnalogyLocalDataRoot } = loadTypeScriptModule("src/runtime/runtime-paths.ts");
  const macRoot = resolveAnalogyLocalDataRoot("darwin", {}, "/Users/analogy");
  const windowsRoot = resolveAnalogyLocalDataRoot("win32", { LOCALAPPDATA: "C:\\Users\\analogy\\AppData\\Local" }, "C:\\Users\\analogy");
  const fallbackWindowsRoot = resolveAnalogyLocalDataRoot("win32", {}, "C:\\Users\\analogy");
  const root = "/Users/analogy/Library/Application Support/Analogy";
  const paths = createRuntimePaths(root, "vault-v2-0123456789abcdef");
  const windowsPaths = createRuntimePaths("C:\\Users\\analogy\\AppData\\Local\\Analogy", "vault-v2-0123456789abcdef");
  const fixtureVault = "/Users/analogy/测试 Vault/.obsidian/plugins/analogy";

  assert.equal(macRoot, root);
  assert.equal(windowsRoot, "C:\\Users\\analogy\\AppData\\Local\\Analogy");
  assert.equal(fallbackWindowsRoot, "C:\\Users\\analogy\\AppData\\Local\\Analogy");
  for (const [key, value] of Object.entries(paths)) {
    if (key === "runtimeVaultId") continue;
    assert.ok(value === root || value.startsWith(`${root}/`));
    assert.ok(!value.startsWith(fixtureVault));
  }
  assert.equal(paths.vaultRoot, `${root}/vaults/vault-v2-0123456789abcdef`);
  assert.equal(paths.chromaDataV2, `${paths.vaultRoot}/chroma_data_v2`);
  for (const vaultPath of [paths.current, paths.chromaProcessLease, paths.onboardingState, paths.runtimeState, paths.chromaDataV2]) {
    assert.ok(!path.posix.relative(paths.vaultRoot, vaultPath).startsWith(".."));
  }
  for (const [key, value] of Object.entries(windowsPaths)) {
    if (key === "runtimeVaultId") continue;
    assert.ok(value === windowsPaths.root || value.startsWith(`${windowsPaths.root}\\`));
  }
  for (const vaultPath of [windowsPaths.current, windowsPaths.chromaProcessLease, windowsPaths.onboardingState, windowsPaths.runtimeState, windowsPaths.chromaDataV2]) {
    assert.ok(!path.win32.relative(windowsPaths.vaultRoot, vaultPath).startsWith(".."));
  }
  assert.throws(() => createRuntimePaths(root, "vault-v2-0123456789abcdef/../../escape"), /INVALID_RUNTIME_VAULT_ID/);
});
