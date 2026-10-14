import { createRequire } from "module";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { VectorStoreEngine, type SqliteDatabase } from "./vector-store-engine";
import { ParallelVectorScanner, parallelScanThreads } from "./parallel-scan";
import {
  vectorStoreError,
  type VectorStoreRequest,
  type VectorStoreResponse,
} from "./vector-store-protocol";

type DatabaseConstructor = new (filename: string) => SqliteDatabase;

let engine: VectorStoreEngine | null = null;
let openedPath = "";
let scanner: ParallelVectorScanner | null = null;

function createScanner(): ParallelVectorScanner | null {
  // availableParallelism (Node 18.14+) respects CPU affinity; @types/node here predates it.
  const available = (os as { availableParallelism?: () => number }).availableParallelism;
  const cpus = typeof available === "function" ? available() : os.cpus().length;
  const threads = parallelScanThreads(cpus);
  if (threads < 2) return null;
  try {
    return new ParallelVectorScanner(threads);
  } catch {
    return null;
  }
}

function loadSqlite(): DatabaseConstructor {
  // node:sqlite is resolved at runtime so bundlers never try to inline it.
  const runtimeRequire = createRequire(__filename);
  const sqlite = runtimeRequire("node:sqlite") as { DatabaseSync?: DatabaseConstructor };
  if (typeof sqlite.DatabaseSync !== "function") throw vectorStoreError("VECTOR_STORE_SQLITE_UNAVAILABLE");
  return sqlite.DatabaseSync;
}

function openDatabase(databasePath: string): { schemaVersion: number } {
  if (typeof databasePath !== "string" || !path.isAbsolute(databasePath)) {
    throw vectorStoreError("VECTOR_STORE_PATH_INVALID");
  }
  if (engine) {
    if (openedPath === databasePath) return { schemaVersion: engine.schemaVersion };
    throw vectorStoreError("VECTOR_STORE_ALREADY_OPEN");
  }
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const DatabaseSync = loadSqlite();
  scanner ??= createScanner();
  engine = new VectorStoreEngine(new DatabaseSync(databasePath), { scanner });
  openedPath = databasePath;
  scheduleKeywordBackfill();
  return { schemaVersion: engine.schemaVersion };
}

let backfillScheduled = false;

/** Backfills the keyword index in small batches between requests, never blocking search for long. */
function scheduleKeywordBackfill(): void {
  if (backfillScheduled) return;
  backfillScheduled = true;
  setImmediate(function step() {
    backfillScheduled = false;
    let more = false;
    try {
      more = engine?.keywordBackfillStep(1000) ?? false;
    } catch {
      more = false;
    }
    if (more) {
      backfillScheduled = true;
      setImmediate(step);
    }
  });
}

function requireEngine(): VectorStoreEngine {
  if (!engine) throw vectorStoreError("VECTOR_STORE_NOT_OPEN");
  return engine;
}

export function handleVectorStoreRequest(request: VectorStoreRequest): unknown {
  const params = (request.params ?? {}) as Record<string, any>;
  switch (request.op) {
    case "open":
      return openDatabase(params.databasePath);
    case "health":
      return {
        collections: engine ? engine.collectionCount() : 0,
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      };
    case "ensureCollection":
      return requireEngine().ensureCollection(params.name);
    case "hasCollection":
      return requireEngine().hasCollection(params.name);
    case "deleteCollection":
      return requireEngine().deleteCollection(params.name);
    case "upsert":
      return requireEngine().upsert(params.collection, params.records);
    case "deleteByDocId":
      return requireEngine().deleteByDocId(params.collection, params.docId);
    case "count":
      return requireEngine().count(params.collection);
    case "identityPage":
      return requireEngine().identityPage(params.collection, params.offset, params.limit);
    case "get":
      return requireEngine().get(params.collection, params);
    case "query":
      return requireEngine().queryAsync(params.collection, params.embedding, params.topK);
    case "hybridQuery":
      return requireEngine().hybridQueryAsync(params.collection, params.embedding, params.text, params.topK, params.keywordWeight);
    case "keywordStatus":
      return requireEngine().keywordStatus();
    case "documentEntries":
      return requireEngine().documentEntries(params.collection);
    case "close":
      engine?.close();
      engine = null;
      openedPath = "";
      return { closed: true };
    default:
      throw vectorStoreError("VECTOR_STORE_UNKNOWN_OPERATION");
  }
}

function respond(response: VectorStoreResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

let requestQueue: Promise<void> = Promise.resolve();

/**
 * Requests run strictly one after another in arrival order (a parallel scan is awaited before
 * the next request starts), so writes never interleave with a scan of the shared matrix.
 */
function processLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request: VectorStoreRequest;
  try {
    request = JSON.parse(trimmed) as VectorStoreRequest;
  } catch {
    return;
  }
  requestQueue = requestQueue.then(() => processRequest(request));
}

async function processRequest(request: VectorStoreRequest): Promise<void> {
  const id = typeof request?.id === "string" ? request.id : "unknown";
  try {
    respond({ id, ok: true, result: await handleVectorStoreRequest(request) });
  } catch (error) {
    const code = typeof (error as { code?: unknown })?.code === "string"
      && /^[A-Z][A-Z0-9_]{2,80}$/.test((error as { code: string }).code)
      ? (error as { code: string }).code
      : "VECTOR_STORE_OPERATION_FAILED";
    respond({ id, ok: false, error: { code, message: (error as Error)?.message || code } });
  }
}

export function runVectorStoreWorker(): void {
  let buffer = "";
  process.stdin.setEncoding("utf-8");
  // Requests are queued in arrival order (see processLine), so writes never interleave.
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) processLine(line);
  });
  process.stdin.on("end", () => {
    if (buffer.trim()) processLine(buffer);
    void requestQueue.finally(() => {
      try { engine?.close(); } catch { /* The process is exiting. */ }
      process.exit(0);
    });
  });
  const shutdown = () => {
    try { engine?.close(); } catch { /* The process is exiting. */ }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("uncaughtException", (error) => {
    console.error("[AnalogyVectorStore] uncaughtException", error instanceof Error ? error.message : "");
    try { engine?.close(); } catch { /* The process is exiting. */ }
    process.exit(1);
  });
}
