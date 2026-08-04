import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { readCurrentRuntime, type CurrentRuntimePointer } from "./atomic-runtime-installer";
import {
  FileSystemRuntimeHistoryIsolationAdapter,
  readTrustedRuntimeHistoryPointer,
  type RetainedRuntimeCleanupRecovery,
  type RuntimeHistoryIsolationAdapter,
  type TrustedRuntimeAssetResolver,
} from "./runtime-history-isolation";
import type { ChromaRuntimeManager, ManagedProcessState } from "./chroma-runtime-manager";
import type { EnvironmentReport } from "../onboarding/onboarding-types";
import type { OnboardingMode } from "../onboarding/OnboardingView";
import type { RuntimeAssetKind, RuntimePaths, SupportedPlatformKey } from "./runtime-types";

export type RuntimeControlAction = "verify" | "restart" | "redownload" | "cleanup" | "reveal"
  | "migration-resume" | "migration-cancel" | "migration-discard" | "migration-rebuild";
export type RuntimeHealth = "healthy" | "stopped" | "unhealthy" | "unknown";

export interface RuntimeHistoryItem {
  kind: RuntimeAssetKind;
  runtimeId: string;
  installedAt: number;
  /** Opaque inode snapshot. It is never rendered and must match immediately before trashing. */
  identity: string;
}

export interface RuntimeCleanupResult {
  removed: number;
  failed: number;
  skipped: number;
}

export type RuntimeCleanupRecoveryItem = RetainedRuntimeCleanupRecovery;

export interface LegacyChromaRecoveryItem {
  id: string;
  state: "prepared" | "isolated" | "trash-failed" | "restore-failed";
  updatedAt: number;
}

export interface RuntimeControlSnapshot {
  platform: SupportedPlatformKey;
  environment: EnvironmentReport | null;
  chromaRuntimeId: string | null;
  embeddingRuntimeId: string | null;
  chromaVersion: string | null;
  embeddingVersion: string | null;
  health: RuntimeHealth;
  ownership: ManagedProcessState["ownership"];
  port: number | null;
  storage: "device-local";
  model: EnvironmentReport["embeddingModel"] | "unknown";
  index: EnvironmentReport["index"] | "unknown";
  lastAction: RuntimeControlAction | null;
  busyAction: RuntimeControlAction | null;
  history: RuntimeHistoryItem[];
  legacyDataDetected: boolean;
  legacyMigration: {
    status: "none" | "available" | "preparing" | "copying" | "reconciling" | "verifying" | "failed" | "cancelled" | "completed";
    copiedRecords: number | null;
    totalRecords: number | null;
    sourceBytes: number | null;
    recoverable: boolean;
  };
}

export interface RuntimeControlSurfaceCapability {
  getSnapshot(): RuntimeControlSnapshot;
  subscribe(listener: (snapshot: RuntimeControlSnapshot) => void): () => void;
  openOnboarding(mode: OnboardingMode): void;
  verifyRuntimes(): Promise<RuntimeControlSnapshot>;
  restartOwnedChroma(): Promise<void>;
  redownloadRuntime(kind: RuntimeAssetKind): Promise<void>;
  revealStorageDirectory(): Promise<void>;
  listRuntimeHistory(): Promise<RuntimeHistoryItem[]>;
  /** Path-free inventory retained in private quarantine after a system-trash failure. */
  listRuntimeCleanupRecoveries(): Promise<RuntimeCleanupRecoveryItem[]>;
  cleanRuntimeHistory(items: RuntimeHistoryItem[]): Promise<RuntimeCleanupResult>;
  cleanLegacyChromaData(confirmation: string): Promise<RuntimeCleanupResult>;
  listLegacyChromaRecoveries(): Promise<LegacyChromaRecoveryItem[]>;
  retryLegacyChromaRecovery(id: string): Promise<{removed: number; failed: number}>;
  restoreLegacyChromaRecovery(id: string): Promise<{restored: number; failed: number}>;
  resumeLegacyMigration(): Promise<void>;
  cancelLegacyMigration(): Promise<void>;
  discardLegacyMigration(): Promise<void>;
  fallbackLegacyMigrationToRebuild(): Promise<void>;
}

interface CoordinatorControl {
  getSnapshot(): {
    stage: string;
    error?: { stage?: string; code?: string } | null;
    progress?: number | null;
    legacyIndexChoice?: string | null;
    legacyRecordsCopied?: number | null;
    legacyRecordsTotal?: number | null;
    legacySourceBytes?: number | null;
  };
  retry(): Promise<unknown>;
  resume(): Promise<unknown>;
  cancel(): Promise<void>;
  fallbackToLegacyRebuild(): Promise<unknown>;
  retryRuntime(kind: RuntimeAssetKind): Promise<unknown>;
}

export interface RuntimeControlSurfaceOptions {
  paths: RuntimePaths;
  platform: SupportedPlatformKey;
  detectEnvironment(): Promise<EnvironmentReport>;
  coordinator: CoordinatorControl;
  chromaManager: Pick<ChromaRuntimeManager, "getState" | "health" | "stopOwnedProcess">;
  openOnboarding(mode: OnboardingMode): void;
  restartServices(): Promise<void>;
  revealStorage(): Promise<void>;
  trashItem(target: string): Promise<void>;
  resolveTrustedRuntimeAsset: TrustedRuntimeAssetResolver;
  historyIsolationAdapter?: RuntimeHistoryIsolationAdapter;
  getActiveEmbeddingRuntimeId?(): string | null;
  legacyCleanup?(confirmation: string): Promise<RuntimeCleanupResult>;
  listLegacyRecoveries?(): Promise<LegacyChromaRecoveryItem[]>;
  retryLegacyRecovery?(id: string): Promise<{removed: number; failed: number}>;
  restoreLegacyRecovery?(id: string): Promise<{restored: number; failed: number}>;
  discardLegacyMigration?(): Promise<void>;
}

const ACTIVE_SETUP_STAGES = new Set([
  "checking", "downloading-chroma", "verifying-chroma", "installing-chroma",
  "downloading-embedding-runtime", "verifying-embedding-runtime", "installing-embedding-runtime",
  "starting-chroma", "downloading-embedding-model", "warming-up-model",
  "selecting-legacy-index-action", "preparing-legacy-snapshot", "migrating-legacy-index",
  "reconciling-legacy-index", "verifying-legacy-index", "selecting-index-scope", "building-quick-index",
]);
const SAFE_RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const LEGACY_CONFIRMATION = "DELETE LEGACY DATA";

function controlError(code: string, cause?: unknown): Error {
  const error = new Error(code) as Error & { code?: string; cause?: unknown };
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function cloneSnapshot(snapshot: RuntimeControlSnapshot): RuntimeControlSnapshot {
  return {
    ...snapshot,
    environment: snapshot.environment ? { ...snapshot.environment } : null,
    history: snapshot.history.map((item) => ({ ...item })),
    legacyMigration: { ...snapshot.legacyMigration },
  };
}

function migrationSnapshot(value: ReturnType<CoordinatorControl["getSnapshot"]>): RuntimeControlSnapshot["legacyMigration"] {
  const byStage: Record<string, RuntimeControlSnapshot["legacyMigration"]["status"]> = {
    "selecting-legacy-index-action": "available",
    "preparing-legacy-snapshot": "preparing",
    "migrating-legacy-index": "copying",
    "reconciling-legacy-index": "reconciling",
    "verifying-legacy-index": "verifying",
  };
  let status = byStage[value.stage] ?? "none";
  if (value.stage === "failed" && (value.error?.code?.includes("LEGACY") || value.legacyIndexChoice === "reuse")) status = "failed";
  if (value.stage === "cancelled" && value.legacyIndexChoice === "reuse") status = "cancelled";
  if (value.stage === "ready" && value.legacyIndexChoice === "reuse") status = "completed";
  return {
    status,
    copiedRecords: Number.isFinite(value.legacyRecordsCopied) ? value.legacyRecordsCopied as number : null,
    totalRecords: Number.isFinite(value.legacyRecordsTotal) ? value.legacyRecordsTotal as number : null,
    sourceBytes: Number.isFinite(value.legacySourceBytes) ? value.legacySourceBytes as number : null,
    recoverable: ["available", "preparing", "copying", "reconciling", "verifying", "failed", "cancelled"].includes(status),
  };
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function boundedPort(port: number): number | null {
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

function sameLease(left: ManagedProcessState, right: ManagedProcessState): boolean {
  return left.ownership === "analogy" && right.ownership === "analogy"
    && left.pid !== null && left.pid === right.pid
    && left.executablePath !== null && left.executablePath === right.executablePath
    && left.port === right.port && left.runtimeVersion !== null && left.runtimeVersion === right.runtimeVersion
    && left.startedAt !== null && left.startedAt === right.startedAt;
}

function identityFor(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

export class RuntimeControlSurface implements RuntimeControlSurfaceCapability {
  private readonly options: RuntimeControlSurfaceOptions;
  private readonly historyIsolationAdapter: RuntimeHistoryIsolationAdapter;
  private readonly listeners = new Set<(snapshot: RuntimeControlSnapshot) => void>();
  private snapshot: RuntimeControlSnapshot;
  private verifyFlight: Promise<RuntimeControlSnapshot> | null = null;
  private restartFlight: Promise<void> | null = null;
  private redownloadFlight: Promise<void> | null = null;
  private revealFlight: Promise<void> | null = null;
  private cleanupFlight: Promise<RuntimeCleanupResult> | null = null;
  private migrationFlight: Promise<void> | null = null;
  private onboardingOpen = false;

  constructor(options: RuntimeControlSurfaceOptions) {
    this.options = options;
    this.historyIsolationAdapter = options.historyIsolationAdapter
      ?? new FileSystemRuntimeHistoryIsolationAdapter(options.paths, options.resolveTrustedRuntimeAsset);
    const state = options.chromaManager.getState();
    this.snapshot = {
      platform: options.platform,
      environment: null,
      chromaRuntimeId: null,
      embeddingRuntimeId: null,
      chromaVersion: state.runtimeVersion,
      embeddingVersion: null,
      health: state.ownership === "analogy" ? "unknown" : "stopped",
      ownership: state.ownership,
      port: boundedPort(state.port),
      storage: "device-local",
      model: "unknown",
      index: "unknown",
      lastAction: null,
      busyAction: null,
      history: [],
      legacyDataDetected: false,
      legacyMigration: migrationSnapshot(options.coordinator.getSnapshot()),
    };
  }

  getSnapshot(): RuntimeControlSnapshot {
    return cloneSnapshot(this.snapshot);
  }

  subscribe(listener: (snapshot: RuntimeControlSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  publishEnvironment(
    environment: EnvironmentReport,
    runtimeIds: { chromaRuntimeId?: string | null; embeddingRuntimeId?: string | null } = {},
  ): void {
    const state = this.options.chromaManager.getState();
    this.snapshot = {
      ...this.snapshot,
      environment: { ...environment },
      chromaRuntimeId: runtimeIds.chromaRuntimeId ?? this.snapshot.chromaRuntimeId,
      embeddingRuntimeId: runtimeIds.embeddingRuntimeId ?? this.snapshot.embeddingRuntimeId,
      chromaVersion: state.runtimeVersion ?? this.snapshot.chromaVersion,
      ownership: state.ownership,
      port: boundedPort(state.port),
      health: state.ownership === "none" ? "stopped" : this.snapshot.health,
      model: environment.embeddingModel,
      index: environment.index,
      legacyDataDetected: environment.index === "legacy",
      legacyMigration: migrationSnapshot(this.options.coordinator.getSnapshot()),
    };
    this.notify();
  }

  openOnboarding(mode: OnboardingMode): void {
    if (this.onboardingOpen) return;
    this.onboardingOpen = true;
    try {
      this.options.openOnboarding(mode);
    } finally {
      queueMicrotask(() => { this.onboardingOpen = false; });
    }
  }

  verifyRuntimes(): Promise<RuntimeControlSnapshot> {
    if (this.verifyFlight) return this.verifyFlight;
    const operation = this.withBusy("verify", async () => {
      const environment = await this.options.detectEnvironment();
      const [chroma, embedding, history] = await Promise.all([
        readCurrentRuntime(this.options.paths, "chroma"),
        readCurrentRuntime(this.options.paths, "embedding-runtime"),
        this.scanHistory(),
      ]);
      const processState = this.options.chromaManager.getState();
      const healthy = processState.ownership === "none"
        ? environment.chroma === "running"
        : await this.options.chromaManager.health(processState.port).catch(() => false);
      this.snapshot = {
        ...this.snapshot,
        environment,
        chromaRuntimeId: chroma?.runtimeId ?? null,
        embeddingRuntimeId: embedding?.runtimeId ?? null,
        chromaVersion: processState.runtimeVersion ?? (chroma ? "cli-1.4.4" : null),
        embeddingVersion: embedding ? "Node 22.23.2 · Transformers 4.2.0 · ONNX Runtime 1.26.0" : null,
        health: healthy ? "healthy" : processState.ownership === "none" ? "stopped" : "unhealthy",
        ownership: processState.ownership,
        port: boundedPort(processState.port),
        model: environment.embeddingModel,
        index: environment.index,
        history,
        legacyDataDetected: environment.index === "legacy",
        lastAction: "verify",
      };
      this.notify();
      return this.getSnapshot();
    });
    this.verifyFlight = operation;
    void operation.then(
      () => { if (this.verifyFlight === operation) this.verifyFlight = null; },
      () => { if (this.verifyFlight === operation) this.verifyFlight = null; },
    );
    return operation;
  }

  restartOwnedChroma(): Promise<void> {
    if (this.restartFlight) return this.restartFlight;
    const operation = this.withBusy("restart", async () => {
      this.assertSetupIdle();
      const expected = this.options.chromaManager.getState();
      if (expected.ownership !== "analogy" || expected.pid === null || expected.executablePath === null
        || expected.startedAt === null || expected.runtimeVersion === null) {
        throw controlError("RUNTIME_RESTART_NOT_OWNED");
      }
      const result = await this.options.chromaManager.stopOwnedProcess(expected);
      if (!result.stopped) throw controlError("RUNTIME_RESTART_LEASE_CHANGED");
      try {
        await this.options.restartServices();
      } catch (error) {
        const environment = await this.options.detectEnvironment().catch(() => null);
        const failedState = this.options.chromaManager.getState();
        this.snapshot = {
          ...this.snapshot,
          environment: environment ? { ...environment } : this.snapshot.environment,
          ownership: failedState.ownership,
          port: boundedPort(failedState.port),
          chromaVersion: failedState.runtimeVersion,
          health: failedState.ownership === "none" ? "stopped" : "unhealthy",
          model: environment?.embeddingModel ?? this.snapshot.model,
          index: environment?.index ?? this.snapshot.index,
          legacyDataDetected: environment ? environment.index === "legacy" : this.snapshot.legacyDataDetected,
        };
        this.notify();
        throw error;
      }
      const state = this.options.chromaManager.getState();
      this.snapshot = {
        ...this.snapshot,
        ownership: state.ownership,
        port: boundedPort(state.port),
        chromaVersion: state.runtimeVersion,
        health: state.ownership === "analogy" ? "healthy" : "stopped",
        lastAction: "restart",
      };
      this.notify();
    });
    this.restartFlight = operation;
    void operation.then(
      () => { if (this.restartFlight === operation) this.restartFlight = null; },
      () => { if (this.restartFlight === operation) this.restartFlight = null; },
    );
    return operation;
  }

  redownloadRuntime(kind: RuntimeAssetKind): Promise<void> {
    if (this.redownloadFlight) return this.redownloadFlight;
    const operation = this.withBusy("redownload", async () => {
      this.assertSetupIdle();
      const environment = this.snapshot.environment;
      const permitted = kind === "chroma"
        ? environment?.chroma === "missing" || environment?.chroma === "corrupt" || environment?.chroma === "incompatible"
        : environment?.embeddingRuntime === "missing" || environment?.embeddingRuntime === "corrupt";
      if (!permitted) throw controlError("RUNTIME_REDOWNLOAD_UNAVAILABLE");
      this.openOnboarding("repair");
      await this.options.coordinator.retryRuntime(kind);
      this.snapshot = { ...this.snapshot, lastAction: "redownload" };
      this.notify();
    });
    this.redownloadFlight = operation;
    void operation.then(
      () => { if (this.redownloadFlight === operation) this.redownloadFlight = null; },
      () => { if (this.redownloadFlight === operation) this.redownloadFlight = null; },
    );
    return operation;
  }

  revealStorageDirectory(): Promise<void> {
    if (this.revealFlight) return this.revealFlight;
    const operation = this.withBusy("reveal", async () => {
      await this.options.revealStorage();
      this.snapshot = { ...this.snapshot, lastAction: "reveal" };
      this.notify();
    });
    this.revealFlight = operation;
    void operation.then(
      () => { if (this.revealFlight === operation) this.revealFlight = null; },
      () => { if (this.revealFlight === operation) this.revealFlight = null; },
    );
    return operation;
  }

  async listRuntimeHistory(): Promise<RuntimeHistoryItem[]> {
    const [chroma, embedding, history] = await Promise.all([
      readCurrentRuntime(this.options.paths, "chroma"),
      readCurrentRuntime(this.options.paths, "embedding-runtime"),
      this.scanHistory(),
    ]);
    this.snapshot = {
      ...this.snapshot,
      chromaRuntimeId: chroma?.runtimeId ?? null,
      embeddingRuntimeId: embedding?.runtimeId ?? null,
      chromaVersion: chroma ? this.snapshot.chromaVersion ?? "cli-1.4.4" : null,
      embeddingVersion: embedding
        ? this.snapshot.embeddingVersion ?? "Node 22.23.2 · Transformers 4.2.0 · ONNX Runtime 1.26.0"
        : null,
      history,
    };
    this.notify();
    return history.map((item) => ({ ...item }));
  }

  async listRuntimeCleanupRecoveries(): Promise<RuntimeCleanupRecoveryItem[]> {
    return this.historyIsolationAdapter.listRecoveries().map((item) => ({ ...item }));
  }

  cleanRuntimeHistory(items: RuntimeHistoryItem[]): Promise<RuntimeCleanupResult> {
    if (this.cleanupFlight) return this.cleanupFlight;
    const operation = this.withBusy("cleanup", async () => {
      this.assertSetupIdle();
      const lock = await this.acquireCleanupLock();
      try {
        let removed = 0;
        let failed = 0;
        let skipped = 0;
        for (const requested of items) {
          const kindLock = await this.acquireKindCleanupLock(requested.kind).catch(() => null);
          if (!kindLock) {
            skipped += 1;
            continue;
          }
          try {
            this.assertSetupIdle();
            const isolated = this.historyIsolationAdapter.isolate({
              item: requested,
              activeRuntimeId: this.activeRuntimeId(requested.kind),
              kindLock: { filename: kindLock.filename, token: kindLock.token },
            });
            if (!isolated) {
              skipped += 1;
              continue;
            }
            if (!this.historyIsolationAdapter.readyForTrash(isolated)) {
              failed += 1;
              continue;
            }
            await this.options.trashItem(isolated.quarantinePath);
            if (!this.historyIsolationAdapter.trashCompleted(isolated)) {
              failed += 1;
              continue;
            }
            removed += 1;
          } catch {
            failed += 1;
          } finally {
            await this.releaseKindCleanupLock(kindLock);
          }
        }
        const result = { removed, failed, skipped };
        const history = await this.scanHistory().catch(() => [] as RuntimeHistoryItem[]);
        this.snapshot = { ...this.snapshot, history, lastAction: "cleanup" };
        this.notify();
        return result;
      } finally {
        await lock.close().catch(() => undefined);
        await fs.promises.unlink(this.cleanupLockPath()).catch(() => undefined);
      }
    });
    this.cleanupFlight = operation;
    void operation.then(
      () => { if (this.cleanupFlight === operation) this.cleanupFlight = null; },
      () => { if (this.cleanupFlight === operation) this.cleanupFlight = null; },
    );
    return operation;
  }

  async cleanLegacyChromaData(confirmation: string): Promise<RuntimeCleanupResult> {
    if (confirmation !== LEGACY_CONFIRMATION) throw controlError("LEGACY_CLEANUP_CONFIRMATION_REQUIRED");
    if (!this.options.legacyCleanup) throw controlError("LEGACY_CLEANUP_UNAVAILABLE");
    this.assertSetupIdle();
    return this.options.legacyCleanup(confirmation);
  }

  async listLegacyChromaRecoveries(): Promise<LegacyChromaRecoveryItem[]> {
    if (!this.options.listLegacyRecoveries) return [];
    this.assertSetupIdle();
    const items = await this.options.listLegacyRecoveries();
    return items.map((item) => ({ id: item.id, state: item.state, updatedAt: item.updatedAt }));
  }

  async retryLegacyChromaRecovery(id: string): Promise<{removed: number; failed: number}> {
    if (!/^[0-9a-f]{32}$/.test(id)) throw controlError("LEGACY_CLEANUP_RECOVERY_INVALID");
    if (!this.options.retryLegacyRecovery) throw controlError("LEGACY_CLEANUP_RECOVERY_UNAVAILABLE");
    this.assertSetupIdle();
    return this.options.retryLegacyRecovery(id);
  }

  async restoreLegacyChromaRecovery(id: string): Promise<{restored: number; failed: number}> {
    if (!/^[0-9a-f]{32}$/.test(id)) throw controlError("LEGACY_CLEANUP_RECOVERY_INVALID");
    if (!this.options.restoreLegacyRecovery) throw controlError("LEGACY_CLEANUP_RECOVERY_UNAVAILABLE");
    this.assertSetupIdle();
    return this.options.restoreLegacyRecovery(id);
  }

  resumeLegacyMigration(): Promise<void> {
    return this.runMigrationAction("migration-resume", async () => {
      const stage = this.options.coordinator.getSnapshot().stage;
      this.openOnboarding("repair");
      if (stage === "failed" || stage === "cancelled") await this.options.coordinator.retry();
      else await this.options.coordinator.resume();
    });
  }

  cancelLegacyMigration(): Promise<void> {
    return this.runMigrationAction("migration-cancel", () => this.options.coordinator.cancel());
  }

  discardLegacyMigration(): Promise<void> {
    return this.runMigrationAction("migration-discard", async () => {
      if (!this.options.discardLegacyMigration) throw controlError("LEGACY_MIGRATION_DISCARD_UNAVAILABLE");
      await this.options.discardLegacyMigration();
    });
  }

  fallbackLegacyMigrationToRebuild(): Promise<void> {
    return this.runMigrationAction("migration-rebuild", async () => {
      this.openOnboarding("repair");
      await this.options.coordinator.fallbackToLegacyRebuild();
    });
  }

  private runMigrationAction(action: Extract<RuntimeControlAction, `migration-${string}`>, operation: () => Promise<unknown>): Promise<void> {
    if (this.migrationFlight) return this.migrationFlight;
    const flight = this.withBusy(action, async () => {
      await operation();
      this.snapshot = {
        ...this.snapshot,
        lastAction: action,
        legacyMigration: migrationSnapshot(this.options.coordinator.getSnapshot()),
      };
      this.notify();
    });
    this.migrationFlight = flight;
    void flight.finally(() => { if (this.migrationFlight === flight) this.migrationFlight = null; }).catch(() => undefined);
    return flight;
  }

  private async withBusy<T>(action: RuntimeControlAction, operation: () => Promise<T>): Promise<T> {
    if (this.snapshot.busyAction && this.snapshot.busyAction !== action) throw controlError("RUNTIME_OPERATION_BUSY");
    this.snapshot = { ...this.snapshot, busyAction: action };
    this.notify();
    try {
      return await operation();
    } finally {
      if (this.snapshot.busyAction === action) {
        this.snapshot = { ...this.snapshot, busyAction: null };
        this.notify();
      }
    }
  }

  private assertSetupIdle(): void {
    if (ACTIVE_SETUP_STAGES.has(this.options.coordinator.getSnapshot().stage)) {
      throw controlError("RUNTIME_OPERATION_BUSY");
    }
  }

  private versionRoot(kind: RuntimeAssetKind): string {
    return kind === "chroma" ? this.options.paths.chromaVersions : this.options.paths.embeddingVersions;
  }

  private activeRuntimeId(kind: RuntimeAssetKind): string | null {
    if (kind === "embedding-runtime") return this.options.getActiveEmbeddingRuntimeId?.() ?? null;
    const state = this.options.chromaManager.getState();
    if (state.ownership !== "analogy" || !state.executablePath) return null;
    const root = this.versionRoot(kind);
    const relative = path.relative(root, state.executablePath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    const runtimeId = relative.split(path.sep)[0];
    return SAFE_RUNTIME_ID.test(runtimeId) ? runtimeId : null;
  }

  private async scanHistory(): Promise<RuntimeHistoryItem[]> {
    const realDataRoot = await fs.promises.realpath(this.options.paths.root).catch(() => null);
    if (!realDataRoot) return [];
    const currents = new Map<RuntimeAssetKind, CurrentRuntimePointer | null>();
    for (const kind of ["chroma", "embedding-runtime"] as RuntimeAssetKind[]) {
      currents.set(kind, await readCurrentRuntime(this.options.paths, kind));
    }
    const result: RuntimeHistoryItem[] = [];
    for (const kind of ["chroma", "embedding-runtime"] as RuntimeAssetKind[]) {
      const root = this.versionRoot(kind);
      const rootStat = await fs.promises.lstat(root).catch(() => null);
      if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) continue;
      const realRoot = await fs.promises.realpath(root).catch(() => null);
      if (!realRoot || !isContained(realDataRoot, realRoot)) continue;
      const currentId = currents.get(kind)?.runtimeId ?? null;
      const activeId = this.activeRuntimeId(kind);
      const historyDirectory = path.join(this.options.paths.current, "history", kind);
      const historyStat = await fs.promises.lstat(historyDirectory).catch(() => null);
      if (!historyStat || !historyStat.isDirectory() || historyStat.isSymbolicLink()) continue;
      for (const filename of await fs.promises.readdir(historyDirectory)) {
        if (!filename.endsWith(".json")) continue;
        const name = filename.slice(0, -5);
        if (!SAFE_RUNTIME_ID.test(name) || name === currentId || name === activeId) continue;
        const pointer = readTrustedRuntimeHistoryPointer(
          this.options.paths,
          kind,
          name,
          this.options.resolveTrustedRuntimeAsset,
        );
        if (!pointer) continue;
        const target = pointer.installedPath;
        const stat = await fs.promises.lstat(target).catch(() => null);
        if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) continue;
        const realTarget = await fs.promises.realpath(target).catch(() => null);
        if (!realTarget || !isContained(realRoot, realTarget)) continue;
        result.push({ kind, runtimeId: name, installedAt: pointer.installedAt, identity: identityFor(stat) });
      }
    }
    result.sort((left, right) => left.installedAt - right.installedAt
      || left.kind.localeCompare(right.kind) || left.runtimeId.localeCompare(right.runtimeId));
    return result;
  }

  private cleanupLockPath(): string {
    return path.join(this.options.paths.current, ".locks", "runtime-control-cleanup.lock");
  }

  private async acquireCleanupLock(): Promise<fs.promises.FileHandle> {
    const directory = path.dirname(this.cleanupLockPath());
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.promises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw controlError("RUNTIME_CLEANUP_UNSAFE_LOCK");
    try {
      return await fs.promises.open(this.cleanupLockPath(), "wx", 0o600);
    } catch (error) {
      throw controlError("RUNTIME_CLEANUP_BUSY", error);
    }
  }

  private async acquireKindCleanupLock(kind: RuntimeAssetKind): Promise<{
    handle: fs.promises.FileHandle;
    filename: string;
    token: string;
  }> {
    if (kind !== "chroma" && kind !== "embedding-runtime") throw controlError("RUNTIME_CLEANUP_INVALID_KIND");
    const filename = path.join(this.options.paths.current, ".locks", `${kind}.lock`);
    const directory = path.dirname(filename);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const token = randomUUID();
    const handle = await fs.promises.open(filename, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid, token, createdAt: Date.now() }), "utf8");
      await handle.sync();
      return { handle, filename, token };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.promises.unlink(filename).catch(() => undefined);
      throw error;
    }
  }

  private async releaseKindCleanupLock(lock: {
    handle: fs.promises.FileHandle;
    filename: string;
    token: string;
  }): Promise<void> {
    await lock.handle.close().catch(() => undefined);
    const metadata = await fs.promises.readFile(lock.filename, "utf8").then(JSON.parse).catch(() => null);
    if (metadata?.token !== lock.token) throw controlError("RUNTIME_CLEANUP_LOCK_REPLACED");
    await fs.promises.unlink(lock.filename).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  private notify(): void {
    const snapshot = this.getSnapshot();
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue;
      try { listener(snapshot); } catch { /* UI observers are isolated. */ }
    }
  }
}
