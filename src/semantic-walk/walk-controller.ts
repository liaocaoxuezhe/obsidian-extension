import type { ChunkSearchResult } from "../local-vector/search";
import {
  candidateCriteriaKey,
  createWalkSessionState,
  prepareCandidateReplacement,
  semanticWalkReducer,
  selectVisibleGraph,
} from "./graph-reducer";
import {
  COLUMN_GAP,
  layoutChildren,
  layoutRestoredNodes,
  NODE_MIN_HEIGHT,
  NODE_WIDTH,
  ROW_GAP,
} from "./incremental-layout";
import { labelSimilarityBands } from "./similarity";
import type { CandidateMode, ChunkRepository, IndexedChunk, WalkNode, WalkSessionState } from "./types";
import { SemanticWalkRelationError, type ChunkRelationService } from "./relation-service";
import { t } from "../util/i18n";
import type {
  SemanticWalkDiagnosticRecorder,
  SemanticWalkExpandDiagnostic,
  SemanticWalkExpandErrorCategory,
} from "../diagnostics/diagnostic-types";
import type { FileValidity } from "./file-bridge";

export interface SemanticWalkControllerDependencies {
  repository: Pick<ChunkRepository, "getChunk">;
  relationService: Pick<ChunkRelationService, "findRelatedChunks">;
  candidateLimit?: number;
  diagnosticRecorder?: SemanticWalkDiagnosticRecorder | null;
  model?: string;
  getActiveModel?: () => string;
  getIndexRevision?: () => number;
  validateSource?: (chunk: ChunkSearchResult) => FileValidity;
}

export interface CachedCandidate {
  chunkId: string;
  distance: number;
}

export type WalkOperationResult =
  | { status: "success" }
  | { status: "missing" }
  | { status: "expand-error"; error: string }
  | { status: "confirmation-required" }
  | { status: "cancelled" }
  | { status: "invalid" };

export type ConfirmRestart = (currentRootChunkId: string | null, nextChunkId: string) => boolean | Promise<boolean>;
export type ConfirmHide = (chunkId: string) => boolean | Promise<boolean>;

type StateListener = (state: WalkSessionState) => void;

function toSearchResult(chunk: IndexedChunk): ChunkSearchResult {
  return {
    chunkId: chunk.chunkId,
    docId: chunk.docId,
    path: chunk.path,
    title: chunk.title,
    content: chunk.content,
    chunkIndex: chunk.chunkIndex,
    chunkCount: chunk.chunkCount,
    sectionLabel: chunk.sectionLabel,
    mtime: chunk.mtime,
    distance: 0,
  };
}

function availablePosition(state: WalkSessionState): { x: number; y: number } {
  const focus = state.focusNodeId ? state.nodes[state.focusNodeId] : undefined;
  const x = focus ? focus.x + NODE_WIDTH + COLUMN_GAP : 0;
  const occupied = new Set(Object.values(state.nodes).filter((node) => node.x === x).map((node) => node.y));
  let y = focus?.y ?? 0;
  while (occupied.has(y)) y += NODE_MIN_HEIGHT + ROW_GAP;
  return { x, y };
}

export class SemanticWalkController {
  private state = createWalkSessionState();
  private readonly listeners = new Set<StateListener>();
  private readonly candidateCache = new Map<string, CachedCandidate[]>();
  private readonly requestVersions = new Map<string, number>();
  private generation = 0;
  private startRequestVersion = 0;
  private readonly candidateLimit: number;

  constructor(private readonly dependencies: SemanticWalkControllerDependencies) {
    this.candidateLimit = dependencies.candidateLimit ?? 6;
  }

  getState(): WalkSessionState {
    return this.state;
  }

  subscribe(listener: StateListener): () => void {
    let active = true;
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.cancelPendingRequests();
    };
  }

  getCachedCandidates(chunkId: string): CachedCandidate[] {
    const prefix = `${JSON.stringify([chunkId]).slice(0, -1)},`;
    const matches = Array.from(this.candidateCache.entries()).filter(([key]) => key.startsWith(prefix));
    return (matches.at(-1)?.[1] ?? []).map((candidate) => ({ ...candidate }));
  }

  async setCandidateMode(mode: CandidateMode): Promise<WalkOperationResult> {
    if (mode === this.state.candidateMode) return { status: "success" };
    const focusNodeId = this.state.focusNodeId;
    this.state = semanticWalkReducer(this.state, { type: "set-candidate-mode", mode });
    this.cancelLoadingRequestsForFilterChange();
    this.emit();
    const focusNode = focusNodeId ? this.state.nodes[focusNodeId] : undefined;
    return focusNode?.expanded && !focusNode.collapsed
      ? this.expand(focusNodeId!)
      : { status: "success" };
  }

  async setExcludeSameDocument(exclude: boolean): Promise<WalkOperationResult> {
    if (exclude === this.state.excludeSameDocument) return { status: "success" };
    const focusNodeId = this.state.focusNodeId;
    this.state = semanticWalkReducer(this.state, { type: "set-exclude-same-document", exclude });
    this.cancelLoadingRequestsForFilterChange();
    this.emit();
    const focusNode = focusNodeId ? this.state.nodes[focusNodeId] : undefined;
    return focusNode?.expanded && !focusNode.collapsed
      ? this.expand(focusNodeId!)
      : { status: "success" };
  }

  refreshFileValidity(): void {
    if (!this.dependencies.validateSource) return;
    let changed = false;
    const nodes = Object.fromEntries(Object.entries(this.state.nodes).map(([chunkId, node]) => {
      const validity = this.dependencies.validateSource!(node.chunk);
      if (validity === node.validity) return [chunkId, node];
      changed = true;
      return [chunkId, { ...node, validity, loading: validity === "valid" ? node.loading : false }];
    }));
    if (!changed) return;
    this.state = { ...this.state, nodes };
    this.emit();
  }

  async setStart(chunkId: string, confirmRestart?: ConfirmRestart): Promise<WalkOperationResult> {
    const requestVersion = ++this.startRequestVersion;
    if (this.state.nodes[chunkId]) {
      this.focus(chunkId);
      return { status: "success" };
    }
    if (Object.keys(this.state.nodes).length > 0) {
      if (!confirmRestart) return { status: "confirmation-required" };
      if (!await confirmRestart(this.state.rootNodeId, chunkId)) return { status: "cancelled" };
      if (requestVersion !== this.startRequestVersion) return { status: "cancelled" };
    }
    const chunk = await this.dependencies.repository.getChunk(chunkId, false);
    if (requestVersion !== this.startRequestVersion) return { status: "cancelled" };
    if (!chunk) return { status: "missing" };
    this.beginSession();
    this.state = semanticWalkReducer(this.state, { type: "add-root", chunk: toSearchResult(chunk) });
    this.emit();
    return { status: "success" };
  }

  async addChunk(chunkId: string): Promise<WalkOperationResult> {
    const generation = this.generation;
    if (this.state.nodes[chunkId]) {
      this.focus(chunkId);
      return { status: "success" };
    }
    const chunk = await this.dependencies.repository.getChunk(chunkId, false);
    if (!this.isCurrent(generation)) return { status: "cancelled" };
    if (!chunk) return { status: "missing" };
    if (this.state.nodes[chunkId]) {
      return { status: "success" };
    }
    const result = toSearchResult(chunk);
    if (Object.keys(this.state.nodes).length === 0) {
      this.state = semanticWalkReducer(this.state, { type: "add-root", chunk: result });
    } else {
      const position = availablePosition(this.state);
      const sourceId = this.state.focusNodeId ?? this.state.rootNodeId;
      if (!sourceId) return { status: "missing" };
      this.state = semanticWalkReducer(this.state, {
        type: "add-linked-node",
        sourceId,
        chunk: result,
        placement: position,
        createdAt: Date.now(),
      });
      if (!this.state.nodes[result.chunkId]) return { status: "cancelled" };
      this.state = semanticWalkReducer(this.state, { type: "focus-node", nodeId: result.chunkId });
    }
    this.emit();
    return { status: "success" };
  }

  async addAndExpand(chunkId: string): Promise<WalkOperationResult> {
    const added = await this.addChunk(chunkId);
    if (added.status !== "success") return added;
    return this.expand(chunkId);
  }

  async toggleNodeExpansion(chunkId: string): Promise<WalkOperationResult> {
    const node = this.state.nodes[chunkId];
    if (!node) return { status: "missing" };
    if (!node.expanded) return this.expand(chunkId);
    if (!node.collapsed) {
      this.state = semanticWalkReducer(this.state, { type: "collapse-node", nodeId: chunkId });
      this.emit();
      return { status: "success" };
    }

    if (this.state.expansionCriteria[chunkId] !== this.currentCriteria()) {
      return this.expand(chunkId);
    }

    const occupiedNodes = selectVisibleGraph(this.state).nodes;
    const expandedState = semanticWalkReducer(this.state, { type: "expand-node", nodeId: chunkId });
    const expandedVisibleNodes = selectVisibleGraph(expandedState).nodes;
    const restoredNodes = Object.values(expandedVisibleNodes)
      .filter((restoredNode) => !occupiedNodes[restoredNode.id]);
    const restoredPlacements = layoutRestoredNodes(restoredNodes, Object.values(occupiedNodes));
    const nodes = { ...expandedState.nodes };
    for (const placement of restoredPlacements) {
      const restoredNode = nodes[placement.nodeId];
      if (restoredNode) nodes[placement.nodeId] = { ...restoredNode, x: placement.x, y: placement.y };
    }
    this.state = { ...expandedState, nodes };
    this.emit();
    return { status: "success" };
  }

  async hideNode(chunkId: string, confirmHide?: ConfirmHide): Promise<WalkOperationResult> {
    const node = this.state.nodes[chunkId];
    if (!node) return { status: "missing" };
    const isVisitedPath = this.state.visitedOrder.includes(chunkId);
    if (isVisitedPath) {
      if (!confirmHide) return { status: "confirmation-required" };
      if (!await confirmHide(chunkId)) return { status: "cancelled" };
    }
    this.state = semanticWalkReducer(this.state, { type: "hide-node", nodeId: chunkId });
    this.candidateCache.clear();
    for (const requestedChunkId of this.requestVersions.keys()) {
      if (!this.state.nodes[requestedChunkId]) this.requestVersions.delete(requestedChunkId);
    }
    this.emit();
    return { status: "success" };
  }

  async expand(chunkId: string): Promise<WalkOperationResult> {
    const node = this.state.nodes[chunkId];
    if (!node) return { status: "missing" };
    const validity = this.dependencies.validateSource?.(node.chunk) ?? node.validity;
    if (validity !== "valid") {
      this.updateNode(chunkId, (current) => ({ ...current, validity, loading: false }));
      return { status: "invalid" };
    }
    const startedAt = Date.now();
    const criteria = this.currentCriteria();
    let usedEmbeddingFallback = false;
    let errorCategory: SemanticWalkExpandErrorCategory = "chunk-read";
    this.recordExpand({
      chunkId,
      stage: "start",
      durationMs: 0,
      candidateCount: 0,
      model: this.activeModel(),
      usedEmbeddingFallback: false,
      distanceRange: "none",
      errorCategory: "none",
    });
    const generation = this.generation;
    const requestVersion = (this.requestVersions.get(chunkId) ?? 0) + 1;
    this.requestVersions.set(chunkId, requestVersion);
    this.updateNode(chunkId, (current) => ({ ...current, loading: true, error: undefined }));

    try {
      errorCategory = "chunk-read";
      const source = await this.dependencies.repository.getChunk(chunkId, true);
      if (!this.isRequestCurrent(generation, chunkId, requestVersion)) return { status: "cancelled" };
      if (!source) {
        this.updateNode(chunkId, (current) => ({
          ...current,
          loading: false,
          status: "error",
          error: t("semanticWalk.chunkMissing"),
        }));
        this.recordExpandResult(chunkId, "error", startedAt, [], false, "chunk-missing");
        return { status: "missing" };
      }
      const cacheKey = this.cacheKey(source);
      const cached = this.candidateCache.get(cacheKey);
      let candidates: ChunkSearchResult[];
      if (cached) {
        errorCategory = "chunk-read";
        const hydrated = await Promise.all(cached.map(async (candidate) => {
          const cachedChunk = await this.dependencies.repository.getChunk(candidate.chunkId, false);
          return cachedChunk ? { ...toSearchResult(cachedChunk), distance: candidate.distance } : null;
        }));
        if (!this.isRequestCurrent(generation, chunkId, requestVersion)) return { status: "cancelled" };
        candidates = hydrated.filter((candidate): candidate is ChunkSearchResult => candidate !== null);
        this.candidateCache.set(cacheKey, candidates.map((candidate) => ({
          chunkId: candidate.chunkId,
          distance: candidate.distance,
        })));
      } else {
        errorCategory = "query";
        const replacementPreview = prepareCandidateReplacement(this.state, chunkId);
        const replaceableIds = new Set(
          Object.values(this.state.edges)
            .filter((edge) => edge.source === chunkId && !replacementPreview.edges[edge.id])
            .map((edge) => edge.target),
        );
        candidates = await this.dependencies.relationService.findRelatedChunks(source, {
          limit: this.candidateLimit,
          mode: this.state.candidateMode,
          excludeSameDocument: this.state.excludeSameDocument,
          excludeChunkIds: [
            ...Object.keys(this.state.nodes).filter((nodeId) => !replaceableIds.has(nodeId)),
            ...this.state.hiddenChunkIds,
          ],
          onEmbeddingFallback: () => { usedEmbeddingFallback = true; },
        });
        if (!this.isRequestCurrent(generation, chunkId, requestVersion)) return { status: "cancelled" };
        this.candidateCache.set(cacheKey, candidates.map((candidate) => ({
          chunkId: candidate.chunkId,
          distance: candidate.distance,
        })));
      }

      const ranked = labelSimilarityBands(candidates);
      let replacementState = prepareCandidateReplacement(this.state, chunkId);
      const currentSource = replacementState.nodes[chunkId];
      if (!currentSource) return { status: "cancelled" };
      const visibleNodes = selectVisibleGraph(replacementState).nodes;
      const placements = layoutChildren(currentSource, ranked, visibleNodes);
      replacementState = {
        ...replacementState,
        nodes: {
          ...replacementState.nodes,
          [chunkId]: {
            ...currentSource,
            loading: false,
            error: undefined,
            status: this.statusWithoutError(currentSource),
          },
        },
      };
      this.state = semanticWalkReducer(replacementState, {
        type: "expand-candidates",
        sourceId: chunkId,
        candidates: ranked,
        placements,
        relationBands: ranked.map((candidate) => candidate.relationBand),
        criteria,
        createdAt: Date.now(),
      });
      const edges = { ...this.state.edges };
      ranked.forEach((candidate, index) => {
        const edgeId = `${chunkId}->${candidate.chunkId}`;
        const edge = edges[edgeId];
        if (edge) edges[edgeId] = { ...edge, relationBand: ranked[index].relationBand };
      });
      this.state = { ...this.state, edges };
      this.emit();
      this.recordExpandResult(chunkId, "success", startedAt, candidates, usedEmbeddingFallback, "none");
      return { status: "success" };
    } catch (error) {
      if (!this.isRequestCurrent(generation, chunkId, requestVersion)) return { status: "cancelled" };
      if (error instanceof SemanticWalkRelationError) errorCategory = error.category;
      const message = error instanceof Error ? error.message : String(error);
      this.updateNode(chunkId, (current) => ({
        ...current,
        loading: false,
        status: "error",
        error: message,
      }));
      this.recordExpandResult(chunkId, "error", startedAt, [], usedEmbeddingFallback, errorCategory);
      return { status: "expand-error", error: message };
    }
  }

  refreshExpansion(chunkId: string): Promise<WalkOperationResult> {
    this.deleteCachedCandidates(chunkId);
    return this.expand(chunkId);
  }

  focus(chunkId: string): void {
    this.state = semanticWalkReducer(this.state, { type: "focus-node", nodeId: chunkId });
    this.emit();
  }

  move(chunkId: string, x: number, y: number): void {
    this.updateNode(chunkId, (node) => ({ ...node, x, y, positionMode: "manual" }));
  }

  setViewport(viewport: WalkSessionState["viewport"]): void {
    this.state = { ...this.state, viewport };
    this.emit();
  }

  reset(): void {
    this.startRequestVersion++;
    this.beginSession();
    this.state = createWalkSessionState();
    this.emit();
  }

  dispose(): void {
    this.cancelPendingRequests();
    this.candidateCache.clear();
    this.listeners.clear();
  }

  private beginSession(): number {
    this.generation++;
    this.requestVersions.clear();
    this.candidateCache.clear();
    return this.generation;
  }

  private activeModel(): string {
    return this.dependencies.getActiveModel?.() || this.dependencies.model || "unknown";
  }

  private cacheKey(source: IndexedChunk): string {
    return JSON.stringify([
      source.chunkId,
      this.activeModel(),
      this.state.candidateMode,
      this.state.excludeSameDocument,
      this.dependencies.getIndexRevision?.() ?? 0,
      source.mtime,
    ]);
  }

  private deleteCachedCandidates(chunkId: string): void {
    const prefix = `${JSON.stringify([chunkId]).slice(0, -1)},`;
    for (const key of this.candidateCache.keys()) {
      if (key.startsWith(prefix)) this.candidateCache.delete(key);
    }
  }

  private isCurrent(generation: number): boolean {
    return this.generation === generation;
  }

  private currentCriteria(): string {
    return candidateCriteriaKey(this.state.candidateMode, this.state.excludeSameDocument);
  }

  private cancelLoadingRequestsForFilterChange(): void {
    const nodes = { ...this.state.nodes };
    let changed = false;
    for (const [chunkId, requestVersion] of this.requestVersions) {
      const node = nodes[chunkId];
      if (!node?.loading) continue;
      this.requestVersions.set(chunkId, requestVersion + 1);
      nodes[chunkId] = { ...node, loading: false };
      changed = true;
    }
    if (changed) this.state = { ...this.state, nodes };
  }

  private isRequestCurrent(generation: number, chunkId: string, requestVersion: number): boolean {
    return this.isCurrent(generation)
      && this.requestVersions.get(chunkId) === requestVersion
      && Boolean(this.state.nodes[chunkId]);
  }

  private statusWithoutError(node: WalkNode): WalkNode["status"] {
    if (this.state.focusNodeId === node.id) return "focus";
    return this.state.visitedOrder.includes(node.id) ? "visited" : "candidate";
  }

  private updateNode(chunkId: string, updater: (node: WalkNode) => WalkNode, emit = true): void {
    const node = this.state.nodes[chunkId];
    if (!node) return;
    this.state = { ...this.state, nodes: { ...this.state.nodes, [chunkId]: updater(node) } };
    if (emit) this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  private cancelPendingRequests(): void {
    this.generation++;
    this.startRequestVersion++;
    const nodes = { ...this.state.nodes };
    let changed = false;
    for (const chunkId of this.requestVersions.keys()) {
      const node = nodes[chunkId];
      if (!node?.loading) continue;
      nodes[chunkId] = { ...node, loading: false };
      changed = true;
    }
    if (changed) this.state = { ...this.state, nodes };
    this.requestVersions.clear();
  }

  private recordExpandResult(
    chunkId: string,
    stage: "success" | "error",
    startedAt: number,
    candidates: ChunkSearchResult[],
    usedEmbeddingFallback: boolean,
    errorCategory: SemanticWalkExpandErrorCategory,
  ): void {
    const distances = candidates.map((candidate) => candidate.distance).filter(Number.isFinite);
    const distanceRange = distances.length > 0
      ? `${Math.min(...distances).toFixed(4)}..${Math.max(...distances).toFixed(4)}`
      : "none";
    this.recordExpand({
      chunkId,
      stage,
      durationMs: Date.now() - startedAt,
      candidateCount: candidates.length,
      model: this.activeModel(),
      usedEmbeddingFallback,
      distanceRange,
      errorCategory,
    });
  }

  private recordExpand(event: SemanticWalkExpandDiagnostic): void {
    try {
      this.dependencies.diagnosticRecorder?.recordSemanticWalkExpand(event);
    } catch {
      // Diagnostic failures must not affect semantic-walk state transitions.
    }
  }
}
