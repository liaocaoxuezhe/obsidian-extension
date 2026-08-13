const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");

async function loadModule(relativeSource) {
  const source = path.join(__dirname, "..", "src", relativeSource);
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

(async () => {
  const { labelSimilarityBands } = await loadModule("semantic-walk/similarity.ts");
  const labelled = labelSimilarityBands([
    { chunkId: "fourth", distance: 0.4 },
    { chunkId: "first", distance: 0.1 },
    { chunkId: "third", distance: 0.3 },
    { chunkId: "second", distance: 0.2 },
  ]);
  assert.deepStrictEqual(labelled, [
    { chunkId: "first", distance: 0.1, relationBand: "strong" },
    { chunkId: "second", distance: 0.2, relationBand: "related" },
    { chunkId: "third", distance: 0.3, relationBand: "related" },
    { chunkId: "fourth", distance: 0.4, relationBand: "exploratory" },
  ]);

  assert.deepStrictEqual(labelSimilarityBands([{ chunkId: "only", distance: 0.1 }]), [
    { chunkId: "only", distance: 0.1, relationBand: "strong" },
  ]);
  assert.deepStrictEqual(labelSimilarityBands([
    { chunkId: "near", distance: 0.1 },
    { chunkId: "far", distance: 0.2 },
  ]), [
    { chunkId: "near", distance: 0.1, relationBand: "strong" },
    { chunkId: "far", distance: 0.2, relationBand: "exploratory" },
  ]);
  assert.ok(labelled.every((result) => !Object.prototype.hasOwnProperty.call(result, "percentage")));
  assert.ok(!JSON.stringify(labelled).includes("%"));

  console.log("Semantic walk similarity tests passed");
})().catch((err) => {
  console.error("Semantic walk similarity tests FAILED:", err);
  process.exit(1);
});
