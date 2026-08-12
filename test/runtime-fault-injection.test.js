"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const extensionRoot = process.cwd();
const loaded = new Map();

function loadTypeScriptFile(filename) {
  if (loaded.has(filename)) return loaded.get(filename);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}, fileName: filename,
  }).outputText;
  const module = {exports: {}};
  loaded.set(filename, module.exports);
  const localRequire = (specifier) => {
    if (!specifier.startsWith(".")) return require(specifier);
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

function coded(code) {
  return Object.assign(new Error(code), {code});
}

test("runtime fault matrix maps every injected failure to a bounded onboarding error", () => {
  const {classifyOnboardingError} = loadTypeScriptFile(path.join(
    extensionRoot, "src/onboarding/onboarding-coordinator.ts",
  ));
  const cases = [
    ["connection interruption", "ECONNRESET", "downloading-chroma", "DOWNLOAD_NETWORK_ERROR", "retry"],
    ["wrong content length", "DOWNLOAD_INVALID_CONTENT_LENGTH", "downloading-chroma", "DOWNLOAD_SIZE_MISMATCH", "redownload"],
    ["hash tampering", "DOWNLOAD_HASH_MISMATCH", "verifying-chroma", "DOWNLOAD_HASH_MISMATCH", "redownload"],
    ["disk write failure", "ENOSPC", "installing-chroma", "INSUFFICIENT_DISK_SPACE", "retry"],
    ["staging rename failure", "EXDEV", "installing-embedding-runtime", "RUNTIME_EXTRACT_FAILED", "retry"],
    ["Chroma exits immediately", "CHROMA_EXITED", "starting-chroma", "CHROMA_EXITED", "retry"],
    ["port occupied", "CHROMA_PORT_CONFLICT", "starting-chroma", "CHROMA_PORT_CONFLICT", "change-port"],
    ["worker native load failure", "ERR_DLOPEN_FAILED", "warming-up-model", "EMBEDDING_MODEL_WARMUP_FAILED", "retry"],
  ];
  for (const [label, injected, stage, expected, action] of cases) {
    const result = classifyOnboardingError(coded(injected), stage);
    assert.equal(result.code, expected, label);
    assert.equal(result.action, action, label);
    assert.equal(result.recoverable, true, label);
    assert.ok(result.technicalMessage.length <= 160, label);
    assert.equal(result.technicalMessage.includes("/"), false, label);
  }
});

test("every persisted setup stage resumes explicitly without an automatic retry loop", () => {
  const {recommendedActionForSnapshot} = loadTypeScriptFile(path.join(
    extensionRoot, "src/onboarding/onboarding-types.ts",
  ));
  const resumable = [
    "checking", "downloading-chroma", "verifying-chroma", "installing-chroma",
    "downloading-embedding-runtime", "verifying-embedding-runtime", "installing-embedding-runtime",
    "starting-chroma", "downloading-embedding-model", "warming-up-model",
    "selecting-index-scope", "building-quick-index",
  ];
  for (const stage of resumable) {
    const action = recommendedActionForSnapshot({
      schemaVersion: 1, stage, progress: null, completedBytes: null, totalBytes: null,
      currentItem: "", runtimePlatform: "darwin-arm64", chromaRuntimeId: null,
      embeddingRuntimeId: null, selectedIndexScope: null, startedAt: 1, updatedAt: 2,
      completedAt: null, dismissedAt: null, error: null,
    });
    assert.equal(action, "resume", stage);
  }
  assert.equal(recommendedActionForSnapshot({
    schemaVersion: 1, stage: "failed", progress: null, completedBytes: null, totalBytes: null,
    currentItem: "", runtimePlatform: "darwin-arm64", chromaRuntimeId: null,
    embeddingRuntimeId: null, selectedIndexScope: null, startedAt: 1, updatedAt: 2,
    completedAt: null, dismissedAt: null, error: null,
  }), "repair", "failures wait for an explicit repair action");
});

test("release workflow gates publication on every supported native runner and public redownload verification", () => {
  const workflow = fs.readFileSync(path.join(
    process.cwd(), ".github/workflows/obsidian-runtime-matrix.yml",
  ), "utf8");
  for (const required of [
    "macos-14", "windows-2025", "node-version: 22.23.2", "run-native-runtime-smoke.mjs",
    "cosign attest-blob", "id-token: write", "needs: [native-runtime]",
    "gh release download", "prepare-release.mjs --runtime-only --runtime-staging redownload",
    "npm run test:runtime",
  ]) assert.ok(workflow.includes(required), required);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/);

  const pkg = JSON.parse(fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["test:runtime"], "node scripts/verify-test-execution-set.mjs && node scripts/run-runtime-tests.mjs");
  assert.equal(pkg.scripts["test:plugin"], "node scripts/run-public-tests.mjs");
});
