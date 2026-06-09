import { request } from "http";

const TENANT = "default_tenant";
const DATABASE = "default_database";
type ChromaApiVersion = "v1" | "v2";

export interface SearchResult {
  chunkId: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface CollectionInfo {
  id: string;
  name: string;
  metadata: Record<string, unknown> | null;
}

export class ChromaClient {
  private port: number;
  private apiVersion: ChromaApiVersion | null = null;

  constructor(port: number) {
    this.port = port;
  }

  async healthCheck(): Promise<boolean> {
    const version = await this.detectApiVersion();
    if (version) {
      this.apiVersion = version;
      return true;
    }
    return false;
  }

  async listCollections(): Promise<CollectionInfo[]> {
    await this.ensureApiVersion();
    const path = this.apiVersion === "v2"
      ? `/api/v2/tenants/${TENANT}/databases/${DATABASE}/collections`
      : "/api/v1/collections";
    return this.requestJson<CollectionInfo[]>("GET", path);
  }

  async getCollectionByName(name: string): Promise<CollectionInfo | null> {
    const collections = await this.listCollections();
    return collections.find((c) => c.name === name) ?? null;
  }

  async searchCollection(
    collectionId: string,
    queryEmbedding: number[],
    topK: number
  ): Promise<SearchResult[]> {
    const result = await this.requestJson<{
      ids: string[][];
      documents: (string | null)[][];
      distances?: number[][];
      metadatas?: Record<string, unknown>[][];
    }>("POST", this.collectionPath(collectionId, "/query"), {
      query_embeddings: [queryEmbedding],
      n_results: topK,
      include: ["documents", "metadatas", "distances"],
    });

    const ids = result.ids?.[0] ?? [];
    const documents = result.documents?.[0] ?? [];
    const distances = result.distances?.[0] ?? [];
    const metadatas = result.metadatas?.[0] ?? [];

    return ids.map((id, i) => ({
      chunkId: id,
      content: documents[i] || "",
      score: distances[i] ?? 0,
      metadata: metadatas[i] || {},
    }));
  }

  async countCollection(collectionId: string): Promise<number> {
    return this.requestJson<number>(
      "GET",
      this.collectionPath(collectionId, "/count")
    );
  }

  private collectionPath(collectionId: string, suffix: string): string {
    if (!/^[a-f0-9-]+$/i.test(collectionId)) {
      throw new Error(`Invalid collection ID: "${collectionId}". Expected UUID format.`);
    }
    if (this.apiVersion === "v2") {
      return `/api/v2/tenants/${TENANT}/databases/${DATABASE}/collections/${collectionId}${suffix}`;
    }
    return `/api/v1/collections/${collectionId}${suffix}`;
  }

  private async ensureApiVersion(): Promise<void> {
    if (this.apiVersion) return;
    const version = await this.detectApiVersion();
    if (!version) {
      throw new Error("ChromaDB heartbeat failed on both /api/v2/heartbeat and /api/v1/heartbeat");
    }
    this.apiVersion = version;
  }

  private async detectApiVersion(): Promise<ChromaApiVersion | null> {
    if (await this.isEndpointHealthy("/api/v2/heartbeat")) return "v2";
    if (await this.isEndpointHealthy("/api/v1/heartbeat")) return "v1";
    return null;
  }

  private async isEndpointHealthy(path: string): Promise<boolean> {
    try {
      await this.requestJson("GET", path);
      return true;
    } catch {
      return false;
    }
  }

  private requestJson<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload =
        body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path,
          method,
          timeout: 15000,
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
          res.on("data", (chunk) => (responseBody += chunk));
          res.on("end", () => {
            const statusCode = res.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
              reject(
                new Error(
                  `ChromaDB ${method} ${path} returned HTTP ${statusCode}: ${responseBody}`
                )
              );
              return;
            }
            if (!responseBody) {
              resolve(undefined as unknown as T);
              return;
            }
            try {
              resolve(JSON.parse(responseBody) as T);
            } catch (err) {
              reject(
                new Error(
                  `ChromaDB returned invalid JSON for ${method} ${path}: ${(err as Error).message}`
                )
              );
            }
          });
        }
      );
      req.on("error", (err) =>
        reject(
          new Error(
            `Failed to connect to ChromaDB at 127.0.0.1:${this.port} — ${err.message}. ` +
              `Make sure the Analogy Obsidian plugin is running and ChromaDB is started.`
          )
        )
      );
      req.on("timeout", () => {
        req.destroy();
        reject(
          new Error(
            `ChromaDB request timed out: ${method} ${path}. The server at 127.0.0.1:${this.port} is not responding.`
          )
        );
      });
      if (payload) req.write(payload);
      req.end();
    });
  }
}
