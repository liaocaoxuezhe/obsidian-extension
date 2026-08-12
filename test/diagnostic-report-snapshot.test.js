const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");

async function loadModule(entry) {
  const source = path.join(__dirname, "..", "src", "diagnostics", entry);
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    module,
    module.exports,
    require,
  );
  return module.exports;
}

async function loadReportSender() {
  const source = path.join(
    __dirname,
    "..",
    "src",
    "diagnostics",
    "diagnostic-report.ts",
  );
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    plugins: [
      {
        name: "obsidian-request-test-double",
        setup(build) {
          build.onResolve({ filter: /^obsidian$/ }, () => ({
            path: "obsidian",
            namespace: "request-double",
          }));
          build.onLoad({ filter: /.*/, namespace: "request-double" }, () => ({
            loader: "js",
            contents: `
              exports.requestUrl = async function(options) {
                globalThis.__diagnosticRequestBody = options.body;
                return {
                  status: 200,
                  json: {
                    code: 0,
                    data: {
                      report_id: "AR-1",
                      fingerprint: "ERR-1",
                      received_at: "2026-07-26T00:00:01.000Z"
                    }
                  },
                  text: ""
                };
              };
            `,
          }));
        },
      },
    ],
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    module,
    module.exports,
    require,
  );
  return module.exports;
}

function makeReport(reportId) {
  return {
    schema_version: 1,
    report_id: reportId,
    reporter_id: "reporter",
    created_at: "2026-07-26T00:00:00.000Z",
    plugin: { version: "1.1.6", build_id: "1.1.6+test.1" },
    host: {
      obsidian_version: "1.12.7",
      platform: "darwin",
      arch: "arm64",
      locale: "zh",
    },
    runtime: {
      model: "test-model",
      transformers_version: "4.2.0",
      onnxruntime_version: "1.26.0",
      chroma_version: "1.8.1",
    },
    session: {
      suspected_unclean_exit: false,
      last_stage: "plugin.onload",
      safe_mode: true,
    },
    events: [
      {
        id: "event-1",
        timestamp: "2026-07-26T00:00:00.000Z",
        level: "error",
        stage: "embedding.inference",
        code: "worker.failed",
        message: "worker failed",
      },
    ],
    user_note: "用户备注",
  };
}

(async () => {
  const { DiagnosticReportSnapshot } = await loadModule(
    "diagnostic-report-snapshot.ts",
  );
  const snapshot = new DiagnosticReportSnapshot();
  assert.strictEqual(snapshot.get(), null);

  const sourceReport = makeReport("report-one");
  const storedReport = snapshot.replace(sourceReport);
  const previewJson = snapshot.serialize();
  const copyJson = snapshot.serialize();
  const saveJson = snapshot.serialize();
  const sendJson = snapshot.serialize();

  assert.strictEqual(snapshot.get(), storedReport, "snapshot returns one stable object");
  assert.strictEqual(copyJson, previewJson, "copy uses the preview payload");
  assert.strictEqual(saveJson, previewJson, "save uses the preview payload");
  assert.strictEqual(sendJson, previewJson, "send uses the preview payload");

  sourceReport.events.push({
    id: "late-event",
    timestamp: "2026-07-26T00:01:00.000Z",
    level: "info",
    stage: "plugin.onload",
    code: "late",
    message: "late mutation",
  });
  assert.strictEqual(
    snapshot.serialize(),
    previewJson,
    "mutating the recorder result after preview must not alter the snapshot",
  );

  snapshot.invalidate();
  assert.strictEqual(snapshot.get(), null);
  assert.strictEqual(snapshot.serialize(), null);

  const nextReport = snapshot.replace(makeReport("report-two"));
  assert.strictEqual(nextReport.report_id, "report-two");
  assert.notStrictEqual(snapshot.serialize(), previewJson);

  const { sendDiagnosticReport } = await loadReportSender();
  const serializedForSend = snapshot.serialize();
  await sendDiagnosticReport(nextReport, {
    endpoint: "https://example.invalid/diagnostics",
    serializedReport: serializedForSend,
  });
  assert.strictEqual(
    globalThis.__diagnosticRequestBody,
    serializedForSend,
    "the network body must be exactly the serialized preview payload",
  );
  delete globalThis.__diagnosticRequestBody;

  console.log("Diagnostic report snapshot tests passed");
})();
