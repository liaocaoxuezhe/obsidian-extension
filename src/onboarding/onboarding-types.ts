import type { SupportedPlatformKey } from "../runtime/runtime-types";

export type OnboardingStage =
  | "not-started"
  | "checking"
  | "awaiting-consent"
  | "downloading-chroma"
  | "verifying-chroma"
  | "installing-chroma"
  | "downloading-embedding-runtime"
  | "verifying-embedding-runtime"
  | "installing-embedding-runtime"
  | "starting-chroma"
  | "downloading-embedding-model"
  | "warming-up-model"
  | "selecting-legacy-index-action"
  | "preparing-legacy-snapshot"
  | "migrating-legacy-index"
  | "reconciling-legacy-index"
  | "verifying-legacy-index"
  | "selecting-index-scope"
  | "building-quick-index"
  | "ready"
  | "failed"
  | "cancelled";

export type OnboardingErrorCode =
  | "UNSUPPORTED_PLATFORM"
  | "LOCAL_DATA_ROOT_UNAVAILABLE"
  | "INSUFFICIENT_DISK_SPACE"
  | "ONBOARDING_STATE_CORRUPT"
  | "DOWNLOAD_NETWORK_ERROR"
  | "DOWNLOAD_CANCELLED"
  | "DOWNLOAD_SIZE_MISMATCH"
  | "DOWNLOAD_HASH_MISMATCH"
  | "RUNTIME_EXTRACT_FAILED"
  | "RUNTIME_EXECUTION_BLOCKED"
  | "RUNTIME_SMOKE_TEST_FAILED"
  | "CHROMA_PORT_CONFLICT"
  | "CHROMA_START_TIMEOUT"
  | "CHROMA_VERSION_MISMATCH"
  | "CHROMA_EXITED"
  | "EMBEDDING_RUNTIME_INVALID"
  | "EMBEDDING_MODEL_DOWNLOAD_FAILED"
  | "EMBEDDING_MODEL_CACHE_CORRUPT"
  | "EMBEDDING_MODEL_WARMUP_FAILED"
  | "CHROMA_DATA_REBUILD_FAILED"
  | "LEGACY_INDEX_MIGRATION_FAILED"
  | "LEGACY_MIGRATION_UNAVAILABLE"
  | "QUICK_INDEX_FAILED";

export type OnboardingErrorAction =
  | "retry"
  | "redownload"
  | "change-port"
  | "open-help"
  | "none";

export interface OnboardingError {
  code: OnboardingErrorCode;
  stage: OnboardingStage;
  userMessageKey: string;
  technicalMessage: string;
  recoverable: boolean;
  action: OnboardingErrorAction;
}

export type QuickIndexScope =
  | { type: "recent"; limit: 30 }
  | { type: "folder"; path: string }
  | { type: "vault" };

export type LegacyIndexChoice = "reuse" | "rebuild" | "later";

export interface OnboardingSnapshot {
  schemaVersion: 1;
  stage: OnboardingStage;
  progress: number | null;
  completedBytes: number | null;
  totalBytes: number | null;
  currentItem: string;
  runtimePlatform: SupportedPlatformKey | null;
  chromaRuntimeId: string | null;
  embeddingRuntimeId: string | null;
  selectedIndexScope: QuickIndexScope | null;
  legacyIndexChoice: LegacyIndexChoice | null;
  legacyRecordsCopied: number | null;
  legacyRecordsTotal: number | null;
  legacySourceBytes: number | null;
  startedAt: number | null;
  updatedAt: number;
  completedAt: number | null;
  dismissedAt: number | null;
  error: OnboardingError | null;
}

export type RecommendedAction = "setup" | "repair" | "resume" | "start-services" | "none";

export interface EnvironmentReport {
  platform: SupportedPlatformKey;
  chroma: "missing" | "installed" | "running" | "incompatible" | "corrupt";
  embeddingRuntime: "missing" | "installed" | "ready" | "corrupt";
  embeddingModel: "missing" | "cached" | "ready" | "corrupt";
  index: "empty" | "partial" | "ready" | "legacy";
  recommendedAction: RecommendedAction;
  legacyIndexSummary?: {
    runtimeAvailable: boolean;
    estimatedRecords: number | null;
    sourceBytes: number | null;
  } | null;
}

const RESUMABLE_STAGES = new Set<OnboardingStage>([
  "checking",
  "downloading-chroma",
  "verifying-chroma",
  "installing-chroma",
  "downloading-embedding-runtime",
  "verifying-embedding-runtime",
  "installing-embedding-runtime",
  "starting-chroma",
  "downloading-embedding-model",
  "warming-up-model",
  "selecting-legacy-index-action",
  "preparing-legacy-snapshot",
  "migrating-legacy-index",
  "reconciling-legacy-index",
  "verifying-legacy-index",
  "selecting-index-scope",
  "building-quick-index",
]);

export function recommendedActionForSnapshot(snapshot: OnboardingSnapshot): RecommendedAction {
  if (snapshot.stage === "failed") return "repair";
  if (RESUMABLE_STAGES.has(snapshot.stage)) return "resume";
  if (snapshot.stage === "ready") return "start-services";
  if (snapshot.stage === "not-started" || snapshot.stage === "awaiting-consent"
    || snapshot.stage === "cancelled") return "setup";
  return "setup";
}
