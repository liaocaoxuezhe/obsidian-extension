import { TFile } from "obsidian";
import { LocalEmbeddingService } from "./embedding";
import { LocalVectorStore, SearchResult } from "./vector-store";
import { cleanMarkdown } from "./strip-markdown";
import type { DocumentIndexer } from "./document-indexer";

export const MAX_DOCUMENT_SEARCH_CHARS = 1800;

export interface LocalSearchResult {
  title: string;
  content: string;
  source: "local";
  score: number;
  path?: string;
}

export function createDocumentSearchInput(content: string, maxInputChars: number): string {
  const limit = Math.max(1, Math.min(maxInputChars, MAX_DOCUMENT_SEARCH_CHARS));
  return cleanMarkdown(content)
    .replace(/^#{1,6}\s+/gm, "")
    .trim()
    .slice(0, limit);
}

export class LocalSemanticSearch {
  private embedding: LocalEmbeddingService;
  private vectorStore: LocalVectorStore;
  private maxInputChars: number;
  private documentIndexer: DocumentIndexer | null = null;

  constructor(embedding: LocalEmbeddingService, vectorStore: LocalVectorStore, maxInputChars: number = 512) {
    this.embedding = embedding;
    this.vectorStore = vectorStore;
    this.maxInputChars = maxInputChars;
  }

  setDocumentIndexer(indexer: DocumentIndexer): void {
    this.documentIndexer = indexer;
  }

  async searchByQuery(query: string, topK: number = 5): Promise<LocalSearchResult[]> {
    const queryEmbedding = await this.embedding.embedQuery(query);
    const extra = this.documentIndexer ? this.documentIndexer.getMutedPaths().size : 0;
    const results = await this.vectorStore.search(queryEmbedding, topK + extra);
    return this.filterAndFormat(results, topK);
  }

  async searchByDocument(file: TFile, topK: number = 5): Promise<LocalSearchResult[]> {
    const vault = file.vault;
    const content = await vault.adapter.read(file.path);
    const firstChunk = createDocumentSearchInput(content, this.maxInputChars);
    if (!firstChunk) return [];

    const docEmbedding = await this.embedding.embedDocument(firstChunk);
    const extra = this.documentIndexer ? this.documentIndexer.getMutedPaths().size : 0;
    const results = await this.vectorStore.search(docEmbedding, topK + extra);
    return this.filterAndFormat(results, topK);
  }

  private filterAndFormat(results: SearchResult[], topK: number): LocalSearchResult[] {
    const mutedPaths = this.documentIndexer?.getMutedPaths() ?? new Set<string>();
    const filtered = mutedPaths.size > 0
      ? results.filter((r) => !mutedPaths.has(r.metadata?.path))
      : results;
    return filtered.slice(0, topK).map((r) => ({
      title: r.metadata?.title || "Untitled",
      content: r.content,
      source: "local",
      score: r.score,
      path: r.metadata?.path,
    }));
  }
}
