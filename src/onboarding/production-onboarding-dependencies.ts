import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { EmbeddingService } from "../local-vector/embedding-service";
import type { EmbeddingModelConfig } from "../local-vector/embedding";
import { installRuntime } from "../runtime/atomic-runtime-installer";
import { ChromaRuntimeManager } from "../runtime/chroma-runtime-manager";
import type {
  EmbeddingRuntimeManager,
  ManagedEmbeddingRuntime,
} from "../runtime/embedding-runtime-manager";
import { downloadRuntimeAsset } from "../runtime/runtime-downloader";
import type { RuntimeAsset, RuntimePaths } from "../runtime/runtime-types";
import { verifyRuntimeAsset } from "../runtime/runtime-verifier";
import type {
  EmbeddingModelProgress,
  RuntimePipelineDependency,
} from "./onboarding-coordinator";

interface RuntimePipelineInput {
  asset: RuntimeAsset;
  paths: RuntimePaths;
}

interface EmbeddingModelInput {
  paths: RuntimePaths;
  runtimeManager: EmbeddingRuntimeManager;
  modelConfig: EmbeddingModelConfig;
  createService(
    runtime: ManagedEmbeddingRuntime,
    cacheDir: string,
  ): EmbeddingService | Promise<EmbeddingService>;
}

interface ModelSetupGeneration {
  id: number;
  controller: AbortController;
  cancelled: boolean;
  initialized: boolean;
  service: EmbeddingService | null;
  preparePromise: Promise<EmbeddingService> | null;
  initializePromise: Promise<void> | null;
  downloadPromise: Promise<void> | null;
  warmUpPromise: Promise<void> | null;
  disposePromise: Promise<void> | null;
  cancelPromise: Promise<void> | null;
  flights: Set<Promise<unknown>>;
}

function codedError(code: string, cause?: unknown): Error {
  const error = new Error(code) as Error & { code?: string; cause?: unknown };
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function runEmbeddingExecutableSmokeTest(executablePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(executablePath, ["--version"], { timeout: 15_000, maxBuffer: 8 * 1024 }, (error, stdout) => {
      if (error) {
        reject(codedError("EMBEDDING_RUNTIME_SMOKE_FAILED", error));
        return;
      }
      if (!/^v22\.23\.2(?:\s|$)/.test(stdout.trim())) {
        reject(codedError("EMBEDDING_RUNTIME_SMOKE_VERSION_MISMATCH"));
        return;
      }
      resolve();
    });
  });
}

async function runChromaSmokeTest(
  installedPath: string,
  asset: RuntimeAsset,
  paths: RuntimePaths,
): Promise<void> {
  const executablePath = path.join(installedPath, asset.executableRelativePath);
  const dataPath = await fs.promises.mkdtemp(path.join(paths.staging, "chroma-smoke-"));
  const manager = new ChromaRuntimeManager();
  let lease = null;
  try {
    lease = await manager.start({ executablePath, dataPath, runtimeVersion: asset.version });
    if (!await manager.health(lease.port)) throw codedError("RUNTIME_SMOKE_TEST_FAILED");
  } finally {
    try {
      const owned = lease ?? (manager.getState().ownership === "analogy" ? manager.getState() : null);
      if (owned) await manager.stopOwnedProcess(owned);
    } finally {
      await fs.promises.rm(dataPath, { recursive: true, force: true });
    }
  }
}

export function createProductionRuntimePipeline(input: RuntimePipelineInput): RuntimePipelineDependency {
  const partPath = path.join(input.paths.downloads, `${input.asset.id}.part`);
  return {
    asset: input.asset,
    download: (signal, onProgress) => downloadRuntimeAsset({
      asset: input.asset,
      partPath,
      signal,
      onProgress,
    }),
    verify: (downloaded) => verifyRuntimeAsset(input.asset, downloaded.path),
    install: (downloaded) => installRuntime({
      asset: input.asset,
      verifiedAssetPath: downloaded.path,
      paths: input.paths,
      smokeTest: (installedPath) => input.asset.kind === "chroma"
        ? runChromaSmokeTest(installedPath, input.asset, input.paths)
        : runEmbeddingExecutableSmokeTest(path.join(installedPath, input.asset.executableRelativePath)),
    }),
  };
}

export function createProductionEmbeddingModel(input: EmbeddingModelInput): {
  download(signal: AbortSignal, onProgress: (progress: EmbeddingModelProgress) => void): Promise<void>;
  warmUp(signal: AbortSignal, onProgress: (progress: EmbeddingModelProgress) => void): Promise<void>;
  cancel(): Promise<void>;
} {
  const modelRoot = path.join(input.paths.modelCache, input.modelConfig.shortName);
  let generation = 0;
  let active: ModelSetupGeneration | null = null;
  let cancellationBarrier: Promise<void> | null = null;

  const cancellationError = (cause?: unknown) => codedError("DOWNLOAD_CANCELLED", cause);

  const boundedError = (error: unknown, fallback: string): Error => {
    const candidate = error as { code?: unknown; message?: unknown } | null;
    const value = typeof candidate?.code === "string" ? candidate.code
      : typeof candidate?.message === "string" ? candidate.message : "";
    const code = /^(?:DOWNLOAD_CANCELLED|EMBEDDING_(?:RUNTIME|MODEL|WORKER)_[A-Z0-9_]+)$/.test(value)
      ? value
      : fallback;
    return codedError(code, error);
  };

  const isCurrent = (context: ModelSetupGeneration): boolean => active === context
    && generation === context.id && !context.cancelled && !context.controller.signal.aborted;

  const assertCurrent = (context: ModelSetupGeneration, signal?: AbortSignal): void => {
    if (!isCurrent(context) || signal?.aborted) throw cancellationError();
  };

  const track = <T>(context: ModelSetupGeneration, promise: Promise<T>): Promise<T> => {
    context.flights.add(promise);
    void promise.then(
      () => context.flights.delete(promise),
      () => context.flights.delete(promise),
    );
    // Attach a rejection observer immediately; callers still receive the original promise.
    void promise.catch(() => undefined);
    return promise;
  };

  const begin = (): ModelSetupGeneration => {
    if (active && isCurrent(active)) return active;
    const context: ModelSetupGeneration = {
      id: ++generation,
      controller: new AbortController(),
      cancelled: false,
      initialized: false,
      service: null,
      preparePromise: null,
      initializePromise: null,
      downloadPromise: null,
      warmUpPromise: null,
      disposePromise: null,
      cancelPromise: null,
      flights: new Set(),
    };
    active = context;
    return context;
  };

  const invalidate = (context: ModelSetupGeneration): void => {
    if (context.cancelled) return;
    context.cancelled = true;
    context.controller.abort();
    if (generation === context.id) generation += 1;
  };

  const disposeGeneration = (context: ModelSetupGeneration): Promise<void> => {
    if (context.disposePromise) return context.disposePromise;
    const service = context.service;
    const operation = (async () => {
      if (!service) return;
      try {
        await service.dispose();
      } catch (error) {
        throw boundedError(error, "EMBEDDING_MODEL_DISPOSE_FAILED");
      } finally {
        if (context.service === service) context.service = null;
        context.initialized = false;
      }
    })();
    context.disposePromise = operation;
    void operation.catch(() => undefined);
    return operation;
  };

  const prepareService = (context: ModelSetupGeneration): Promise<EmbeddingService> => {
    if (context.service) return Promise.resolve(context.service);
    if (context.preparePromise) return context.preparePromise;
    const operation = (async () => {
      assertCurrent(context);
      let runtime: ManagedEmbeddingRuntime;
      try {
        runtime = await input.runtimeManager.resolve();
      } catch (error) {
        if (!isCurrent(context)) throw cancellationError(error);
        throw boundedError(error, "EMBEDDING_RUNTIME_INVALID");
      }
      assertCurrent(context);
      let service: EmbeddingService;
      try {
        service = await Promise.resolve(input.createService(runtime, modelRoot));
      } catch (error) {
        if (!isCurrent(context)) throw cancellationError(error);
        throw boundedError(error, "EMBEDDING_MODEL_DOWNLOAD_FAILED");
      }
      context.service = service;
      if (!isCurrent(context)) {
        await disposeGeneration(context);
        throw cancellationError();
      }
      return service;
    })();
    context.preparePromise = track(context, operation);
    return context.preparePromise;
  };

  const initializeService = (context: ModelSetupGeneration): Promise<void> => {
    if (context.initialized) return Promise.resolve();
    if (context.initializePromise) return context.initializePromise;
    const operation = (async () => {
      const service = await prepareService(context);
      assertCurrent(context);
      try {
        await service.initialize((progress) => {
          if (isCurrent(context)) contextProgress.get(context)?.(progress);
        });
      } catch (error) {
        if (!isCurrent(context)) throw cancellationError(error);
        throw boundedError(error, "EMBEDDING_MODEL_DOWNLOAD_FAILED");
      }
      assertCurrent(context);
      if (!service.isReady()) throw codedError("EMBEDDING_MODEL_DOWNLOAD_FAILED");
      context.initialized = true;
    })();
    context.initializePromise = track(context, operation);
    return context.initializePromise;
  };

  const contextProgress = new WeakMap<
    ModelSetupGeneration,
    (progress: EmbeddingModelProgress) => void
  >();

  const settleCancellation = (context: ModelSetupGeneration): Promise<void> => {
    if (context.cancelPromise) return context.cancelPromise;
    const operation = (async () => {
      const service = context.service;
      if (service) await service.cancelInitialization().catch(() => undefined);
      while (context.flights.size > 0) {
        await Promise.allSettled([...context.flights]);
      }
      await disposeGeneration(context);
      if (active === context) active = null;
    })();
    context.cancelPromise = operation;
    void operation.catch(() => undefined);
    return operation;
  };

  const publishCancellationBarrier = (operation: Promise<void>): Promise<void> => {
    cancellationBarrier = operation;
    void operation.then(
      () => { if (cancellationBarrier === operation) cancellationBarrier = null; },
      () => { if (cancellationBarrier === operation) cancellationBarrier = null; },
    );
    return operation;
  };

  const linkSignal = (context: ModelSetupGeneration, signal: AbortSignal): (() => void) => {
    const abort = () => {
      invalidate(context);
      void publishCancellationBarrier(settleCancellation(context)).catch(() => undefined);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    return () => signal.removeEventListener("abort", abort);
  };

  return {
    download(signal, onProgress) {
      if (cancellationBarrier) {
        const rejected = Promise.reject(cancellationError());
        void rejected.catch(() => undefined);
        return rejected;
      }
      const context = begin();
      if (context.downloadPromise) return context.downloadPromise;
      contextProgress.set(context, onProgress);
      const unlink = linkSignal(context, signal);
      const operation = (async () => {
        try {
          assertCurrent(context, signal);
          await fs.promises.mkdir(modelRoot, { recursive: true, mode: 0o700 });
          assertCurrent(context, signal);
          await initializeService(context);
          assertCurrent(context, signal);
        } catch (error) {
          let failure = !isCurrent(context) || signal.aborted
            ? cancellationError(error)
            : boundedError(error, "EMBEDDING_MODEL_DOWNLOAD_FAILED");
          try { await disposeGeneration(context); } catch (disposeError) { failure = disposeError; }
          if (active === context) active = null;
          throw failure;
        } finally {
          unlink();
        }
      })();
      context.downloadPromise = track(context, operation);
      return context.downloadPromise;
    },
    warmUp(signal, onProgress) {
      if (cancellationBarrier) {
        const rejected = Promise.reject(cancellationError());
        void rejected.catch(() => undefined);
        return rejected;
      }
      const context = begin();
      if (context.warmUpPromise) return context.warmUpPromise;
      contextProgress.set(context, (progress) => onProgress({
        ...progress,
        phase: progress.phase === "ready" ? "loading" : progress.phase,
      }));
      const unlink = linkSignal(context, signal);
      const operation = (async () => {
        let failure: unknown = null;
        let markerPublished = false;
        try {
          assertCurrent(context, signal);
          await fs.promises.mkdir(modelRoot, { recursive: true, mode: 0o700 });
          await initializeService(context);
          assertCurrent(context, signal);
          const service = context.service!;
          onProgress({ phase: "loading", file: null, loadedBytes: null, totalBytes: null, percent: 0 });
          const vector = await service.embed("Analogy embedding model warm-up");
          assertCurrent(context, signal);
          if (!Array.isArray(vector) || vector.length === 0 || !vector.every(Number.isFinite)) {
            throw codedError("EMBEDDING_MODEL_WARMUP_FAILED");
          }
          const markerPath = path.join(modelRoot, ".analogy-ready.json");
          const temporaryPath = path.join(modelRoot, `.analogy-ready.${randomUUID()}.tmp`);
          try {
            await fs.promises.writeFile(temporaryPath, `${JSON.stringify({
              schemaVersion: 1,
              modelKey: input.modelConfig.shortName,
            })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
            assertCurrent(context, signal);
            await fs.promises.rename(temporaryPath, markerPath);
            markerPublished = true;
            assertCurrent(context, signal);
          } finally {
            await fs.promises.unlink(temporaryPath).catch(() => undefined);
            if (markerPublished && !isCurrent(context)) {
              await fs.promises.unlink(markerPath).catch(() => undefined);
            }
          }
          onProgress({ phase: "ready", file: null, loadedBytes: null, totalBytes: null, percent: 100 });
        } catch (error) {
          failure = !isCurrent(context) || signal.aborted
            ? cancellationError(error)
            : boundedError(error, "EMBEDDING_MODEL_WARMUP_FAILED");
        } finally {
          unlink();
          try {
            await disposeGeneration(context);
          } catch (disposeError) {
            failure = disposeError;
          }
          if (active === context) active = null;
        }
        if (failure) throw failure;
      })();
      context.warmUpPromise = track(context, operation);
      return context.warmUpPromise;
    },
    cancel() {
      const context = active;
      if (!context) return cancellationBarrier ?? Promise.resolve();
      invalidate(context);
      return publishCancellationBarrier(settleCancellation(context));
    },
  };
}
