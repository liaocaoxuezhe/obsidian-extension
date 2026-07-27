import { TFile } from "obsidian";
import { EmbeddingService } from "./embedding-service";
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

export interface LocalSearchOptions {
  excludePaths?: string[];
  useSummary?: boolean;
}

const SEARCH_RESULT_EXPANSION_LIMIT = 200;

export function createDocumentSearchInput(content: string, maxInputChars: number): string {
  const limit = Math.max(1, Math.min(maxInputChars, MAX_DOCUMENT_SEARCH_CHARS));
  return cleanMarkdown(content)
    .replace(/^#{1,6}\s+/gm, "")
    .trim()
    .slice(0, limit);
}

export class LocalSemanticSearch {
  private embedding: EmbeddingService;
  private vectorStore: LocalVectorStore;
  private maxInputChars: number;
  private documentIndexer: DocumentIndexer | null = null;
  private summarizer?: DocumentSummarizer;

  constructor(
    embedding: EmbeddingService,
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

  async searchByQuery(query: string, topK: number = 5, options: LocalSearchOptions = {}): Promise<LocalSearchResult[]> {
    const queryEmbedding = await this.embedding.embedQuery(query);
    return this.searchWithBackfill(queryEmbedding, topK, options.excludePaths);
  }

  async searchByDocument(file: TFile, topK: number = 5, options: LocalSearchOptions = {}): Promise<LocalSearchResult[]> {
    const response = await this.searchByDocumentWithQueryText(file, topK, options);
    return response.results;
  }

  async searchByDocumentWithQueryText(
    file: TFile,
    topK: number = 5,
    options: LocalSearchOptions = {}
  ): Promise<LocalDocumentSearchResponse> {
    const vault = file.vault;
    const content = await vault.adapter.read(file.path);
    const firstChunk = createDocumentSearchInput(content, this.maxInputChars);
    if (!firstChunk) return { results: [] };

    const summaryResult = options.useSummary && this.summarizer
      ? await this.summarizer.summarize(firstChunk, file.path)
      : null;
    const textForMatching = summaryResult?.text || firstChunk;
    const docEmbedding = await this.embedding.embedDocument(textForMatching);
    return {
      results: await this.searchWithBackfill(docEmbedding, topK, options.excludePaths),
      queryText: summaryResult?.usedSummary ? summaryResult.text : undefined,
    };
  }

  private getSearchExtra(topK: number, excludePaths: string[] = []): number {
    const mutedCount = this.documentIndexer ? this.documentIndexer.getMutedPaths().size : 0;
    return mutedCount + excludePaths.length + topK;
  }

  private async searchWithBackfill(
    embedding: number[],
    topK: number,
    excludePaths: string[] = []
  ): Promise<LocalSearchResult[]> {
    const targetCount = Math.max(1, topK);
    const batchSize = Math.max(targetCount, 10);
    let requestedCount = Math.min(
      SEARCH_RESULT_EXPANSION_LIMIT,
      targetCount + this.getSearchExtra(targetCount, excludePaths)
    );
    let lastRawCount = -1;

    while (requestedCount <= SEARCH_RESULT_EXPANSION_LIMIT) {
      const rawResults = await this.vectorStore.search(embedding, requestedCount);
      const filteredResults = this.filterAndFormat(rawResults, targetCount, excludePaths);
      if (filteredResults.length >= targetCount) {
        return filteredResults;
      }

      if (rawResults.length < requestedCount || rawResults.length === lastRawCount) {
        return filteredResults;
      }

      lastRawCount = rawResults.length;
      const nextRequestedCount = Math.min(SEARCH_RESULT_EXPANSION_LIMIT, requestedCount + batchSize);
      if (nextRequestedCount === requestedCount) {
        return filteredResults;
      }
      requestedCount = nextRequestedCount;
    }

    const rawResults = await this.vectorStore.search(embedding, SEARCH_RESULT_EXPANSION_LIMIT);
    return this.filterAndFormat(rawResults, targetCount, excludePaths);
  }

  private filterAndFormat(
    results: SearchResult[],
    topK: number,
    excludePaths: string[] = []
  ): LocalSearchResult[] {
    const mutedPaths = this.documentIndexer?.getMutedPaths() ?? new Set<string>();
    const excluded = new Set(excludePaths);
    const filtered = results.filter((r) => {
      const path = r.metadata?.path;
      return !mutedPaths.has(path) && !excluded.has(path);
    });
    return filtered.slice(0, topK).map((r) => ({
      title: r.metadata?.title || "Untitled",
      content: r.content,
      source: "local",
      score: r.score,
      path: r.metadata?.path,
    }));
  }
}
