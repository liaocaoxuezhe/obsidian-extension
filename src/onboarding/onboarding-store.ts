import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import type { RuntimePaths, SupportedPlatformKey } from "../runtime/runtime-types";
import {
  type OnboardingError,
  type OnboardingErrorAction,
  type OnboardingErrorCode,
  type OnboardingSnapshot,
  type OnboardingStage,
  type QuickIndexScope,
  type LegacyIndexChoice,
  type RecommendedAction,
  recommendedActionForSnapshot,
} from "./onboarding-types";

const MAX_STATE_BYTES = 1024 * 1024;
const DEFAULT_PROGRESS_THROTTLE_MS = 1000;
const RUNTIME_VAULT_ID = /^vault-v2-[0-9a-f]{16}$/;
const SAFE_RUNTIME_ID = /^[A-Za-z0-9._-]{1,160}$/;

const STAGES = new Set<OnboardingStage>([
  "not-started", "checking", "awaiting-consent", "downloading-chroma", "verifying-chroma",
  "installing-chroma", "downloading-embedding-runtime", "verifying-embedding-runtime",
  "installing-embedding-runtime", "starting-chroma", "downloading-embedding-model",
  "warming-up-model", "selecting-legacy-index-action", "preparing-legacy-snapshot",
  "migrating-legacy-index", "reconciling-legacy-index", "verifying-legacy-index",
  "selecting-index-scope", "building-quick-index", "ready", "failed", "cancelled",
]);

const ERROR_CODES = new Set<OnboardingErrorCode>([
  "UNSUPPORTED_PLATFORM", "LOCAL_DATA_ROOT_UNAVAILABLE", "INSUFFICIENT_DISK_SPACE",
  "ONBOARDING_STATE_CORRUPT", "DOWNLOAD_NETWORK_ERROR", "DOWNLOAD_CANCELLED",
  "DOWNLOAD_SIZE_MISMATCH", "DOWNLOAD_HASH_MISMATCH", "RUNTIME_EXTRACT_FAILED",
  "RUNTIME_EXECUTION_BLOCKED", "RUNTIME_SMOKE_TEST_FAILED", "CHROMA_PORT_CONFLICT",
  "CHROMA_START_TIMEOUT", "CHROMA_VERSION_MISMATCH", "CHROMA_EXITED",
  "EMBEDDING_RUNTIME_INVALID", "EMBEDDING_MODEL_DOWNLOAD_FAILED", "EMBEDDING_MODEL_CACHE_CORRUPT",
  "EMBEDDING_MODEL_WARMUP_FAILED", "CHROMA_DATA_REBUILD_FAILED", "QUICK_INDEX_FAILED",
  "LEGACY_INDEX_MIGRATION_FAILED", "LEGACY_MIGRATION_UNAVAILABLE",
]);

const ERROR_ACTIONS = new Set<OnboardingErrorAction>([
  "retry", "redownload", "change-port", "open-help", "none",
]);

const PLATFORMS = new Set<SupportedPlatformKey>(["darwin-arm64", "darwin-x64", "win32-x64"]);

/**
 * The only data.json keys Task 8 recognizes. This allowlist deliberately excludes
 * active chromaPort/indexStates; their device-local migration belongs to Tasks 10/14.
 */
export const LEGACY_ONBOARDING_SETTINGS_KEYS = [
  "onboardingState",
  "onboardingStage",
  "onboardingProgress",
  "onboardingCompletedBytes",
  "onboardingTotalBytes",
  "onboardingCurrentItem",
  "onboardingRuntimePlatform",
  "onboardingChromaRuntimeId",
  "onboardingEmbeddingRuntimeId",
  "onboardingSelectedIndexScope",
  "onboardingStartedAt",
  "onboardingUpdatedAt",
  "onboardingCompletedAt",
  "onboardingDismissedAt",
  "onboardingError",
] as const;

export type LegacyOnboardingSettingsKey = typeof LEGACY_ONBOARDING_SETTINGS_KEYS[number];

export interface LegacyOnboardingLoadOptions {
  legacySettings: Record<string, unknown>;
  persistSanitizedSettings?: (settings: Record<string, unknown>) => Promise<void>;
}

export interface OnboardingLoadResult {
  snapshot: OnboardingSnapshot;
  recommendedAction: RecommendedAction;
  migrated: boolean;
  sanitizedSettings?: Record<string, unknown>;
  removedLegacyKeys: LegacyOnboardingSettingsKey[];
}

export interface OnboardingStoreOptions {
  paths: RuntimePaths;
  progressThrottleMs?: number;
  now?: () => number;
  rename?: (oldPath: string, newPath: string) => Promise<void>;
  platform?: NodeJS.Platform;
}

interface MutationTicket {
  generation: number;
  finish: () => void;
}

function stateError(code: string, cause?: unknown): Error {
  const error = new Error(code) as Error & { code?: string; cause?: unknown };
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizedProgress(value: unknown): number | null {
  const number = finiteOrNull(value);
  return number === null ? null : Math.max(0, Math.min(100, number));
}

function safeRuntimeId(value: unknown): string | null {
  return typeof value === "string" && SAFE_RUNTIME_ID.test(value) ? value : null;
}

function safeCurrentItem(value: unknown): string {
  if (typeof value !== "string") return "";
  let decoded = value.trim();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  if (/[?#]/.test(decoded) || /%(?:[0-9a-f]{2}|25)/i.test(decoded)
    || /(?:^|[._-])(token|auth|key|signature|secret|credential)(?:$|[=._-])/i.test(decoded)) return "";
  const normalized = decoded.replace(/\\/g, "/");
  const item = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(item)
    || item === "." || item === "..") return "";
  return item;
}

function normalizeScope(value: unknown): QuickIndexScope | null {
  if (!value || typeof value !== "object") return null;
  const scope = value as Record<string, unknown>;
  if (scope.type === "recent" && scope.limit === 30) return { type: "recent", limit: 30 };
  if (scope.type === "vault") return { type: "vault" };
  // Folder paths are user/Vault input and are intentionally not persisted by this device-state store.
  return null;
}

function normalizeLegacyChoice(value: unknown): LegacyIndexChoice | null {
  return value === "reuse" || value === "rebuild" || value === "later" ? value : null;
}

function normalizeError(value: unknown): OnboardingError | null {
  if (!value || typeof value !== "object") return null;
  const error = value as Record<string, unknown>;
  if (!ERROR_CODES.has(error.code as OnboardingErrorCode)
    || !STAGES.has(error.stage as OnboardingStage)
    || !ERROR_ACTIONS.has(error.action as OnboardingErrorAction)
    || typeof error.recoverable !== "boolean") return null;
  const code = error.code as OnboardingErrorCode;
  // Builds before RC10 could persist a generic migration wrapper as nonrecoverable after the
  // exact vector copy had already completed. The migration transaction is resumable, so carrying
  // that stale classification forward would incorrectly replace Retry with Close.
  const legacyMigrationRetry = code === "LEGACY_INDEX_MIGRATION_FAILED";
  return {
    code,
    stage: error.stage as OnboardingStage,
    userMessageKey: typeof error.userMessageKey === "string"
      && /^[A-Za-z0-9._-]{1,160}$/.test(error.userMessageKey)
      ? error.userMessageKey
      : `onboarding.error.${code.toLowerCase()}`,
    // Raw errors can contain URLs, tokens, absolute paths, ports, PIDs, or model input.
    technicalMessage: code,
    recoverable: legacyMigrationRetry ? true : error.recoverable,
    action: legacyMigrationRetry ? "retry" : error.action as OnboardingErrorAction,
  };
}

function defaultSnapshot(updatedAt = 0): OnboardingSnapshot {
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
    updatedAt,
    completedAt: null,
    dismissedAt: null,
    error: null,
  };
}

function normalizeSnapshot(value: unknown, now: number, allowLegacy: boolean): OnboardingSnapshot {
  if (!value || typeof value !== "object") throw stateError("ONBOARDING_STATE_CORRUPT");
  const input = value as Record<string, unknown>;
  if (typeof input.schemaVersion === "number" && input.schemaVersion > 1) {
    throw stateError("ONBOARDING_STATE_UNSUPPORTED_SCHEMA");
  }
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) {
    throw stateError("ONBOARDING_STATE_CORRUPT");
  }
  if (input.schemaVersion === undefined && !allowLegacy) throw stateError("ONBOARDING_STATE_CORRUPT");
  if (!STAGES.has(input.stage as OnboardingStage)) throw stateError("ONBOARDING_STATE_CORRUPT");
  const updatedAt = finiteOrNull(input.updatedAt) ?? now;
  return {
    schemaVersion: 1,
    stage: input.stage as OnboardingStage,
    progress: normalizedProgress(input.progress),
    completedBytes: finiteOrNull(input.completedBytes),
    totalBytes: finiteOrNull(input.totalBytes),
    currentItem: safeCurrentItem(input.currentItem),
    runtimePlatform: PLATFORMS.has(input.runtimePlatform as SupportedPlatformKey)
      ? input.runtimePlatform as SupportedPlatformKey
      : null,
    chromaRuntimeId: safeRuntimeId(input.chromaRuntimeId),
    embeddingRuntimeId: safeRuntimeId(input.embeddingRuntimeId),
    selectedIndexScope: normalizeScope(input.selectedIndexScope),
    legacyIndexChoice: normalizeLegacyChoice(input.legacyIndexChoice),
    legacyRecordsCopied: finiteOrNull(input.legacyRecordsCopied),
    legacyRecordsTotal: finiteOrNull(input.legacyRecordsTotal),
    legacySourceBytes: finiteOrNull(input.legacySourceBytes),
    startedAt: finiteOrNull(input.startedAt),
    updatedAt,
    completedAt: finiteOrNull(input.completedAt),
    dismissedAt: finiteOrNull(input.dismissedAt),
    error: normalizeError(input.error),
  };
}

function legacySnapshot(settings: Record<string, unknown>, now: number): OnboardingSnapshot | null {
  if (settings.onboardingState && typeof settings.onboardingState === "object") {
    return normalizeSnapshot(settings.onboardingState, now, true);
  }
  const hasLegacyField = LEGACY_ONBOARDING_SETTINGS_KEYS.some((key) =>
    Object.prototype.hasOwnProperty.call(settings, key));
  if (!hasLegacyField) return null;
  const stage = STAGES.has(settings.onboardingStage as OnboardingStage)
    ? settings.onboardingStage
    : normalizeError(settings.onboardingError) ? "failed" : "checking";
  return normalizeSnapshot({
    stage,
    progress: settings.onboardingProgress,
    completedBytes: settings.onboardingCompletedBytes,
    totalBytes: settings.onboardingTotalBytes,
    currentItem: settings.onboardingCurrentItem,
    runtimePlatform: settings.onboardingRuntimePlatform,
    chromaRuntimeId: settings.onboardingChromaRuntimeId,
    embeddingRuntimeId: settings.onboardingEmbeddingRuntimeId,
    selectedIndexScope: settings.onboardingSelectedIndexScope,
    startedAt: settings.onboardingStartedAt,
    updatedAt: settings.onboardingUpdatedAt,
    completedAt: settings.onboardingCompletedAt,
    dismissedAt: settings.onboardingDismissedAt,
    error: settings.onboardingError,
  }, now, true);
}

export function sanitizeLegacyOnboardingSettings(settings: Record<string, unknown>): {
  settings: Record<string, unknown>;
  removedKeys: LegacyOnboardingSettingsKey[];
} {
  const sanitized = { ...settings };
  const removedKeys: LegacyOnboardingSettingsKey[] = [];
  for (const key of LEGACY_ONBOARDING_SETTINGS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(sanitized, key)) {
      delete sanitized[key];
      removedKeys.push(key);
    }
  }
  return { settings: sanitized, removedKeys };
}

function progressOnly(previous: OnboardingSnapshot, next: OnboardingSnapshot): boolean {
  const omitProgress = (snapshot: OnboardingSnapshot) => ({
    schemaVersion: snapshot.schemaVersion,
    stage: snapshot.stage,
    runtimePlatform: snapshot.runtimePlatform,
    chromaRuntimeId: snapshot.chromaRuntimeId,
    embeddingRuntimeId: snapshot.embeddingRuntimeId,
    selectedIndexScope: snapshot.selectedIndexScope,
    legacyIndexChoice: snapshot.legacyIndexChoice,
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    dismissedAt: snapshot.dismissedAt,
    error: snapshot.error,
  });
  return JSON.stringify(omitProgress(previous)) === JSON.stringify(omitProgress(next));
}

export class OnboardingStore {
  private readonly paths: RuntimePaths;
  private readonly progressThrottleMs: number;
  private readonly now: () => number;
  private readonly rename: (oldPath: string, newPath: string) => Promise<void>;
  private readonly platform: NodeJS.Platform;
  private operationQueue: Promise<void> = Promise.resolve();
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingProgress: OnboardingSnapshot | null = null;
  private latestSnapshot: OnboardingSnapshot | null = null;
  private persistenceError: unknown = null;
  private generation = 0;
  private lifecycle: "active" | "disposing" | "disposed" = "active";
  private flushPromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;
  private readonly activeMutations = new Set<Promise<void>>();

  constructor(options: OnboardingStoreOptions) {
    this.paths = options.paths;
    this.progressThrottleMs = Math.max(1, options.progressThrottleMs ?? DEFAULT_PROGRESS_THROTTLE_MS);
    this.now = options.now ?? Date.now;
    this.rename = options.rename ?? fs.promises.rename.bind(fs.promises);
    this.platform = options.platform ?? process.platform;
    this.validateConfiguredPath();
  }

  async load(options?: LegacyOnboardingLoadOptions): Promise<OnboardingLoadResult> {
    const mutation = this.beginMutation();
    try {
      const existing = await this.readSnapshot();
      this.assertMutationCurrent(mutation.generation);
      const sanitized = options ? sanitizeLegacyOnboardingSettings(options.legacySettings) : null;
      const legacy = options && sanitized && sanitized.removedKeys.length > 0
        ? legacySnapshot(options.legacySettings, this.now())
        : null;
      let snapshot = existing ?? legacy ?? defaultSnapshot();
      let migrated = false;
      if (!existing && legacy) {
        await this.enqueuePersist(legacy, mutation.generation);
        this.assertMutationCurrent(mutation.generation);
        snapshot = legacy;
        migrated = true;
      } else if (existing && sanitized && sanitized.removedKeys.length > 0) {
        // A previous crash may have happened after the local rename and before saveData.
        migrated = true;
      }
      this.assertMutationCurrent(mutation.generation);
      this.latestSnapshot = snapshot;
      if (migrated && sanitized && options?.persistSanitizedSettings) {
        await options.persistSanitizedSettings(sanitized.settings);
        this.assertMutationCurrent(mutation.generation);
      }
      return {
        snapshot,
        recommendedAction: recommendedActionForSnapshot(snapshot),
        migrated,
        sanitizedSettings: migrated ? sanitized?.settings : undefined,
        removedLegacyKeys: migrated ? sanitized?.removedKeys ?? [] : [],
      };
    } finally {
      mutation.finish();
    }
  }

  async save(value: OnboardingSnapshot): Promise<void> {
    const mutation = this.beginMutation();
    try {
      const snapshot = normalizeSnapshot(value, this.now(), false);
      const previous = this.latestSnapshot;
      if (previous && progressOnly(previous, snapshot)) {
        this.latestSnapshot = snapshot;
        this.pendingProgress = snapshot;
        if (!this.progressTimer) {
          const generation = this.generation;
          this.progressTimer = setTimeout(() => {
            this.progressTimer = null;
            if (generation === this.generation) {
              void this.getFlushPromise().catch((error) => {
                this.persistenceError = error;
              });
            }
          }, this.progressThrottleMs);
          this.progressTimer.unref?.();
        }
        if (this.persistenceError) throw this.persistenceError;
        return;
      }
      if (this.pendingProgress || this.persistenceError) {
        await this.getFlushPromise();
        this.assertMutationCurrent(mutation.generation);
      }
      await this.enqueuePersist(snapshot, mutation.generation);
      this.assertMutationCurrent(mutation.generation);
      this.latestSnapshot = snapshot;
    } finally {
      mutation.finish();
    }
  }

  flush(): Promise<void> {
    if (this.lifecycle === "disposed") return this.disposePromise ?? Promise.resolve();
    if (this.lifecycle === "disposing") return this.dispose();
    return this.getFlushPromise();
  }

  private getFlushPromise(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    const flight = this.flushInternal();
    this.flushPromise = flight;
    void flight.then(
      () => { if (this.flushPromise === flight) this.flushPromise = null; },
      () => { if (this.flushPromise === flight) this.flushPromise = null; },
    );
    return flight;
  }

  private async flushInternal(): Promise<void> {
    this.clearProgressTimer();
    const pending = this.pendingProgress;
    if (!pending) {
      if (this.persistenceError) throw this.persistenceError;
      await this.operationQueue;
      return;
    }
    try {
      await this.enqueuePersist(pending, this.generation);
      if (this.pendingProgress === pending) this.pendingProgress = null;
      this.persistenceError = null;
    } catch (error) {
      this.persistenceError = error;
      throw error;
    }
  }

  async reset(): Promise<void> {
    const mutation = this.beginMutation();
    try {
      this.clearProgressTimer();
      this.pendingProgress = null;
      this.persistenceError = null;
      this.latestSnapshot = null;
      this.generation += 1;
      const resetGeneration = this.generation;
      await this.enqueue(async () => {
        await this.assertSafeExistingTarget(true);
        try {
          await fs.promises.unlink(this.paths.onboardingState);
          await this.fsyncDirectory(this.paths.vaultRoot);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      });
      this.assertMutationCurrent(resetGeneration);
    } finally {
      mutation.finish();
    }
  }

  dispose(): Promise<void> {
    if (this.lifecycle === "disposed") return this.disposePromise ?? Promise.resolve();
    if (this.disposePromise) return this.disposePromise;
    this.lifecycle = "disposing";
    const mutations = [...this.activeMutations];
    const flush = this.getFlushPromise();
    let disposal: Promise<void>;
    disposal = Promise.allSettled([...mutations, flush]).then(
      (results) => {
        const flushResult = results[results.length - 1];
        if (flushResult?.status === "rejected") throw flushResult.reason;
        this.lifecycle = "disposed";
      },
    ).catch((error) => {
      if (this.disposePromise === disposal) this.disposePromise = null;
      throw error;
    });
    this.disposePromise = disposal;
    return disposal;
  }

  private validateConfiguredPath(): void {
    const root = path.resolve(this.paths.root);
    const vaultRoot = path.resolve(this.paths.vaultRoot);
    const runtimeVaultId = path.basename(vaultRoot);
    const expectedVaultRoot = path.join(root, "vaults", runtimeVaultId);
    const expectedState = path.join(expectedVaultRoot, "onboarding-state.json");
    if (!path.isAbsolute(this.paths.root) || !RUNTIME_VAULT_ID.test(runtimeVaultId)
      || vaultRoot !== expectedVaultRoot || path.resolve(this.paths.onboardingState) !== expectedState) {
      throw stateError("ONBOARDING_STATE_UNSAFE_PATH");
    }
  }

  private async readSnapshot(): Promise<OnboardingSnapshot | null> {
    await this.assertSafeExistingTarget(true);
    let expected: fs.Stats | null = null;
    try {
      expected = await fs.promises.lstat(this.paths.onboardingState);
      if (expected.isSymbolicLink() || !expected.isFile()) throw stateError("ONBOARDING_STATE_UNSAFE_PATH");
      this.assertOwnedMode(expected, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(
        this.paths.onboardingState,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw stateError("ONBOARDING_STATE_UNSAFE_PATH", error);
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw stateError("ONBOARDING_STATE_UNSAFE_PATH");
      this.assertOwnedMode(stat, false);
      if (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino)) {
        throw stateError("ONBOARDING_STATE_UNSAFE_PATH");
      }
      const body = await handle.readFile("utf8");
      try {
        return normalizeSnapshot(JSON.parse(body), this.now(), true);
      } catch (error) {
        if ((error as Error).message === "ONBOARDING_STATE_UNSUPPORTED_SCHEMA") throw error;
        throw stateError("ONBOARDING_STATE_CORRUPT", error);
      }
    } finally {
      await handle.close();
    }
  }

  private async enqueuePersist(snapshot: OnboardingSnapshot, generation: number): Promise<void> {
    await this.enqueue(() => this.persist(snapshot, generation));
  }

  private async persist(snapshot: OnboardingSnapshot, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    await this.ensurePrivateDirectories();
    await this.assertSafeExistingTarget(true);
    const temporary = path.join(
      this.paths.vaultRoot,
      `.onboarding-state.json.${randomUUID()}.tmp`,
    );
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(
        temporary,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const stat = await handle.stat();
      if (!stat.isFile()) throw stateError("ONBOARDING_STATE_UNSAFE_PATH");
      this.assertOwnedMode(stat, false);
      await handle.writeFile(`${JSON.stringify(snapshot)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      if (generation !== this.generation) return;
      await this.rename(temporary, this.paths.onboardingState);
      await this.fsyncDirectory(this.paths.vaultRoot);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fs.promises.unlink(temporary).catch(() => undefined);
      throw error;
    } finally {
      await fs.promises.unlink(temporary).catch(() => undefined);
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private clearProgressTimer(): void {
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = null;
  }

  private beginMutation(): MutationTicket {
    this.assertActive();
    const generation = this.generation;
    let resolveSettlement: () => void = () => undefined;
    const settlement = new Promise<void>((resolve) => { resolveSettlement = resolve; });
    this.activeMutations.add(settlement);
    let finished = false;
    return {
      generation,
      finish: () => {
        if (finished) return;
        finished = true;
        this.activeMutations.delete(settlement);
        resolveSettlement();
      },
    };
  }

  private assertMutationCurrent(generation: number): void {
    this.assertActive();
    if (generation !== this.generation) throw stateError("ONBOARDING_STORE_MUTATION_CANCELLED");
  }

  private assertActive(): void {
    if (this.lifecycle !== "active") throw stateError("ONBOARDING_STORE_DISPOSED");
  }

  private async ensurePrivateDirectories(): Promise<void> {
    await this.createOrAssertDirectory(this.paths.root);
    const vaults = path.join(this.paths.root, "vaults");
    await this.createOrAssertDirectory(vaults);
    await this.createOrAssertDirectory(this.paths.vaultRoot);
  }

  private async createOrAssertDirectory(directory: string): Promise<void> {
    let created = false;
    try {
      await fs.promises.mkdir(directory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await this.assertDirectory(directory, false);
    if (created && this.platform !== "win32") {
      const stat = await fs.promises.lstat(directory);
      if ((stat.mode & 0o777) !== 0o700) throw stateError("ONBOARDING_STATE_UNSAFE_MODE");
    }
  }

  private async assertSafeExistingTarget(missingAllowed: boolean): Promise<void> {
    if (!await this.assertDirectory(this.paths.root, missingAllowed)) return;
    const vaults = path.join(this.paths.root, "vaults");
    if (!await this.assertDirectory(vaults, true)) return;
    if (!await this.assertDirectory(this.paths.vaultRoot, true)) return;
    try {
      const stat = await fs.promises.lstat(this.paths.onboardingState);
      if (stat.isSymbolicLink() || !stat.isFile()) throw stateError("ONBOARDING_STATE_UNSAFE_PATH");
      this.assertOwnedMode(stat, false);
    } catch (error) {
      if (missingAllowed && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private async assertDirectory(directory: string, missingAllowed: boolean): Promise<boolean> {
    try {
      const stat = await fs.promises.lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw stateError("ONBOARDING_STATE_UNSAFE_PATH");
      this.assertOwnedMode(stat, true);
      return true;
    } catch (error) {
      if (missingAllowed && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private assertOwnedMode(stat: fs.Stats, directory: boolean): void {
    if (this.platform === "win32") return;
    const getuid = process.getuid;
    if (typeof getuid !== "function" || stat.uid !== getuid.call(process)) {
      throw stateError("ONBOARDING_STATE_UNSAFE_OWNER");
    }
    const expected = directory ? 0o700 : 0o600;
    if ((stat.mode & 0o777) !== expected) throw stateError("ONBOARDING_STATE_UNSAFE_MODE");
  }

  private async fsyncDirectory(directory: string): Promise<void> {
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(directory, fs.constants.O_RDONLY);
      await handle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (this.platform !== "win32" || (code !== "EPERM" && code !== "EISDIR" && code !== "EINVAL")) {
        throw error;
      }
    } finally {
      await handle?.close();
    }
  }
}
