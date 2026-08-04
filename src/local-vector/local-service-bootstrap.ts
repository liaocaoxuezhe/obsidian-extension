import type { DocumentSummarizer } from "./document-summarizer";
import type { EmbeddingInitializationProgress } from "./embedding-worker-protocol";
import type { ManagedEmbeddingRuntime } from "../runtime/embedding-runtime-manager";
import type {
  ChromaStartOptions,
  ManagedProcessState,
  StopOwnedProcessResult,
} from "../runtime/chroma-runtime-manager";
import type { EnvironmentReport } from "../onboarding/onboarding-types";
import type { ServiceState } from "./search-instance";

export interface VerifiedChromaRuntime {
  runtimeId: string;
  executablePath: string;
  dataPath: string;
  preferredPort: number;
  runtimeVersion: string;
  assetSha256: string;
  revalidate(): Promise<{
    runtimeId: string;
    executablePath: string;
    runtimeVersion: string;
    assetSha256: string;
  }>;
}

export interface VerifiedLocalRuntimes {
  chroma: VerifiedChromaRuntime;
  embedding: ManagedEmbeddingRuntime;
}

export interface BootstrapVectorStore {
  initialize(
    port: number,
    vaultId: string,
    modelShortName: string,
    collectionName?: string,
  ): Promise<void>;
}

export interface BootstrapEmbeddingService {
  initialize(onProgress?: (progress: EmbeddingInitializationProgress) => void): Promise<void>;
  isReady(): boolean;
  dispose(): Promise<void>;
}

export interface BootstrapDocumentIndexer {
  loadState(): Promise<void>;
  watchVault(): void;
  stop(): Promise<void>;
  shutdown(): void;
  flushState(): Promise<void>;
}

export interface BootstrapChromaManager {
  start(options: ChromaStartOptions): Promise<ManagedProcessState>;
  health(port: number): Promise<boolean>;
  getState(): ManagedProcessState;
  stopOwnedProcess(expectedLease?: ManagedProcessState): Promise<StopOwnedProcessResult>;
}

export interface LocalChromaServiceController {
  isHealthy(): Promise<boolean>;
  stop(): Promise<void>;
  getLastError(): string;
  getPort(): number;
  getDbPath(): string;
  getProcessState(): ManagedProcessState;
}

export interface LocalServiceReady {
  embeddingService: BootstrapEmbeddingService;
  vectorStore: BootstrapVectorStore;
  documentIndexer: BootstrapDocumentIndexer;
  documentSummarizer: DocumentSummarizer | null;
  chromaManager: LocalChromaServiceController;
  lease: ManagedProcessState;
  runtimes: VerifiedLocalRuntimes;
  maxInputChars: number;
  resolveCollectionName?(): Promise<string | undefined>;
}

export interface LocalServiceStopOptions {
  /** Onboarding still owns this lease and will stop it exactly once. */
  preserveChromaLease?: boolean;
}

export interface LocalServiceBootstrapOptions {
  resolveVerifiedRuntimes(signal: AbortSignal): Promise<VerifiedLocalRuntimes>;
  chromaManager: BootstrapChromaManager;
  vaultId: string;
  modelShortName: string;
  maxInputChars: number;
  resolveCollectionName?(): Promise<string | undefined>;
  createVectorStore(): BootstrapVectorStore;
  createEmbeddingService(runtime: ManagedEmbeddingRuntime): BootstrapEmbeddingService;
  createSummarizer(): DocumentSummarizer | null;
  createDocumentIndexer(
    embedding: BootstrapEmbeddingService,
    vectorStore: BootstrapVectorStore,
  ): BootstrapDocumentIndexer;
  publishServices(ready: LocalServiceReady | null): void | Promise<void>;
  updateSearchState(patch: Partial<ServiceState>): void;
  recordCleanupError?(error: Error): void;
  coordinator?: {
    retry(): Promise<Readonly<{ stage: string }>>;
    cancel?(): Promise<void>;
  };
  detectEnvironment?: (signal: AbortSignal) => Promise<EnvironmentReport>;
}

interface BootstrapGeneration {
  id: number;
  controller: AbortController;
  chromaStartPromise: Promise<ManagedProcessState> | null;
  chromaStartBaseline: ManagedProcessState | null;
  chromaStartOptions: ChromaStartOptions | null;
  lease: ManagedProcessState | null;
  embedding: BootstrapEmbeddingService | null;
  indexer: BootstrapDocumentIndexer | null;
  cleanupPromise: Promise<void> | null;
}

type CleanupFailure = Error & { code: string; cause?: unknown; errors: readonly unknown[] };
type RollbackFailure = Error & { code: string; cause: unknown; cleanupError: unknown };

function bootstrapError(code: string, cause?: unknown): Error {
  const error = new Error(code) as Error & { code?: string; cause?: unknown };
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function cleanupFailure(errors: unknown[]): CleanupFailure {
  const error = bootstrapError("LOCAL_SERVICE_CLEANUP_FAILED", errors[0]) as CleanupFailure;
  error.errors = Object.freeze([...errors]);
  return error;
}

function rollbackFailure(primary: unknown, cleanupError: unknown): RollbackFailure {
  const error = bootstrapError("LOCAL_SERVICE_ROLLBACK_FAILED", primary) as RollbackFailure;
  error.cause = primary;
  error.cleanupError = cleanupError;
  return error;
}

function isReadyEnvironment(report: EnvironmentReport): boolean {
  return (report.chroma === "installed" || report.chroma === "running")
    && report.embeddingRuntime === "ready"
    && report.embeddingModel === "ready"
    && report.index === "ready"
    && (report.recommendedAction === "start-services" || report.recommendedAction === "none");
}

export class LocalServiceBootstrap {
  private readonly options: LocalServiceBootstrapOptions;
  private generation = 0;
  private active: BootstrapGeneration | null = null;
  private ready: LocalServiceReady | null = null;
  private startPromise: Promise<LocalServiceReady> | null = null;
  private stopPromise: Promise<void> | null = null;
  private releasePromise: Promise<void> | null = null;
  private retainedLease: ManagedProcessState | null = null;
  private retainedLeaseStopPromise: Promise<void> | null = null;
  private repairAbort: AbortController | null = null;
  private disposed = false;

  constructor(options: LocalServiceBootstrapOptions) {
    this.options = options;
  }

  isReady(): boolean {
    return this.ready !== null;
  }

  start(): Promise<LocalServiceReady> {
    if (this.disposed) return Promise.reject(bootstrapError("LOCAL_SERVICE_BOOTSTRAP_DISPOSED"));
    if (this.ready) return Promise.resolve(this.ready);
    if (this.startPromise) return this.startPromise;
    const context: BootstrapGeneration = {
      id: ++this.generation,
      controller: new AbortController(),
      chromaStartPromise: null,
      chromaStartBaseline: null,
      chromaStartOptions: null,
      lease: null,
      embedding: null,
      indexer: null,
      cleanupPromise: null,
    };
    this.active = context;
    const operation = this.run(context);
    this.startPromise = operation;
    void operation.then(
      () => { if (this.startPromise === operation) this.startPromise = null; },
      () => { if (this.startPromise === operation) this.startPromise = null; },
    );
    return operation;
  }

  async repairAndStart(): Promise<LocalServiceReady> {
    if (!this.options.coordinator || !this.options.detectEnvironment) {
      throw bootstrapError("LOCAL_SERVICE_REPAIR_UNAVAILABLE");
    }
    const controller = new AbortController();
    this.repairAbort = controller;
    try {
      const repaired = await this.options.coordinator.retry();
      if (controller.signal.aborted) throw bootstrapError("LOCAL_SERVICE_BOOTSTRAP_CANCELLED");
      if (repaired.stage !== "ready") throw bootstrapError("LOCAL_SERVICE_REPAIR_INCOMPLETE");
      const report = await this.options.detectEnvironment(controller.signal);
      if (controller.signal.aborted) throw bootstrapError("LOCAL_SERVICE_BOOTSTRAP_CANCELLED");
      if (!isReadyEnvironment(report)) throw bootstrapError("LOCAL_SERVICE_ENVIRONMENT_NOT_READY");
      return this.start();
    } finally {
      if (this.repairAbort === controller) this.repairAbort = null;
    }
  }

  stop(options: LocalServiceStopOptions = {}): Promise<void> {
    return this.stopServices(options, true);
  }

  async restartForGenerationSwitch(): Promise<LocalServiceReady> {
    await this.stopForGenerationSwitch({ preserveChromaLease: true });
    return this.start();
  }

  stopForGenerationSwitch(options: LocalServiceStopOptions): Promise<void> {
    return this.stopServices(options, false);
  }

  private stopServices(options: LocalServiceStopOptions, cancelCoordinator: boolean): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const context = this.active;
    this.generation += 1;
    context?.controller.abort();
    this.repairAbort?.abort();
    const pendingRelease = this.releasePromise;
    const coordinatorCancellation = cancelCoordinator
      ? Promise.resolve()
        .then(() => this.options.coordinator?.cancel?.())
        .then(() => undefined, () => undefined)
      : Promise.resolve();
    const operation = (async () => {
      await coordinatorCancellation;
      await pendingRelease?.catch(() => undefined);
      if (context) await this.cleanup(context, options);
      if (!options.preserveChromaLease) await this.stopRetainedLease();
      this.ready = null;
      if (this.active === context) this.active = null;
      await this.publishStoppedState();
    })();
    this.stopPromise = operation;
    void operation.then(
      () => { if (this.stopPromise === operation) this.stopPromise = null; },
      () => { if (this.stopPromise === operation) this.stopPromise = null; },
    );
    return operation;
  }

  releaseSetupServices(
    options: LocalServiceStopOptions = { preserveChromaLease: true },
  ): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.releasePromise) return this.releasePromise;
    const context = this.active;
    this.generation += 1;
    context?.controller.abort();
    const operation = (async () => {
      try {
        if (context) await this.cleanup(context, options);
        if (!options.preserveChromaLease) await this.stopRetainedLease();
      } finally {
        this.ready = null;
        if (this.active === context) this.active = null;
        await this.publishStoppedState();
      }
    })();
    this.releasePromise = operation;
    void operation.then(
      () => { if (this.releasePromise === operation) this.releasePromise = null; },
      () => { if (this.releasePromise === operation) this.releasePromise = null; },
    );
    return operation;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
  }

  private async run(context: BootstrapGeneration): Promise<LocalServiceReady> {
    this.options.updateSearchState({
      status: "initializing",
      embeddingStatus: "idle",
      vectorStoreStatus: "idle",
      modelDownloadProgress: 0,
      lastError: "",
    });
    try {
      await this.stopRetainedLease();
      this.assertCurrent(context);
      const runtimes = await this.options.resolveVerifiedRuntimes(context.controller.signal);
      this.assertCurrent(context);
      const chromaSnapshot = await runtimes.chroma.revalidate();
      this.assertCurrent(context);
      if (chromaSnapshot.runtimeId !== runtimes.chroma.runtimeId
        || chromaSnapshot.executablePath !== runtimes.chroma.executablePath
        || chromaSnapshot.runtimeVersion !== runtimes.chroma.runtimeVersion
        || chromaSnapshot.assetSha256 !== runtimes.chroma.assetSha256) {
        throw bootstrapError("LOCAL_SERVICE_CHROMA_SNAPSHOT_MISMATCH");
      }
      const startOptions: ChromaStartOptions = {
        executablePath: runtimes.chroma.executablePath,
        dataPath: runtimes.chroma.dataPath,
        preferredPort: runtimes.chroma.preferredPort,
        runtimeVersion: runtimes.chroma.runtimeVersion,
      };
      context.chromaStartBaseline = this.options.chromaManager.getState();
      context.chromaStartOptions = startOptions;
      context.chromaStartPromise = this.options.chromaManager.start(startOptions);
      const lease = await context.chromaStartPromise;
      context.chromaStartPromise = null;
      context.lease = { ...lease };
      this.assertCurrent(context);
      this.assertLease(runtimes.chroma, lease);
      if (!await this.options.chromaManager.health(lease.port)) {
        throw bootstrapError("LOCAL_SERVICE_CHROMA_NOT_READY");
      }
      this.assertCurrent(context);

      const vectorStore = this.options.createVectorStore();
      const collectionName = await this.options.resolveCollectionName?.();
      this.assertCurrent(context);
      await vectorStore.initialize(
        lease.port,
        this.options.vaultId,
        this.options.modelShortName,
        collectionName,
      );
      this.assertCurrent(context);
      this.options.updateSearchState({ vectorStoreStatus: "ready", lastError: "" });

      const embedding = this.options.createEmbeddingService(runtimes.embedding);
      context.embedding = embedding;
      await embedding.initialize((progress) => {
        if (!this.isCurrent(context)) return;
        this.options.updateSearchState({
          embeddingStatus: progress.phase === "ready" ? "ready" : "loading",
          modelDownloadProgress: progress.percent ?? 0,
        });
      });
      this.assertCurrent(context);
      if (!embedding.isReady()) throw bootstrapError("LOCAL_SERVICE_EMBEDDING_NOT_READY");

      const summarizer = this.options.createSummarizer();
      const indexer = this.options.createDocumentIndexer(embedding, vectorStore);
      context.indexer = indexer;
      await indexer.loadState();
      this.assertCurrent(context);
      indexer.watchVault();

      const chromaManager = this.createChromaController(runtimes.chroma, lease);
      const ready: LocalServiceReady = {
        embeddingService: embedding,
        vectorStore,
        documentIndexer: indexer,
        documentSummarizer: summarizer,
        chromaManager,
        lease: { ...lease },
        runtimes,
        maxInputChars: this.options.maxInputChars,
      };
      this.assertCurrent(context);
      await this.options.publishServices(ready);
      this.assertCurrent(context);
      this.ready = ready;
      this.options.updateSearchState({
        status: "ready",
        chromaManager,
        dbPath: runtimes.chroma.dataPath,
        port: lease.port,
        embeddingStatus: "ready",
        vectorStoreStatus: "ready",
        modelDownloadProgress: 100,
        activeModel: this.options.modelShortName,
        lastError: "",
      });
      return ready;
    } catch (error) {
      let rollbackError: unknown = null;
      try {
        await this.cleanup(context);
      } catch (cleanupError) {
        rollbackError = rollbackFailure(error, cleanupError);
      }
      try {
        await this.options.publishServices(null);
      } catch (publicationError) {
        rollbackError = rollbackFailure(error, rollbackError ?? publicationError);
      }
      if (rollbackError) {
        this.options.updateSearchState({ status: "error", lastError: "LOCAL_SERVICE_ROLLBACK_FAILED" });
        throw rollbackError;
      }
      if (!this.isCurrent(context)) throw bootstrapError("LOCAL_SERVICE_BOOTSTRAP_CANCELLED", error);
      const message = (error as Error).message || "LOCAL_SERVICE_BOOTSTRAP_FAILED";
      this.options.updateSearchState({ status: "error", lastError: message });
      throw error;
    }
  }

  private assertCurrent(context: BootstrapGeneration): void {
    if (!this.isCurrent(context)) throw bootstrapError("LOCAL_SERVICE_BOOTSTRAP_CANCELLED");
  }

  private isCurrent(context: BootstrapGeneration): boolean {
    return !this.disposed && this.active === context && this.generation === context.id
      && !context.controller.signal.aborted;
  }

  private assertLease(runtime: VerifiedChromaRuntime, lease: ManagedProcessState): void {
    if (lease.ownership !== "analogy" || lease.pid === null || lease.startedAt === null
      || lease.executablePath !== runtime.executablePath || lease.runtimeVersion !== runtime.runtimeVersion) {
      throw bootstrapError("LOCAL_SERVICE_CHROMA_IDENTITY_MISMATCH");
    }
  }

  private cleanup(
    context: BootstrapGeneration,
    options: LocalServiceStopOptions = {},
  ): Promise<void> {
    if (context.cleanupPromise) return context.cleanupPromise;
    const operation = (async () => {
      const failures: unknown[] = [];
      const indexer = context.indexer;
      if (indexer) {
        const before = failures.length;
        try { await indexer.stop(); } catch (error) { failures.push(error); }
        try { indexer.shutdown(); } catch (error) { failures.push(error); }
        try { await indexer.flushState(); } catch (error) { failures.push(error); }
        if (failures.length === before) context.indexer = null;
      }
      const embedding = context.embedding;
      if (embedding) {
        try {
          await embedding.dispose();
          context.embedding = null;
        } catch (error) {
          failures.push(error);
        }
      }
      if (!context.lease && context.chromaStartPromise) {
        try {
          context.lease = { ...await context.chromaStartPromise };
        } catch {
          const baseline = context.chromaStartBaseline;
          const expected = context.chromaStartOptions;
          const current = this.options.chromaManager.getState();
          if (baseline?.ownership === "none" && expected && current.ownership === "analogy"
            && current.pid !== null && current.startedAt !== null
            && current.executablePath === expected.executablePath
            && current.runtimeVersion === (expected.runtimeVersion ?? current.runtimeVersion)) {
            context.lease = { ...current };
          }
        } finally {
          context.chromaStartPromise = null;
        }
      }
      const lease = context.lease;
      if (lease && !options.preserveChromaLease) {
        try {
          await this.options.chromaManager.stopOwnedProcess(lease);
          context.lease = null;
        } catch (error) {
          failures.push(error);
        }
      } else if (lease) {
        if (this.retainedLease && !this.sameLease(this.retainedLease, lease)) {
          failures.push(bootstrapError("LOCAL_SERVICE_RETAINED_LEASE_CONFLICT"));
        } else {
          this.retainedLease = { ...lease };
          context.lease = null;
        }
      }
      if (failures.length > 0) {
        const error = cleanupFailure(failures);
        this.options.recordCleanupError?.(error);
        throw error;
      }
      if (lease && this.ready?.lease.startedAt === lease.startedAt && this.ready?.lease.pid === lease.pid) {
        this.ready = null;
      }
    })();
    context.cleanupPromise = operation;
    void operation.then(
      () => undefined,
      () => { if (context.cleanupPromise === operation) context.cleanupPromise = null; },
    );
    return operation;
  }

  private stopRetainedLease(): Promise<void> {
    const retained = this.retainedLease;
    if (!retained) return Promise.resolve();
    if (this.retainedLeaseStopPromise) return this.retainedLeaseStopPromise;
    const operation = (async () => {
      try {
        await this.options.chromaManager.stopOwnedProcess(retained);
        if (this.retainedLease && this.sameLease(this.retainedLease, retained)) {
          this.retainedLease = null;
        }
      } catch (error) {
        const failure = cleanupFailure([error]);
        this.options.recordCleanupError?.(failure);
        throw failure;
      }
    })();
    this.retainedLeaseStopPromise = operation;
    void operation.then(
      () => { if (this.retainedLeaseStopPromise === operation) this.retainedLeaseStopPromise = null; },
      () => { if (this.retainedLeaseStopPromise === operation) this.retainedLeaseStopPromise = null; },
    );
    return operation;
  }

  private sameLease(left: ManagedProcessState, right: ManagedProcessState): boolean {
    return left.ownership === right.ownership
      && left.pid === right.pid
      && left.executablePath === right.executablePath
      && left.port === right.port
      && left.runtimeVersion === right.runtimeVersion
      && left.startedAt === right.startedAt;
  }

  private async publishStoppedState(): Promise<void> {
    await this.options.publishServices(null);
    this.options.updateSearchState({
      status: "idle",
      chromaManager: null,
      embeddingStatus: "idle",
      vectorStoreStatus: "idle",
      modelDownloadProgress: 0,
      lastError: "",
      rebuildProgress: null,
    });
  }

  private createChromaController(
    runtime: VerifiedChromaRuntime,
    lease: ManagedProcessState,
  ): LocalChromaServiceController {
    return {
      isHealthy: () => this.options.chromaManager.health(lease.port),
      stop: async () => { await this.options.chromaManager.stopOwnedProcess(lease); },
      getLastError: () => "",
      getPort: () => lease.port,
      getDbPath: () => runtime.dataPath,
      getProcessState: () => this.options.chromaManager.getState(),
    };
  }
}
