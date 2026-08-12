"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const extensionRoot = process.cwd();

function loadOllamaClient() {
  const filename = path.join(extensionRoot, "src/local-vector/ollama-client.ts");
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports, require, module, filename, path.dirname(filename),
  );
  return module.exports.OllamaClient;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("pullModel parses split and coalesced JSONL incrementally before response end", async () => {
  let responseEnded = false;
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/api/pull");
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.write('{"status":"starting","completed":1');
    setTimeout(() => {
      response.write(',"total":4}\n{"status":"pulling","completed":2,"total":4}\n');
    }, 50);
    setTimeout(() => {
      response.write('{"status":"verifying","completed":3,"total":4}\n');
    }, 100);
    setTimeout(() => {
      response.end('{"status":"success","completed":4,"total":4}');
      responseEnded = true;
    }, 150);
  });
  const host = await listen(server);
  const OllamaClient = loadOllamaClient();
  const progress = [];
  let callbacksBeforeEnd = 0;
  try {
    const client = new OllamaClient({ host, timeoutMs: 2_000 });
    await client.pullModel("qwen3:0.6b", (event) => {
      progress.push(event);
      if (!responseEnded) callbacksBeforeEnd += 1;
    });
  } finally {
    await close(server);
  }
  assert.ok(callbacksBeforeEnd >= 2, "progress must be delivered while the response is still streaming");
  assert.deepEqual(progress.map((event) => event.status), ["starting", "pulling", "verifying", "success"]);
});

test("pullModel aborts an in-flight body stream and does not wait for response completion", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.write('{"status":"pulling","completed":1,"total":9}\n');
    const timer = setInterval(() => response.write("\n"), 50);
    response.on("close", () => clearInterval(timer));
  });
  const host = await listen(server);
  const OllamaClient = loadOllamaClient();
  const controller = new AbortController();
  let callbacks = 0;
  try {
    const client = new OllamaClient({ host, timeoutMs: 5_000 });
    await assert.rejects(
      client.pullModel("qwen3:0.6b", () => {
        callbacks += 1;
        controller.abort();
      }, controller.signal),
      (error) => error?.name === "AbortError",
    );
  } finally {
    await close(server);
  }
  assert.equal(callbacks, 1);
});

test("base onboarding has no Ollama detection or download side effect", () => {
  const onboarding = fs.readFileSync(
    path.join(extensionRoot, "src/onboarding/OnboardingView.tsx"), "utf8",
  );
  assert.doesNotMatch(onboarding, /OllamaClient|listModels\(|pullModel\(/);
  assert.match(onboarding, /snapshot\.stage === "ready"/);

  const settings = fs.readFileSync(path.join(extensionRoot, "src/SettingView.tsx"), "utf8");
  assert.match(settings, /ollamaAvailable === false/);
  assert.match(settings, /ollamaAvailable === true/);
  assert.match(settings, /https:\/\/ollama\.com\/download/);
});
