import { TFile } from "obsidian";
import { LocalEmbeddingService } from "./embedding";
import { LocalVectorStore, SearchResult } from "./vector-store";
import { cleanMarkdown } from "./strip-markdown";
import type { DocumentIndexer } from "./document-indexer";
import type { DocumentSummarizer } from "./document-summarizer";

export const MAX_DOCUMENT_SEARCH_CHARS = 5000;

export interface LocalSearchResult {
  title: string;
  content: string;
  source: "local";
  score: number;
  path?: string;
}

export interface LocalDocumentSearchResponse {
  results: LocalSearchResult[];
  queryText?: string;
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
  private summarizer?: DocumentSummarizer;

  constructor(
    embedding: LocalEmbeddingService,
    vectorStore: LocalVectorStore,
    maxInputChars: number = 512,
    summarizer?: DocumentSummarizer
  ) {
    this.embedding = embedding;
    this.vectorStore = vectorStore;
    this.maxInputChars = maxInputChars;
    this.summarizer = summarizer;
  }

  setDocumentIndexer(indexer: DocumentIndexer): void {
    this.documentIndexer = indexer;
  }

  setDocumentSummarizer(summarizer?: DocumentSummarizer): void {
    this.summarizer = summarizer;
  }

  async searchByQuery(query: string, topK: number = 5): Promise<LocalSearchResult[]> {
    const queryEmbedding = await this.embedding.embedQuery(query);
    const extra = this.documentIndexer ? this.documentIndexer.getMutedPaths().size : 0;
    const results = await this.vectorStore.search(queryEmbedding, topK + extra);
    return this.filterAndFormat(results, topK);
  }

  async searchByDocument(file: TFile, topK: number = 5): Promise<LocalSearchResult[]> {
    const response = await this.searchByDocumentWithQueryText(file, topK);
    return response.results;
  }

  async searchByDocumentWithQueryText(file: TFile, topK: number = 5): Promise<LocalDocumentSearchResponse> {
    const vault = file.vault;
    const content = await vault.adapter.read(file.path);
    const firstChunk = createDocumentSearchInput(content, this.maxInputChars);
    if (!firstChunk) return { results: [] };

    const summaryResult = this.summarizer
      ? await this.summarizer.summarize(firstChunk, file.path)
      : null;
    const textForMatching = summaryResult?.text || firstChunk;
    const docEmbedding = await this.embedding.embedDocument(textForMatching);
    const extra = this.documentIndexer ? this.documentIndexer.getMutedPaths().size : 0;
    const results = await this.vectorStore.search(docEmbedding, topK + extra);
    return {
      results: this.filterAndFormat(results, topK),
      queryText: summaryResult?.usedSummary ? summaryResult.text : undefined,
    };
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
