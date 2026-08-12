const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const esbuild = require("esbuild");

function waitForResponse(child, expectedId, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${expectedId}`));
    }, timeoutMs);
    const onData = (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const response = JSON.parse(line);
        if (response.id === expectedId && typeof response.ok === "boolean") {
          cleanup();
          resolve(response);
          return;
        }
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
    };
    child.stdout.on("data", onData);
  });
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-worker-env-"));
  const fakeModuleDir = path.join(
    tmpDir,
    "node_modules",
    "@huggingface",
    "transformers",
  );
  const moduleRoot = path.join(tmpDir, "node_modules");
  const fakeOnnxDir = path.join(moduleRoot, "onnxruntime-node");
  const stateFile = path.join(tmpDir, "transformers-env.json");
  const workerBundle = path.join(tmpDir, "embedding-worker.cjs");

  try {
    fs.mkdirSync(fakeModuleDir, { recursive: true });
    fs.mkdirSync(fakeOnnxDir, { recursive: true });
    fs.writeFileSync(path.join(moduleRoot, "package.json"), "{\"private\":true}\n", "utf8");
    fs.writeFileSync(path.join(fakeOnnxDir, "package.json"), "{\"name\":\"onnxruntime-node\",\"main\":\"index.js\"}\n", "utf8");
    fs.writeFileSync(path.join(fakeOnnxDir, "index.js"), "module.exports = {};\n", "utf8");
    fs.writeFileSync(
      path.join(fakeModuleDir, "index.js"),
      `
        const fs = require("fs");
        exports.env = {};
        exports.pipeline = async function pipeline() {
          fs.writeFileSync(
            process.env.ANALOGY_TEST_TRANSFORMERS_ENV,
            JSON.stringify(exports.env),
            "utf-8"
          );
          const extractor = async function extract(texts) {
            return { data: new Float32Array(texts.length), dims: [texts.length, 1] };
          };
          extractor.dispose = async function dispose() {};
          return extractor;
        };
      `,
      "utf-8",
    );

    await esbuild.build({
      entryPoints: [
        path.join(
          __dirname,
          "..",
          "src",
          "local-vector",
          "embedding-worker.ts",
        ),
      ],
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["@huggingface/transformers"],
      outfile: workerBundle,
    });

    const child = spawn(process.execPath, [workerBundle], {
      cwd: tmpDir,
      env: {
        ...process.env,
        NODE_PATH: path.join(tmpDir, "untrusted-vault-node_modules"),
        ANALOGY_RUNTIME_MODULE_ROOT: moduleRoot,
        ANALOGY_TEST_TRANSFORMERS_ENV: stateFile,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf-8");
    try {
      const responsePromise = waitForResponse(child, "init");
      child.stdin.write(`${JSON.stringify({
        id: "init",
        type: "initialize",
        modelId: "test/model",
        dtype: "q8",
        cacheDir: path.join(tmpDir, "cache"),
        modelHost: "https://hf-mirror.com/",
      })}\n`);
      const response = await responsePromise;
      assert.strictEqual(response.ok, true, response.error?.message);

      const configured = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      assert.strictEqual(configured.remoteHost, "https://hf-mirror.com/");
      assert.strictEqual(
        configured.remotePathTemplate,
        "{model}/resolve/{revision}/",
        "custom model hosts must preserve the transformers Hub path template",
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise((resolve) => child.once("close", resolve));
        child.kill("SIGTERM");
        await closed;
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  console.log("Embedding worker environment tests passed");
})();
