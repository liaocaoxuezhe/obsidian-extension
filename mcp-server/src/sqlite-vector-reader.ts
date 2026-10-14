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

  /** True when the plugin's keyword index exists and its one-time backfill has finished. */
  keywordIndexReady(): boolean {
    try {
      if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'records_fts'").get()) return false;
      const cursor = Number(this.db.prepare("SELECT value FROM meta WHERE key = 'fts_backfill_cursor'").get()?.value ?? -1);
      const target = Number(this.db.prepare("SELECT value FROM meta WHERE key = 'fts_backfill_target'").get()?.value ?? 0);
      return cursor >= target;
    } catch {
      return false;
    }
  }

  /**
   * Keyword candidates for hybrid search: BM25-ranked FTS5 trigram hits for `match`, then
   * LIKE hits for short terms ranked by how many terms they contain. Returns chunk ids only.
   */
  keywordCandidates(name: string, match: string | null, shortTerms: string[], limit: number): { fts: string[]; like: string[] } {
    const id = this.collectionId(name);
    if (!id || !this.keywordIndexReady()) return { fts: [], like: [] };
    const fts = match
      ? this.db.prepare(
        "SELECT r.id AS id FROM records_fts JOIN records r ON r.seq = records_fts.rowid "
          + "WHERE records_fts MATCH ? AND r.collection_id = ? ORDER BY bm25(records_fts) LIMIT ?",
      ).all(match, id, limit).map((row) => String(row.id))
      : [];
    const counts = new Map<string, number>();
    for (const term of shortTerms) {
      const pattern = `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
      for (const row of this.db.prepare(
        "SELECT id FROM records WHERE collection_id = ? AND document LIKE ? ESCAPE '\\' ORDER BY seq LIMIT ?",
      ).all(id, pattern, limit)) {
        counts.set(String(row.id), (counts.get(String(row.id)) ?? 0) + 1);
      }
    }
    return { fts, like: [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([chunkId]) => chunkId) };
  }

  /** Loads chunks by id with their exact squared distance to `embedding`. */
  chunksByIds(name: string, ids: string[], embedding: number[]): SqliteSearchResult[] {
    const id = this.collectionId(name);
    if (!id || ids.length === 0) return [];
    const cache = this.loadMatrix(id);
    const slots = new Map(cache.ids.map((chunkId, slot) => [chunkId, slot]));
    const rows = this.db.prepare(
      `SELECT id, document, metadata FROM records WHERE collection_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
    ).all(id, ...ids);
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    const results: SqliteSearchResult[] = [];
    for (const chunkId of ids) {
      const row = byId.get(chunkId);
      const slot = slots.get(chunkId);
      if (!row || slot === undefined || embedding.length !== cache.dimension) continue;
      let distance = 0;
      for (let index = 0; index < cache.dimension; index += 1) {
        const delta = cache.data[slot * cache.dimension + index] - embedding[index];
        distance += delta * delta;
      }
      let metadata: Record<string, unknown> = {};
      try {
        metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : {};
      } catch {
        metadata = {};
      }
      results.push({ chunkId, content: typeof row.document === "string" ? row.document : "", distance, metadata });
    }
    return results;
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
