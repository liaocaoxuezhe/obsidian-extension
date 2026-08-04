export type DiagnosticLevel = "debug" | "info" | "warn" | "error";

export type DiagnosticStage =
  | "plugin.onload"
  | "plugin.layout-ready"
  | "environment.detect"
  | "onboarding.setup"
  | "service.bootstrap"
  | "search.readiness"
  | "runtime.check"
  | "runtime.install"
  | "chroma.start"
  | "chroma.health-check"
  | "vector-store.initialize"
  | "embedding.worker-start"
  | "embedding.model-load"
  | "embedding.inference"
  | "index.state-load"
  | "index.document-read"
  | "index.chunk"
  | "index.embed"
  | "index.upsert"
  | "search.embed-query"
  | "search.vector-query"
  | "semantic-walk.expand"
  | "react.render"
  | "license.refresh"
  | "plugin.unload"
  | "diagnostic.report"
  | "diagnostic.send"
  | "safe-mode.enter"
  | "safe-mode.recover"
  | "unknown";

export interface SanitizedError {
  name: string;
  message: string;
  stack?: string;
  causeCode?: string;
}

export interface DiagnosticEvent {
  id: string;
  timestamp: string;
  level: DiagnosticLevel;
  stage: DiagnosticStage;
  code: string;
  message: string;
  context?: Record<string, string | number | boolean | null>;
  error?: SanitizedError;
}

export interface RuntimeSetupDiagnosticContext {
  stage: string;
  errorCode?: string;
  platform?: string;
  arch?: string;
  runtimeId?: string;
  durationMs?: number;
  receivedBytes?: number;
  retryCount?: number;
  portConflict?: boolean;
  copiedRecords?: number;
  totalRecords?: number;
  sourceBytes?: number;
}

export interface DiagnosticSessionMarker {
  schemaVersion: 1;
  sessionId: string;
  pluginVersion: string;
  buildId: string;
  startedAt: string;
  updatedAt: string;
  status: "running" | "clean-exit";
  lastStage: DiagnosticStage;
  lastEventCode?: string;
  workerState?: "not-started" | "starting" | "ready" | "failed";
}

export interface DiagnosticReport {
  schema_version: number;
  report_id: string;
  reporter_id: string;
  created_at: string;
  plugin: {
    version: string;
    build_id: string;
  };
  host: {
    obsidian_version: string;
    platform: string;
    arch: string;
    locale: string;
  };
  runtime: {
    model: string;
    transformers_version: string;
    onnxruntime_version: string;
    chroma_version: string;
  };
  session: {
    suspected_unclean_exit: boolean;
    last_stage: DiagnosticStage;
    safe_mode: boolean;
  };
  events: DiagnosticEvent[];
  user_note: string;
}

export interface DiagnosticReportResponse {
  code: number;
  data: {
    report_id: string;
    fingerprint: string;
    received_at: string;
  };
}

export interface DiagnosticStorageOptions {
  pluginDir: string;
  maxRingEvents?: number;
  maxPersistedEvents?: number;
  maxSnapshotBytes?: number;
  maxStackBytes?: number;
  maxMessageBytes?: number;
}

export interface DiagnosticRecorderOptions extends DiagnosticStorageOptions {
  pluginVersion: string;
  buildId: string;
  obsidianVersion: string;
  platform: string;
  arch: string;
  locale: string;
  model?: string;
}

export type SemanticWalkExpandEventStage = "start" | "success" | "error" | "fallback";

export type SemanticWalkExpandErrorCategory =
  | "none"
  | "chunk-missing"
  | "chunk-read"
  | "service-unavailable"
  | "embedding"
  | "query"
  | "unknown";

export interface SemanticWalkExpandDiagnostic {
  chunkId: string;
  stage: SemanticWalkExpandEventStage;
  durationMs: number;
  candidateCount: number;
  model: string;
  usedEmbeddingFallback: boolean;
  distanceRange: string;
  errorCategory: SemanticWalkExpandErrorCategory;
}

export interface SemanticWalkDiagnosticRecorder {
  recordSemanticWalkExpand(event: SemanticWalkExpandDiagnostic): void;
}
