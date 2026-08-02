import { request } from "http";

const TENANT = "default_tenant";
const DATABASE = "default_database";
type ChromaApiVersion = "v1" | "v2";

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

export class LocalVectorStore {
  private collectionId: string | null = null;
  private collectionName: string = "";
  private port: number = 8000;
  private apiVersion: ChromaApiVersion = "v2";

  async initialize(port: number = 8000, vaultId?: string, modelShortName?: string): Promise<void> {
    this.port = port;
    this.apiVersion = await this.detectApiVersion();
    const suffix = modelShortName ? `_${modelShortName}` : "";
    this.collectionName = vaultId
      ? `analogy_${vaultId}${suffix}`
      : `analogy_obsidian${suffix}`;
    await this.ensureCollection(this.collectionName);
  }

  async ensureCollection(name: string): Promise<void> {
    try {
      const path = this.apiVersion === "v2"
        ? `/api/v2/tenants/${TENANT}/databases/${DATABASE}/collections`
        : "/api/v1/collections";
      const body = this.apiVersion === "v2"
        ? {
            name,
            configuration: null,
            get_or_create: true,
            metadata: { description: "Analogy Obsidian local vector store" },
          }
        : {
            name,
            get_or_create: true,
            metadata: { description: "Analogy Obsidian local vector store" },
          };
      const collection = await this.requestJson<{ id: string }>(
        "POST",
        path,
        body
      );
      this.collectionId = collection.id;
    } catch (err) {
      throw err;
    }
  }

  async upsertDocument(
    docId: string,
    chunks: DocumentChunk[],
    metadata: { title: string; path: string; mtime: number }
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

  async deleteDocument(docId: string): Promise<void> {
    await this.ensureCollectionReady();
    await this.requestJson("POST", this.collectionPath("/delete"), { where: { doc_id: docId } });
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
    const all = await this.requestJson<{ metadatas?: any[] | any[][] }>("POST", this.collectionPath("/get"), {});
    const docIds = new Set<string>();

    for (const meta of this.normalizeMetadatas(all.metadatas)) {
      if (meta?.doc_id) {
        docIds.add(meta.doc_id);
      }
    }
    return Array.from(docIds);
  }

  async listIndexedDocumentEntries(): Promise<IndexedDocumentEntry[]> {
    await this.ensureCollectionReady();
    const all = await this.requestJson<{ metadatas?: any[] | any[][] }>("POST", this.collectionPath("/get"), {});
    const entries = new Map<string, IndexedDocumentEntry>();

    for (const meta of this.normalizeMetadatas(all.metadatas)) {
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

  private async ensureCollectionReady(): Promise<void> {
    if (!this.collectionId) {
      await this.ensureCollection(this.collectionName);
    }
  }

  private collectionPath(suffix: string): string {
    if (!this.collectionId) {
      throw new Error("Collection not initialized");
    }
    if (this.apiVersion === "v2") {
      return `/api/v2/tenants/${TENANT}/databases/${DATABASE}/collections/${this.collectionId}${suffix}`;
    }
    return `/api/v1/collections/${this.collectionId}${suffix}`;
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

  private async detectApiVersion(): Promise<ChromaApiVersion> {
    if (await this.isEndpointHealthy("/api/v2/heartbeat")) return "v2";
    if (await this.isEndpointHealthy("/api/v1/heartbeat")) return "v1";
    throw new Error("ChromaDB heartbeat failed on both /api/v2/heartbeat and /api/v1/heartbeat");
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
