const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");

async function loadModule(source) {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, "..", "src", source)],
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

function chunk(id, docId, index, embedding) {
  return {
    id,
    document: `${id} 的内容`,
    metadata: {
      doc_id: docId,
      path: `${docId}.md`,
      title: docId,
      mtime: "123",
      ...(index === undefined ? {} : { chunk_index: index }),
      chunk_count: 3,
      section_label: "主题",
    },
    embedding,
  };
}

function chromaGetResponse(entries, nested) {
  const field = (name) => entries.map((entry) => entry[name]);
  const response = {
    ids: field("id"),
    documents: field("document"),
    metadatas: field("metadata"),
    embeddings: field("embedding"),
  };
  return nested ? Object.fromEntries(Object.entries(response).map(([key, value]) => [key, [value]])) : response;
}

(async () => {
  const { LocalVectorStore } = await loadModule("local-vector/vector-store.ts");
  const store = new LocalVectorStore();
  store.collectionId = "collection";
  const requests = [];
  store.requestJson = async (method, url, body) => {
    requests.push({ method, url, body });
    return chromaGetResponse([chunk("Note.md::chunk-0", "Note", 0, [0.1])], false);
  };
  const fetched = await store.getChunks({ ids: ["Note.md::chunk-0"], includeEmbedding: true });
  assert.deepStrictEqual(fetched.ids, ["Note.md::chunk-0"]);
  assert.deepStrictEqual(requests[0], {
    method: "POST",
    url: "/api/v2/tenants/default_tenant/databases/default_database/collections/collection/get",
    body: {
      ids: ["Note.md::chunk-0"],
      include: ["documents", "metadatas", "embeddings"],
    },
  });
  store.apiVersion = "v1";
  store.requestJson = async (method, url, body) => {
    requests.push({ method, url, body });
    return chromaGetResponse([chunk("Legacy.md::chunk-0", "Legacy", 0, [0.1])], true);
  };
  const v1Fetched = await store.getChunks({ where: { doc_id: "Legacy" } });
  assert.deepStrictEqual(v1Fetched.ids, [["Legacy.md::chunk-0"]]);
  assert.deepStrictEqual(requests[1], {
    method: "POST",
    url: "/api/v2/tenants/default_tenant/databases/default_database/collections/collection/get",
    body: {
      where: { doc_id: "Legacy" },
      include: ["documents", "metadatas"],
    },
  });

  const { ChromaChunkRepository } = await loadModule("semantic-walk/chunk-repository.ts");
  let unboundedGetCalls = 0;
  const pagedEntries = [{
    docId: "LargeVault",
    path: "LargeVault.md",
    mtime: 123,
    chunkCount: 60_203,
    needsReindex: true,
  }];
  const largeVaultRepository = new ChromaChunkRepository({
    getChunks: async () => {
      unboundedGetCalls++;
      throw new Error("UNBOUNDED_CHROMA_GET");
    },
    listIndexedDocumentEntries: async () => pagedEntries,
  });
  assert.deepStrictEqual(
    await largeVaultRepository.listIndexedDocuments(),
    pagedEntries,
    "大仓库文档列表必须复用 LocalVectorStore 的分页元数据读取",
  );
  assert.strictEqual(unboundedGetCalls, 0, "文档列表不得对整个 collection 发起无 limit 的 /get");

  const flatEntries = [
    chunk("Guide.md::chunk-2", "Guide", 2, [0.2]),
    chunk("Guide.md::chunk-0", "Guide", 0, [0.0]),
    chunk("Guide.md::chunk-1", "Guide", 1, [0.1]),
  ];
  const flatStore = {
    listIndexedDocumentEntries: async () => [{
      docId: "Guide", path: "Guide.md", mtime: 123, chunkCount: 3,
    }],
    getChunks: async (options) => chromaGetResponse(
      flatEntries.filter((entry) =>
        (!options.ids || options.ids.includes(entry.id))
        && (!options.where || entry.metadata.doc_id === options.where.doc_id)),
      false,
    ),
  };
  const repository = new ChromaChunkRepository(flatStore);
  const listed = await repository.listChunksByDocument("Guide");
  assert.deepStrictEqual(listed.map((entry) => entry.chunkId), [
    "Guide.md::chunk-0",
    "Guide.md::chunk-1",
    "Guide.md::chunk-2",
  ]);
  assert.strictEqual((await repository.getChunk("Guide.md::chunk-1", true)).embedding[0], 0.1);
  assert.deepStrictEqual(await repository.listIndexedDocuments(), [{
    docId: "Guide",
    path: "Guide.md",
    mtime: 123,
    chunkCount: 3,
  }]);

  const legacyEntries = [
    {
      id: "Legacy.md::chunk-10",
      document: "\n  旧索引标题十  \n正文",
      metadata: { doc_id: "Legacy", path: "Legacy.md", title: "Legacy", mtime: "123" },
      embedding: [1],
    },
    {
      id: "Legacy.md::chunk-2",
      document: "旧索引标题二\n正文",
      metadata: { doc_id: "Legacy", path: "Legacy.md", title: "Legacy", mtime: "123" },
      embedding: [2],
    },
  ];
  const legacyRepository = new ChromaChunkRepository({
    listIndexedDocumentEntries: async () => [],
    getChunks: async () => chromaGetResponse(legacyEntries, true),
  });
  const legacyChunks = await legacyRepository.listChunksByDocument("Legacy");
  assert.deepStrictEqual(legacyChunks.map((entry) => entry.chunkIndex), [2, 10]);
  assert.deepStrictEqual(legacyChunks.map((entry) => entry.chunkCount), [2, 2], "旧索引 chunkCount 必须由文档实际结果数推导");
  assert.deepStrictEqual(legacyChunks.map((entry) => entry.sectionLabel), ["旧索引标题二", "旧索引标题十"]);
  assert.ok(legacyChunks.every((entry) => entry.needsReindex === true), "元数据不完整的旧 chunk 必须暴露重建索引提示标记");

  const randomStore = {
    listIndexedDocumentEntries: async () => [
      { docId: "Long", path: "Long.md", mtime: 123, chunkCount: 2 },
      { docId: "Short", path: "Short.md", mtime: 123, chunkCount: 2 },
    ],
    getChunks: async (options) => {
      if (options.where) return chromaGetResponse([
        chunk("Short.md::chunk-0", "Short", 0, [0]),
        chunk("Short.md::chunk-1", "Short", 1, [1]),
      ], true);
      return chromaGetResponse([
        chunk("Long.md::chunk-0", "Long", 0, [0]),
        chunk("Long.md::chunk-1", "Long", 1, [1]),
        chunk("Short.md::chunk-0", "Short", 0, [2]),
        chunk("Short.md::chunk-1", "Short", 1, [3]),
      ], true);
    },
  };
  const originalRandom = Math.random;
  const randomDraws = [0.9, 0.9];
  Math.random = () => randomDraws.shift() ?? 0;
  try {
    const randomChunk = await new ChromaChunkRepository(randomStore).getRandomChunk();
    assert.strictEqual(randomChunk.docId, "Short");
    assert.strictEqual(randomChunk.chunkId, "Short.md::chunk-1");
    assert.strictEqual(randomDraws.length, 0, "第二次随机抽样必须实际用于所选文档的 chunk 选择");
  } finally {
    Math.random = originalRandom;
  }

  console.log("Semantic walk chunk repository tests passed");
})().catch((err) => {
  console.error("Semantic walk chunk repository tests FAILED:", err);
  process.exit(1);
});
