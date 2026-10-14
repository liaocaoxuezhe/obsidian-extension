export type VectorMetadataValue = string | number | boolean;
export type VectorMetadata = Record<string, VectorMetadataValue>;

export interface VectorStoreRecord {
  id: string;
  document: string | null;
  metadata: VectorMetadata | null;
  embedding: number[];
}

export interface VectorStoreQueryMatch {
  id: string;
  document: string | null;
  metadata: VectorMetadata | null;
  distance: number;
}

export interface VectorStoreHybridMatch extends VectorStoreQueryMatch {
  /** Reciprocal rank fusion score; present when keyword search took part. */
  fusedScore?: number;
  matchedBy: Array<"vector" | "keyword">;
}

export interface VectorStoreFtsStatus {
  state: "ready" | "backfilling" | "unavailable";
  indexed: number;
  total: number;
}

export interface VectorStoreGetResult {
  ids: string[];
  documents?: (string | null)[];
  metadatas: (VectorMetadata | null)[];
  embeddings?: number[][];
}

export interface VectorStoreDocumentEntry {
  docId: string;
  path: string;
  mtime: number;
  chunkCount: number;
  needsReindex?: boolean;
}

export interface VectorStoreOperations {
  open: { params: { databasePath: string }; result: { schemaVersion: number } };
  health: { params: Record<string, never>; result: { collections: number; rss: number } };
  ensureCollection: { params: { name: string }; result: { id: string; dimension: number | null } };
  hasCollection: { params: { name: string }; result: boolean };
  deleteCollection: { params: { name: string }; result: { deleted: boolean } };
  upsert: { params: { collection: string; records: VectorStoreRecord[] }; result: { upserted: number } };
  deleteByDocId: { params: { collection: string; docId: string }; result: { deleted: number } };
  count: { params: { collection: string }; result: number };
  identityPage: { params: { collection: string; offset: number; limit: number }; result: string[] };
  get: {
    params: {
      collection: string;
      ids?: string[];
      where?: Record<string, VectorMetadataValue>;
      offset?: number;
      limit?: number;
      includeDocuments?: boolean;
      includeEmbeddings?: boolean;
    };
    result: VectorStoreGetResult;
  };
  query: {
    params: { collection: string; embedding: number[]; topK: number };
    result: VectorStoreQueryMatch[];
  };
  hybridQuery: {
    params: { collection: string; embedding: number[]; text: string; topK: number; keywordWeight?: number };
    result: VectorStoreHybridMatch[];
  };
  keywordStatus: { params: Record<string, never>; result: VectorStoreFtsStatus };
  documentEntries: { params: { collection: string }; result: VectorStoreDocumentEntry[] };
  close: { params: Record<string, never>; result: { closed: true } };
}

export type VectorStoreOperation = keyof VectorStoreOperations;

export interface VectorStoreRequest<K extends VectorStoreOperation = VectorStoreOperation> {
  id: string;
  op: K;
  params: VectorStoreOperations[K]["params"];
}

export type VectorStoreResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };

export const VECTOR_STORE_SCHEMA_VERSION = 1;
export const VECTOR_STORE_WORKER_ROLE = "vector-store";
export const MAX_VECTOR_STORE_BATCH = 1024;
export const MAX_VECTOR_STORE_TOP_K = 1000;

export function vectorStoreError(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function isValidCollectionName(name: unknown): name is string {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/.test(name);
}
