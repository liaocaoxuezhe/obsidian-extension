import type { LocalSearchResult } from "./local-vector/search";

export const MAX_SEARCH_TABS = 5;
export const SEARCH_TAB_TITLE_MAX_LENGTH = 15;

export type SearchTabSource =
  | { type: "manual" }
  | { type: "document"; sourcePath?: string }
  | { type: "result-card"; parentTabId?: string; sourcePath?: string };

export type SearchTab = {
  id: string;
  title: string;
  query: string;
  results: LocalSearchResult[];
  documentQueryText: string;
  isLoading: boolean;
  excludedPaths: string[];
  source: SearchTabSource;
};

export function createTabTitle(text: string, fallback: string = "搜索"): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, SEARCH_TAB_TITLE_MAX_LENGTH) : fallback;
}

export function createDefaultSearchTab(id: string): SearchTab {
  return {
    id,
    title: "搜索",
    query: "",
    results: [],
    documentQueryText: "",
    isLoading: false,
    excludedPaths: [],
    source: { type: "manual" },
  };
}

export function createEmptySearchTab(id: string): SearchTab {
  return createDefaultSearchTab(id);
}

export function canCreateSearchTab(tabs: readonly unknown[]): boolean {
  return tabs.length < MAX_SEARCH_TABS;
}

export function uniquePaths(paths: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  paths.forEach((path) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    unique.push(path);
  });
  return unique;
}

export function createDerivedSearchQuery(result: LocalSearchResult): string {
  return result.title ? `${result.title}\n\n${result.content}` : result.content;
}

export function createDerivedSearchTab(
  id: string,
  parentTab: SearchTab,
  result: LocalSearchResult
): SearchTab {
  return {
    id,
    title: createTabTitle(result.title || result.content, "搜索"),
    query: createDerivedSearchQuery(result),
    results: [],
    documentQueryText: "",
    isLoading: false,
    excludedPaths: uniquePaths([
      ...parentTab.excludedPaths,
      ...parentTab.results.map((item) => item.path),
    ]),
    source: {
      type: "result-card",
      parentTabId: parentTab.id,
      sourcePath: result.path,
    },
  };
}

export function closeSearchTab(
  tabs: SearchTab[],
  closingTabId: string,
  activeTabId: string,
  createFallbackTab: (id: string) => SearchTab,
  fallbackTabId: string
): { tabs: SearchTab[]; activeTabId: string } {
  const closingIndex = tabs.findIndex((tab) => tab.id === closingTabId);
  if (closingIndex === -1) {
    return { tabs, activeTabId };
  }

  const nextTabs = tabs.filter((tab) => tab.id !== closingTabId);
  if (nextTabs.length === 0) {
    const fallbackTab = createFallbackTab(fallbackTabId);
    return { tabs: [fallbackTab], activeTabId: fallbackTab.id };
  }

  if (closingTabId !== activeTabId) {
    return { tabs: nextTabs, activeTabId };
  }

  const nextActiveIndex = Math.min(closingIndex, nextTabs.length - 1);
  return {
    tabs: nextTabs,
    activeTabId: nextTabs[nextActiveIndex].id,
  };
}
