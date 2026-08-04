import type { InstalledRuntime } from "../runtime/atomic-runtime-installer";
import type { ChromaStartOptions, ManagedProcessState } from "../runtime/chroma-runtime-manager";
import type { DownloadProgress, DownloadedAsset } from "../runtime/runtime-downloader";
import type { RuntimeAsset, RuntimeAssetKind } from "../runtime/runtime-types";
import type { VerificationResult } from "../runtime/runtime-verifier";
import type {
  EnvironmentReport,
  OnboardingError,
  OnboardingErrorAction,
  OnboardingErrorCode,
  OnboardingSnapshot,
  OnboardingStage,
  QuickIndexScope,
  LegacyIndexChoice,
} from "./onboarding-types";

const MAX_TECHNICAL_MESSAGE = 240;

type SnapshotListener = (snapshot: Readonly<OnboardingSnapshot>) => void;
type OperationMode = "start" | "resume" | "retry" | "retry-runtime";
type RuntimeKey = "chroma" | "embedding";

export interface OnboardingStoreDependency {
  load(): Promise<{ snapshot: OnboardingSnapshot }>;
  save(snapshot: OnboardingSnapshot): Promise<void>;
  flush?(): Promise<void>;
}

export interface RuntimePipelineDependency {
  asset: RuntimeAsset;
  download(
    signal: AbortSignal,
    onProgress: (progress: DownloadProgress & { currentItem?: string }) => void,
  ): Promise<DownloadedAsset>;
  verify(downloaded: DownloadedAsset): Promise<VerificationResult | void>;
  install(downloaded: DownloadedAsset): Promise<InstalledRuntime>;
}

export interface QuickIndexProgress {
  current: number;
  total: number;
  currentFileName?: string | null;
}

export interface EmbeddingModelProgress {
  phase: "downloading" | "loading" | "ready";
  file: string | null;
  loadedBytes: number | null;
  totalBytes: number | null;
  percent: number | null;
}

export interface QuickIndexResult {
  requested: number;
  scopeType: "recent" | "folder" | "vault";
  /** Files selected after scope, exclusions and license capacity gates. */
  selectedFileCount: number;
  indexed: number;
  skipped: number;
  failed: number;
  chunkCount: number;
  selectedDocuments: readonly Readonly<{
    docId: string;
    path: string;
    mtime: number;
  }>[];
}

/** Task 11 supplies the implementation; Task 9 owns only this injection contract. */
export interface QuickIndexCoordinatorDependency {
  run(
    scope: QuickIndexScope,
    onProgress: (progress: QuickIndexProgress) => void,
    options?: {
      signal: AbortSignal;
      finalize?: (result: QuickIndexResult) => Promise<void>;
    },
  ): Promise<QuickIndexResult>;
}

export interface LegacyMigrationProgress {
  copiedRecords: number;
  totalRecords: number;
  sourceBytes: number;
}

export interface LegacyMigrationCoordinatorDependency {
  prepare(signal: AbortSignal): Promise<LegacyMigrationProgress | void>;
  copy(signal: AbortSignal, onProgress: (progress: LegacyMigrationProgress) => void): Promise<void>;
  reconcile(signal: AbortSignal, onProgress: (progress: LegacyMigrationProgress) => void): Promise<void>;
  verify(signal: AbortSignal): Promise<void>;
  cancel(): Promise<void>;
}

export interface OnboardingCoordinatorOptions {
  detectEnvironment(signal: AbortSignal): Promise<EnvironmentReport>;
  store: OnboardingStoreDependency;
  runtimes: Record<RuntimeKey, RuntimePipelineDependency>;
  chromaManager: {
    getState(): ManagedProcessState;
    start(options: ChromaStartOptions): Promise<ManagedProcessState>;
    stopOwnedProcess(expectedLease: ManagedProcessState): Promise<unknown>;
  };
  chromaStartOptions(installed: InstalledRuntime | null): ChromaStartOptions;
  embeddingRuntimeManager: { resolve(): Promise<unknown> };
  embeddingModel: {
    download(
      signal: AbortSignal,
      onProgress: (progress: EmbeddingModelProgress) => void,
    ): Promise<void>;
    warmUp(
      signal: AbortSignal,
      onProgress: (progress: EmbeddingModelProgress) => void,
    ): Promise<void>;
    cancel(): Promise<void>;
  };
  quickIndex: QuickIndexCoordinatorDependency;
  legacyMigration?: LegacyMigrationCoordinatorDependency;
  finalizeQuickIndex?(result: QuickIndexResult): Promise<void>;
  now?: () => number;
}

interface Suspension<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  settled: boolean;
}

interface GenerationContext {
  id: number;
  mode: OperationMode;
  runtimeRetryKey: RuntimeKey | null;
  controller: AbortController;
  consent: Suspension<boolean> | null;
  scope: Suspension<QuickIndexScope> | null;
  legacyChoice: Suspension<LegacyIndexChoice> | null;
  progressQueue: Promise<void>;
  firstProgressError: unknown | null;
  acceptingProgressStage: OnboardingStage | null;
  currentStage: OnboardingStage;
  terminal: "open" | "cancelling" | "ready" | "failed" | "cancelled";
  cancelRequested: boolean;
  cancelPromise: Promise<void> | null;
  modelCancellation: Promise<void> | null;
  ownedChromaLease: ManagedProcessState | null;
  ownedChromaStopped: boolean;
}

interface RuntimeEvidence {
  downloaded: DownloadedAsset | null;
  verified: boolean;
  installed: InstalledRuntime | null;
}

function createSuspension<T>(): Suspension<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const suspension: Suspension<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve(value: T) {
      if (suspension.settled) return;
      suspension.settled = true;
      resolvePromise(value);
    },
    reject(error: unknown) {
      if (suspension.settled) return;
      suspension.settled = true;
      rejectPromise(error);
    },
    settled: false,
  };
  return suspension;
}

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const candidate = error as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
  if (typeof candidate.code === "string") return candidate.code.toUpperCase();
  if (typeof candidate.name === "string" && candidate.name === "AbortError") return "ABORT_ERR";
  if (typeof candidate.message === "string" && /^[A-Z][A-Z0-9_]{2,80}$/.test(candidate.message)) {
    return candidate.message;
  }
  if (candidate.cause && candidate.cause !== error) return errorCode(candidate.cause);
  return "";
}

function isCancellation(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ABORT_ERR" || code === "DOWNLOAD_CANCELLED"
    || code === "CHROMA_START_CANCELLED" || code === "EMBEDDING_INITIALIZATION_CANCELLED"
    || /\bcancell?ed\b/i.test((error as Error)?.message ?? "");
}

interface ErrorRule {
  code: OnboardingErrorCode;
  action: OnboardingErrorAction;
  recoverable: boolean;
}

function knownErrorRule(code: string, stage: OnboardingStage): ErrorRule | null {
  if (code === "ABORT_ERR" || code === "DOWNLOAD_CANCELLED" || code === "CHROMA_START_CANCELLED"
    || code === "EMBEDDING_INITIALIZATION_CANCELLED") {
    return { code: "DOWNLOAD_CANCELLED", action: "none", recoverable: true };
  }
  if (code === "UNSUPPORTED_PLATFORM" || code === "PLATFORM_UNSUPPORTED") {
    return { code: "UNSUPPORTED_PLATFORM", action: "open-help", recoverable: false };
  }
  if (code === "ENOSPC" || code === "INSUFFICIENT_DISK_SPACE") {
    return { code: "INSUFFICIENT_DISK_SPACE", action: "retry", recoverable: true };
  }
  if (code === "EACCES" || code === "EPERM" || code.startsWith("ONBOARDING_STORE_")
    || code.startsWith("ONBOARDING_STATE_UNSAFE") || code === "LOCAL_DATA_ROOT_UNAVAILABLE") {
    return { code: "LOCAL_DATA_ROOT_UNAVAILABLE", action: "open-help", recoverable: true };
  }
  if (code === "ONBOARDING_STATE_CORRUPT" || code === "ONBOARDING_STATE_UNSUPPORTED_SCHEMA") {
    return { code: "ONBOARDING_STATE_CORRUPT", action: "retry", recoverable: true };
  }
  if (["ECONNRESET", "ETIMEDOUT", "EPIPE", "ENETUNREACH"].includes(code)) {
    return { code: "DOWNLOAD_NETWORK_ERROR", action: "retry", recoverable: true };
  }
  if (code === "DOWNLOAD_SIZE_MISMATCH" || code === "DOWNLOAD_HASH_MISMATCH") {
    return { code, action: "redownload", recoverable: true } as ErrorRule;
  }
  if (code === "DOWNLOAD_INSECURE_URL" || code === "DOWNLOAD_INSECURE_REDIRECT") {
    return { code: "DOWNLOAD_NETWORK_ERROR", action: "none", recoverable: false };
  }
  if (code === "DOWNLOAD_PART_CHANGED" || code === "DOWNLOAD_UNSAFE_META"
    || code === "DOWNLOAD_INVALID_CONTENT_LENGTH" || code === "DOWNLOAD_INVALID_CONTENT_RANGE") {
    return { code: "DOWNLOAD_SIZE_MISMATCH", action: "redownload", recoverable: true };
  }
  if (code.startsWith("DOWNLOAD_")) {
    return { code: "DOWNLOAD_NETWORK_ERROR", action: "retry", recoverable: true };
  }
  if (code === "RUNTIME_EXTRACT_FAILED") {
    return { code: "RUNTIME_EXTRACT_FAILED", action: "retry", recoverable: true };
  }
  if (["EXDEV", "EBUSY", "EIO", "RUNTIME_STAGING_RENAME_FAILED"].includes(code)) {
    return { code: "RUNTIME_EXTRACT_FAILED", action: "retry", recoverable: true };
  }
  if (code === "RUNTIME_EXECUTION_BLOCKED" || code === "CHROMA_EXECUTABLE_INVALID"
    || code === "CHROMA_EXECUTABLE_NOT_FOUND") {
    return { code: "RUNTIME_EXECUTION_BLOCKED", action: "open-help", recoverable: true };
  }
  if (code === "RUNTIME_SMOKE_TEST_FAILED" || code.startsWith("EMBEDDING_RUNTIME_SMOKE_")) {
    return { code: "RUNTIME_SMOKE_TEST_FAILED", action: "redownload", recoverable: true };
  }
  if (code === "CHROMA_PORT_CONFLICT" || code === "CHROMA_ALREADY_RUNNING") {
    return { code: "CHROMA_PORT_CONFLICT", action: "change-port", recoverable: true };
  }
  if (code === "CHROMA_START_TIMEOUT" || code === "CHROMA_HEALTH_TIMEOUT") {
    return { code: "CHROMA_START_TIMEOUT", action: "retry", recoverable: true };
  }
  if (code === "CHROMA_VERSION_MISMATCH") {
    return { code: "CHROMA_VERSION_MISMATCH", action: "redownload", recoverable: true };
  }
  if (code === "CHROMA_EXITED") {
    return { code: "CHROMA_EXITED", action: "retry", recoverable: true };
  }
  if (code.startsWith("EMBEDDING_RUNTIME_")) {
    return { code: "EMBEDDING_RUNTIME_INVALID", action: "redownload", recoverable: true };
  }
  if (code === "EMBEDDING_MODEL_DOWNLOAD_FAILED") {
    return { code: "EMBEDDING_MODEL_DOWNLOAD_FAILED", action: "retry", recoverable: true };
  }
  if (code === "EMBEDDING_MODEL_CACHE_CORRUPT") {
    return { code: "EMBEDDING_MODEL_CACHE_CORRUPT", action: "redownload", recoverable: true };
  }
  if (code === "EMBEDDING_MODEL_WARMUP_FAILED" || code.startsWith("EMBEDDING_WORKER_")) {
    return { code: "EMBEDDING_MODEL_WARMUP_FAILED", action: "retry", recoverable: true };
  }
  if (code === "ERR_DLOPEN_FAILED" || code === "MODULE_NOT_FOUND") {
    return { code: "EMBEDDING_MODEL_WARMUP_FAILED", action: "retry", recoverable: true };
  }
  if (code === "CHROMA_DATA_REBUILD_FAILED") {
    return { code: "CHROMA_DATA_REBUILD_FAILED", action: "retry", recoverable: true };
  }
  if (code === "LEGACY_RUNTIME_UNAVAILABLE" || code === "LEGACY_RUNTIME_UNTRUSTED"
    || code === "LEGACY_MIGRATION_UNAVAILABLE") {
    return { code: "LEGACY_MIGRATION_UNAVAILABLE", action: "retry", recoverable: true };
  }
  if (code.startsWith("LEGACY_") || code.startsWith("CHROMA_MIGRATION_")) {
    return { code: "LEGACY_INDEX_MIGRATION_FAILED", action: "retry", recoverable: true };
  }
  if (code === "QUICK_INDEX_FAILED") {
    return { code: "QUICK_INDEX_FAILED", action: "retry", recoverable: true };
  }
  const fallback: OnboardingErrorCode = stage === "building-quick-index"
    ? "QUICK_INDEX_FAILED"
    : stage.includes("legacy")
      ? "LEGACY_INDEX_MIGRATION_FAILED"
    : stage === "starting-chroma"
      ? "CHROMA_START_TIMEOUT"
      : stage === "downloading-embedding-model"
        ? "EMBEDDING_MODEL_DOWNLOAD_FAILED"
        : stage === "warming-up-model"
          ? "EMBEDDING_MODEL_WARMUP_FAILED"
          : stage.includes("embedding-runtime")
            ? "EMBEDDING_RUNTIME_INVALID"
            : "RUNTIME_EXTRACT_FAILED";
  return { code: fallback, action: "none", recoverable: false };
}

export function classifyOnboardingError(error: unknown, stage: OnboardingStage): OnboardingError {
  const rule = knownErrorRule(errorCode(error), stage) as ErrorRule;
  const cancelled = isCancellation(error);
  const classifiedStage = cancelled ? "cancelled" : stage;
  const technicalMessage = rule.code.slice(0, MAX_TECHNICAL_MESSAGE);
  return {
    code: rule.code,
    stage: classifiedStage,
    userMessageKey: `onboarding.error.${rule.code.toLowerCase()}`,
    technicalMessage,
    recoverable: rule.recoverable,
    action: rule.action,
  };
}

function initialSnapshot(): OnboardingSnapshot {
  return {
    schemaVersion: 1,
    stage: "not-started",
    progress: null,
    completedBytes: null,
    totalBytes: null,
    currentItem: "",
    runtimePlatform: null,
    chromaRuntimeId: null,
    embeddingRuntimeId: null,
    selectedIndexScope: null,
    legacyIndexChoice: null,
    legacyRecordsCopied: null,
    legacyRecordsTotal: null,
    legacySourceBytes: null,
    startedAt: null,
    updatedAt: 0,
    completedAt: null,
    dismissedAt: null,
    error: null,
  };
}

function copySnapshot(snapshot: OnboardingSnapshot): OnboardingSnapshot {
  return {
    ...snapshot,
    legacyIndexChoice: snapshot.legacyIndexChoice ?? null,
    legacyRecordsCopied: finiteNonNegative(snapshot.legacyRecordsCopied),
    legacyRecordsTotal: finiteNonNegative(snapshot.legacyRecordsTotal),
    legacySourceBytes: finiteNonNegative(snapshot.legacySourceBytes),
    selectedIndexScope: snapshot.selectedIndexScope ? { ...snapshot.selectedIndexScope } : null,
    error: snapshot.error ? { ...snapshot.error } : null,
  };
}

function immutableSnapshot(snapshot: OnboardingSnapshot): Readonly<OnboardingSnapshot> {
  const copy = copySnapshot(snapshot);
  if (copy.selectedIndexScope) Object.freeze(copy.selectedIndexScope);
  if (copy.error) Object.freeze(copy.error);
  return Object.freeze(copy);
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function boundedProgress(value: unknown): number | null {
  const number = finiteNonNegative(value);
  return number === null ? null : Math.max(0, Math.min(100, number));
}

function safeItem(value: unknown): string {
  if (typeof value !== "string") return "";
  const withoutQuery = value.trim().split(/[?#]/, 1)[0].replace(/\\/g, "/");
  let item = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
  try { item = decodeURIComponent(item); } catch { return ""; }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(item)
    || /(?:token|auth|secret|credential)/i.test(item)) return "";
  return item;
}

function validScope(value: unknown): QuickIndexScope | null {
  if (!value || typeof value !== "object") return null;
  const scope = value as Partial<QuickIndexScope> & { path?: unknown; limit?: unknown };
  if (scope.type === "recent" && scope.limit === 30) return { type: "recent", limit: 30 };
  if (scope.type === "vault") return { type: "vault" };
  if (scope.type !== "folder" || typeof scope.path !== "string") return null;
  const candidate = scope.path.trim().replace(/\\/g, "/");
  if (!candidate || candidate.length > 1024 || candidate.startsWith("/")
    || /^[A-Za-z]:\//.test(candidate) || candidate.includes("\0")
    || candidate.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return { type: "folder", path: candidate };
}

export class OnboardingCoordinator {
  private readonly options: OnboardingCoordinatorOptions;
  private readonly now: () => number;
  private readonly listeners = new Set<SnapshotListener>();
  private snapshot: OnboardingSnapshot = initialSnapshot();
  private generation = 0;
  private active: { context: GenerationContext; promise: Promise<Readonly<OnboardingSnapshot>> } | null = null;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private readonly runtimeEvidence: Record<RuntimeKey, RuntimeEvidence> = {
    chroma: { downloaded: null, verified: false, installed: null },
    embedding: { downloaded: null, verified: false, installed: null },
  };

  constructor(options: OnboardingCoordinatorOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  start(): Promise<Readonly<OnboardingSnapshot>> {
    return this.begin("start");
  }

  resume(): Promise<Readonly<OnboardingSnapshot>> {
    return this.begin("resume");
  }

  retry(): Promise<Readonly<OnboardingSnapshot>> {
    return this.begin("retry");
  }

  async fallbackToLegacyRebuild(): Promise<Readonly<OnboardingSnapshot>> {
    if (this.disposed || this.active || this.snapshot.legacyIndexChoice !== "reuse"
      || !["failed", "cancelled"].includes(this.snapshot.stage)) {
      throw codedError("LEGACY_REBUILD_FALLBACK_UNAVAILABLE");
    }
    const candidate = copySnapshot({
      ...this.snapshot,
      stage: "checking",
      progress: null,
      completedBytes: null,
      totalBytes: null,
      currentItem: "",
      legacyIndexChoice: "rebuild",
      error: null,
      completedAt: null,
      updatedAt: this.now(),
    });
    await this.options.store.save(candidate);
    this.snapshot = candidate;
    this.notify(candidate);
    return this.begin("retry");
  }

  retryRuntime(kind: RuntimeAssetKind): Promise<Readonly<OnboardingSnapshot>> {
    if (kind !== "chroma" && kind !== "embedding-runtime") {
      return Promise.reject(codedError("RUNTIME_SINGLE_ASSET_RETRY_INVALID_KIND"));
    }
    return this.begin("retry-runtime", kind === "chroma" ? "chroma" : "embedding");
  }

  getSnapshot(): Readonly<OnboardingSnapshot> {
    return immutableSnapshot(this.snapshot);
  }

  subscribe(listener: SnapshotListener): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  async provideConsent(accepted: boolean): Promise<boolean> {
    const context = this.active?.context;
    if (!context || context.consent?.settled !== false || this.snapshot.stage !== "awaiting-consent") return false;
    context.consent.resolve(accepted === true);
    return true;
  }

  async selectIndexScope(scope: QuickIndexScope): Promise<boolean> {
    const context = this.active?.context;
    const normalized = validScope(scope);
    if (!context || !normalized || context.scope?.settled !== false
      || this.snapshot.stage !== "selecting-index-scope") return false;
    context.scope.resolve(normalized);
    return true;
  }

  async selectLegacyIndexAction(choice: LegacyIndexChoice): Promise<boolean> {
    const context = this.active?.context;
    if (!context || !["reuse", "rebuild", "later"].includes(choice)
      || context.legacyChoice?.settled !== false
      || this.snapshot.stage !== "selecting-legacy-index-action") return false;
    context.legacyChoice.resolve(choice);
    return true;
  }

  cancel(): Promise<void> {
    const context = this.active?.context;
    if (!context || context.terminal === "ready" || context.terminal === "failed"
      || context.terminal === "cancelled") return Promise.resolve();
    if (context.cancelPromise) return context.cancelPromise;
    context.terminal = "cancelling";
    context.cancelRequested = true;
    context.controller.abort();
    const cancellation = codedError("DOWNLOAD_CANCELLED");
    context.consent?.reject(cancellation);
    context.scope?.reject(cancellation);
    context.legacyChoice?.reject(cancellation);
    const promise = this.cleanupGeneration(context);
    context.cancelPromise = promise;
    return promise;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.listeners.clear();
    const operation = this.active?.promise;
    const cancellation = this.cancel();
    this.disposePromise = (async () => {
      await cancellation.catch(() => undefined);
      await operation?.then(() => undefined, () => undefined);
      await this.options.store.flush?.().catch(() => undefined);
    })();
    return this.disposePromise;
  }

  private begin(mode: OperationMode, runtimeRetryKey: RuntimeKey | null = null): Promise<Readonly<OnboardingSnapshot>> {
    if (this.disposed) return Promise.reject(codedError("ONBOARDING_COORDINATOR_DISPOSED"));
    if (this.active) return this.active.promise;
    const context: GenerationContext = {
      id: ++this.generation,
      mode,
      runtimeRetryKey,
      controller: new AbortController(),
      consent: null,
      scope: null,
      legacyChoice: null,
      progressQueue: Promise.resolve(),
      firstProgressError: null,
      acceptingProgressStage: null,
      currentStage: "checking",
      terminal: "open",
      cancelRequested: false,
      cancelPromise: null,
      modelCancellation: null,
      ownedChromaLease: null,
      ownedChromaStopped: false,
    };
    const promise = Promise.resolve().then(() => this.run(context));
    this.active = { context, promise };
    void promise.then(
      () => { if (this.active?.context === context) this.active = null; },
      () => { if (this.active?.context === context) this.active = null; },
    );
    return promise;
  }

  private async run(context: GenerationContext): Promise<Readonly<OnboardingSnapshot>> {
    let loaded = this.snapshot;
    try {
      loaded = copySnapshot((await this.options.store.load()).snapshot);
      this.assertRunnable(context);
      this.snapshot = loaded;
      this.notify(loaded);
      if (context.mode === "retry" && loaded.stage === "failed"
        && loaded.error?.recoverable === false) {
        context.terminal = "failed";
        return this.getSnapshot();
      }
      const previousStage = loaded.stage === "failed" && loaded.error ? loaded.error.stage : loaded.stage;
      await this.publishStage(context, "checking", {
        runtimePlatform: null,
        startedAt: loaded.startedAt ?? this.now(),
        completedAt: null,
        error: null,
      });
      const report = await this.options.detectEnvironment(context.controller.signal);
      this.assertRunnable(context);
      this.resetInMemoryEvidence();
      await this.publishPatch(context, { runtimePlatform: report.platform });

      const needsWork = report.chroma !== "running" || report.embeddingRuntime !== "ready"
        || report.embeddingModel !== "ready" || report.index !== "ready";
      const previouslyConsented = context.runtimeRetryKey !== null
        || (context.mode !== "start" && loaded.startedAt !== null
          && !["not-started", "awaiting-consent", "cancelled"].includes(previousStage));
      if (needsWork && !previouslyConsented) {
        context.consent = createSuspension<boolean>();
        await this.publishStage(context, "awaiting-consent");
        const accepted = await context.consent.promise;
        context.consent = null;
        this.assertRunnable(context);
        if (!accepted) {
          return await this.settleCancelled(context, { dismissedAt: this.now() });
        }
      }

      const chromaInstalled = report.chroma === "installed" || report.chroma === "running";
      const embeddingInstalled = report.embeddingRuntime === "installed" || report.embeddingRuntime === "ready";
      if (context.runtimeRetryKey) {
        const otherRuntimeReady = context.runtimeRetryKey === "chroma"
          ? report.embeddingRuntime === "ready"
          : report.chroma === "running";
        if (!otherRuntimeReady || report.embeddingModel !== "ready" || report.index !== "ready") {
          throw codedError("RUNTIME_SINGLE_ASSET_RETRY_UNAVAILABLE");
        }
      }
      await this.prepareRuntime(context, "chroma", context.runtimeRetryKey === "chroma" ? false : chromaInstalled);
      await this.prepareRuntime(context, "embedding", context.runtimeRetryKey === "embedding" ? false : embeddingInstalled);
      if (context.runtimeRetryKey !== "chroma") {
        await this.options.embeddingRuntimeManager.resolve();
        this.assertRunnable(context);
      }

      if (report.chroma !== "running") {
        await this.publishStage(context, "starting-chroma");
        const before = this.options.chromaManager.getState();
        const state = await this.options.chromaManager.start(
          this.options.chromaStartOptions(this.runtimeEvidence.chroma.installed),
        );
        if (before.ownership === "none" && state.ownership === "analogy") {
          context.ownedChromaLease = { ...state };
        }
        this.assertRunnable(context);
      }

      if (report.embeddingModel !== "ready") {
        if (report.embeddingModel !== "cached") {
          await this.publishStage(context, "downloading-embedding-model");
          await this.options.embeddingModel.download(context.controller.signal, (progress) => {
            this.enqueueEmbeddingProgress(context, "downloading-embedding-model", progress);
          });
          await this.drainProgress(context);
          this.assertRunnable(context);
        }
        await this.publishStage(context, "warming-up-model");
        await this.options.embeddingModel.warmUp(context.controller.signal, (progress) => {
          this.enqueueEmbeddingProgress(context, "warming-up-model", progress);
        });
        await this.drainProgress(context);
        this.assertRunnable(context);
      }

      if (report.index === "legacy") {
        let choice = context.mode === "start" ? null : loaded.legacyIndexChoice;
        if (choice !== "reuse" && choice !== "rebuild") {
          context.legacyChoice = createSuspension<LegacyIndexChoice>();
          await this.publishStage(context, "selecting-legacy-index-action", {
            legacyIndexChoice: null,
            legacyRecordsCopied: 0,
            legacyRecordsTotal: finiteNonNegative(report.legacyIndexSummary?.estimatedRecords),
            legacySourceBytes: finiteNonNegative(report.legacyIndexSummary?.sourceBytes),
          });
          choice = await context.legacyChoice.promise;
          context.legacyChoice = null;
          this.assertRunnable(context);
          await this.publishPatch(context, { legacyIndexChoice: choice });
        }
        if (choice === "later") {
          return await this.settleCancelled(context, { dismissedAt: this.now() });
        }
        if (choice === "reuse") {
          await this.runLegacyMigration(context);
          return await this.commitReady(context);
        }
      }

      if (report.index !== "ready") {
        let scope = validScope(loaded.selectedIndexScope);
        if (!scope) {
          context.scope = createSuspension<QuickIndexScope>();
          await this.publishStage(context, "selecting-index-scope", { selectedIndexScope: null });
          scope = await context.scope.promise;
          context.scope = null;
          this.assertRunnable(context);
          await this.publishPatch(context, { selectedIndexScope: scope });
        }
        await this.publishStage(context, "building-quick-index", { selectedIndexScope: scope });
        await this.options.quickIndex.run(scope, (progress) => {
          this.enqueueQuickIndexProgress(context, progress);
        }, {
          signal: context.controller.signal,
          finalize: this.options.finalizeQuickIndex,
        });
        await this.drainProgress(context);
        this.assertRunnable(context);
      }

      return await this.commitReady(context);
    } catch (error) {
      const progressError = context.firstProgressError;
      await this.drainProgress(context, false);
      if (context.cancelRequested || context.controller.signal.aborted || isCancellation(error)) {
        return await this.settleCancelled(context);
      }
      const classified = classifyOnboardingError(progressError ?? error, context.currentStage);
      this.invalidateEvidenceAfterFailure(classified);
      await this.cleanupGeneration(context);
      if (context.cancelRequested || context.controller.signal.aborted || context.terminal === "cancelling") {
        return await this.settleCancelled(context);
      }
      try {
        return await this.commitFailed(context, classified);
      } catch (persistenceError) {
        if (context.cancelRequested || context.controller.signal.aborted || isCancellation(persistenceError)) {
          return await this.settleCancelled(context);
        }
        const persistence = classifyOnboardingError(persistenceError, context.currentStage);
        throw codedError(persistence.code);
      }
    }
  }

  private async prepareRuntime(
    context: GenerationContext,
    key: RuntimeKey,
    freshEvidence: boolean,
  ): Promise<void> {
    const evidence = this.runtimeEvidence[key];
    const pipeline = this.options.runtimes[key];
    if (freshEvidence || evidence.installed) {
      await this.publishPatch(context, key === "chroma"
        ? { chromaRuntimeId: pipeline.asset.id }
        : { embeddingRuntimeId: pipeline.asset.id });
      return;
    }
    const label = key === "chroma" ? "chroma" : "embedding-runtime";
    if (!evidence.downloaded) {
      await this.publishStage(context, `downloading-${label}` as OnboardingStage);
      evidence.downloaded = await pipeline.download(context.controller.signal, (progress) => {
        this.enqueueDownloadProgress(context, `downloading-${label}` as OnboardingStage, progress);
      });
      await this.drainProgress(context);
      this.assertRunnable(context);
    }
    if (!evidence.verified) {
      await this.publishStage(context, `verifying-${label}` as OnboardingStage);
      const verification = await pipeline.verify(evidence.downloaded);
      this.assertRunnable(context);
      if (verification && !verification.ok) throw codedError(verification.errorCode ?? "DOWNLOAD_HASH_MISMATCH");
      evidence.verified = true;
    }
    await this.publishStage(context, `installing-${label}` as OnboardingStage);
    evidence.installed = await pipeline.install(evidence.downloaded);
    this.assertRunnable(context);
    await this.publishPatch(context, key === "chroma"
      ? { chromaRuntimeId: evidence.installed.runtimeId }
      : { embeddingRuntimeId: evidence.installed.runtimeId });
  }

  private invalidateEvidenceAfterFailure(error: OnboardingError): void {
    if (error.code !== "DOWNLOAD_SIZE_MISMATCH" && error.code !== "DOWNLOAD_HASH_MISMATCH") return;
    const key: RuntimeKey | null = error.stage.includes("embedding-runtime") ? "embedding"
      : error.stage.includes("chroma") ? "chroma" : null;
    if (!key) return;
    this.runtimeEvidence[key].downloaded = null;
    this.runtimeEvidence[key].verified = false;
    this.runtimeEvidence[key].installed = null;
  }

  private resetInMemoryEvidence(): void {
    this.runtimeEvidence.chroma = { downloaded: null, verified: false, installed: null };
    this.runtimeEvidence.embedding = { downloaded: null, verified: false, installed: null };
  }

  private enqueueDownloadProgress(
    context: GenerationContext,
    stage: OnboardingStage,
    progress: DownloadProgress & { currentItem?: string },
  ): void {
    if (!this.acceptsProgress(context, stage)) return;
    const patch: Partial<OnboardingSnapshot> = {
      progress: boundedProgress(progress.percent),
      completedBytes: finiteNonNegative(progress.receivedBytes),
      totalBytes: finiteNonNegative(progress.totalBytes),
      currentItem: safeItem(progress.currentItem ?? this.options.runtimes[
        stage === "downloading-chroma" ? "chroma" : "embedding"
      ].asset.fileName),
    };
    this.enqueueProgress(context, stage, patch);
  }

  private enqueueEmbeddingProgress(
    context: GenerationContext,
    stage: OnboardingStage,
    progress: EmbeddingModelProgress,
  ): void {
    this.enqueueProgress(context, stage, {
      progress: boundedProgress(progress.percent),
      completedBytes: finiteNonNegative(progress.loadedBytes),
      totalBytes: finiteNonNegative(progress.totalBytes),
      currentItem: safeItem(progress.file),
    });
  }

  private enqueueQuickIndexProgress(context: GenerationContext, progress: QuickIndexProgress): void {
    const current = finiteNonNegative(progress.current);
    const total = finiteNonNegative(progress.total);
    this.enqueueProgress(context, "building-quick-index", {
      progress: current !== null && total !== null && total > 0 ? boundedProgress((current / total) * 100) : null,
      completedBytes: current,
      totalBytes: total,
      currentItem: safeItem(progress.currentFileName),
    });
  }

  private enqueueLegacyProgress(
    context: GenerationContext,
    stage: OnboardingStage,
    progress: LegacyMigrationProgress,
  ): void {
    const copied = finiteNonNegative(progress.copiedRecords);
    const total = finiteNonNegative(progress.totalRecords);
    this.enqueueProgress(context, stage, {
      progress: copied !== null && total !== null && total > 0 ? boundedProgress((copied / total) * 100) : null,
      completedBytes: copied,
      totalBytes: total,
      currentItem: "",
      legacyRecordsCopied: copied,
      legacyRecordsTotal: total,
      legacySourceBytes: finiteNonNegative(progress.sourceBytes),
    });
  }

  private async runLegacyMigration(context: GenerationContext): Promise<void> {
    const migration = this.options.legacyMigration;
    if (!migration) throw codedError("LEGACY_MIGRATION_UNAVAILABLE");
    await this.publishStage(context, "preparing-legacy-snapshot");
    const prepared = await migration.prepare(context.controller.signal);
    this.assertRunnable(context);
    if (prepared) {
      await this.publishPatch(context, {
        legacyRecordsCopied: finiteNonNegative(prepared.copiedRecords),
        legacyRecordsTotal: finiteNonNegative(prepared.totalRecords),
        legacySourceBytes: finiteNonNegative(prepared.sourceBytes),
      });
    }
    await this.publishStage(context, "migrating-legacy-index");
    await migration.copy(context.controller.signal, (progress) => {
      this.enqueueLegacyProgress(context, "migrating-legacy-index", progress);
    });
    await this.drainProgress(context);
    this.assertRunnable(context);
    await this.publishStage(context, "reconciling-legacy-index");
    await migration.reconcile(context.controller.signal, (progress) => {
      this.enqueueLegacyProgress(context, "reconciling-legacy-index", progress);
    });
    await this.drainProgress(context);
    this.assertRunnable(context);
    await this.publishStage(context, "verifying-legacy-index");
    await migration.verify(context.controller.signal);
    this.assertRunnable(context);
  }

  private enqueueProgress(
    context: GenerationContext,
    stage: OnboardingStage,
    patch: Partial<OnboardingSnapshot>,
  ): void {
    if (!this.acceptsProgress(context, stage)) return;
    const queued = context.progressQueue.then(async () => {
      if (!this.acceptsProgress(context, stage)) return;
      await this.publishPatch(context, patch);
    });
    context.progressQueue = queued.catch((error) => {
      if (context.firstProgressError === null) context.firstProgressError = error;
    });
  }

  private async drainProgress(context: GenerationContext, rethrow = true): Promise<void> {
    await context.progressQueue;
    const error = context.firstProgressError;
    context.firstProgressError = null;
    if (rethrow && error !== null) throw error;
  }

  private acceptsProgress(context: GenerationContext, stage: OnboardingStage): boolean {
    return this.isCurrent(context) && !context.controller.signal.aborted
      && !context.cancelRequested && context.acceptingProgressStage === stage;
  }

  private async publishStage(
    context: GenerationContext,
    stage: OnboardingStage,
    patch: Partial<OnboardingSnapshot> = {},
  ): Promise<void> {
    context.currentStage = stage;
    context.acceptingProgressStage = null;
    await this.drainProgress(context);
    await this.publishPatch(context, {
      stage,
      progress: null,
      completedBytes: null,
      totalBytes: null,
      currentItem: "",
      ...patch,
    });
    context.acceptingProgressStage = stage;
  }

  private async publishPatch(
    context: GenerationContext,
    patch: Partial<OnboardingSnapshot>,
  ): Promise<void> {
    this.assertRunnable(context);
    const candidate = this.snapshotWith(patch);
    await this.options.store.save(copySnapshot(candidate));
    this.assertRunnable(context);
    this.snapshot = candidate;
    this.notify(candidate);
  }

  private snapshotWith(patch: Partial<OnboardingSnapshot>): OnboardingSnapshot {
    return {
      ...copySnapshot(this.snapshot),
      ...patch,
      selectedIndexScope: patch.selectedIndexScope === undefined
        ? this.snapshot.selectedIndexScope
        : patch.selectedIndexScope,
      error: patch.error === undefined ? this.snapshot.error : patch.error,
      updatedAt: this.now(),
    };
  }

  private async commitReady(context: GenerationContext): Promise<Readonly<OnboardingSnapshot>> {
    context.currentStage = "ready";
    context.acceptingProgressStage = null;
    await this.drainProgress(context);
    this.assertRunnable(context);
    const candidate = this.snapshotWith({
      stage: "ready",
      progress: 100,
      completedBytes: null,
      totalBytes: null,
      currentItem: "",
      completedAt: this.now(),
      error: null,
    });
    await this.options.store.save(copySnapshot(candidate));
    // This synchronous block is the ready linearization point. A cancellation
    // that wins while save is pending changes terminal away from open.
    this.assertRunnable(context);
    context.terminal = "ready";
    context.ownedChromaLease = null;
    this.snapshot = candidate;
    this.notify(candidate);
    return this.getSnapshot();
  }

  private async commitFailed(
    context: GenerationContext,
    error: OnboardingError,
  ): Promise<Readonly<OnboardingSnapshot>> {
    if (!this.isCurrent(context) || context.terminal !== "open") throw codedError("DOWNLOAD_CANCELLED");
    context.acceptingProgressStage = null;
    const candidate = this.snapshotWith({
      stage: "failed",
      progress: null,
      completedBytes: null,
      totalBytes: null,
      currentItem: "",
      error,
    });
    await this.options.store.save(copySnapshot(candidate));
    if (!this.isCurrent(context) || context.terminal !== "open"
      || context.controller.signal.aborted || context.cancelRequested) {
      throw codedError("DOWNLOAD_CANCELLED");
    }
    context.terminal = "failed";
    this.snapshot = candidate;
    this.notify(candidate);
    return this.getSnapshot();
  }

  private async settleCancelled(
    context: GenerationContext,
    patch: Partial<OnboardingSnapshot> = {},
  ): Promise<Readonly<OnboardingSnapshot>> {
    if (context.terminal === "ready" || context.terminal === "cancelled") return this.getSnapshot();
    context.terminal = "cancelling";
    context.acceptingProgressStage = null;
    context.cancelRequested = true;
    context.controller.abort();
    const cancellation = codedError("DOWNLOAD_CANCELLED");
    context.consent?.reject(cancellation);
    context.scope?.reject(cancellation);
    context.legacyChoice?.reject(cancellation);
    await this.drainProgress(context, false);
    await this.cleanupGeneration(context);
    const candidate = this.snapshotWith({
      stage: "cancelled",
      progress: null,
      completedBytes: null,
      totalBytes: null,
      currentItem: "",
      error: null,
      ...patch,
    });
    try {
      await this.options.store.save(copySnapshot(candidate));
    } catch (error) {
      throw codedError(classifyOnboardingError(error, "cancelled").code);
    }
    if (!this.isCurrent(context) || context.terminal !== "cancelling") {
      throw codedError("DOWNLOAD_CANCELLED");
    }
    context.terminal = "cancelled";
    this.snapshot = candidate;
    this.notify(candidate);
    return this.getSnapshot();
  }

  private notify(candidate: OnboardingSnapshot): void {
    const listeners = [...this.listeners];
    for (const listener of listeners) {
      if (!this.listeners.has(listener)) continue;
      try { listener(immutableSnapshot(candidate)); } catch { /* listeners are isolated */ }
    }
  }

  private assertRunnable(context: GenerationContext): void {
    if (!this.isCurrent(context) || context.terminal !== "open" || context.cancelRequested
      || context.controller.signal.aborted || this.disposed) {
      throw codedError("DOWNLOAD_CANCELLED");
    }
  }

  private isCurrent(context: GenerationContext): boolean {
    return this.active?.context === context && context.id === this.generation;
  }

  private async cleanupGeneration(context: GenerationContext): Promise<void> {
    await this.drainProgress(context, false);
    if (!context.modelCancellation) {
      context.modelCancellation = this.options.embeddingModel.cancel().catch(() => undefined);
    }
    await Promise.all([
      context.modelCancellation,
      this.options.legacyMigration?.cancel().catch(() => undefined),
      this.stopOwnedChroma(context).catch(() => undefined),
    ]);
  }

  private async stopOwnedChroma(context: GenerationContext): Promise<void> {
    const lease = context.ownedChromaLease;
    if (!lease || context.ownedChromaStopped || context.terminal === "ready") return;
    context.ownedChromaStopped = true;
    context.ownedChromaLease = null;
    await this.options.chromaManager.stopOwnedProcess(lease);
  }
}
