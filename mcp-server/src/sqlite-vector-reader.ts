import * as fs from "fs";
import { createRequire } from "module";

export interface SqliteSearchResult {
  chunkId: string;
  content: string;
  /** Squared L2 distance between unit vectors (0 = identical, 4 = opposite). */
  distance: number;
  metadata: Record<string, unknown>;
}

interface Statement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
}

type DatabaseConstructor = new (filename: string, options?: { readOnly?: boolean }) => Database;

interface MatrixCache {
  collectionId: string;
  dataVersion: number;
  dimension: number;
  ids: string[];
  data: Float32Array;
}

function decode(value: unknown): Float32Array {
  if (!(value instanceof Uint8Array) || value.byteLength % 4 !== 0) {
    throw new Error("Vector record is corrupt.");
  }
  return value.byteOffset % 4 === 0
    ? new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4)
    : new Float32Array(value.slice().buffer);
}

function loadSqlite(): DatabaseConstructor {
  try {
    const sqlite = createRequire(__filename)("node:sqlite") as { DatabaseSync?: DatabaseConstructor };
    if (typeof sqlite.DatabaseSync === "function") return sqlite.DatabaseSync;
  } catch {
    // Fall through to the actionable error below.
  }
  throw new Error(
    `node:sqlite is unavailable in Node ${process.version}. ` +
      "Run the MCP server with Node.js >= 22.13 (for example the Analogy managed runtime).",
  );
}

/**
 * Read-only view of the plugin's SQLite vector store. Safe to use while
 * Obsidian is writing: the database runs in WAL mode.
 */
export class SqliteVectorReader {
  private readonly db: Database;
  private cache: MatrixCache | null = null;

  constructor(databasePath: string) {
    if (!fs.existsSync(databasePath)) {
      throw new Error(
        `Vector database not found at ${databasePath}. ` +
          "Open Obsidian once so the Analogy plugin can create or migrate the local index.",
      );
    }
    const DatabaseSync = loadSqlite();
    this.db = new DatabaseSync(databasePath, { readOnly: true });
    this.db.exec("PRAGMA busy_timeout = 5000");
  }

  close(): void {
    this.cache = null;
    this.db.close();
  }

  hasCollection(name: string): boolean {
    return this.collectionId(name) !== null;
  }

  count(name: string): number {
    const id = this.collectionId(name);
    if (!id) return 0;
    return Number(this.db.prepare("SELECT COUNT(*) AS total FROM records WHERE collection_id = ?").get(id)?.total ?? 0);
  }

  search(name: string, embedding: number[], topK: number): SqliteSearchResult[] {
    const id = this.collectionId(name);
    if (!id) return [];
    const cache = this.loadMatrix(id);
    if (cache.ids.length === 0) return [];
    if (embedding.length !== cache.dimension) {
      throw new Error(`Query dimension ${embedding.length} does not match the index dimension ${cache.dimension}.`);
    }
    const query = Float32Array.from(embedding);
    const scored: Array<{ slot: number; distance: number }> = [];
    for (let slot = 0; slot < cache.ids.length; slot += 1) {
      const offset = slot * cache.dimension;
      let distance = 0;
      for (let index = 0; index < cache.dimension; index += 1) {
        const delta = cache.data[offset + index] - query[index];
        distance += delta * delta;
      }
      scored.push({ slot, distance });
    }
    scored.sort((left, right) => left.distance - right.distance);
    const nearest = scored.slice(0, Math.max(1, topK));
    const ids = nearest.map(({ slot }) => cache.ids[slot]);
    const rows = this.db.prepare(
      `SELECT id, document, metadata FROM records WHERE collection_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
    ).all(id, ...ids);
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    return nearest.map(({ slot, distance }) => {
      const row = byId.get(cache.ids[slot]);
      let metadata: Record<string, unknown> = {};
      try {
        metadata = typeof row?.metadata === "string" ? JSON.parse(row.metadata) : {};
      } catch {
        metadata = {};
      }
      return {
        chunkId: cache.ids[slot],
        content: typeof row?.document === "string" ? row.document : "",
        distance,
        metadata,
      };
    });
  }

  private collectionId(name: string): string | null {
    const row = this.db.prepare("SELECT id FROM collections WHERE name = ?").get(name);
    return row ? String(row.id) : null;
  }

  private loadMatrix(collectionId: string): MatrixCache {
    const dataVersion = Number(this.db.prepare("PRAGMA data_version").get()?.data_version ?? 0);
    if (this.cache && this.cache.collectionId === collectionId && this.cache.dataVersion === dataVersion) {
      return this.cache;
    }
    const rows = this.db.prepare("SELECT id, embedding FROM records WHERE collection_id = ? ORDER BY seq").all(collectionId);
    const dimension = rows.length > 0 ? decode(rows[0].embedding).length : 0;
    const data = new Float32Array(Math.max(1, rows.length * dimension));
    const ids: string[] = [];
    rows.forEach((row, index) => {
      data.set(decode(row.embedding), index * dimension);
      ids.push(String(row.id));
    });
    this.cache = { collectionId, dataVersion, dimension, ids, data };
    return this.cache;
  }
}
