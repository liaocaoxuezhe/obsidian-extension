import { request } from "http";

const TENANT = "default_tenant";
const DATABASE = "default_database";

export interface SearchResult {
  chunkId: string;
  content: string;
  distance: number;
  score: number;
  metadata: any;
}

export interface DocumentChunk {
  chunkId: string;
  content: string;
  embedding: number[];
  chunkIndex: number;
  chunkCount: number;
  sectionLabel: string;
}

export interface DocumentMetadata {
  title: string;
  path: string;
  mtime: number;
}

export interface ChromaGetOptions {
  ids?: string[];
  where?: Record<string, unknown>;
  includeDocuments?: boolean;
  includeEmbedding?: boolean;
}

export interface ChromaGetResponse {
  ids?: string[] | string[][];
  documents?: (string | null)[] | (string | null)[][];
  metadatas?: any[] | any[][];
  embeddings?: number[][] | number[][][];
}

export interface IndexedDocumentEntry {
  docId: string;
  path: string;
  mtime: number;
  chunkCount: number;
}

export interface ChromaVectorRecord {
  id: string;
  document: string | null;
  metadata: Record<string, string | number | boolean> | null;
  embedding: number[];
}

export class LocalVectorStore {
  private collectionId: string | null = null;
  private collectionName: string = "";
  private port: number = 8000;

  async initialize(
    port: number,
    vaultId: string,
    modelShortName: string,
    explicitCollectionName?: string,
  ): Promise<void> {
    this.port = port;
    await this.ensureV2Available();
    const suffix = `_${modelShortName}`;
    const expectedPrefix = `analogy_${vaultId}${suffix}`;
    if (explicitCollectionName !== undefined
      && explicitCollectionName !== expectedPrefix
      && !new RegExp(`^${expectedPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_[0-9a-f]{12}$`).test(explicitCollectionName)) {
      throw new Error("INVALID_CHROMA_COLLECTION_NAME");
    }
    this.collectionName = explicitCollectionName ?? expectedPrefix;
    await this.ensureCollection(this.collectionName);
  }

  async ensureCollection(name: string): Promise<void> {
    const path = `/api/v2/tenants/${TENANT}/databases/${DATABASE}/collections`;
    const body = {
      name,
      configuration: null,
      get_or_create: true,
      metadata: { description: "Analogy Obsidian local vector store" },
    };
    const collection = await this.requestJson<{ id: string }>(
      "POST",
      path,
      body
    );
    this.collectionId = collection.id;
  }

  async upsertDocument(
    docId: string,
    chunks: DocumentChunk[],
    metadata: DocumentMetadata
  ): Promise<void> {
    await this.ensureCollectionReady();
    if (chunks.length === 0) return;

    await this.requestJson("POST", this.collectionPath("/upsert"), {
      ids: chunks.map((c) => c.chunkId),
      documents: chunks.map((c) => c.content),
      embeddings: chunks.map((c) => c.embedding),
      metadatas: chunks.map((chunk) => ({
        ...metadata,
        doc_id: docId,
        chunk_index: chunk.chunkIndex,
        chunk_count: chunk.chunkCount,
        section_label: chunk.sectionLabel,
      })),
    });
  }

  async upsertRecords(records: readonly ChromaVectorRecord[]): Promise<void> {
    await this.ensureCollectionReady();
    if (records.length === 0) return;
    if (records.length > 1024) throw new Error("CHROMA_VECTOR_BATCH_TOO_LARGE");
    const dimension = records[0]?.embedding.length ?? 0;
    if (dimension < 1) throw new Error("CHROMA_VECTOR_RECORD_INVALID");
    for (const record of records) {
      if (!record || typeof record.id !== "string" || record.id.length < 1 || record.id.length > 2048
        || (record.document !== null && typeof record.document !== "string")
        || !Array.isArray(record.embedding) || record.embedding.length < 1
        || record.embedding.some((value) => !Number.isFinite(value))
        || !this.validMigrationMetadata(record.metadata)) {
        throw new Error("CHROMA_VECTOR_RECORD_INVALID");
      }
      if (record.embedding.length !== dimension) throw new Error("CHROMA_VECTOR_DIMENSION_MISMATCH");
    }
    await this.requestJson("POST", this.collectionPath("/upsert"), {
      ids: records.map((record) => record.id),
      documents: records.map((record) => record.document),
      metadatas: records.map((record) => record.metadata),
      embeddings: records.map((record) => record.embedding),
    });
  }

  async getRecordIdentityPage(offset: number, limit: number): Promise<{ ids: string[] }> {
    await this.ensureCollectionReady();
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1024) {
      throw new Error("CHROMA_VECTOR_PAGE_INVALID");
    }
    const response = await this.requestJson<{ ids?: unknown }>("POST", this.collectionPath("/get"), {
      offset,
      limit,
      include: [],
    });
    if (!response || !Array.isArray(response.ids)
      || response.ids.some((id) => typeof id !== "string" || !id || id.length > 2048)) {
      throw new Error("CHROMA_VECTOR_PAGE_INVALID");
    }
    return { ids: response.ids as string[] };
  }

  async deleteDocument(docId: string): Promise<void> {
    await this.ensureCollectionReady();
    await this.requestJson("POST", this.collectionPath("/delete"), { where: { doc_id: docId } });
  }

  async deleteCollectionByName(port: number, name: string): Promise<void> {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error("INVALID_CHROMA_PORT");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/.test(name)) {
      throw new Error("INVALID_CHROMA_COLLECTION_NAME");
    }
    this.port = port;
    await this.requestJson(
      "DELETE",
      `/api/v2/tenants/${TENANT}/databases/${DATABASE}/collections/${encodeURIComponent(name)}`,
    );
    if (this.collectionName === name) this.collectionId = null;
  }

  async search(queryEmbedding: number[], topK: number = 5): Promise<SearchResult[]> {
    await this.ensureCollectionReady();
    const result = await this.requestJson<{
      ids: string[][];
      documents: (string | null)[][];
      distances?: number[][];
      metadatas?: any[][];
    }>("POST", this.collectionPath("/query"), {
      query_embeddings: [queryEmbedding],
      n_results: topK,
    });

    const ids = result.ids?.[0] ?? [];
    const documents = result.documents?.[0] ?? [];
    const distances = result.distances?.[0] ?? [];
    const metadatas = result.metadatas?.[0] ?? [];

    return ids.map((id, index) => ({
      chunkId: id,
      content: documents[index] || "",
      distance: distances[index] ?? 0,
      score: distances[index] ?? 0,
      metadata: metadatas[index] || {},
    }));
  }

  async count(): Promise<number> {
    await this.ensureCollectionReady();
    return await this.requestJson<number>("GET", this.collectionPath("/count"));
  }

  async getChunks(options: ChromaGetOptions = {}): Promise<ChromaGetResponse> {
    await this.ensureCollectionReady();
    return await this.requestJson<ChromaGetResponse>("POST", this.collectionPath("/get"), {
      ...(options.ids ? { ids: options.ids } : {}),
      ...(options.where ? { where: options.where } : {}),
      include: [
        ...(options.includeDocuments === false ? [] : ["documents"]),
        "metadatas",
        ...(options.includeEmbedding ? ["embeddings"] : []),
      ],
    });
  }

  async listIndexedDocs(): Promise<string[]> {
    await this.ensureCollectionReady();
    const docIds = new Set<string>();
    for (const meta of await this.listAllMetadatas()) {
      if (meta?.doc_id) {
        docIds.add(meta.doc_id);
      }
    }
    return Array.from(docIds);
  }

  async listIndexedDocumentEntries(): Promise<IndexedDocumentEntry[]> {
    await this.ensureCollectionReady();
    const entries = new Map<string, IndexedDocumentEntry>();

    for (const meta of await this.listAllMetadatas()) {
      const docId = typeof meta?.doc_id === "string" ? meta.doc_id : "";
      if (!docId) continue;

      const existing = entries.get(docId);
      const path = typeof meta?.path === "string" && meta.path ? meta.path : docId;
      const mtime = this.normalizeMtime(meta?.mtime);
      if (existing) {
        existing.chunkCount++;
        if (mtime > existing.mtime) existing.mtime = mtime;
        if (!existing.path && path) existing.path = path;
      } else {
        entries.set(docId, {
          docId,
          path,
          mtime,
          chunkCount: 1,
        });
      }
    }

    return Array.from(entries.values());
  }

  private async listAllMetadatas(): Promise<any[]> {
    const total = await this.count();
    const all: any[] = [];
    const pageSize = 1024;
    for (let offset = 0; offset < total; offset += pageSize) {
      const limit = Math.min(pageSize, total - offset);
      const page = await this.requestJson<{ ids?: unknown; metadatas?: any[] | any[][] }>(
        "POST",
        this.collectionPath("/get"),
        { offset, limit, include: ["metadatas"] },
      );
      if (!Array.isArray(page.ids)) throw new Error("CHROMA_VECTOR_PAGE_INVALID");
      const metadatas = this.normalizeMetadatas(page.metadatas);
      if (page.ids.length !== metadatas.length || page.ids.length !== limit) {
        throw new Error("CHROMA_VECTOR_PAGE_INVALID");
      }
      all.push(...metadatas);
    }
    return all;
  }

  private async ensureCollectionReady(): Promise<void> {
    if (!this.collectionId) {
      await this.ensureCollection(this.collectionName);
    }
  }

  private collectionPath(suffix: string): string {
    if (!this.collectionId) {
      throw new Error("Collection not initialized");
    }
    return `/api/v2/tenants/${TENANT}/databases/${DATABASE}/collections/${this.collectionId}${suffix}`;
  }

  private normalizeMetadatas(metadatas: any[] | any[][] | null | undefined): any[] {
    if (!metadatas) return [];
    if (Array.isArray(metadatas[0])) {
      return metadatas[0] as any[];
    }
    return metadatas as any[];
  }

  private normalizeMtime(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  private validMigrationMetadata(
    value: Record<string, string | number | boolean> | null,
  ): boolean {
    if (value === null) return true;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const entries = Object.entries(value);
    if (entries.length > 256) return false;
    return entries.every(([key, item]) => key.length > 0 && key.length <= 256
      && (typeof item === "string" || typeof item === "boolean"
        || (typeof item === "number" && Number.isFinite(item))));
  }

  private async requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path,
          method,
          timeout: 10000,
          headers: payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : undefined,
        },
        (res) => {
          let responseBody = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            responseBody += chunk;
          });
          res.on("end", () => {
            const statusCode = res.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
              reject(new Error(`ChromaDB ${method} ${path} failed with HTTP ${statusCode}: ${responseBody}`));
              return;
            }

            if (!responseBody) {
              resolve(undefined as unknown as T);
              return;
            }

            try {
              resolve(JSON.parse(responseBody) as T);
            } catch (err) {
              reject(new Error(`ChromaDB returned invalid JSON for ${method} ${path}: ${(err as Error).message}`));
            }
          });
        }
      );

      req.on("error", (err) => reject(err));
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`ChromaDB ${method} ${path} timed out`));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  private async ensureV2Available(): Promise<void> {
    if (!await this.isEndpointHealthy("/api/v2/heartbeat")) {
      throw new Error("ChromaDB heartbeat failed on /api/v2/heartbeat");
    }
  }

  private async isEndpointHealthy(path: string): Promise<boolean> {
    try {
      await this.requestJson("GET", path);
      return true;
    } catch {
      return false;
    }
  }
}
