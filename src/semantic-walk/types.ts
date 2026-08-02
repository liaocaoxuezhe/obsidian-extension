export interface IndexedChunk {
  chunkId: string;
  docId: string;
  path: string;
  title: string;
  content: string;
  chunkIndex: number;
  chunkCount: number;
  sectionLabel: string;
  mtime: number;
  embedding?: number[];
  needsReindex?: boolean;
}

export interface IndexedDocumentEntry {
  docId: string;
  path: string;
  mtime: number;
  chunkCount: number;
  needsReindex?: boolean;
}

export type CandidateMode = "balanced" | "pure";

export interface ChunkRepository {
  getChunk(chunkId: string, includeEmbedding?: boolean): Promise<IndexedChunk | null>;
  listChunksByDocument(docId: string): Promise<IndexedChunk[]>;
  listIndexedDocuments(): Promise<IndexedDocumentEntry[]>;
  getRandomChunk(): Promise<IndexedChunk | null>;
}

export type WalkNodeStatus = "candidate" | "visited" | "focus" | "error";

export interface WalkNode {
  id: string;
  chunk: import("../local-vector/search").ChunkSearchResult;
  x: number;
  y: number;
  depth: number;
  status: WalkNodeStatus;
  positionMode: "auto" | "manual";
  expanded: boolean;
  collapsed: boolean;
  loading: boolean;
  error?: string;
  validity: import("./file-bridge").FileValidity;
}

export interface WalkEdge {
  id: string;
  source: string;
  target: string;
  distance: number;
  relationBand: "strong" | "related" | "exploratory";
  createdAt: number;
}

export interface WalkSessionState {
  nodes: Record<string, WalkNode>;
  edges: Record<string, WalkEdge>;
  focusNodeId: string | null;
  rootNodeId: string | null;
  visitedOrder: string[];
  hiddenChunkIds: string[];
  expansionCache: Record<string, string[]>;
  expansionCriteria: Record<string, string>;
  viewport: { x: number; y: number; zoom: number };
  candidateMode: CandidateMode;
  excludeSameDocument: boolean;
  limitWarning: "nodes" | "edges" | null;
}

export type WalkAction =
  | { type: "add-root"; chunk: import("../local-vector/search").ChunkSearchResult }
  | {
    type: "expand-candidates";
    sourceId: string;
    candidates: import("../local-vector/search").ChunkSearchResult[];
    placements: Array<{ chunkId: string; x: number; y: number }>;
    relationBands?: WalkEdge["relationBand"][];
    criteria: string;
    createdAt: number;
  }
  | { type: "focus-node"; nodeId: string }
  | {
    type: "add-linked-node";
    sourceId: string;
    chunk: import("../local-vector/search").ChunkSearchResult;
    placement: { x: number; y: number };
    createdAt: number;
  }
  | { type: "collapse-node"; nodeId: string }
  | { type: "expand-node"; nodeId: string }
  | { type: "hide-node"; nodeId: string }
  | { type: "set-candidate-mode"; mode: CandidateMode }
  | { type: "set-exclude-same-document"; exclude: boolean }
  | { type: "reset" };
