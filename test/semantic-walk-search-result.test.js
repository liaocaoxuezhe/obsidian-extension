const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");

async function loadModule(relativeSource, obsidian = {}) {
  const source = path.join(__dirname, "..", "src", "local-vector", relativeSource);
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
  fn(module, module.exports, (id) => id === "obsidian" ? obsidian : require(id));
  return module.exports;
}

(async () => {
  const { LocalVectorStore } = await loadModule("vector-store.ts");
  const store = new LocalVectorStore();
  store.collectionId = "collection";
  const requests = [];
  store.requestJson = async (_method, _url, body) => {
    requests.push(body);
    return {
      ids: [["Note.md::chunk-1"]],
      documents: [["匹配段落"]],
      distances: [[0.125]],
      metadatas: [[{
        doc_id: "Note.md",
        path: "Note.md",
        title: "Note.md",
        chunk_index: 1,
        chunk_count: 3,
        section_label: "主题 > 细节",
        mtime: 1000,
      }]],
    };
  };
  const rawResults = await store.search([0.1]);
  assert.deepStrictEqual(rawResults[0], {
    chunkId: "Note.md::chunk-1",
    content: "匹配段落",
    distance: 0.125,
    score: 0.125,
    metadata: {
      doc_id: "Note.md",
      path: "Note.md",
      title: "Note.md",
      chunk_index: 1,
      chunk_count: 3,
      section_label: "主题 > 细节",
      mtime: 1000,
    },
  });

  await store.upsertDocument("Note.md", [{
    chunkId: "Note.md::chunk-1",
    content: "匹配段落",
    embedding: [0.1],
    chunkIndex: 1,
    chunkCount: 3,
    sectionLabel: "主题 > 细节",
  }], { title: "Note.md", path: "Note.md", mtime: 1000 });
  assert.deepStrictEqual(requests[1].metadatas, [{
    title: "Note.md",
    path: "Note.md",
    mtime: 1000,
    doc_id: "Note.md",
    chunk_index: 1,
    chunk_count: 3,
    section_label: "主题 > 细节",
  }]);

  const { LocalSemanticSearch } = await loadModule("search.ts", { TFile: class TFile {} });
  const search = new LocalSemanticSearch(
    { embedQuery: async () => [0.1] },
    { search: async () => rawResults },
  );
  const [result] = await search.searchByQuery("查询", 1);
  assert.deepStrictEqual(result, {
    chunkId: "Note.md::chunk-1",
    docId: "Note.md",
    path: "Note.md",
    title: "Note.md",
    content: "匹配段落",
    chunkIndex: 1,
    chunkCount: 3,
    sectionLabel: "主题 > 细节",
    mtime: 1000,
    distance: 0.125,
    source: "local",
    score: 0.125,
  });

  const { DocumentIndexer } = await loadModule("document-indexer.ts", {
    TFile: class TFile {},
    Notice: class Notice {},
  });
  const upserts = [];
  const indexer = new DocumentIndexer(
    { embedBatch: async (texts) => texts.map(() => [0.1]) },
    { upsertDocument: async (...args) => upserts.push(args), deleteDocument: async () => {} },
    { adapter: { read: async () => "# 主题\n足够长的第一段文本。\n\n## 细节\n足够长的第二段文本。" } },
    { load: async () => undefined, save: async () => {} },
  );
  await indexer.indexDocument({
    path: "Note.md", name: "Note.md", extension: "md", stat: { mtime: 1000, ctime: 500, size: 100 },
  });
  const indexedChunks = upserts.flatMap(([, chunks]) => chunks);
  assert.deepStrictEqual(indexedChunks.map((chunk) => ({
    chunkId: chunk.chunkId,
    chunkIndex: chunk.chunkIndex,
    chunkCount: chunk.chunkCount,
    sectionLabel: chunk.sectionLabel,
  })), [
    { chunkId: "Note.md::chunk-0", chunkIndex: 0, chunkCount: 2, sectionLabel: "主题" },
    { chunkId: "Note.md::chunk-1", chunkIndex: 1, chunkCount: 2, sectionLabel: "主题 > 细节" },
  ]);

  console.log("Semantic walk search result tests passed");
})().catch((err) => {
  console.error("Semantic walk search result tests FAILED:", err);
  process.exit(1);
});
