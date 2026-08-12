import type { LocalVectorStore, ChromaGetResponse } from "../local-vector/vector-store";
import type { ChunkRepository, IndexedChunk, IndexedDocumentEntry } from "./types";

type ChunkStore = Pick<LocalVectorStore, "getChunks" | "listIndexedDocumentEntries">;

export class ChromaChunkRepository implements ChunkRepository {
  constructor(private readonly vectorStore: ChunkStore) {}

  async getChunk(chunkId: string, includeEmbedding: boolean = false): Promise<IndexedChunk | null> {
    const response = await this.vectorStore.getChunks({ ids: [chunkId], includeEmbedding });
    return this.toChunks(response, includeEmbedding)[0] ?? null;
  }

  async listChunksByDocument(docId: string): Promise<IndexedChunk[]> {
    const response = await this.vectorStore.getChunks({ where: { doc_id: docId } });
    return this.toChunks(response).sort((left, right) => left.chunkIndex - right.chunkIndex);
  }

  async listIndexedDocuments(): Promise<IndexedDocumentEntry[]> {
    return await this.vectorStore.listIndexedDocumentEntries();
  }

  async getRandomChunk(): Promise<IndexedChunk | null> {
    const documents = await this.listIndexedDocuments();
    if (documents.length === 0) return null;
    const document = documents[Math.floor(Math.random() * documents.length)];
    const chunks = await this.listChunksByDocument(document.docId);
    if (chunks.length === 0) return null;
    return chunks[Math.floor(Math.random() * chunks.length)];
  }

  private toChunks(response: ChromaGetResponse, includeEmbedding: boolean = false): IndexedChunk[] {
    const nested = Array.isArray(response.ids?.[0]);
    const values = <T>(field: T[] | T[][] | null | undefined): T[] => {
      if (!field) return [];
      return (nested ? field[0] : field) as T[];
    };
    const ids = values(response.ids);
    const documents = values(response.documents);
    const metadatas = values(response.metadatas);
    const embeddings = values(response.embeddings);
    const docIds = ids.map((chunkId, index) => {
      const metadata = metadatas[index] || {};
      return this.stringValue(metadata.doc_id) || this.stringValue(metadata.path) || chunkId.split("::")[0];
    });
    const actualChunkCounts = new Map<string, number>();
    for (const docId of docIds) actualChunkCounts.set(docId, (actualChunkCounts.get(docId) ?? 0) + 1);

    return ids.map((chunkId, index) => {
      const metadata = metadatas[index] || {};
      const docId = docIds[index];
      const chunkIndex = this.numberValue(metadata.chunk_index, this.legacyChunkIndex(chunkId));
      const embedding = embeddings[index];
      const content = documents[index] || "";
      const metadataComplete = this.hasNumber(metadata.chunk_index)
        && this.hasNumber(metadata.chunk_count)
        && Object.prototype.hasOwnProperty.call(metadata, "section_label")
        && this.stringValue(metadata.doc_id).length > 0
        && this.stringValue(metadata.path).length > 0
        && this.hasNumber(metadata.mtime);
      return {
        chunkId,
        docId,
        path: this.stringValue(metadata.path) || docId,
        title: this.stringValue(metadata.title) || docId,
        content,
        chunkIndex,
        chunkCount: this.numberValue(metadata.chunk_count, actualChunkCounts.get(docId) ?? 1),
        sectionLabel: this.stringValue(metadata.section_label).trim() || this.firstContentLine(content),
        mtime: this.numberValue(metadata.mtime, 0),
        ...(!metadataComplete ? { needsReindex: true } : {}),
        ...(includeEmbedding && Array.isArray(embedding) ? { embedding } : {}),
      };
    });
  }

  private legacyChunkIndex(chunkId: string): number {
    const match = /chunk-(\d+)$/.exec(chunkId);
    return match ? Number(match[1]) : 0;
  }

  private numberValue(value: unknown, fallback: number): number {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  private stringValue(value: unknown): string {
    return typeof value === "string" ? value : "";
  }

  private hasNumber(value: unknown): boolean {
    if (value === null || value === undefined || value === "") return false;
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number);
  }

  private firstContentLine(content: string): string {
    return content.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  }
}
