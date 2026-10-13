import { createRequire } from "module";
import * as fs from "fs";
import * as path from "path";
import { VectorStoreEngine, type SqliteDatabase } from "./vector-store-engine";
import {
  vectorStoreError,
  type VectorStoreRequest,
  type VectorStoreResponse,
} from "./vector-store-protocol";

type DatabaseConstructor = new (filename: string) => SqliteDatabase;

let engine: VectorStoreEngine | null = null;
let openedPath = "";

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
  engine = new VectorStoreEngine(new DatabaseSync(databasePath));
  openedPath = databasePath;
  return { schemaVersion: engine.schemaVersion };
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
      return requireEngine().query(params.collection, params.embedding, params.topK);
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

function processLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request: VectorStoreRequest;
  try {
    request = JSON.parse(trimmed) as VectorStoreRequest;
  } catch {
    return;
  }
  const id = typeof request?.id === "string" ? request.id : "unknown";
  try {
    respond({ id, ok: true, result: handleVectorStoreRequest(request) });
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
  // Requests are handled synchronously in arrival order, so writes never interleave.
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) processLine(line);
  });
  process.stdin.on("end", () => {
    if (buffer.trim()) processLine(buffer);
    try { engine?.close(); } catch { /* The process is exiting. */ }
    process.exit(0);
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
