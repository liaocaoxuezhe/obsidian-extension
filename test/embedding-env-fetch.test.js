const assert = require("assert");
const path = require("path");
const { EventEmitter } = require("events");
const esbuild = require("esbuild");

async function loadModule() {
  const source = path.join(__dirname, "..", "src", "local-vector", "embedding.ts");
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    external: ["@huggingface/transformers"],
  });
  const module = { exports: {} };
  const fn = new Function("module", "exports", "require", result.outputFiles[0].text);
  fn(module, module.exports, require);
  return module.exports;
}

function mockHttpClient(clientName) {
  // Replace http.request or https.request with a mock that records calls and immediately errors.
  const client = require(clientName);
  const originalRequest = client.request;
  let called = false;
  let requestedUrl = null;
  client.request = function mockedRequest(url, options, callback) {
    called = true;
    requestedUrl = typeof url === "string" ? url : url.toString();
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.end = () => {};
    req.write = () => {};
    req.destroy = () => {};
    // Schedule an error so any awaiting Promise rejects immediately.
    process.nextTick(() => req.emit("error", new Error("mocked network error")));
    return req;
  };
  return {
    restore: () => {
      client.request = originalRequest;
    },
    wasCalled: () => called,
    lastUrl: () => requestedUrl,
  };
}

(async () => {
  const mod = await loadModule();
  const { installNodeFetch } = mod;

  // ---------- 1. installNodeFetch is exported ----------
  assert.strictEqual(
    typeof installNodeFetch,
    "function",
    "installNodeFetch should be exported from embedding.ts so the override can be applied when transformers loads"
  );

  // ---------- 2. After installNodeFetch, env.fetch is replaced ----------
  const transformersPath = require.resolve("@huggingface/transformers");
  const originalTransformers = require.cache[transformersPath];
  const transformers = { env: { fetch: (...args) => globalThis.fetch(...args) } };
  require.cache[transformersPath] = {
    id: transformersPath, filename: transformersPath, loaded: true, exports: transformers,
  };
  process.on("exit", () => {
    if (originalTransformers) require.cache[transformersPath] = originalTransformers;
    else delete require.cache[transformersPath];
  });
  const originalEnvFetch = transformers.env.fetch;
  installNodeFetch(transformers);
  assert.notStrictEqual(
    transformers.env.fetch,
    originalEnvFetch,
    "installNodeFetch should replace transformers.env.fetch so the override actually takes effect (globalThis.fetch is too late — DEFAULT_FETCH was captured at module load)"
  );

  // ---------- 3. https URL goes through Node's https.request ----------
  const httpsSpy = mockHttpClient("https");
  try {
    await transformers.env
      .fetch("https://huggingface.co/jinaai/jina-embeddings-v5-text-nano-retrieval/resolve/main/config.json")
      .catch(() => {});
    assert.ok(httpsSpy.wasCalled(), "env.fetch should call https.request for https URLs");
  } finally {
    httpsSpy.restore();
  }

  // ---------- 4. http URL goes through Node's http.request ----------
  const httpSpy = mockHttpClient("http");
  try {
    await transformers.env.fetch("http://example.com/test").catch(() => {});
    assert.ok(httpSpy.wasCalled(), "env.fetch should call http.request for http URLs");
  } finally {
    httpSpy.restore();
  }

  // ---------- 5. Non-http URL falls back to the original fetch (does NOT call http/https.request) ----------
  const httpsSpy2 = mockHttpClient("https");
  const httpSpy2 = mockHttpClient("http");
  try {
    // A relative / file-style URL should bypass Node's http(s) modules.
    const result = transformers.env.fetch("transformers-cache/file.txt");
    // Either resolves or rejects — what matters is that http/https.request was not used.
    await Promise.resolve(result).catch(() => {});
    assert.strictEqual(
      httpsSpy2.wasCalled(),
      false,
      "env.fetch should NOT call https.request for non-http URLs"
    );
    assert.strictEqual(
      httpSpy2.wasCalled(),
      false,
      "env.fetch should NOT call http.request for non-http URLs"
    );
  } finally {
    httpsSpy2.restore();
    httpSpy2.restore();
  }

  console.log("Embedding env fetch tests passed");
})().catch((err) => {
  console.error("Embedding env fetch tests FAILED:", err);
  process.exit(1);
});
