import type { LocalSearchResult } from "./search";

export type SearchResultCacheMode = "document" | "document-summary" | "query";

export interface SearchResultCacheKey {
  mode: SearchResultCacheMode;
  topK: number;
  model?: string;
  path?: string;
  mtime?: number;
  query?: string;
  activePath?: string;
  excludePaths?: string[];
}

export interface SearchResultCacheValue {
  results: LocalSearchResult[];
  queryText?: string;
}

function normalizeKey(key: SearchResultCacheKey): string {
  return JSON.stringify({
    mode: key.mode,
    topK: key.topK,
    model: key.model || "",
    path: key.path || "",
    mtime: key.mtime || 0,
    query: key.query || "",
    activePath: key.activePath || "",
    excludePaths: [...(key.excludePaths || [])].sort(),
  });
}

export class SearchResultCache {
  private entries = new Map<string, SearchResultCacheValue>();

  constructor(private maxEntries: number = 50) {}

  get(key: SearchResultCacheKey): SearchResultCacheValue | null {
    const cacheKey = normalizeKey(key);
    const value = this.entries.get(cacheKey);
    if (!value) return null;

    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, value);
    return value;
  }

  set(key: SearchResultCacheKey, value: SearchResultCacheValue): void {
    const cacheKey = normalizeKey(key);
    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, value);

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

export const searchResultCache = new SearchResultCache();
