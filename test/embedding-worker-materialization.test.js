const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const esbuild = require("esbuild");

async function loadWorkerClient() {
  const entry = path.join(
    __dirname,
    "..",
    "src",
    "local-vector",
    "embedding-worker-client.ts",
  );
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const loadedModule = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    loadedModule,
    loadedModule.exports,
    require,
  );
  return loadedModule.exports;
}

(async () => {
  const { EmbeddingWorkerClient } = await loadWorkerClient();
  const pluginDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "analogy-worker-materialization-"),
  );
  const workerSource = "'use strict';\nprocess.stdin.resume();\n";

  try {
    const workerDir = path.join(pluginDir, "worker");
    fs.mkdirSync(workerDir, { recursive: true });
    for (let index = 0; index < 3; index += 1) {
      const oldWorker = path.join(
        workerDir,
        `embedding-worker-old-${index}.cjs`,
      );
      fs.writeFileSync(oldWorker, `// old worker ${index}\n`, "utf8");
      const timestamp = new Date(Date.now() - (index + 2) * 10_000);
      fs.utimesSync(oldWorker, timestamp, timestamp);
    }

    const client = new EmbeddingWorkerClient({
      pluginDir,
      buildId: "1.1.8+materialization-test",
      workerBundleSource: workerSource,
      execPath: process.execPath,
    });

    const materializedPath = await client.ensureMaterialized();
    assert.match(
      path.basename(materializedPath),
      /^embedding-worker-1\.1\.8\+materialization-test-[a-f0-9]{12}\.cjs$/,
    );
    assert.strictEqual(
      fs.readFileSync(materializedPath, "utf8"),
      workerSource,
      "the materialized worker must exactly match the embedded source",
    );

    const reusedPath = await client.ensureMaterialized();
    assert.strictEqual(
      reusedPath,
      materializedPath,
      "the same build must reuse its materialized worker",
    );

    const workerFiles = fs
      .readdirSync(workerDir)
      .filter(
        (file) =>
          file.startsWith("embedding-worker-") && file.endsWith(".cjs"),
      );
    assert.ok(
      workerFiles.length <= 2,
      `worker cleanup must keep at most two bundles, found ${workerFiles.length}`,
    );
    assert.ok(workerFiles.includes(path.basename(materializedPath)));

    const unsafeBuildClient = new EmbeddingWorkerClient({
      pluginDir,
      buildId: "1.1.8/unsafe\\build",
      workerBundleSource: `${workerSource}// distinct source\n`,
      execPath: process.execPath,
    });
    const safePath = await unsafeBuildClient.ensureMaterialized();
    assert.strictEqual(
      path.dirname(safePath),
      workerDir,
      "build metadata must not escape the worker cache directory",
    );
    assert.match(
      path.basename(safePath),
      /^embedding-worker-1\.1\.8_unsafe_build-[a-f0-9]{12}\.cjs$/,
      "worker filenames must use a safe build identifier and content hash",
    );
  } finally {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }

  console.log("Embedding worker materialization test passed");
})();
