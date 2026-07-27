const fs = require("fs");

const delayMs = Number(process.env.ANALOGY_TEST_DELAY_MS || 0);
const stateFile = process.env.ANALOGY_TEST_STATE_FILE || "";
const mode = process.env.ANALOGY_TEST_WORKER_MODE || "normal";

let buffer = "";
let active = 0;
let maxActive = 0;

function writeState(extra = {}) {
  if (!stateFile) return;
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      pid: process.pid,
      active,
      maxActive,
      ...extra,
    }),
    "utf-8",
  );
}

function respond(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handle(request) {
  if (request.type === "initialize") {
    respond({ id: request.id, ok: true });
    return;
  }
  if (request.type === "health") {
    respond({
      id: request.id,
      ok: true,
      memoryUsage: { rss: 1, heapUsed: 1, external: 1 },
    });
    return;
  }
  if (request.type === "dispose") {
    respond({ id: request.id, ok: true });
    return;
  }
  if (request.type !== "embed") {
    respond({
      id: request.id,
      ok: false,
      error: { code: "UNKNOWN", message: "Unknown request" },
    });
    return;
  }

  active += 1;
  maxActive = Math.max(maxActive, active);
  writeState();
  try {
    if (mode === "hang") {
      await new Promise(() => {});
      return;
    }
    if (delayMs > 0) {
      await wait(delayMs);
    }
    if (mode === "malformed") {
      respond({
        id: request.id,
        ok: true,
        embeddings: [[1, 2], [3]],
      });
      return;
    }
    if (mode === "oversized") {
      respond({
        id: request.id,
        ok: true,
        embeddings: request.texts.map(() => [1]),
        padding: "x".repeat(4096),
      });
      return;
    }
    respond({
      id: request.id,
      ok: true,
      embeddings: request.texts.map((text) => [text.length, 1]),
    });
  } finally {
    active -= 1;
    writeState();
  }
}

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    void handle(request);
  }
});

if (process.env.ANALOGY_TEST_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {
    writeState({ receivedSigterm: true });
  });
}

writeState();
