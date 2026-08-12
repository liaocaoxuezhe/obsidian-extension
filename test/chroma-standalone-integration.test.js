"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdtemp, rm } = require("node:fs/promises");
const { stat } = require("node:fs/promises");
const { request } = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { downloadPinnedChroma } = require("./helpers/download-pinned-chroma.js");

const TENANT = "default_tenant";
const DATABASE = "default_database";

function requestJson(baseUrl, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const url = new URL(pathname, baseUrl);
    const req = request(url, {
      method,
      timeout: 10_000,
      headers: payload
        ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
        : undefined,
    }, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { responseBody += chunk; });
      res.on("end", () => {
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
          reject(new Error(`Chroma ${method} ${pathname} returned ${res.statusCode}: ${responseBody}`));
          return;
        }
        if (!responseBody) {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(responseBody));
        } catch (error) {
          reject(new Error(`Chroma ${method} ${pathname} returned invalid JSON: ${error.message}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Chroma ${method} ${pathname} timed out`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function unusedPort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.listen(0, "127.0.0.1", resolve).on("error", reject));
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function exitsBefore(exited, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => { timeout = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const exitedGracefully = await exitsBefore(exited, 5_000);
  if (exitedGracefully) return;
  child.kill("SIGKILL");
  const exitedAfterKill = await exitsBefore(exited, 5_000);
  if (!exitedAfterKill) throw new Error("Pinned Chroma did not exit after forced termination");
}

async function waitForReady(baseUrl, child, output) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Pinned Chroma exited before becoming ready (${child.exitCode}): ${output()}`);
    }
    try {
      await requestJson(baseUrl, "GET", "/api/v2/heartbeat");
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Pinned Chroma did not become ready: ${lastError?.message ?? output()}`);
}

async function startPinnedChroma(t, binaryPath, options = {}) {
  assert.ok(binaryPath, "ANALOGY_CHROMA_BIN must point to the pinned Chroma CLI binary");
  const dataDirectory = options.dataDirectory
    ? path.resolve(options.dataDirectory)
    : await mkdtemp(path.join(process.cwd(), "test/.runtime/chroma-contract-"));
  if (options.dataDirectory) {
    await require("node:fs/promises").mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  }
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let child;

  const start = async () => {
    let output = "";
    child = spawn(binaryPath, ["run", "--path", dataDirectory, "--host", "127.0.0.1", "--port", String(port)], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", (error) => { output += `\n${error.message}`; });
    await waitForReady(baseUrl, child, () => output);
  };

  await start();
  t.after(async () => {
    await stopProcess(child);
    await rm(dataDirectory, { recursive: true, force: true });
  });

  return {
    baseUrl,
    port,
    dataDirectory,
    async restart() {
      await stopProcess(child);
      await start();
    },
  };
}

async function runChromaContractSuite(baseUrl, restart) {
  await requestJson(baseUrl, "GET", "/api/v2/heartbeat");
  const version = await requestJson(baseUrl, "GET", "/api/v2/version");
  assert.equal(version, "1.0.0", "CLI 1.4.4 exposes the Chroma v2 wire-protocol version");

  const collectionName = `analogy-contract-${randomUUID()}`;
  const collection = await requestJson(
    baseUrl,
    "POST",
    `/api/v2/tenants/${TENANT}/databases/${DATABASE}/collections`,
    {
      name: collectionName,
      configuration: null,
      get_or_create: true,
      metadata: { description: "Analogy standalone contract fixture" },
    },
  );
  const existingCollection = await requestJson(
    baseUrl,
    "POST",
    `/api/v2/tenants/${TENANT}/databases/${DATABASE}/collections`,
    { name: collectionName, configuration: null, get_or_create: true },
  );
  assert.equal(existingCollection.id, collection.id);
  const collectionPath = `/api/v2/tenants/${TENANT}/databases/${DATABASE}/collections/${collection.id}`;
  await requestJson(baseUrl, "POST", `${collectionPath}/upsert`, {
    ids: ["doc-a#0", "doc-b#0"],
    documents: ["alpha content", "beta content"],
    embeddings: [[1, 0, 0], [0, 1, 0]],
    metadatas: [
      { doc_id: "doc-a", chunk_index: 0 },
      { doc_id: "doc-b", chunk_index: 0 },
    ],
  });
  const countAfterUpsert = await requestJson(baseUrl, "GET", `${collectionPath}/count`);
  const query = await requestJson(baseUrl, "POST", `${collectionPath}/query`, {
    query_embeddings: [[1, 0, 0]],
    n_results: 1,
    include: ["documents", "metadatas", "distances"],
  });
  const filtered = await requestJson(baseUrl, "POST", `${collectionPath}/get`, {
    where: { doc_id: "doc-b" },
    include: ["documents", "metadatas"],
  });
  const embedding = await requestJson(baseUrl, "POST", `${collectionPath}/get`, {
    ids: ["doc-a#0"],
    include: ["embeddings"],
  });
  assert.deepEqual(embedding.ids, ["doc-a#0"]);
  assert.deepEqual(embedding.embeddings, [[1, 0, 0]]);

  await requestJson(baseUrl, "POST", `${collectionPath}/delete`, { ids: ["doc-b#0"] });
  const countAfterDelete = await requestJson(baseUrl, "GET", `${collectionPath}/count`);
  await restart();
  const persistedAfterRestart = await requestJson(baseUrl, "GET", `${collectionPath}/count`) === 1;

  return {
    apiVersion: "v2",
    countAfterUpsert,
    queryIds: query.ids[0],
    filteredIds: filtered.ids,
    countAfterDelete,
    persistedAfterRestart,
  };
}

if (require.main === module) {
  test("pinned Chroma downloader reuses an already validated executable", async () => {
    const outputPath = path.resolve(process.env.ANALOGY_CHROMA_BIN);
    const output = path.relative(process.cwd(), outputPath);
    const before = await stat(outputPath);
    const result = await downloadPinnedChroma({ version: "cli-1.4.4", output });
    const after = await stat(outputPath);

    assert.equal(result.outputPath, outputPath);
    assert.equal(after.ino, before.ino, "a validated executable must not be replaced");
    if (process.platform !== "win32") {
      assert.ok((after.mode & 0o111) !== 0, "the reused executable remains executable");
    }
  });

  test("Chroma CLI 1.4.4 satisfies the Analogy vector contract", async (t) => {
    const server = await startPinnedChroma(t, process.env.ANALOGY_CHROMA_BIN);
    const result = await runChromaContractSuite(server.baseUrl, () => server.restart());
    assert.deepEqual(result, {
      apiVersion: "v2",
      countAfterUpsert: 2,
      queryIds: ["doc-a#0"],
      filteredIds: ["doc-b#0"],
      countAfterDelete: 1,
      persistedAfterRestart: true,
    });
  });
}

module.exports = { requestJson, runChromaContractSuite, startPinnedChroma };
