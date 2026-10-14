"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const loaded = new Map();
function loadTypeScriptFile(filename) {
  if (loaded.has(filename)) return loaded.get(filename);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  loaded.set(filename, module.exports);
  const localRequire = (specifier) => {
    if (!specifier.startsWith(".")) return require(specifier);
    const resolved = path.resolve(path.dirname(filename), specifier);
    return fs.existsSync(`${resolved}.ts`) ? loadTypeScriptFile(`${resolved}.ts`) : require(resolved);
  };
  Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports, localRequire, module, filename, path.dirname(filename),
  );
  loaded.set(filename, module.exports);
  return module.exports;
}

const tiers = () => loadTypeScriptFile(path.join(process.cwd(), "src/local-vector/model-tiers.ts"));
const manifest = () => loadTypeScriptFile(path.join(process.cwd(), "src/local-vector/model-file-manifest.ts"));

test("download sizes come from the exact pinned file manifest", () => {
  const { modelDownloadBytes, modelTierInfo } = tiers();
  const { MODEL_FILE_MANIFESTS } = manifest();
  for (const [key, entry] of Object.entries(MODEL_FILE_MANIFESTS)) {
    assert.equal(modelDownloadBytes(key), entry.files.reduce((sum, file) => sum + file.size, 0), key);
  }
  assert.equal(modelDownloadBytes("unknown-model"), null);
  assert.equal(modelTierInfo("bge-small-en-v1.5").heavy, false);
  assert.equal(modelTierInfo("embedding-gemma-300m").heavy, true);
  assert.equal(modelTierInfo("jina-nano").heavy, true);
  assert.equal(modelTierInfo("granite-97m-multilingual-r2").heavy, false);
});

test("memory estimate is calibrated on the measured jina-nano worker (about 1.06 GB)", () => {
  const { estimatedModelMemoryBytes } = tiers();
  const jina = estimatedModelMemoryBytes("jina-nano");
  assert.ok(Math.abs(jina - 1.06e9) / 1.06e9 < 0.1, `jina-nano estimate ${jina}`);
  assert.ok(estimatedModelMemoryBytes("bge-small-en-v1.5") < 400e6);
  assert.ok(estimatedModelMemoryBytes("embedding-gemma-300m") > estimatedModelMemoryBytes("granite-97m-multilingual-r2"));
});

test("low-memory devices do not see 200M+ models unless one is already selected", () => {
  const { selectableModelKeys } = tiers();
  const lowMemory = selectableModelKeys(4, "bge-small-en-v1.5");
  assert.equal(lowMemory.includes("embedding-gemma-300m"), false);
  assert.equal(lowMemory.includes("jina-nano"), false);
  assert.ok(lowMemory.includes("granite-97m-multilingual-r2"));
  assert.ok(selectableModelKeys(4, "jina-nano").includes("jina-nano"), "the current choice is never hidden");
  assert.ok(selectableModelKeys(16, "bge-small-en-v1.5").includes("jina-nano"));
  assert.ok(selectableModelKeys(null, "bge-small-en-v1.5").includes("jina-nano"), "unknown memory hides nothing");
});

test("switching to a heavy or large model requires confirmation", () => {
  const { requiresSwitchConfirmation } = tiers();
  assert.equal(requiresSwitchConfirmation("embedding-gemma-300m"), true);
  assert.equal(requiresSwitchConfirmation("jina-nano"), true);
  assert.equal(requiresSwitchConfirmation("granite-97m-multilingual-r2"), true, "123 MB download");
  assert.equal(requiresSwitchConfirmation("bge-small-zh"), false);
});

test("Chinese-first vaults get the multilingual default; mixed or English vaults keep the small default", () => {
  const { cjkRatio, recommendDefaultModel, scriptCounts } = tiers();
  const chinese = "今天读了一本关于知识管理的书，作者认为卡片笔记的关键在于建立联系。".repeat(10);
  const english = "Today I read a book about personal knowledge management and linking notes. ".repeat(10);
  assert.ok(cjkRatio([chinese]) > 0.9);
  assert.ok(cjkRatio([english]) < 0.05);
  assert.equal(cjkRatio(["短"]), null, "tiny samples give no signal");
  assert.equal(recommendDefaultModel(cjkRatio([chinese, english]), 16), "granite-97m-multilingual-r2");
  assert.equal(recommendDefaultModel(cjkRatio([english]), 16), "bge-small-en-v1.5");
  assert.equal(recommendDefaultModel(null, 16), "bge-small-en-v1.5");
  assert.equal(recommendDefaultModel(0.8, 4), "granite-97m-multilingual-r2", "the multilingual default is not heavy");
  // Code, links and front matter do not count as English prose.
  const counts = scriptCounts("---\ntags: [a, b]\n---\n中文内容\n```js\nconst value = 1;\n```\n[链接](https://example.com/path)");
  assert.equal(counts.latin, 0);
  assert.equal(counts.cjk, 6);
});
