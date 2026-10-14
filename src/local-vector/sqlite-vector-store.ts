import {
  assertValidCollectionName,
  type ChromaGetOptions,
  type ChromaGetResponse,
  type ChromaVectorRecord,
  type DocumentChunk,
  type DocumentMetadata,
  type IndexedDocumentEntry,
  type SearchResult,
  type VectorStore,
} from "./vector-store";
import { MAX_VECTOR_STORE_BATCH, type VectorMetadata, type VectorStoreRecord } from "./vector-store-protocol";
import type { VectorStoreHost } from "./vector-store-host";

type VectorStoreRequester = Pick<VectorStoreHost, "request">;

/**
 * VectorStore backed by the SQLite child process. The `port` arguments are kept
 * for signature compatibility with the former Chroma client and are ignored.
 */
export class SqliteVectorStore implements VectorStore {
  private collectionName = "";

  constructor(private readonly host: VectorStoreRequester) {}

  getCollectionName(): string {
    return this.collectionName;
  }

  async initialize(
    _port: number,
    vaultId: string,
    modelShortName: string,
    explicitCollectionName?: string,
  ): Promise<void> {
    this.collectionName = assertValidCollectionName(vaultId, modelShortName, explicitCollectionName);
    await this.ensureCollection(this.collectionName);
  }

  async ensureCollection(name: string): Promise<void> {
    await this.host.request("ensureCollection", { name });
    this.collectionName = name;
  }

  async upsertDocument(docId: string, chunks: DocumentChunk[], metadata: DocumentMetadata): Promise<void> {
    if (chunks.length === 0) return;
    const records: VectorStoreRecord[] = chunks.map((chunk) => ({
      id: chunk.chunkId,
      document: chunk.content,
      embedding: chunk.embedding,
      metadata: {
        ...metadata,
        doc_id: docId,
        chunk_index: chunk.chunkIndex,
        chunk_count: chunk.chunkCount,
        section_label: chunk.sectionLabel,
      },
    }));
    for (let offset = 0; offset < records.length; offset += MAX_VECTOR_STORE_BATCH) {
      await this.host.request("upsert", {
        collection: this.requireCollection(),
        records: records.slice(offset, offset + MAX_VECTOR_STORE_BATCH),
      });
    }
  }

  async upsertRecords(records: readonly ChromaVectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    if (records.length > MAX_VECTOR_STORE_BATCH) throw new Error("CHROMA_VECTOR_BATCH_TOO_LARGE");
    await this.host.request("upsert", {
      collection: this.requireCollection(),
      records: records.map((record) => ({
        id: record.id,
        document: record.document,
        metadata: record.metadata as VectorMetadata | null,
        embedding: record.embedding,
      })),
    });
  }

  async getRecordIdentityPage(offset: number, limit: number): Promise<{ ids: string[] }> {
    return { ids: await this.host.request("identityPage", { collection: this.requireCollection(), offset, limit }) };
  }

  async deleteDocument(docId: string): Promise<void> {
    await this.host.request("deleteByDocId", { collection: this.requireCollection(), docId });
  }

  async deleteCollectionByName(_port: number, name: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/.test(name)) {
      throw new Error("INVALID_CHROMA_COLLECTION_NAME");
    }
    await this.host.request("deleteCollection", { name });
  }

  async search(queryEmbedding: number[], topK: number = 5): Promise<SearchResult[]> {
    const matches = await this.host.request("query", {
      collection: this.requireCollection(),
      embedding: queryEmbedding,
      topK,
    });
    return matches.map((match) => ({
      chunkId: match.id,
      content: match.document || "",
      distance: match.distance,
      score: match.distance,
      metadata: match.metadata || {},
    }));
  }

  async hybridSearch(queryEmbedding: number[], queryText: string, topK: number, keywordWeight: number): Promise<SearchResult[]> {
    const matches = await this.host.request("hybridQuery", {
      collection: this.requireCollection(),
      embedding: queryEmbedding,
      text: queryText,
      topK,
      keywordWeight,
    });
    return matches.map((match) => ({
      chunkId: match.id,
      content: match.document || "",
      distance: match.distance,
      score: match.distance,
      metadata: match.metadata || {},
      matchedBy: match.matchedBy,
    }));
  }

  async count(): Promise<number> {
    return await this.host.request("count", { collection: this.requireCollection() });
  }

  async getChunks(options: ChromaGetOptions = {}): Promise<ChromaGetResponse> {
    return await this.host.request("get", {
      collection: this.requireCollection(),
      ...(options.ids ? { ids: options.ids } : {}),
      ...(options.where ? { where: options.where as Record<string, string | number | boolean> } : {}),
      includeDocuments: options.includeDocuments !== false,
      includeEmbeddings: Boolean(options.includeEmbedding),
    });
  }

  async listIndexedDocs(): Promise<string[]> {
    return (await this.listIndexedDocumentEntries()).map((entry) => entry.docId);
  }

  async listIndexedDocumentEntries(): Promise<IndexedDocumentEntry[]> {
    return await this.host.request("documentEntries", { collection: this.requireCollection() });
  }

  private requireCollection(): string {
    if (!this.collectionName) throw new Error("Collection not initialized");
    return this.collectionName;
  }
}
