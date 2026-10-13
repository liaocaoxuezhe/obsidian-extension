import { randomUUID } from "crypto";
import {
  MAX_VECTOR_STORE_BATCH,
  MAX_VECTOR_STORE_TOP_K,
  VECTOR_STORE_SCHEMA_VERSION,
  isValidCollectionName,
  vectorStoreError,
  type VectorMetadata,
  type VectorMetadataValue,
  type VectorStoreDocumentEntry,
  type VectorStoreGetResult,
  type VectorStoreQueryMatch,
  type VectorStoreRecord,
} from "./vector-store-protocol";

/** Structural subset of node:sqlite's DatabaseSync used by the engine. */
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface CollectionRow {
  id: string;
  name: string;
  dimension: number | null;
}

interface MatrixCache {
  dimension: number;
  ids: string[];
  slots: Map<string, number>;
  data: Float32Array;
  /** Squared L2 norm per slot, so a query needs one dot product per row. */
  norms: Float64Array;
  size: number;
}

function dotAt(data: Float32Array, offset: number, query: Float32Array, dimension: number): number {
  let sum0 = 0;
  let sum1 = 0;
  let sum2 = 0;
  let sum3 = 0;
  let index = 0;
  for (; index + 3 < dimension; index += 4) {
    sum0 += data[offset + index] * query[index];
    sum1 += data[offset + index + 1] * query[index + 1];
    sum2 += data[offset + index + 2] * query[index + 2];
    sum3 += data[offset + index + 3] * query[index + 3];
  }
  for (; index < dimension; index += 1) sum0 += data[offset + index] * query[index];
  return sum0 + sum1 + sum2 + sum3;
}

function squaredDistanceAt(data: Float32Array, offset: number, query: Float32Array, dimension: number): number {
  let distance = 0;
  for (let index = 0; index < dimension; index += 1) {
    const delta = data[offset + index] - query[index];
    distance += delta * delta;
  }
  return distance;
}

const MAX_RECORD_ID_LENGTH = 2048;
const MAX_METADATA_KEYS = 256;

function encodeEmbedding(values: readonly number[]): Uint8Array {
  const vector = Float32Array.from(values);
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

function decodeEmbedding(value: unknown): Float32Array {
  if (!(value instanceof Uint8Array) || value.byteLength % 4 !== 0) {
    throw vectorStoreError("VECTOR_STORE_RECORD_CORRUPT");
  }
  if (value.byteOffset % 4 === 0) {
    return new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4);
  }
  return new Float32Array(value.slice().buffer);
}

function parseMetadata(value: unknown): VectorMetadata | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw vectorStoreError("VECTOR_STORE_RECORD_CORRUPT");
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as VectorMetadata : null;
  } catch (error) {
    throw vectorStoreError("VECTOR_STORE_RECORD_CORRUPT", (error as Error).message);
  }
}

function validMetadata(value: unknown): value is VectorMetadata | null {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_METADATA_KEYS) return false;
  return entries.every(([key, item]) => key.length > 0 && key.length <= 256
    && (typeof item === "string" || typeof item === "boolean"
      || (typeof item === "number" && Number.isFinite(item))));
}

function normalizeMtime(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function whereValue(value: unknown): VectorMetadataValue {
  if (value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1 && "$eq" in (value as Record<string, unknown>)) {
    value = (value as Record<string, unknown>).$eq;
  }
  if (typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))) {
    return value;
  }
  throw vectorStoreError("VECTOR_STORE_WHERE_UNSUPPORTED");
}

/** Bounded max-heap that keeps the `limit` smallest distances. */
class NearestSelector {
  private readonly slots: number[] = [];
  private readonly distances: number[] = [];

  constructor(private readonly limit: number) {}

  offer(slot: number, distance: number): void {
    if (this.slots.length < this.limit) {
      this.slots.push(slot);
      this.distances.push(distance);
      this.siftUp(this.slots.length - 1);
      return;
    }
    if (distance >= this.distances[0]) return;
    this.slots[0] = slot;
    this.distances[0] = distance;
    this.siftDown(0);
  }

  sorted(): Array<{ slot: number; distance: number }> {
    return this.slots
      .map((slot, index) => ({ slot, distance: this.distances[index] }))
      .sort((left, right) => left.distance - right.distance || left.slot - right.slot);
  }

  private swap(left: number, right: number): void {
    [this.slots[left], this.slots[right]] = [this.slots[right], this.slots[left]];
    [this.distances[left], this.distances[right]] = [this.distances[right], this.distances[left]];
  }

  private siftUp(index: number): void {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.distances[parent] >= this.distances[index]) return;
      this.swap(parent, index);
      index = parent;
    }
  }

  private siftDown(index: number): void {
    const size = this.slots.length;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let largest = index;
      if (left < size && this.distances[left] > this.distances[largest]) largest = left;
      if (right < size && this.distances[right] > this.distances[largest]) largest = right;
      if (largest === index) return;
      this.swap(largest, index);
      index = largest;
    }
  }
}

/**
 * Embedded vector store backed by SQLite. Runs only inside the vector-store
 * worker process; the Obsidian renderer talks to it over the worker protocol.
 */
export class VectorStoreEngine {
  private readonly caches = new Map<string, MatrixCache>();

  constructor(private readonly db: SqliteDatabase) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collections (
        name TEXT PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        dimension INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS records (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        doc_id TEXT,
        document TEXT,
        metadata TEXT,
        embedding BLOB NOT NULL,
        UNIQUE (collection_id, id)
      );
      CREATE INDEX IF NOT EXISTS records_by_document ON records (collection_id, doc_id);
    `);
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (!version) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(VECTOR_STORE_SCHEMA_VERSION));
    } else if (Number(version.value) !== VECTOR_STORE_SCHEMA_VERSION) {
      throw vectorStoreError("VECTOR_STORE_SCHEMA_UNSUPPORTED");
    }
  }

  get schemaVersion(): number {
    return VECTOR_STORE_SCHEMA_VERSION;
  }

  close(): void {
    this.caches.clear();
    this.db.close();
  }

  collectionCount(): number {
    return Number(this.db.prepare("SELECT COUNT(*) AS total FROM collections").get()?.total ?? 0);
  }

  ensureCollection(name: string): { id: string; dimension: number | null } {
    if (!isValidCollectionName(name)) throw vectorStoreError("INVALID_CHROMA_COLLECTION_NAME");
    const existing = this.findCollection(name);
    if (existing) return { id: existing.id, dimension: existing.dimension };
    const id = randomUUID();
    this.db.prepare("INSERT INTO collections (name, id, dimension, created_at) VALUES (?, ?, NULL, ?)")
      .run(name, id, Date.now());
    return { id, dimension: null };
  }

  hasCollection(name: string): boolean {
    if (!isValidCollectionName(name)) throw vectorStoreError("INVALID_CHROMA_COLLECTION_NAME");
    return this.findCollection(name) !== null;
  }

  deleteCollection(name: string): { deleted: boolean } {
    if (!isValidCollectionName(name)) throw vectorStoreError("INVALID_CHROMA_COLLECTION_NAME");
    const collection = this.findCollection(name);
    if (!collection) return { deleted: false };
    this.transaction(() => {
      this.db.prepare("DELETE FROM records WHERE collection_id = ?").run(collection.id);
      this.db.prepare("DELETE FROM collections WHERE id = ?").run(collection.id);
    });
    this.caches.delete(collection.id);
    return { deleted: true };
  }

  upsert(name: string, records: readonly VectorStoreRecord[]): { upserted: number } {
    const collection = this.requireCollection(name);
    if (!Array.isArray(records)) throw vectorStoreError("CHROMA_VECTOR_RECORD_INVALID");
    if (records.length === 0) return { upserted: 0 };
    if (records.length > MAX_VECTOR_STORE_BATCH) throw vectorStoreError("CHROMA_VECTOR_BATCH_TOO_LARGE");
    const dimension = collection.dimension ?? records[0]?.embedding?.length ?? 0;
    if (!Number.isSafeInteger(dimension) || dimension < 1) throw vectorStoreError("CHROMA_VECTOR_RECORD_INVALID");
    const seen = new Set<string>();
    for (const record of records) {
      if (!record || typeof record.id !== "string" || record.id.length < 1
        || record.id.length > MAX_RECORD_ID_LENGTH || seen.has(record.id)
        || (record.document !== null && typeof record.document !== "string")
        || !Array.isArray(record.embedding) || record.embedding.length < 1
        || record.embedding.some((value: unknown) => typeof value !== "number" || !Number.isFinite(value))
        || !validMetadata(record.metadata)) {
        throw vectorStoreError("CHROMA_VECTOR_RECORD_INVALID");
      }
      if (record.embedding.length !== dimension) throw vectorStoreError("CHROMA_VECTOR_DIMENSION_MISMATCH");
      seen.add(record.id);
    }
    const statement = this.db.prepare(`
      INSERT INTO records (collection_id, id, doc_id, document, metadata, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (collection_id, id) DO UPDATE SET
        doc_id = excluded.doc_id,
        document = excluded.document,
        metadata = excluded.metadata,
        embedding = excluded.embedding
    `);
    this.transaction(() => {
      if (collection.dimension === null) {
        this.db.prepare("UPDATE collections SET dimension = ? WHERE id = ?").run(dimension, collection.id);
      }
      for (const record of records) {
        const docId = typeof record.metadata?.doc_id === "string" ? record.metadata.doc_id : null;
        statement.run(
          collection.id,
          record.id,
          docId,
          record.document,
          record.metadata === null ? null : JSON.stringify(record.metadata),
          encodeEmbedding(record.embedding),
        );
      }
    });
    const cache = this.caches.get(collection.id);
    if (cache) {
      for (const record of records) this.cacheSet(cache, record.id, record.embedding);
    }
    return { upserted: records.length };
  }

  deleteByDocId(name: string, docId: string): { deleted: number } {
    const collection = this.requireCollection(name);
    if (typeof docId !== "string" || !docId) throw vectorStoreError("VECTOR_STORE_DOC_ID_INVALID");
    const ids = this.db.prepare("SELECT id FROM records WHERE collection_id = ? AND doc_id = ?")
      .all(collection.id, docId).map((row) => String(row.id));
    if (ids.length === 0) return { deleted: 0 };
    this.db.prepare("DELETE FROM records WHERE collection_id = ? AND doc_id = ?").run(collection.id, docId);
    const cache = this.caches.get(collection.id);
    if (cache) for (const id of ids) this.cacheDelete(cache, id);
    return { deleted: ids.length };
  }

  count(name: string): number {
    const collection = this.requireCollection(name);
    return Number(this.db.prepare("SELECT COUNT(*) AS total FROM records WHERE collection_id = ?")
      .get(collection.id)?.total ?? 0);
  }

  identityPage(name: string, offset: number, limit: number): string[] {
    const collection = this.requireCollection(name);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit)
      || limit < 1 || limit > MAX_VECTOR_STORE_BATCH) {
      throw vectorStoreError("CHROMA_VECTOR_PAGE_INVALID");
    }
    return this.db.prepare("SELECT id FROM records WHERE collection_id = ? ORDER BY seq LIMIT ? OFFSET ?")
      .all(collection.id, limit, offset).map((row) => String(row.id));
  }

  get(name: string, options: {
    ids?: string[];
    where?: Record<string, unknown>;
    offset?: number;
    limit?: number;
    includeDocuments?: boolean;
    includeEmbeddings?: boolean;
  } = {}): VectorStoreGetResult {
    const collection = this.requireCollection(name);
    const clauses = ["collection_id = ?"];
    const params: unknown[] = [collection.id];
    const metadataFilters: Array<[string, VectorMetadataValue]> = [];
    if (options.ids) {
      if (!Array.isArray(options.ids) || options.ids.some((id) => typeof id !== "string")) {
        throw vectorStoreError("VECTOR_STORE_IDS_INVALID");
      }
      if (options.ids.length === 0) {
        return { ids: [], metadatas: [], ...(options.includeDocuments === false ? {} : { documents: [] }),
          ...(options.includeEmbeddings ? { embeddings: [] } : {}) };
      }
      clauses.push(`id IN (${options.ids.map(() => "?").join(", ")})`);
      params.push(...options.ids);
    }
    if (options.where) {
      if (typeof options.where !== "object" || Array.isArray(options.where)) {
        throw vectorStoreError("VECTOR_STORE_WHERE_UNSUPPORTED");
      }
      for (const [key, raw] of Object.entries(options.where)) {
        if (key.startsWith("$")) throw vectorStoreError("VECTOR_STORE_WHERE_UNSUPPORTED");
        const value = whereValue(raw);
        if (key === "doc_id" && typeof value === "string") {
          clauses.push("doc_id = ?");
          params.push(value);
        } else {
          metadataFilters.push([key, value]);
        }
      }
    }
    let sql = `SELECT id, document, metadata${options.includeEmbeddings ? ", embedding" : ""}
      FROM records WHERE ${clauses.join(" AND ")} ORDER BY seq`;
    const paged = options.offset !== undefined || options.limit !== undefined;
    if (paged && metadataFilters.length === 0) {
      const offset = options.offset ?? 0;
      const limit = options.limit ?? -1;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < -1 || limit === 0) {
        throw vectorStoreError("CHROMA_VECTOR_PAGE_INVALID");
      }
      sql += " LIMIT ? OFFSET ?";
      params.push(limit, offset);
    }
    let rows = this.db.prepare(sql).all(...params);
    let metadatas = rows.map((row) => parseMetadata(row.metadata));
    if (metadataFilters.length > 0) {
      const keep = metadatas.map((metadata) => metadataFilters.every(([key, value]) => metadata?.[key] === value));
      rows = rows.filter((_, index) => keep[index]);
      metadatas = metadatas.filter((_, index) => keep[index]);
      if (paged) {
        const offset = options.offset ?? 0;
        const end = options.limit === undefined ? undefined : offset + options.limit;
        rows = rows.slice(offset, end);
        metadatas = metadatas.slice(offset, end);
      }
    }
    return {
      ids: rows.map((row) => String(row.id)),
      metadatas,
      ...(options.includeDocuments === false ? {} : {
        documents: rows.map((row) => (typeof row.document === "string" ? row.document : null)),
      }),
      ...(options.includeEmbeddings ? {
        embeddings: rows.map((row) => Array.from(decodeEmbedding(row.embedding))),
      } : {}),
    };
  }

  query(name: string, embedding: readonly number[], topK: number): VectorStoreQueryMatch[] {
    const collection = this.requireCollection(name);
    if (!Number.isSafeInteger(topK) || topK < 1 || topK > MAX_VECTOR_STORE_TOP_K) {
      throw vectorStoreError("VECTOR_STORE_TOP_K_INVALID");
    }
    if (!Array.isArray(embedding) || embedding.length < 1
      || embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw vectorStoreError("VECTOR_STORE_QUERY_INVALID");
    }
    const cache = this.loadCache(collection);
    if (cache.size === 0) return [];
    if (embedding.length !== cache.dimension) throw vectorStoreError("CHROMA_VECTOR_DIMENSION_MISMATCH");
    const query = Float32Array.from(embedding);
    const dimension = cache.dimension;
    const data = cache.data;
    const norms = cache.norms;
    const queryNorm = dotAt(query, 0, query, dimension);
    const selector = new NearestSelector(Math.min(topK, cache.size));
    // ||a - b||^2 = ||a||^2 + ||b||^2 - 2a.b ranks rows with a single dot product each.
    for (let slot = 0; slot < cache.size; slot += 1) {
      selector.offer(slot, norms[slot] + queryNorm - 2 * dotAt(data, slot * dimension, query, dimension));
    }
    // Report exact squared-L2 distances (Chroma's default space) for the winners.
    const nearest = selector.sorted()
      .map(({ slot }) => ({ slot, distance: squaredDistanceAt(data, slot * dimension, query, dimension) }))
      .sort((left, right) => left.distance - right.distance || left.slot - right.slot);
    const ids = nearest.map(({ slot }) => cache.ids[slot]);
    const rows = this.db.prepare(
      `SELECT id, document, metadata FROM records WHERE collection_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
    ).all(collection.id, ...ids);
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    return nearest.map(({ slot, distance }) => {
      const id = cache.ids[slot];
      const row = byId.get(id);
      return {
        id,
        document: typeof row?.document === "string" ? row.document : null,
        metadata: parseMetadata(row?.metadata ?? null),
        distance,
      };
    });
  }

  documentEntries(name: string): VectorStoreDocumentEntry[] {
    const collection = this.requireCollection(name);
    const entries = new Map<string, VectorStoreDocumentEntry>();
    const rows = this.db.prepare("SELECT metadata FROM records WHERE collection_id = ? ORDER BY seq").all(collection.id);
    for (const row of rows) {
      const meta = parseMetadata(row.metadata) as Record<string, unknown> | null;
      const docId = typeof meta?.doc_id === "string" ? meta.doc_id : "";
      if (!docId) continue;
      const existing = entries.get(docId);
      const path = typeof meta?.path === "string" && meta.path ? meta.path : docId;
      const mtime = normalizeMtime(meta?.mtime);
      const metadataComplete = typeof meta?.path === "string" && meta.path.length > 0
        && Number.isFinite(Number(meta?.mtime))
        && Number.isFinite(Number(meta?.chunk_index))
        && Number.isFinite(Number(meta?.chunk_count))
        && Object.prototype.hasOwnProperty.call(meta ?? {}, "section_label");
      if (existing) {
        existing.chunkCount++;
        if (mtime > existing.mtime) existing.mtime = mtime;
        if (!existing.path && path) existing.path = path;
        if (!metadataComplete) existing.needsReindex = true;
      } else {
        entries.set(docId, {
          docId,
          path,
          mtime,
          chunkCount: 1,
          ...(!metadataComplete ? { needsReindex: true } : {}),
        });
      }
    }
    return Array.from(entries.values());
  }

  private findCollection(name: string): CollectionRow | null {
    const row = this.db.prepare("SELECT id, name, dimension FROM collections WHERE name = ?").get(name);
    if (!row) return null;
    return {
      id: String(row.id),
      name: String(row.name),
      dimension: row.dimension === null || row.dimension === undefined ? null : Number(row.dimension),
    };
  }

  private requireCollection(name: string): CollectionRow {
    if (!isValidCollectionName(name)) throw vectorStoreError("INVALID_CHROMA_COLLECTION_NAME");
    const collection = this.findCollection(name);
    if (!collection) throw vectorStoreError("VECTOR_STORE_COLLECTION_NOT_FOUND");
    return collection;
  }

  private transaction(operation: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      operation();
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  private loadCache(collection: CollectionRow): MatrixCache {
    const existing = this.caches.get(collection.id);
    if (existing) return existing;
    const rows = this.db.prepare("SELECT id, embedding FROM records WHERE collection_id = ? ORDER BY seq")
      .all(collection.id);
    const dimension = collection.dimension ?? (rows[0] ? decodeEmbedding(rows[0].embedding).length : 0);
    const cache: MatrixCache = {
      dimension,
      ids: [],
      slots: new Map(),
      data: new Float32Array(Math.max(1, rows.length) * Math.max(1, dimension)),
      norms: new Float64Array(Math.max(1, rows.length)),
      size: 0,
    };
    for (const row of rows) {
      const vector = decodeEmbedding(row.embedding);
      if (vector.length !== dimension) throw vectorStoreError("VECTOR_STORE_RECORD_CORRUPT");
      const id = String(row.id);
      cache.data.set(vector, cache.size * dimension);
      cache.norms[cache.size] = dotAt(vector, 0, vector, dimension);
      cache.ids.push(id);
      cache.slots.set(id, cache.size);
      cache.size += 1;
    }
    this.caches.set(collection.id, cache);
    return cache;
  }

  private cacheSet(cache: MatrixCache, id: string, embedding: readonly number[]): void {
    if (cache.dimension === 0) cache.dimension = embedding.length;
    const vector = Float32Array.from(embedding);
    const norm = dotAt(vector, 0, vector, cache.dimension);
    const existing = cache.slots.get(id);
    if (existing !== undefined) {
      cache.data.set(vector, existing * cache.dimension);
      cache.norms[existing] = norm;
      return;
    }
    const required = (cache.size + 1) * cache.dimension;
    if (required > cache.data.length) {
      const grown = new Float32Array(Math.max(required, cache.data.length * 2));
      grown.set(cache.data.subarray(0, cache.size * cache.dimension));
      cache.data = grown;
    }
    if (cache.size + 1 > cache.norms.length) {
      const grownNorms = new Float64Array(Math.max(cache.size + 1, cache.norms.length * 2));
      grownNorms.set(cache.norms.subarray(0, cache.size));
      cache.norms = grownNorms;
    }
    cache.data.set(vector, cache.size * cache.dimension);
    cache.norms[cache.size] = norm;
    cache.ids.push(id);
    cache.slots.set(id, cache.size);
    cache.size += 1;
  }

  private cacheDelete(cache: MatrixCache, id: string): void {
    const slot = cache.slots.get(id);
    if (slot === undefined) return;
    const last = cache.size - 1;
    if (slot !== last) {
      const lastId = cache.ids[last];
      cache.data.copyWithin(slot * cache.dimension, last * cache.dimension, (last + 1) * cache.dimension);
      cache.norms[slot] = cache.norms[last];
      cache.ids[slot] = lastId;
      cache.slots.set(lastId, slot);
    }
    cache.ids.pop();
    cache.slots.delete(id);
    cache.size = last;
  }
}
