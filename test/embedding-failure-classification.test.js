"use strict";

const assert = require("node:assert/strict");
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
    external: ["obsidian", "electron"],
    write: false,
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", "__filename", result.outputFiles[0].text)(
    module, module.exports, require, __filename,
  );
  return module.exports;
}

const WINDOWS_DLOPEN = "The specified module could not be found.\r\n\\\\?\\C:\\Users\\张三\\AppData\\Local\\Analogy\\runtime\\embedding\\x\\node_modules\\onnxruntime-node\\bin\\napi-v6\\win32\\x64\\onnxruntime_binding.node";

test("worker failures map to their real cause with path-free evidence", async () => {
  const { classifyEmbeddingFailure } = await loadModule("local-vector/embedding-failure.ts");
  const native = classifyEmbeddingFailure(WINDOWS_DLOPEN, "native-load", ["ERR_DLOPEN_FAILED"]);
  assert.equal(native.code, "EMBEDDING_NATIVE_LOAD_FAILED");
  assert.equal(native.subStage, "native-load");
  assert.deepEqual(native.evidence, ["ERR_DLOPEN_FAILED", "onnxruntime_binding.node"]);
  assert.doesNotMatch(native.evidence.join(" "), /Users|张三|\\\\|\//);

  assert.equal(classifyEmbeddingFailure("std::bad_alloc", "session-build").code, "EMBEDDING_MODEL_OOM");
  const network = classifyEmbeddingFailure("fetch failed: getaddrinfo ENOTFOUND hf-mirror.com", "model-download");
  assert.equal(network.code, "EMBEDDING_MODEL_NETWORK_FAILED");
  assert.ok(network.evidence.includes("ENOTFOUND"));
  assert.equal(classifyEmbeddingFailure("Protobuf parsing failed.", "session-build").code, "EMBEDDING_MODEL_CACHE_CORRUPT");
  assert.equal(classifyEmbeddingFailure("file was not found locally at \"/Users/a/config.json\"", "session-build").code,
    "EMBEDDING_MODEL_CACHE_CORRUPT");
  assert.equal(classifyEmbeddingFailure("spawn EACCES", "worker-start", ["EACCES"]).code, "RUNTIME_EXECUTION_BLOCKED");
  assert.equal(classifyEmbeddingFailure("something odd", "session-build").code, "EMBEDDING_MODEL_WARMUP_FAILED");
});

test("unexpected worker exits are classified from signal, exit code and stderr", async () => {
  const { classifyWorkerExit } = await loadModule("local-vector/embedding-failure.ts");
  const killed = classifyWorkerExit(null, "SIGKILL", "", "session-build");
  assert.equal(killed.code, "EMBEDDING_WORKER_CRASHED");
  assert.deepEqual(killed.evidence, ["SIGKILL"]);
  assert.equal(classifyWorkerExit(134, null, "terminate called after throwing an instance of 'std::bad_alloc'", "session-build").code,
    "EMBEDDING_MODEL_OOM");
  assert.equal(classifyWorkerExit(3221225501, null, "", "native-load").code, "EMBEDDING_NATIVE_LOAD_FAILED");
});

test("onboarding errors keep the sub-stage and only allowlisted evidence", async () => {
  const { classifyOnboardingError } = await loadModule("onboarding/onboarding-coordinator.ts");
  const { classifyEmbeddingFailure, embeddingFailureError } = await loadModule("local-vector/embedding-failure.ts");
  const workerError = embeddingFailureError(
    classifyEmbeddingFailure(WINDOWS_DLOPEN, "native-load", ["ERR_DLOPEN_FAILED"]),
    WINDOWS_DLOPEN,
  );
  const wrapped = Object.assign(new Error("EMBEDDING_NATIVE_LOAD_FAILED"), {
    code: "EMBEDDING_NATIVE_LOAD_FAILED",
    cause: workerError,
  });
  const classified = classifyOnboardingError(wrapped, "downloading-embedding-model");
  assert.equal(classified.code, "EMBEDDING_NATIVE_LOAD_FAILED");
  assert.equal(classified.subStage, "native-load");
  assert.equal(classified.technicalMessage, "EMBEDDING_NATIVE_LOAD_FAILED native-load ERR_DLOPEN_FAILED onnxruntime_binding.node");
  assert.ok(classified.technicalMessage.length <= 160);
  assert.doesNotMatch(classified.technicalMessage, /\/|\\|Users|张三/);

  const network = classifyOnboardingError(Object.assign(new Error("x"), { code: "ECONNRESET" }), "downloading-embedding-runtime");
  assert.equal(network.code, "DOWNLOAD_NETWORK_ERROR");
  assert.equal(network.technicalMessage, "DOWNLOAD_NETWORK_ERROR ECONNRESET");
  assert.equal(network.subStage, null);
});

test("EmbeddingService keeps classified worker causes and collapses unknown ones", async () => {
  const { EmbeddingServiceError } = await loadModule("local-vector/embedding-service.ts");
  const classified = EmbeddingServiceError.fromWorkerFailure(Object.assign(new Error("oom"), {
    code: "EMBEDDING_MODEL_OOM", subStage: "session-build", evidence: ["bad_alloc"],
  }), "Embedding worker initialization failed: oom");
  assert.equal(classified.code, "EMBEDDING_MODEL_OOM");
  assert.equal(classified.subStage, "session-build");
  assert.deepEqual(classified.evidence, ["bad_alloc"]);
  assert.equal(EmbeddingServiceError.fromWorkerFailure(new Error("init failed"), "x").code, "EMBEDDING_WORKER_FAILED");
});

test("persisted onboarding errors keep safe technical lines and drop unsafe ones", async (t) => {
  const { OnboardingStore } = await loadModule("onboarding/onboarding-store.ts");
  const { createRuntimePaths } = await loadModule("runtime/runtime-paths.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-p0-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = createRuntimePaths(root, "vault-v2-0123456789abcdef");
  const store = new OnboardingStore({ paths });
  const base = (await store.load()).snapshot;
  const error = {
    code: "EMBEDDING_NATIVE_LOAD_FAILED", stage: "verifying-embedding-native", subStage: "native-load",
    userMessageKey: "onboarding.error.embedding_native_load_failed",
    technicalMessage: "EMBEDDING_NATIVE_LOAD_FAILED native-load ERR_DLOPEN_FAILED onnxruntime_binding.node",
    recoverable: true, action: "retry",
  };
  await store.save({ ...base, stage: "failed", error });
  await store.flush?.();
  let loaded = (await new OnboardingStore({ paths }).load()).snapshot;
  assert.equal(loaded.error.technicalMessage, error.technicalMessage);
  assert.equal(loaded.error.subStage, "native-load");

  await store.save({ ...base, stage: "failed", error: { ...error, subStage: "elsewhere",
    technicalMessage: "EMBEDDING_NATIVE_LOAD_FAILED /Users/alice/secret port 8000" } });
  await store.flush?.();
  loaded = (await new OnboardingStore({ paths }).load()).snapshot;
  assert.equal(loaded.error.technicalMessage, "EMBEDDING_NATIVE_LOAD_FAILED");
  assert.equal(loaded.error.subStage, undefined);
});

test("the native probe reports blocked launches, native failures and success", async () => {
  const { runNativeProbe } = await loadModule("runtime/native-probe.ts");
  const fake = (stdout, error = null, stderr = "") => (file, args, options, callback) => {
    assert.equal(args[0], "-e");
    assert.equal(options.env.ANALOGY_RUNTIME_MODULE_ROOT, "/runtime/node_modules");
    setImmediate(() => callback(error, stdout, stderr));
  };
  const input = { nodeExecutable: "/runtime/node", moduleRoot: "/runtime/node_modules" };
  await runNativeProbe({ ...input, execFileImpl: fake("{\"ok\":true}\n") });
  await assert.rejects(runNativeProbe({ ...input, execFileImpl: fake(
    JSON.stringify({ ok: false, stage: "native-load", code: "ERR_DLOPEN_FAILED", message: WINDOWS_DLOPEN }),
  ) }), (error) => error.code === "EMBEDDING_NATIVE_LOAD_FAILED" && error.subStage === "native-load"
    && error.evidence.includes("onnxruntime_binding.node"));
  await assert.rejects(runNativeProbe({ ...input, execFileImpl: fake(
    "", Object.assign(new Error("spawn /runtime/node ENOENT"), { code: "ENOENT" }),
  ) }), (error) => error.code === "RUNTIME_EXECUTION_BLOCKED" && error.evidence.includes("ENOENT"));
  await assert.rejects(runNativeProbe({ ...input, execFileImpl: fake(
    "", Object.assign(new Error("spawn EACCES"), { code: "EACCES" }),
  ) }), (error) => error.code === "RUNTIME_EXECUTION_BLOCKED" && error.subStage === "worker-start");
});
