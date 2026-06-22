import { LocalEmbeddingService } from "./embedding";
import { LocalVectorStore } from "./vector-store";
import { LocalSemanticSearch } from "./search";
import { DocumentIndexer } from "./document-indexer";
import { ChromaProcessManager } from "./chroma-process";
import type { DocumentSummarizer } from "./document-summarizer";
import { searchResultCache } from "./search-result-cache";

export type ServiceStatus = "initializing" | "ready" | "degraded" | "error";
type ServiceStateListener = (state: ServiceState) => void;

const listeners = new Set<ServiceStateListener>();

export interface ServiceState {
  status: ServiceStatus;
  chromaManager: ChromaProcessManager | null;
  dbPath: string;
  port: number;
  embeddingStatus: "idle" | "loading" | "downloading" | "ready" | "error";
  vectorStoreStatus: "idle" | "ready" | "error";
  modelDownloadProgress: number; // 0-100
  lastError: string;
  rebuildProgress: { current: number; total: number; currentFile: string } | null;
  activeModel: string;
  summarySearchEnabled: boolean;
}

export const searchInstance = {
  embeddingService: null as LocalEmbeddingService | null,
  vectorStore: null as LocalVectorStore | null,
  localSearch: null as LocalSemanticSearch | null,
  documentIndexer: null as DocumentIndexer | null,
  chromaManager: null as ChromaProcessManager | null,
  documentSummarizer: null as DocumentSummarizer | null,
  state: {
    status: "initializing" as ServiceStatus,
    chromaManager: null as ChromaProcessManager | null,
    dbPath: "",
    port: 8000,
    embeddingStatus: "idle" as "idle" | "downloading" | "ready" | "error",
    vectorStoreStatus: "idle" as "idle" | "ready" | "error",
    modelDownloadProgress: 0,
    lastError: "",
    rebuildProgress: null,
    activeModel: "",
    summarySearchEnabled: false,
  } as ServiceState,
};

function notifyServiceState() {
  const snapshot = { ...searchInstance.state };
  for (const listener of listeners) {
    listener(snapshot);
  }
}

export function subscribeServiceState(listener: ServiceStateListener): () => void {
  listeners.add(listener);
  listener({ ...searchInstance.state });
  return () => {
    listeners.delete(listener);
  };
}

export function initLocalVectorServices(
  embedding: LocalEmbeddingService | null,
  store: LocalVectorStore | null,
  indexer: DocumentIndexer | null,
  chromaManager: ChromaProcessManager | null,
  state: Partial<ServiceState>,
  maxInputChars?: number,
  summarizer?: DocumentSummarizer | null
) {
  searchResultCache.clear();
  searchInstance.embeddingService = embedding;
  searchInstance.vectorStore = store;
  searchInstance.documentIndexer = indexer;
  searchInstance.chromaManager = chromaManager;
  searchInstance.documentSummarizer = summarizer ?? null;
  if (embedding && store && embedding.isReady() && store) {
    const search = new LocalSemanticSearch(embedding, store, maxInputChars, summarizer ?? undefined);
    if (indexer) search.setDocumentIndexer(indexer);
    searchInstance.localSearch = search;
  } else {
    searchInstance.localSearch = null;
  }
  Object.assign(searchInstance.state, state);
  notifyServiceState();
}

export function getLocalSearch(): LocalSemanticSearch {
  if (!searchInstance.localSearch) {
    throw new Error("Local vector services not initialized");
  }
  return searchInstance.localSearch;
}

export function updateServiceState(updates: Partial<ServiceState>) {
  Object.assign(searchInstance.state, updates);
  notifyServiceState();
}

export function isServiceReady(): boolean {
  return searchInstance.state.status === "ready";
}

export function isServiceAvailable(): boolean {
  const s = searchInstance.state.status;
  return s === "ready" || s === "degraded";
}
