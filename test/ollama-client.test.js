const assert = require("assert");
const http = require("http");
const path = require("path");
const esbuild = require("../node_modules/esbuild");

async function loadModule(relativePath) {
  const source = path.join(__dirname, "..", relativePath);
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const module = { exports: {} };
  const fn = new Function("module", "exports", "require", result.outputFiles[0].text);
  fn(module, module.exports, require);
  return module.exports;
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

(async () => {
  const { OllamaClient } = await loadModule("src/local-vector/ollama-client.ts");
  const { server, baseUrl } = await startServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/tags") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ models: [{ name: "gemma3:270m", size: 291000000 }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/generate") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const payload = JSON.parse(body);
        assert.strictEqual(payload.stream, false);
        assert.strictEqual(payload.model, "gemma3:270m");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ response: "摘要内容", done: true }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  try {
    const client = new OllamaClient({ host: baseUrl, timeoutMs: 1000 });
    assert.strictEqual(await client.isAvailable(), true);
    assert.deepStrictEqual(await client.listModels(), [{ name: "gemma3:270m", size: 291000000 }]);
    assert.strictEqual(await client.generate({ model: "gemma3:270m", prompt: "hello" }), "摘要内容");
  } finally {
    server.close();
  }

  console.log("Ollama client tests passed");
})();
