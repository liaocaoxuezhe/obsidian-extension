"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Readable } = require("node:stream");
const esbuild = require("esbuild");

async function loadModule(source) {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, "..", "src", source)],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["obsidian", "electron"],
    write: false,
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", "__filename", result.outputFiles[0].text)(
    module, module.exports, require, __filename,
  );
  return module.exports;
}

function tempDir(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

/** A proxy-aware fetch double that serves byte ranges like a CDN. */
function rangeFetch(body, calls, options = {}) {
  return async ({ url, headers }) => {
    calls.push({ url, range: headers?.Range ?? null });
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (options.fail?.(calls.length)) throw new Error("socket hang up");
    const match = /^bytes=(\d+)-(\d+)$/.exec(headers?.Range ?? "");
    if (!match || options.ignoreRanges) {
      return { status: 200, headers: { ETag: "\"v1\"" }, arrayBuffer: body.buffer.slice(body.byteOffset, body.byteOffset + body.length) };
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), body.length - 1);
    const slice = body.subarray(start, end + 1);
    return {
      status: 206,
      headers: { ETag: "\"v1\"", "Content-Range": `bytes ${start}-${end}/${body.length}` },
      arrayBuffer: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length),
    };
  };
}

test("the proxy-aware chunked transport downloads, resumes and verifies through the runtime downloader", async (t) => {
  const { createChunkedTransport } = await loadModule("runtime/download-transport.ts");
  const { downloadRuntimeAsset } = await loadModule("runtime/runtime-downloader.ts");
  const root = tempDir(t, "analogy-chunked-");
  const body = crypto.randomBytes(5 * 1024 * 1024 + 123);
  const asset = { id: "asset-chunked", url: "https://example.test/asset.bin", size: body.length, sha256: sha256(body) };
  const calls = [];
  const transport = createChunkedTransport(rangeFetch(body, calls, { delayMs: 60 }), { chunkSize: 1024 * 1024 });
  const partPath = path.join(root, "asset.part");

  const controller = new AbortController();
  await assert.rejects(downloadRuntimeAsset({
    asset, partPath, signal: controller.signal, requests: [transport],
    onProgress: (progress) => { if (progress.receivedBytes >= 2 * 1024 * 1024) controller.abort(); },
  }), (error) => error.code === "DOWNLOAD_CANCELLED");
  const partial = fs.statSync(partPath).size;
  assert.ok(partial > 0 && partial < body.length);

  calls.length = 0;
  const done = await downloadRuntimeAsset({ asset, partPath, signal: new AbortController().signal, requests: [transport] });
  assert.equal(done.resumed, true);
  assert.equal(calls[0].range.startsWith(`bytes=${partial}-`), true, "resume starts at the partial size");
  assert.equal(sha256(fs.readFileSync(partPath)), asset.sha256);
});

test("a server that ignores ranges still yields the complete file", async (t) => {
  const { createChunkedTransport } = await loadModule("runtime/download-transport.ts");
  const { downloadRuntimeAsset } = await loadModule("runtime/runtime-downloader.ts");
  const root = tempDir(t, "analogy-chunked-full-");
  const body = crypto.randomBytes(300_000);
  const calls = [];
  const transport = createChunkedTransport(rangeFetch(body, calls, { ignoreRanges: true }), { chunkSize: 64 * 1024 });
  const partPath = path.join(root, "full.part");
  await downloadRuntimeAsset({
    asset: { id: "full", url: "https://example.test/full.bin", size: body.length, sha256: sha256(body) },
    partPath, signal: new AbortController().signal, requests: [transport],
  });
  assert.equal(sha256(fs.readFileSync(partPath)), sha256(body));
  assert.equal(calls.length, 1);
});

test("a failing or stalled transport falls back to the next one and to mirrors", async (t) => {
  const { createChunkedTransport } = await loadModule("runtime/download-transport.ts");
  const { downloadRuntimeAsset } = await loadModule("runtime/runtime-downloader.ts");
  const root = tempDir(t, "analogy-fallback-");
  const body = crypto.randomBytes(200_000);
  const asset = { id: "fallback", url: "https://primary.test/a.bin", size: body.length, sha256: sha256(body) };
  const direct = async () => { throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }); };
  const calls = [];
  const proxyAware = createChunkedTransport(rangeFetch(body, calls), { chunkSize: 64 * 1024 });
  await downloadRuntimeAsset({
    asset, partPath: path.join(root, "a.part"), signal: new AbortController().signal, requests: [direct, proxyAware],
  });
  assert.ok(calls.length > 0, "the proxy-aware transport finished the download");

  const silent = async () => Object.assign(new Readable({ read() {} }), { statusCode: 200, headers: { "content-length": String(body.length), etag: "\"v1\"" } });
  const mirrorCalls = [];
  const mirrorOnly = createChunkedTransport(async (request) => {
    if (request.url.startsWith("https://primary.test")) throw new Error("ENOTFOUND primary.test");
    return rangeFetch(body, mirrorCalls)(request);
  }, { chunkSize: 64 * 1024 });
  await downloadRuntimeAsset({
    asset, partPath: path.join(root, "b.part"), signal: new AbortController().signal,
    requests: [silent, mirrorOnly], alternateUrls: ["https://mirror.test/a.bin"], stallTimeoutMs: 200,
  });
  assert.ok(mirrorCalls.every((call) => call.url.startsWith("https://mirror.test")));
  assert.equal(sha256(fs.readFileSync(path.join(root, "b.part"))), asset.sha256);
});

test("model files download from the fastest source, verify hashes and classify failures", async (t) => {
  const modelFiles = await loadModule("local-vector/model-files.ts");
  const { MODEL_FILE_MANIFESTS } = await loadModule("local-vector/model-file-manifest.ts");
  const manifest = MODEL_FILE_MANIFESTS["all-MiniLM-L6-v2"];
  const root = tempDir(t, "analogy-model-files-");
  const files = new Map(manifest.files.map((file) => [file.path, Buffer.alloc(file.size)]));
  // Zero-filled bodies have the right sizes but wrong hashes, proving verification runs.
  const { createChunkedTransport } = await loadModule("runtime/download-transport.ts");
  const calls = [];
  const transport = createChunkedTransport(async (request) => {
    const file = manifest.files.find((entry) => request.url.endsWith(`/${entry.path}`));
    return rangeFetch(files.get(file.path), calls)(request);
  }, { chunkSize: 8 * 1024 * 1024 });
  await assert.rejects(modelFiles.ensureModelFiles({
    shortName: "all-MiniLM-L6-v2", cacheDir: path.join(root, "bad"),
    hosts: ["https://mirror-a.test/"], transports: [transport], probe: async (hosts) => [...hosts],
  }), (error) => error.code === "EMBEDDING_MODEL_CACHE_CORRUPT" && error.evidence.includes("MODEL_HASH_MISMATCH"));
  assert.ok(calls[0].url.startsWith(`https://mirror-a.test/${manifest.id}/resolve/${manifest.revision}/`));

  const offline = async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); };
  await assert.rejects(modelFiles.ensureModelFiles({
    shortName: "all-MiniLM-L6-v2", cacheDir: path.join(root, "offline"),
    hosts: ["https://a.test/", "https://b.test/"], transports: [offline], probe: async (hosts) => [...hosts],
  }), (error) => error.code === "EMBEDDING_MODEL_NETWORK_FAILED" && error.subStage === "model-download");

  assert.equal(await modelFiles.ensureModelFiles({ shortName: "custom-model", cacheDir: root }), false);
  assert.deepEqual(modelFiles.modelHosts("https://my-mirror.example/"), [
    "https://my-mirror.example/", "https://hf-mirror.com/", "https://huggingface.co/",
  ]);
  assert.deepEqual(modelFiles.modelHosts("http://insecure.example/"), ["https://hf-mirror.com/", "https://huggingface.co/"]);
});

test("model files import offline from a folder only when every file verifies", async (t) => {
  const modelFiles = await loadModule("local-vector/model-files.ts");
  const root = tempDir(t, "analogy-model-import-");
  const source = path.join(root, "source");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "config.json"), "{}");
  await assert.rejects(modelFiles.importModelFiles("bge-small-en-v1.5", source, path.join(root, "cache")),
    (error) => error.code === "MODEL_IMPORT_FILE_MISSING");
  assert.equal(fs.existsSync(path.join(root, "cache", "Xenova")), false, "nothing is copied unless all files verify");

  const real = path.join(os.homedir(), "Library", "Application Support", "Analogy", "models", "transformers-cache", "bge-small-en-v1.5");
  if (!fs.existsSync(path.join(real, "Xenova", "bge-small-en-v1.5", "onnx", "model_quantized.onnx"))) return;
  const result = await modelFiles.importModelFiles("bge-small-en-v1.5", real, path.join(root, "cache"));
  assert.equal(result.imported, 4);
  assert.ok(fs.existsSync(path.join(root, "cache", "Xenova", "bge-small-en-v1.5", "tokenizer.json")));
});
