const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const esbuild = require("esbuild");

async function bundle(entry, outfile) {
  const source = path.join(__dirname, "..", "src", "local-vector", entry);
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: Boolean(outfile),
    ...(outfile ? { outfile } : {}),
  });
  if (outfile) return null;
  const loadedModule = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    loadedModule,
    loadedModule.exports,
    require,
  );
  return loadedModule.exports;
}

function writeModule(filename, contents) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents, "utf8");
}

function installInProcessTransformersDouble(pluginDir) {
  writeModule(path.join(pluginDir, "main.js"), "// createRequire anchor\n");
  writeModule(
    path.join(pluginDir, "node_modules", "@huggingface", "transformers", "package.json"),
    JSON.stringify({ name: "@huggingface/transformers", main: "index.js" }),
  );
  writeModule(
    path.join(pluginDir, "node_modules", "@huggingface", "transformers", "index.js"),
    `
      const state = globalThis.__embeddingModelBehaviorState;
      exports.env = { fetch: async () => new Response() };
      exports.pipeline = async (_task, modelId) => {
        state.modelIds.push(modelId);
        return async (inputs, options) => {
          state.calls.push({ inputs, options });
          const batch = Array.isArray(inputs) ? inputs.length : 1;
          return { data: new Float32Array(batch).fill(1), dims: [batch, 1] };
        };
      };
    `,
  );
}

function installWorkerRuntimeDouble(moduleRoot) {
  writeModule(path.join(moduleRoot, "package.json"), JSON.stringify({ private: true }));
  writeModule(path.join(moduleRoot, "onnxruntime-node", "index.js"), "module.exports = {};\n");
  writeModule(
    path.join(moduleRoot, "@huggingface", "transformers", "index.js"),
    `
      exports.env = {};
      exports.pipeline = async () => async (texts, options) => {
        const values = { mean: 1, cls: 2, last_token: 3 };
        const value = values[options.pooling] || 0;
        return {
          data: new Float32Array(texts.length).fill(value),
          dims: [texts.length, 1],
        };
      };
    `,
  );
}

function runWorker(workerPath, moduleRoot, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], {
      env: { ...process.env, ANALOGY_RUNTIME_MODULE_ROOT: moduleRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`worker exited ${code}: ${stderr}`));
        return;
      }
      resolve(stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    });
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
  });
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-model-behavior-"));
  globalThis.__embeddingModelBehaviorState = { modelIds: [], calls: [] };

  try {
    const { EMBEDDING_MODELS, LocalEmbeddingService } = await bundle("embedding.ts");

    const graniteMultilingual = EMBEDDING_MODELS["granite-97m-multilingual-r2"];
    assert(graniteMultilingual, "Granite 97M multilingual must be selectable");
    assert.strictEqual(graniteMultilingual.id, "onnx-community/granite-embedding-97m-multilingual-r2-ONNX");
    assert.strictEqual(graniteMultilingual.pooling, "cls");

    const graniteEnglish = EMBEDDING_MODELS["granite-small-english-r2"];
    assert(graniteEnglish, "Granite 47M English must be selectable");
    assert.strictEqual(graniteEnglish.id, "onnx-community/granite-embedding-small-english-r2-ONNX");
    assert.strictEqual(graniteEnglish.pooling, "cls");
    assert.strictEqual(EMBEDDING_MODELS["jina-nano"].pooling, "last_token");

    const gemma = EMBEDDING_MODELS["embedding-gemma-300m"];
    assert.strictEqual(gemma.queryPrefix, "task: search result | query: ");
    assert.strictEqual(gemma.documentPrefix, "title: none | text: ");

    const pluginDir = path.join(tmpDir, "plugin");
    installInProcessTransformersDouble(pluginDir);
    const service = new LocalEmbeddingService({
      pluginDir,
      cacheDir: path.join(tmpDir, "cache"),
      modelConfig: gemma,
    });
    await service.initialize();
    await service.embedQuery("planets");
    await service.embedDocument("Mars is red");
    assert.deepStrictEqual(
      globalThis.__embeddingModelBehaviorState.calls.map((call) => call.inputs),
      ["task: search result | query: planets", "title: none | text: Mars is red"],
      "query and document prompts must reach the model intact",
    );
    assert.deepStrictEqual(
      globalThis.__embeddingModelBehaviorState.calls.map((call) => call.options.pooling),
      [gemma.pooling, gemma.pooling],
      "in-process inference must use the configured pooling strategy",
    );

    const workerPath = path.join(tmpDir, "embedding-worker.cjs");
    const moduleRoot = path.join(tmpDir, "runtime", "node_modules");
    await bundle("embedding-worker.ts", workerPath);
    installWorkerRuntimeDouble(moduleRoot);
    const responses = await runWorker(workerPath, moduleRoot, [
      {
        id: "init",
        type: "initialize",
        modelId: graniteMultilingual.id,
        dtype: graniteMultilingual.dtype,
        pooling: graniteMultilingual.pooling,
        cacheDir: path.join(tmpDir, "worker-cache"),
      },
      { id: "embed", type: "embed", texts: ["你好", "hello"] },
    ]);
    const embedResponse = responses.find((response) => response.id === "embed");
    assert.deepStrictEqual(
      embedResponse.embeddings,
      [[2], [2]],
      "worker inference must use CLS pooling received during initialization",
    );
  } finally {
    delete globalThis.__embeddingModelBehaviorState;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("Embedding model behavior test passed");
})();
