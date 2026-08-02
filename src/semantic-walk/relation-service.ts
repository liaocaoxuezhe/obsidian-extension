import type { ChunkSearchResult, LocalSearchOptions } from "../local-vector/search";
import { searchInstance } from "../local-vector/search-instance";
import type { CandidateMode, IndexedChunk } from "./types";
import { t } from "../util/i18n";
import type { SemanticWalkDiagnosticRecorder } from "../diagnostics/diagnostic-types";

export type SemanticWalkRelationErrorCategory = "service-unavailable" | "embedding" | "query";

export class SemanticWalkRelationError extends Error {
  readonly category: SemanticWalkRelationErrorCategory;
  readonly cause: unknown;

  constructor(category: SemanticWalkRelationErrorCategory, message: string, cause?: unknown) {
    super(message);
    this.name = "SemanticWalkRelationError";
    this.category = category;
    this.cause = cause;
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export interface RelationQueryOptions {
  limit?: number;
  mode: CandidateMode;
  excludeSameDocument: boolean;
  excludeChunkIds?: string[];
  onEmbeddingFallback?: () => void;
}

interface RelationSearch {
  searchByEmbedding(
    embedding: number[],
    topK?: number,
    options?: LocalSearchOptions
  ): Promise<ChunkSearchResult[]>;
}

interface RelationEmbeddingService {
  embedDocument(text: string): Promise<number[]>;
}

export interface ChunkRelationServiceDependencies {
  search?: RelationSearch | null;
  embedding?: RelationEmbeddingService | null;
  diagnosticRecorder?: SemanticWalkDiagnosticRecorder | null;
  model?: string;
  validateCandidate?: (candidate: ChunkSearchResult) => boolean | Promise<boolean>;
}

export class ChunkRelationService {
  private readonly search: RelationSearch | null;
  private readonly embedding: RelationEmbeddingService | null;
  private readonly diagnosticRecorder: SemanticWalkDiagnosticRecorder | null;
  private readonly model: string;
  private readonly validateCandidate: (candidate: ChunkSearchResult) => boolean | Promise<boolean>;

  constructor(dependencies: ChunkRelationServiceDependencies = {}) {
    this.search = "search" in dependencies ? dependencies.search ?? null : searchInstance.localSearch;
    this.embedding = "embedding" in dependencies ? dependencies.embedding ?? null : searchInstance.embeddingService;
    this.diagnosticRecorder = dependencies.diagnosticRecorder ?? null;
    this.model = dependencies.model || "unknown";
    this.validateCandidate = dependencies.validateCandidate ?? (() => true);
  }

  async findRelatedChunks(
    source: IndexedChunk,
    options: RelationQueryOptions
  ): Promise<ChunkSearchResult[]> {
    if (!this.search) {
      throw new SemanticWalkRelationError("service-unavailable", t("semanticWalk.serviceUnavailable"));
    }
    const startedAt = Date.now();
    const embedding = source.embedding ?? await this.embedSource(source, options, startedAt);
    const limit = this.normalizeLimit(options.limit);
    const excludedChunkIds = new Set([source.chunkId, ...(options.excludeChunkIds ?? [])]);
    let candidates: ChunkSearchResult[];
    try {
      candidates = await this.search.searchByEmbedding(embedding, 40, {
        excludeChunkIds: Array.from(excludedChunkIds),
      });
    } catch (error) {
      throw new SemanticWalkRelationError("query", errorMessage(error, t("semanticWalk.error.query")), error);
    }
    return this.selectCandidates(candidates, source, { ...options, limit }, excludedChunkIds);
  }

  private async embedSource(
    source: IndexedChunk,
    options: RelationQueryOptions,
    startedAt: number,
  ): Promise<number[]> {
    if (!this.embedding) {
      throw new SemanticWalkRelationError("service-unavailable", t("semanticWalk.serviceUnavailable"));
    }
    try {
      options.onEmbeddingFallback?.();
    } catch {
      // Fallback diagnostics are best effort and must not block embedding.
    }
    try {
      this.diagnosticRecorder?.recordSemanticWalkExpand({
        chunkId: source.chunkId,
        stage: "fallback",
        durationMs: Date.now() - startedAt,
        candidateCount: 0,
        model: this.model,
        usedEmbeddingFallback: true,
        distanceRange: "none",
        errorCategory: "none",
      });
    } catch {
      // Diagnostics must not block the embedding fallback.
    }
    try {
      return await this.embedding.embedDocument(source.content);
    } catch (error) {
      throw new SemanticWalkRelationError("embedding", errorMessage(error, t("semanticWalk.error.embeddingFallback")), error);
    }
  }

  private async selectCandidates(
    candidates: ChunkSearchResult[],
    source: IndexedChunk,
    options: RelationQueryOptions,
    excludedChunkIds: Set<string>
  ): Promise<ChunkSearchResult[]> {
    const selected: ChunkSearchResult[] = [];
    const seen = new Set<string>();
    const perDocument = new Map<string, number>();

    for (const candidate of candidates) {
      if (selected.length >= (options.limit ?? 8)) break;
      if (excludedChunkIds.has(candidate.chunkId) || seen.has(candidate.chunkId)) continue;
      if (!candidate.content?.trim()) continue;
      if (!await this.validateCandidate(candidate)) continue;
      if (options.excludeSameDocument && candidate.docId === source.docId) continue;
      if (options.mode === "balanced" && (perDocument.get(candidate.docId) ?? 0) >= 2) continue;

      seen.add(candidate.chunkId);
      perDocument.set(candidate.docId, (perDocument.get(candidate.docId) ?? 0) + 1);
      selected.push(candidate);
    }

    return selected;
  }

  private normalizeLimit(limit: unknown): number {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return 8;
    return Math.min(40, Math.max(1, Math.floor(limit)));
  }
}

export type { ChunkSearchResult };
