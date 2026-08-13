"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const esbuild = require("esbuild");
const path = require("node:path");
const test = require("node:test");

const extensionRoot = process.cwd();

async function loadModule(source, notices = []) {
  const result = await esbuild.build({
    entryPoints: [path.join(extensionRoot, source)],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["obsidian"],
    write: false,
  });
  const module = { exports: {} };
  Function("module", "exports", "require", result.outputFiles[0].text)(
    module,
    module.exports,
    (specifier) => specifier === "obsidian"
      ? {
          TFile: class TFile {},
          Notice: class Notice {
            constructor(message) {
              notices.push(message);
            }
          },
        }
      : require(specifier),
  );
  return module.exports;
}

function file(filePath, mtime = 1_000, extension) {
  return {
    path: filePath,
    name: filePath.replace(/\\/g, "/").split("/").at(-1),
    extension: extension ?? filePath.split(".").at(-1),
    stat: { mtime, ctime: 500, size: 100 },
  };
}

async function settlesWithin(promise, timeoutMs = 500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("maintenance timeout")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function fakeIndexer(options = {}) {
  const statuses = options.statuses ?? new Map();
  return {
    buildDocId: (candidate) => candidate.path,
    isExcluded: (candidate) => options.excluded?.has(candidate.path) ?? false,
    getAllFileStatuses: (files) => files.map((candidate) => ({
      path: candidate.path,
      name: candidate.name,
      status: statuses.get(candidate.path) ?? "unindexed",
      mtime: candidate.stat.mtime,
      chunkCount: 0,
      muted: false,
    })),
    indexFiles: options.indexFiles ?? (async (files, batchOptions) => {
      const outcomes = [];
      for (let index = 0; index < files.length; index++) {
        const candidate = files[index];
        outcomes.push({ path: candidate.path, status: "indexed", chunkCount: 1 });
        batchOptions?.onProgress?.({
          current: index + 1,
          total: files.length,
          currentFileName: candidate.name,
        });
      }
      return {
        requested: files.length,
        indexed: files.length,
        skipped: 0,
        failed: 0,
        chunkCount: files.length,
        cancelled: false,
        files: outcomes,
      };
    }),
  };
}

test("recent selection is a deterministic frozen snapshot capped at 30 across 101 Chinese files", async () => {
  const { QuickIndexCoordinator } = await loadModule("src/onboarding/quick-index-coordinator.ts");
  const chinese = Array.from({ length: 101 }, (_, index) =>
    file(`知识 库/主题 ${String(index).padStart(3, "0")}.md`, 2_000 - Math.floor(index / 2)));
  const excluded = file("私密/密码.md", 9_999);
  const nonMarkdown = file("知识 库/附件.txt", 10_000, "txt");
  const files = [...chinese].reverse().concat(excluded, nonMarkdown);
  const indexer = fakeIndexer({ excluded: new Set([excluded.path]) });
  const coordinator = new QuickIndexCoordinator({
    vault: { getFiles: () => files },
    getDocumentIndexer: async () => indexer,
    getLicenseState: () => ({ status: "active", maxPages: 500_000 }),
    hashSalt: "vault-fixture",
  });

  const selected = await coordinator.selectFiles({ type: "recent", limit: 30 });
  files.splice(0, files.length, file("后来新增.md", 99_999));

  assert.equal(selected.length, 30);
  assert.deepEqual(selected.slice(0, 4).map((candidate) => candidate.path), [
    "知识 库/主题 000.md",
    "知识 库/主题 001.md",
    "知识 库/主题 002.md",
    "知识 库/主题 003.md",
  ]);
  assert.equal(selected.some((candidate) => candidate.path === "后来新增.md"), false);
  assert.equal(selected.some((candidate) => candidate.path.includes("密码")), false);
});

test("folder selection normalizes separators and NFC while rejecting unsafe paths and prefix siblings", async () => {
  const { QuickIndexCoordinator } = await loadModule("src/onboarding/quick-index-coordinator.ts");
  const decomposed = "咖啡".normalize("NFD");
  const inside = file(`资料/${decomposed}/阅读 笔记.md`);
  const sibling = file(`资料/${decomposed}-旧/不应选中.md`);
  const coordinator = new QuickIndexCoordinator({
    vault: { getFiles: () => [sibling, inside] },
    getDocumentIndexer: async () => fakeIndexer(),
    getLicenseState: () => ({ status: "active", maxPages: 500_000 }),
    hashSalt: "folder-fixture",
  });

  const selected = await coordinator.selectFiles({ type: "folder", path: "资料\\咖啡" });
  assert.deepEqual(selected.map((candidate) => candidate.path), [inside.path]);
  for (const unsafe of ["", "../资料", "/资料", "C:\\资料", "资料//咖啡", "资料/./咖啡"]) {
    await assert.rejects(
      coordinator.selectFiles({ type: "folder", path: unsafe }),
      (error) => error.code === "QUICK_INDEX_INVALID_SCOPE"
        && error.message === "QUICK_INDEX_INVALID_SCOPE",
    );
  }
});

test("capacity reuses indexed status: updates remain eligible and blocked new files are exact skips", async () => {
  const { QuickIndexCoordinator } = await loadModule("src/onboarding/quick-index-coordinator.ts");
  const existing = file("已有.md", 2_000);
  const newFile = file("新增.md", 1_000);
  const indexer = fakeIndexer({ statuses: new Map([[existing.path, "outdated"]]) });
  const coordinator = new QuickIndexCoordinator({
    vault: { getFiles: () => [newFile, existing] },
    getDocumentIndexer: async () => indexer,
    getLicenseState: () => ({ status: "active", maxPages: 1 }),
    hashSalt: "capacity-fixture",
  });

  assert.deepEqual((await coordinator.selectFiles({ type: "vault" })).map((item) => item.path), ["已有.md"]);
  assert.deepEqual(await coordinator.run({ type: "vault" }, () => {}), {
    requested: 2,
    scopeType: "vault",
    selectedFileCount: 1,
    indexed: 1,
    skipped: 1,
    failed: 0,
    chunkCount: 1,
    selectedDocuments: [{ docId: "已有.md", path: "已有.md", mtime: 2_000 }],
  });
});

test("partial failures reject the transaction and expose only salted SHA-256 diagnostics", async () => {
  const { QuickIndexCoordinator } = await loadModule("src/onboarding/quick-index-coordinator.ts");
  const salt = "diagnostic-fixture";
  const failedPath = "机密 文件夹/失败.md";
  const diagnostics = [];
  const progress = [];
  const indexer = fakeIndexer({
    indexFiles: async (files, options) => {
      options.onProgress({ current: 1, total: 2, currentFileName: "成功.md" });
      options.onProgress({ current: 2, total: 2, currentFileName: "失败.md" });
      return {
        requested: 2, indexed: 1, skipped: 0, failed: 1, chunkCount: 3, cancelled: false,
        files: [
          { path: files[0].path, status: "indexed", chunkCount: 3 },
          { path: failedPath, status: "failed", chunkCount: 0, errorCategory: "embedding" },
        ],
      };
    },
  });
  const coordinator = new QuickIndexCoordinator({
    vault: { getFiles: () => [file("成功.md"), file(failedPath)] },
    getDocumentIndexer: async () => indexer,
    getLicenseState: () => ({ status: "active", maxPages: 500_000, licenseKey: "never-log-me" }),
    hashSalt: salt,
    recordFailure: (diagnostic) => diagnostics.push(diagnostic),
  });

  let result;
  await assert.rejects(
    coordinator.run({ type: "vault" }, (item) => progress.push(item)),
    (error) => {
      result = error.result;
      return error.code === "QUICK_INDEX_FAILED";
    },
  );
  const expectedHash = crypto.createHash("sha256").update(`${salt}\0${failedPath.normalize("NFC")}`).digest("hex");
  assert.equal(result.requested, 2);
  assert.equal(result.scopeType, "vault");
  assert.equal(result.selectedFileCount, 2);
  assert.equal(result.indexed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.chunkCount, 3);
  assert.deepEqual(progress.map(({ current, total }) => [current, total]), [[1, 2], [2, 2]]);
  assert.deepEqual(diagnostics, [{ pathHash: expectedHash, errorCategory: "embedding" }]);
  assert.equal(JSON.stringify(diagnostics).includes(failedPath), false);
  assert.equal(JSON.stringify(diagnostics).includes("never-log-me"), false);
});

test("resume reports every eligible selected file even when an existing v2 state is skipped", async () => {
  const { QuickIndexCoordinator } = await loadModule("src/onboarding/quick-index-coordinator.ts");
  const files = [file("已完成.md"), file("待继续.md")];
  const indexer = fakeIndexer({
    statuses: new Map([["已完成.md", "indexed"], ["待继续.md", "unindexed"]]),
    indexFiles: async (selected) => ({
      requested: selected.length,
      indexed: 1,
      skipped: 1,
      failed: 0,
      chunkCount: 2,
      cancelled: false,
      files: [
        { path: "已完成.md", status: "skipped", chunkCount: 1 },
        { path: "待继续.md", status: "indexed", chunkCount: 1 },
      ],
    }),
  });
  const coordinator = new QuickIndexCoordinator({
    vault: { getFiles: () => files },
    getDocumentIndexer: async () => indexer,
    getLicenseState: () => ({ status: "active", maxPages: 100 }),
    hashSalt: "resume",
  });

  const result = await coordinator.run({ type: "vault" }, () => {});

  assert.equal(result.selectedFileCount, 2);
  assert.equal(result.indexed, 1);
  assert.equal(result.skipped, 1);
});

test("DocumentIndexer cancellation settles one in-flight file, submits no later files, and flushes once", async () => {
  const { DocumentIndexer } = await loadModule("src/local-vector/document-indexer.ts");
  let releaseEmbedding;
  const embeddingGate = new Promise((resolve) => { releaseEmbedding = resolve; });
  const reads = [];
  const saves = [];
  const progress = [];
  const indexer = new DocumentIndexer(
    {
      async embedBatch(texts) { await embeddingGate; return texts.map(() => [0.25, 0.75]); },
      getInferenceCount: () => 0,
      resetSession: async () => {},
    },
    { upsertDocument: async () => {}, deleteDocument: async () => {}, listIndexedDocumentEntries: async () => [] },
    { adapter: { read: async (filePath) => { reads.push(filePath); return "足够长的中文测试内容，用来完成一次真实索引。"; } } },
    { load: async () => undefined, save: async (state) => saves.push(JSON.parse(JSON.stringify(state))) },
  );
  const controller = new AbortController();
  const running = indexer.indexFiles(
    [file("一.md"), file("二.md"), file("三.md")],
    { signal: controller.signal, onProgress: (item) => progress.push(item) },
  );
  while (reads.length === 0) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  releaseEmbedding();

  const result = await running;
  assert.equal(result.cancelled, true);
  assert.deepEqual(reads, ["一.md"]);
  assert.deepEqual(progress, [{ current: 1, total: 3, currentFileName: "一.md" }]);
  assert.equal(result.indexed, 1);
  assert.equal(result.skipped, 2);
  assert.equal(saves.length, 1, "cancel must flush the dirty state exactly once");
});

test("DocumentIndexer keeps the notice denominator fixed at the selected file count", async () => {
  const notices = [];
  const { DocumentIndexer } = await loadModule("src/local-vector/document-indexer.ts", notices);
  const indexer = new DocumentIndexer(
    {
      embedBatch: async (texts) => texts.map(() => [0.25, 0.75]),
      getInferenceCount: () => 0,
      resetSession: async () => {},
    },
    { upsertDocument: async () => {}, deleteDocument: async () => {}, listIndexedDocumentEntries: async () => [] },
    { adapter: { read: async () => "足够长的中文测试内容，用来验证批量索引进度的固定总数。" } },
    { load: async () => undefined, save: async () => {} },
  );

  await indexer.indexFiles([file("一.md"), file("二.md"), file("三.md")]);

  assert.deepEqual(notices, ["[Analogy] 索引进度: 3 / 3"]);
});

test("DocumentIndexer excludes unavailable files from the frozen notice denominator", async () => {
  const notices = [];
  const { DocumentIndexer } = await loadModule("src/local-vector/document-indexer.ts", notices);
  const indexer = new DocumentIndexer(
    {
      embedBatch: async (texts) => texts.map(() => [0.25, 0.75]),
      getInferenceCount: () => 0,
      resetSession: async () => {},
    },
    { upsertDocument: async () => {}, deleteDocument: async () => {}, listIndexedDocumentEntries: async () => [] },
    { adapter: { read: async () => "足够长的中文测试内容，用来验证文件删除后的进度完成。" } },
    { load: async () => undefined, save: async () => {} },
  );
  const disappearing = file("删除中.md");
  const available = file("仍存在.md");

  await indexer.indexFiles([disappearing, available], {
    isFileAvailable: (candidate) => candidate.path !== disappearing.path,
  });

  assert.deepEqual(notices, ["[Analogy] 索引进度: 1 / 1"]);
});

test("DocumentIndexer drains queued auto-index work before resetting batch progress", async () => {
  const notices = [];
  const { DocumentIndexer } = await loadModule("src/local-vector/document-indexer.ts", notices);
  let releaseFirstRead;
  const firstReadGate = new Promise((resolve) => { releaseFirstRead = resolve; });
  const reads = [];
  const indexer = new DocumentIndexer(
    {
      embedBatch: async (texts) => texts.map(() => [0.25, 0.75]),
      getInferenceCount: () => 0,
      resetSession: async () => {},
    },
    { upsertDocument: async () => {}, deleteDocument: async () => {}, listIndexedDocumentEntries: async () => [] },
    {
      adapter: {
        read: async (filePath) => {
          reads.push(filePath);
          if (filePath === "自动一.md") await firstReadGate;
          return "足够长的中文测试内容，用来验证自动索引与批量索引不会交叉污染。";
        },
      },
    },
    { load: async () => undefined, save: async () => {} },
  );

  const firstAuto = indexer.enqueue(file("自动一.md"));
  const secondAuto = indexer.enqueue(file("自动二.md"));
  while (reads.length === 0) await new Promise((resolve) => setImmediate(resolve));
  const batch = indexer.indexFiles([file("批次.md")]);
  releaseFirstRead();

  await settlesWithin(Promise.all([firstAuto, secondAuto, batch]), 2_000);
  assert.deepEqual(reads, ["自动一.md", "自动二.md", "批次.md"]);
  assert.deepEqual(notices, [
    "[Analogy] 索引进度: 2 / 2",
    "[Analogy] 索引进度: 1 / 1",
  ]);
});

test("a missing initialized indexer fails boundedly instead of reporting a fake ready result", async () => {
  const { QuickIndexCoordinator } = await loadModule("src/onboarding/quick-index-coordinator.ts");
  const coordinator = new QuickIndexCoordinator({
    vault: { getFiles: () => [file("文档.md")] },
    getDocumentIndexer: async () => null,
    getLicenseState: () => ({ status: "inactive", licenseKey: "never-log-me" }),
    hashSalt: "missing-indexer",
  });

  await assert.rejects(
    coordinator.run({ type: "vault" }, () => {}),
    (error) => error.code === "QUICK_INDEX_UNAVAILABLE"
      && error.message === "QUICK_INDEX_UNAVAILABLE"
      && !JSON.stringify(error).includes("never-log-me"),
  );
});

test("invalid and already-cancelled requests never initialize the production indexer", async () => {
  const { QuickIndexCoordinator } = await loadModule("src/onboarding/quick-index-coordinator.ts");
  let resolutions = 0;
  const coordinator = new QuickIndexCoordinator({
    vault: { getFiles: () => [file("文档.md")] },
    getDocumentIndexer: async () => { resolutions += 1; return fakeIndexer(); },
    getLicenseState: () => ({ status: "inactive" }),
    hashSalt: "early-rejection",
  });

  await assert.rejects(coordinator.selectFiles({ type: "folder", path: "../逃逸" }), /QUICK_INDEX_INVALID_SCOPE/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    coordinator.run({ type: "vault" }, () => {}, { signal: controller.signal }),
    /DOWNLOAD_CANCELLED/,
  );
  assert.equal(resolutions, 0);
});

test("DocumentIndexer bounds a final flush failure and releases its batch state", async () => {
  const { DocumentIndexer } = await loadModule("src/local-vector/document-indexer.ts");
  const indexer = new DocumentIndexer(
    { getInferenceCount: () => 0, resetSession: async () => {} },
    {},
    { adapter: { read: async () => "" } },
    { load: async () => undefined, save: async () => {} },
  );
  indexer.flushState = async () => { throw new Error("state store failed"); };

  await assert.rejects(
    indexer.indexFiles([]),
    (error) => error.code === "INDEXER_MAINTENANCE_FAILED"
      && error.message === "INDEXER_MAINTENANCE_FAILED",
  );
  assert.equal(indexer.getIsIndexing(), false);
});

test("DocumentIndexer rejects the triggering item before reporting maintenance success", async () => {
  const { DocumentIndexer } = await loadModule("src/local-vector/document-indexer.ts");
  for (const maintenance of ["reset", "flush"]) {
    let failMaintenance = true;
    const unhandled = [];
    const onUnhandled = (error) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    const indexer = new DocumentIndexer(
      {
        embedBatch: async (texts) => texts.map(() => [0.25, 0.75]),
        getInferenceCount: () => 300,
        resetSession: async () => {
          if (maintenance === "reset" && failMaintenance) {
            failMaintenance = false;
            throw new Error("raw reset failure");
          }
        },
      },
      { upsertDocument: async () => {}, deleteDocument: async () => {}, listIndexedDocumentEntries: async () => [] },
      { adapter: { read: async () => "足够长的中文测试内容，用来完成一次真实索引。" } },
      { load: async () => undefined, save: async () => {} },
    );
    const originalFlush = indexer.flushState.bind(indexer);
    if (maintenance === "flush") {
      indexer.flushState = async () => {
        if (failMaintenance) {
          failMaintenance = false;
          throw new Error("raw flush failure");
        }
        await originalFlush();
      };
    }

    try {
      await assert.rejects(
        settlesWithin(indexer.indexFiles([file(`${maintenance}-单文件.md`)])),
        (error) => error.code === "INDEXER_MAINTENANCE_FAILED"
          && error.message === "INDEXER_MAINTENANCE_FAILED",
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
      assert.equal(indexer.getIsIndexing(), false);
      const retry = await indexer.indexFiles([file(`${maintenance}-重试.md`)]);
      assert.equal(retry.indexed, 1);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }
});

test("DocumentIndexer rejects both the maintenance trigger and already queued remainder", async () => {
  const { DocumentIndexer } = await loadModule("src/local-vector/document-indexer.ts");
  let failReset = true;
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const indexer = new DocumentIndexer(
    {
      embedBatch: async (texts) => texts.map(() => [0.25, 0.75]),
      getInferenceCount: () => 300,
      resetSession: async () => {
        if (failReset) {
          failReset = false;
          throw new Error("raw reset failure");
        }
      },
    },
    { upsertDocument: async () => {}, deleteDocument: async () => {}, listIndexedDocumentEntries: async () => [] },
    { adapter: { read: async () => "足够长的中文测试内容，用来完成一次真实索引。" } },
    { load: async () => undefined, save: async () => {} },
  );

  try {
    const outcomes = await settlesWithin(Promise.allSettled([
      indexer.enqueue(file("触发维护.md")),
      indexer.enqueue(file("排队等待.md")),
    ]));
    assert.deepEqual(outcomes.map((outcome) => [outcome.status, outcome.reason?.code]), [
      ["rejected", "INDEXER_MAINTENANCE_FAILED"],
      ["rejected", "INDEXER_MAINTENANCE_FAILED"],
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    const retry = await indexer.indexFiles([file("维护后重试.md")]);
    assert.equal(retry.indexed, 1);
    assert.equal(indexer.getIsIndexing(), false);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("NFC-equivalent duplicate paths select deterministically when Vault order reverses", async () => {
  const { QuickIndexCoordinator } = await loadModule("src/onboarding/quick-index-coordinator.ts");
  const composed = file("资料/Café.md", 1_000);
  const decomposed = file(`资料/${"Café".normalize("NFD")}.md`, 2_000);
  const indexer = fakeIndexer();
  let files = [composed, decomposed];
  const coordinator = new QuickIndexCoordinator({
    vault: { getFiles: () => files },
    getDocumentIndexer: async () => indexer,
    getLicenseState: () => ({ status: "active", maxPages: 500_000 }),
    hashSalt: "unicode-order",
  });

  const forward = (await coordinator.selectFiles({ type: "vault" })).map((item) => item.path);
  files = [decomposed, composed];
  const reversed = (await coordinator.selectFiles({ type: "vault" })).map((item) => item.path);
  assert.deepEqual(forward, reversed);
  assert.equal(forward.length, 1);
});

test("quick index rejects any partial failure before finalize and settles the bootstrap as failed", async () => {
  const { QuickIndexCoordinator } = await loadModule("src/onboarding/quick-index-coordinator.ts");
  const settled = [];
  let finalized = false;
  const coordinator = new QuickIndexCoordinator({
    vault: { getFiles: () => [file("成功.md", 10), file("失败.md", 11)] },
    getDocumentIndexer: async () => fakeIndexer({
      indexFiles: async () => ({
        requested: 2, indexed: 1, skipped: 0, failed: 1, chunkCount: 1, cancelled: false,
        files: [
          { path: "成功.md", status: "indexed", chunkCount: 1 },
          { path: "失败.md", status: "failed", chunkCount: 0, errorCategory: "embedding" },
        ],
      }),
    }),
    getLicenseState: () => ({ status: "active", maxPages: 10 }),
    hashSalt: "partial-transaction",
    onSettled: async (outcome) => { settled.push(outcome); },
  });

  await assert.rejects(
    coordinator.run({ type: "vault" }, () => {}, {
      finalize: async () => { finalized = true; },
    }),
    /QUICK_INDEX_FAILED/,
  );
  assert.equal(finalized, false);
  assert.deepEqual(settled, ["failed"]);
});

test("finalize receives frozen selected identity evidence and must succeed before completed settle", async () => {
  const { QuickIndexCoordinator } = await loadModule("src/onboarding/quick-index-coordinator.ts");
  const source = file("资料/恢复.md", 42);
  const settled = [];
  const coordinator = new QuickIndexCoordinator({
    vault: { getFiles: () => [source] },
    getDocumentIndexer: async () => fakeIndexer(),
    getLicenseState: () => ({ status: "active", maxPages: 10 }),
    hashSalt: "finalize-transaction",
    onSettled: async (outcome) => { settled.push(outcome); },
  });

  await assert.rejects(
    coordinator.run({ type: "recent", limit: 30 }, () => {}, {
      finalize: async (result) => {
        assert.deepEqual(result.selectedDocuments, [{ docId: "资料/恢复.md", path: "资料/恢复.md", mtime: 42 }]);
        assert.equal(Object.isFrozen(result.selectedDocuments), true);
        assert.equal(Object.isFrozen(result.selectedDocuments[0]), true);
        source.path = "资料/被替换.md";
        throw new Error("FINALIZER_DURABILITY_FAILED");
      },
    }),
    /FINALIZER_DURABILITY_FAILED/,
  );
  assert.deepEqual(settled, ["failed"]);
});
