const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const esbuild = require("esbuild");

async function loadModule(entry) {
  const source = path.join(__dirname, "..", "src", "diagnostics", entry);
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    external: ["obsidian"],
    define: {
      // Recorder uses window.setTimeout for debouncing.
      window: "globalThis",
    },
  });
  const module = { exports: {} };
  const fn = new Function("module", "exports", "require", result.outputFiles[0].text);
  fn(module, module.exports, require);
  return module.exports;
}

(async () => {
  const { DiagnosticRecorder } = await loadModule("diagnostic-recorder.ts");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-diag-"));

  globalThis.window = globalThis;
  globalThis.document = {};

  const recorder = new DiagnosticRecorder({
    pluginDir: tmpDir,
    pluginVersion: "1.1.6",
    buildId: "1.1.6+abc1234.42",
    obsidianVersion: "1.12.7",
    platform: "darwin",
    arch: "arm64",
    locale: "zh",
    model: "bge-small-en-v1.5",
  });

  await recorder.initialize();

  assert.strictEqual(recorder.getMarker().status, "running", "marker should be running after init");
  assert.strictEqual(recorder.isSuspectedUncleanExit(), false, "first session should not be unclean");
  assert(fs.existsSync(path.join(tmpDir, "diagnostics")), "diagnostics dir should be created");

  recorder.info("plugin.onload", "plugin.onload.start", "start");
  recorder.warn("chroma.start", "chroma.start.delay", "delayed");
  recorder.captureException("embedding.model-load", "embedding.load.failed", new Error("ONNX failed"));
  assert.strictEqual(
    typeof recorder.error,
    "function",
    "recorder must expose the error-level API used by worker lifecycle logging",
  );
  recorder.error("embedding.worker-start", "worker.process.exit", "worker exited");

  assert.strictEqual(recorder.getEvents().length, 4, "events should be recorded");
  assert.strictEqual(
    recorder.getEvents().at(-1).level,
    "error",
    "worker exit logging must create an error-level diagnostic event",
  );

  // Simulate clean exit and new session
  await recorder.markCleanExit();

  const markerPath = path.join(tmpDir, "diagnostics", "session.json");
  assert(fs.existsSync(markerPath), "session marker file should be persisted after clean exit");
  const savedMarker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
  assert.strictEqual(savedMarker.status, "clean-exit", "saved marker should be clean-exit");

  const recorder2 = new DiagnosticRecorder({
    pluginDir: tmpDir,
    pluginVersion: "1.1.6",
    buildId: "1.1.6+abc1234.42",
    obsidianVersion: "1.12.7",
    platform: "darwin",
    arch: "arm64",
    locale: "zh",
    model: "bge-small-en-v1.5",
  });
  await recorder2.initialize();
  assert.strictEqual(recorder2.isSuspectedUncleanExit(), false, "clean exit should not be unclean");

  // Simulate unclean exit: do not mark clean, create new recorder
  const recorder3 = new DiagnosticRecorder({
    pluginDir: tmpDir,
    pluginVersion: "1.1.6",
    buildId: "1.1.6+abc1234.42",
    obsidianVersion: "1.12.7",
    platform: "darwin",
    arch: "arm64",
    locale: "zh",
    model: "bge-small-en-v1.5",
  });
  await recorder3.initialize();
  assert.strictEqual(recorder3.isSuspectedUncleanExit(), true, "running marker without clean exit is unclean");

  // Ring capacity should not exceed 200
  for (let i = 0; i < 250; i++) {
    recorder3.info("index.chunk", `chunk.${i}`, `chunk ${i}`);
  }
  assert.ok(recorder3.getEvents().length <= 200, "ring should not exceed capacity");

  // Build report
  const report = recorder3.buildReport({
    obsidianVersion: "1.12.7",
    platform: "darwin",
    arch: "arm64",
    locale: "zh",
    model: "bge-small-en-v1.5",
    transformersVersion: "4.2.0",
    onnxruntimeVersion: "1.26.0",
    chromaVersion: "1.8.1",
  });
  assert.strictEqual(report.schema_version, 1, "report schema version should be 1");
  assert.strictEqual(report.plugin.version, "1.1.6", "report plugin version");
  assert.strictEqual(report.session.suspected_unclean_exit, true, "report should flag unclean exit");
  assert.ok(report.events.length > 0, "report should include events");

  const chunkBodySentinel = "SEMANTIC_WALK_CHUNK_BODY_绝不能进入报告";
  const querySentinel = "SEMANTIC_WALK_QUERY_绝不能进入报告";
  const vectorSentinel = 987654.321987;
  assert.strictEqual(
    typeof recorder3.recordSemanticWalkExpand,
    "function",
    "recorder must expose an allowlisted semantic-walk diagnostic API",
  );
  recorder3.recordSemanticWalkExpand({
    chunkId: "Private/机密笔记.md::chunk-7",
    stage: "start",
    durationMs: 0,
    candidateCount: 0,
    model: "jina-nano",
    usedEmbeddingFallback: false,
    distanceRange: "none",
    errorCategory: "none",
    chunkContent: chunkBodySentinel,
    query: querySentinel,
    embedding: [0.1, vectorSentinel, 0.3],
    path: `Private/${chunkBodySentinel}.md`,
  });
  recorder3.recordSemanticWalkExpand({
    chunkId: "Private/机密笔记.md::chunk-7",
    stage: "fallback",
    durationMs: 3,
    candidateCount: 0,
    model: "jina-nano",
    usedEmbeddingFallback: true,
    distanceRange: "none",
    errorCategory: "none",
  });
  recorder3.recordSemanticWalkExpand({
    chunkId: "Private/机密笔记.md::chunk-7",
    stage: "success",
    durationMs: 12,
    candidateCount: 4,
    model: "jina-nano",
    usedEmbeddingFallback: true,
    distanceRange: "0.1023..0.8842",
    errorCategory: "none",
  });
  const semanticReport = recorder3.buildReport({
    obsidianVersion: "1.12.7",
    platform: "darwin",
    arch: "arm64",
    locale: "zh",
    model: "jina-nano",
    transformersVersion: "4.2.0",
    onnxruntimeVersion: "1.26.0",
    chromaVersion: "1.8.1",
  });
  const semanticSerialized = JSON.stringify(semanticReport);
  for (const forbidden of [chunkBodySentinel, querySentinel, String(vectorSentinel), "Private/机密笔记.md"]) {
    assert.ok(!semanticSerialized.includes(forbidden), `semantic-walk report must not contain ${forbidden}`);
  }
  const semanticEvents = semanticReport.events.filter((event) => event.stage === "semantic-walk.expand");
  assert.deepStrictEqual(semanticEvents.map((event) => event.code), [
    "semantic-walk.expand.start",
    "semantic-walk.expand.fallback",
    "semantic-walk.expand.success",
  ]);
  const allowedSemanticKeys = [
    "candidateCount",
    "chunkId",
    "distanceRange",
    "durationMs",
    "errorCategory",
    "model",
    "stage",
    "usedEmbeddingFallback",
  ];
  for (const event of semanticEvents) {
    assert.deepStrictEqual(Object.keys(event.context || {}).sort(), allowedSemanticKeys, "semantic-walk context must use an exact allowlist");
    assert.match(event.context.chunkId, /^chunk:[a-f0-9]{8}$/, "chunk identity must be hashed before diagnostics persistence");
  }
  recorder3.recordSemanticWalkExpand({
    chunkId: "Clamp::chunk-0",
    stage: "success",
    durationMs: Number.MAX_SAFE_INTEGER,
    candidateCount: Number.MAX_SAFE_INTEGER,
    model: "jina-nano",
    usedEmbeddingFallback: false,
    distanceRange: `${"9".repeat(80)}..${"8".repeat(80)}`,
    errorCategory: "none",
  });
  const clampedEvent = recorder3.getEvents().at(-1);
  assert.strictEqual(clampedEvent.context.durationMs, 86_400_000, "semantic duration must be clamped to one day");
  assert.strictEqual(clampedEvent.context.candidateCount, 40, "semantic candidate count must be clamped to the 40-result query pool");
  assert.strictEqual(clampedEvent.context.distanceRange, "none", "oversized distanceRange must be rejected");

  const limitedDir = path.join(tmpDir, "limited");
  const limitedRecorder = new DiagnosticRecorder({
    pluginDir: limitedDir,
    pluginVersion: "1.1.6",
    buildId: "1.1.6+abc1234.42",
    obsidianVersion: "1.12.7",
    platform: "darwin",
    arch: "arm64",
    locale: "zh",
    model: "bge-small-en-v1.5",
    maxSnapshotBytes: 8 * 1024,
  });
  await limitedRecorder.initialize();
  limitedRecorder.captureException(
    "embedding.inference",
    "embedding.critical",
    new Error(`必须保留的关键错误，读取失败 ${limitedDir}/机密项目.md`),
  );
  for (let i = 0; i < 100; i++) {
    limitedRecorder.info(
      "index.chunk",
      `index.verbose.${i}`,
      `普通中文诊断消息 ${i} ${"中".repeat(600)}`,
    );
  }
  await limitedRecorder.flush();

  const limitedRingPath = path.join(limitedDir, "diagnostics", "ring-buffer.json");
  const limitedRingBytes = fs.readFileSync(limitedRingPath).byteLength;
  assert.ok(
    limitedRingBytes <= 8 * 1024,
    `persisted snapshot must stay within 8KB, got ${limitedRingBytes}`,
  );
  const limitedEvents = JSON.parse(fs.readFileSync(limitedRingPath, "utf-8")).events;
  assert.ok(
    limitedEvents.some((event) => event.code === "embedding.critical"),
    "the most recent error must survive snapshot eviction",
  );

  const sensitiveNote = [
    "/Users/alice/PrivateVault/机密项目.md",
    "C:\\Users\\alice\\Notes\\secret.md",
    "user@example.com",
    "ANALOGY-PRO-1234567890",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
  ].join(" ");
  const reportOptions = {
    obsidianVersion: "1.12.7",
    platform: "darwin",
    arch: "arm64",
    locale: "zh",
    model: "bge-small-en-v1.5",
    transformersVersion: "4.2.0",
    onnxruntimeVersion: "1.26.0",
    chromaVersion: "1.8.1",
    safeMode: true,
    userNote: sensitiveNote,
  };
  const limitedReport1 = limitedRecorder.buildReport(reportOptions);
  const limitedReport2 = limitedRecorder.buildReport(reportOptions);
  const serializedReport = JSON.stringify(limitedReport1);
  for (const secret of [
    "/Users/alice",
    "C:\\Users\\alice",
    "user@example.com",
    "ANALOGY-PRO-1234567890",
    "abcdefghijklmnopqrstuvwxyz",
  ]) {
    assert.ok(!serializedReport.includes(secret), `report must redact ${secret}`);
  }
  assert.strictEqual(limitedReport1.session.safe_mode, true);
  const fileId1 = serializedReport.match(/<file:([a-f0-9]{8})>/)?.[1];
  const fileId2 = JSON.stringify(limitedReport2).match(/<file:([a-f0-9]{8})>/)?.[1];
  assert.ok(fileId1 && fileId2, "reports should contain anonymous file IDs");
  assert.notStrictEqual(
    fileId1,
    fileId2,
    "the same local file ID must be re-salted for each report",
  );

  // Clear diagnostics
  await recorder3.clearDiagnostics();
  assert.strictEqual(recorder3.getEvents().length, 0, "events cleared");

  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log("Diagnostic recorder and session marker tests passed");
})();
