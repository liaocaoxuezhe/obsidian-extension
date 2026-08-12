const assert = require("assert");
const path = require("path");
const esbuild = require("../node_modules/esbuild");

async function loadModule() {
  const source = path.join(__dirname, "..", "src", "local-vector", "search.ts");
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["obsidian"],
    write: false,
  });
  const module = { exports: {} };
  const fn = new Function("module", "exports", "require", result.outputFiles[0].text);
  const testRequire = (id) => {
    if (id === "obsidian") {
      return { TFile: class TFile {} };
    }
    return require(id);
  };
  fn(module, module.exports, testRequire);
  return module.exports;
}

(async () => {
  const { LocalSemanticSearch } = await loadModule();
  const embeddedDocuments = [];
  let summarizeCalls = 0;
  const embedding = {
    isReady: () => true,
    embedDocument: async (text) => {
      embeddedDocuments.push(text);
      return [0.5, 0.5];
    },
    embedQuery: async () => [1, 0],
  };
  const vectorStore = {
    search: async () => [
      {
        content: "matched original chunk",
        score: 0.9,
        metadata: { title: "Match", path: "match.md" },
      },
    ],
  };
  const summarizer = {
    summarize: async (text, filePath) => {
      summarizeCalls++;
      assert.match(text, /原文内容/);
      assert.strictEqual(filePath, "note.md");
      return { text: "这是用于匹配的文章摘要，不写入 Chroma。", usedSummary: true };
    },
  };
  const search = new LocalSemanticSearch(embedding, vectorStore, 512, summarizer);
  const file = {
    path: "note.md",
    vault: { adapter: { read: async () => "# 标题\n原文内容很长，用来生成摘要。" } },
  };

  const contentResponse = await search.searchByDocumentWithQueryText(file, 5);

  assert.strictEqual(summarizeCalls, 0);
  assert.deepStrictEqual(embeddedDocuments, ["标题\n原文内容很长，用来生成摘要。"]);
  assert.strictEqual(contentResponse.queryText, undefined);
  assert.strictEqual(contentResponse.results[0].content, "matched original chunk");

  const summaryResponse = await search.searchByDocumentWithQueryText(file, 5, { useSummary: true });

  assert.strictEqual(summarizeCalls, 1);
  assert.deepStrictEqual(embeddedDocuments, [
    "标题\n原文内容很长，用来生成摘要。",
    "这是用于匹配的文章摘要，不写入 Chroma。",
  ]);
  assert.strictEqual(summaryResponse.queryText, "这是用于匹配的文章摘要，不写入 Chroma。");
  assert.strictEqual(summaryResponse.results[0].content, "matched original chunk");

  console.log("Search by document summary query test passed");
})();
