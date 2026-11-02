"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadTypeScriptFile(filename) {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports, require, module, filename, path.dirname(filename),
  );
  return module.exports;
}

const { loadSentenceEmbeddingModel } = loadTypeScriptFile(
  path.join(process.cwd(), "src/local-vector/sentence-embedding-model.ts"),
);

class FakeTensor {
  constructor(type, data, dims) {
    Object.assign(this, { type, data, dims });
  }
}

function fakeRuntime(cacheDir) {
  const calls = { tokenizerIds: [], graphs: [], feeds: [], released: 0 };
  const tokenizer = (texts) => {
    const length = Math.max(...texts.map((text) => text.length));
    const ids = texts.flatMap((text) => Array.from({ length }, (_, i) => BigInt(i < text.length ? 2 : 0)));
    const mask = texts.flatMap((text) => Array.from({ length }, (_, i) => BigInt(i < text.length ? 1 : 0)));
    return {
      input_ids: { data: ids, dims: [texts.length, length] },
      attention_mask: { data: mask, dims: [texts.length, length] },
    };
  };
  const transformers = {
    AutoTokenizer: {
      async from_pretrained(id, options) {
        calls.tokenizerIds.push([id, options]);
        return tokenizer;
      },
    },
  };
  const ort = {
    Tensor: FakeTensor,
    InferenceSession: {
      async create(file) {
        calls.graphs.push(path.relative(cacheDir, file));
        return {
          inputNames: ["input_ids", "attention_mask", "image_features", "audio_features"],
          async run(feeds) {
            calls.feeds.push(feeds);
            const batch = feeds.input_ids.dims[0];
            const data = new Float32Array(batch * 2);
            for (let i = 0; i < batch; i++) data.set([3 * (i + 1), 4 * (i + 1)], i * 2);
            return { sentence_embedding: { data, dims: [batch, 2] } };
          },
          async release() {
            calls.released++;
          },
        };
      },
    },
  };
  return { calls, transformers, ort };
}

test("sentence-embedding models run the text graph only and return unit vectors", async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-sentence-embedding-"));
  const modelDir = path.join(cacheDir, "onnx-community", "embeddinggemma-2-ONNX");
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(modelDir, "config.json"), JSON.stringify({ text_config: { hidden_size: 512 } }), "utf8");
  const { calls, transformers, ort } = fakeRuntime(cacheDir);

  const extractor = await loadSentenceEmbeddingModel(
    transformers, ort, cacheDir, "onnx-community/embeddinggemma-2-ONNX", "q8",
  );
  const output = await extractor(["火星", "Mars is red"]);

  assert.deepEqual(calls.tokenizerIds, [["onnx-community/embeddinggemma-2-ONNX", { local_files_only: true }]]);
  assert.deepEqual(calls.graphs, [path.join("onnx-community", "embeddinggemma-2-ONNX", "onnx", "model_quantized.onnx")]);
  const feeds = calls.feeds[0];
  assert.equal(feeds.input_ids.type, "int64");
  assert.ok(feeds.input_ids.data instanceof BigInt64Array);
  assert.deepEqual(feeds.attention_mask.dims, [2, 11]);
  for (const name of ["image_features", "audio_features"]) {
    assert.equal(feeds[name].type, "float32");
    assert.deepEqual(feeds[name].dims, [0, 512], `${name} stays empty so no other encoder runs`);
  }
  assert.deepEqual(output.dims, [2, 2]);
  assert.deepEqual(Array.from(output.data, (value) => Number(value.toFixed(6))), [0.6, 0.8, 0.6, 0.8]);

  await extractor.dispose();
  assert.equal(calls.released, 1);
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test("unsupported dtypes fail before anything is loaded", async () => {
  const { calls, transformers, ort } = fakeRuntime(os.tmpdir());
  await assert.rejects(
    loadSentenceEmbeddingModel(transformers, ort, os.tmpdir(), "onnx-community/embeddinggemma-2-ONNX", "q2"),
    /Unsupported dtype/,
  );
  assert.equal(calls.graphs.length, 0);
});
