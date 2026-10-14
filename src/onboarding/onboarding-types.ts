import type { EmbeddingFailureStage } from "../local-vector/embedding-failure";
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
  | "verifying-embedding-native"
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
  | "DOWNLOAD_PROXY_AUTH_REQUIRED"
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
  | "EMBEDDING_NATIVE_LOAD_FAILED"
  | "EMBEDDING_MODEL_NETWORK_FAILED"
  | "EMBEDDING_MODEL_OOM"
  | "EMBEDDING_WORKER_CRASHED"
  | "VECTOR_STORE_FAILED"
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
  /** Step where the failure really happened, when the stage alone is misleading. */
  subStage?: EmbeddingFailureStage | null;
  userMessageKey: string;
  /** Error code plus allowlisted evidence tokens; never raw messages, paths or URLs. */
  technicalMessage: string;
  recoverable: boolean;
  action: OnboardingErrorAction;
}

export type QuickIndexScope =
  | { type: "recent"; limit: 30 }
  | { type: "folder"; path: string }
  | { type: "vault" };

export type LegacyIndexChoice = "reuse" | "rebuild" | "later";

/**
 * A pending replacement of an installed, still-trusted runtime by a newer
 * per-platform version (for example the Windows runtime moving to node22-v2).
 */
export interface OnboardingRuntimeUpgrade {
  kind: "embedding-runtime";
  fromRuntimeId: string;
  toRuntimeId: string;
  downloadBytes: number;
  /** Set once the user agrees to download the upgrade; null while consent is pending. */
  acceptedAt: number | null;
}

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
  /** Present only while an installed runtime is being upgraded to a newer version. */
  runtimeUpgrade?: OnboardingRuntimeUpgrade | null;
}

export type RecommendedAction = "setup" | "repair" | "upgrade" | "resume" | "start-services" | "none";

export interface EnvironmentReport {
  platform: SupportedPlatformKey;
  chroma: "missing" | "installed" | "running" | "incompatible" | "corrupt" | "not-required";
  embeddingRuntime: "missing" | "installed" | "ready" | "upgradable" | "corrupt";
  /** Set when embeddingRuntime is "upgradable": a trusted older version is installed. */
  embeddingRuntimeUpgrade?: {
    fromRuntimeId: string;
    toRuntimeId: string;
    downloadBytes: number;
  } | null;
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
  "verifying-embedding-native",
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
