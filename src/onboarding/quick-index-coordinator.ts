import { createHash } from "crypto";
import type { TFile, Vault } from "obsidian";
import { getCurrentPageLimit, getIndexCapacityPlan } from "../license/license-limits";
import type { LicenseState } from "../license/license-types";
import type {
  FileIndexErrorCategory,
  FileIndexStatus,
  IndexFilesOptions,
  IndexFilesResult,
} from "../local-vector/document-indexer";
import type { QuickIndexCoordinatorDependency, QuickIndexProgress, QuickIndexResult } from "./onboarding-coordinator";
import type { QuickIndexScope } from "./onboarding-types";

interface QuickIndexVault {
  getFiles(): readonly TFile[];
  getAbstractFileByPath?(path: string): unknown;
}

interface QuickIndexDocumentIndexer {
  buildDocId(file: TFile): string;
  isExcluded(file: TFile): boolean;
  getAllFileStatuses(files: TFile[]): FileIndexStatus[];
  indexFiles(files: TFile[], options?: IndexFilesOptions): Promise<IndexFilesResult>;
}

export interface QuickIndexFailureDiagnostic {
  pathHash: string;
  errorCategory: FileIndexErrorCategory;
}

export interface QuickIndexCoordinatorOptions {
  vault: Pick<Vault, "getFiles" | "getAbstractFileByPath"> | QuickIndexVault;
  getDocumentIndexer(): Promise<QuickIndexDocumentIndexer | null>;
  getLicenseState(): LicenseState | null | undefined;
  hashSalt: string;
  recordFailure?(diagnostic: QuickIndexFailureDiagnostic): void;
  onSettled?(outcome: "completed" | "failed" | "cancelled"): Promise<void>;
}

interface Selection {
  files: TFile[];
  requested: number;
  blocked: number;
}

interface ActiveRun {
  id: number;
  controller: AbortController;
  promise: Promise<QuickIndexResult>;
}

function codedError(code: string, result?: QuickIndexResult): Error {
  const error = Object.assign(new Error(code), { code }) as Error & {
    code: string;
    result?: QuickIndexResult;
  };
  if (result) error.result = result;
  return error;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeRelativePath(value: unknown): string | null {
  if (typeof value !== "string" || value.includes("\0")) return null;
  const normalized = value.trim().replace(/\\/g, "/").normalize("NFC");
  if (!normalized || normalized.length > 1024 || normalized.startsWith("/")
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    return null;
  }
  return normalized;
}

function assertValidScope(scope: QuickIndexScope): void {
  const folder = scope.type === "folder" ? normalizeRelativePath(scope.path) : null;
  if ((scope.type === "folder" && !folder)
    || (scope.type === "recent" && scope.limit !== 30)
    || !["folder", "recent", "vault"].includes(scope.type)) {
    throw codedError("QUICK_INDEX_INVALID_SCOPE");
  }
}

function snapshotFile(file: TFile): TFile {
  const clone = Object.assign(Object.create(Object.getPrototypeOf(file)), file, {
    path: file.path,
    name: file.name,
    extension: file.extension,
    stat: { ...file.stat },
  });
  return Object.freeze(clone) as TFile;
}

export class QuickIndexCoordinator implements QuickIndexCoordinatorDependency {
  private readonly options: QuickIndexCoordinatorOptions;
  private generation = 0;
  private active: ActiveRun | null = null;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(options: QuickIndexCoordinatorOptions) {
    this.options = options;
  }

  async selectFiles(scope: QuickIndexScope): Promise<TFile[]> {
    assertValidScope(scope);
    const indexer = await this.requireIndexer();
    return (await this.buildSelection(scope, indexer)).files;
  }

  run(
    scope: QuickIndexScope,
    onProgress: (progress: QuickIndexProgress) => void,
    options: {
      signal?: AbortSignal;
      finalize?: (result: QuickIndexResult) => Promise<void>;
    } = {},
  ): Promise<QuickIndexResult> {
    if (this.disposed) return Promise.reject(codedError("QUICK_INDEX_DISPOSED"));
    if (this.active) return Promise.reject(codedError("QUICK_INDEX_BUSY"));
    try {
      assertValidScope(scope);
    } catch (error) {
      return Promise.reject(error);
    }
    if (options.signal?.aborted) return Promise.reject(codedError("DOWNLOAD_CANCELLED"));

    const id = ++this.generation;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });

    const operation = this.execute(id, scope, onProgress, controller.signal, options.finalize).finally(() => {
      options.signal?.removeEventListener("abort", abort);
      if (this.active?.id === id) this.active = null;
    });
    this.active = { id, controller, promise: operation };
    void operation.catch(() => undefined);
    return operation;
  }

  async cancel(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.controller.abort();
    await active.promise.then(() => undefined, () => undefined);
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = this.cancel();
    return this.disposePromise;
  }

  private async execute(
    id: number,
    scope: QuickIndexScope,
    onProgress: (progress: QuickIndexProgress) => void,
    signal: AbortSignal,
    finalize?: (result: QuickIndexResult) => Promise<void>,
  ): Promise<QuickIndexResult> {
    let outcome: "completed" | "failed" | "cancelled" = "failed";
    try {
      if (signal.aborted) throw codedError("DOWNLOAD_CANCELLED");
      const indexer = await this.requireIndexer();
      if (signal.aborted || !this.isCurrent(id)) throw codedError("DOWNLOAD_CANCELLED");
      const selection = await this.buildSelection(scope, indexer);
      if (signal.aborted || !this.isCurrent(id)) throw codedError("DOWNLOAD_CANCELLED");
      const batch = await indexer.indexFiles(selection.files, {
        signal,
        isFileAvailable: (file) => this.isFileAvailable(file),
        onProgress: (progress) => {
          if (!signal.aborted && this.isCurrent(id)) onProgress(progress);
        },
      });
      const result: QuickIndexResult = {
        requested: selection.requested,
        scopeType: scope.type,
        selectedFileCount: selection.files.length,
        indexed: batch.indexed,
        skipped: selection.blocked + batch.skipped,
        failed: batch.failed,
        chunkCount: batch.chunkCount,
        selectedDocuments: Object.freeze(selection.files.map((file) => Object.freeze({
          docId: indexer.buildDocId(file),
          path: file.path,
          mtime: file.stat.mtime,
        }))),
      };
      for (const outcome of batch.files) {
        if (outcome.status !== "failed") continue;
        this.recordFailure(outcome.path, outcome.errorCategory ?? "unknown");
      }
      if (batch.cancelled || signal.aborted || !this.isCurrent(id)) {
        outcome = "cancelled";
        throw codedError("DOWNLOAD_CANCELLED", result);
      }
      if (result.failed > 0) {
        throw codedError("QUICK_INDEX_FAILED", result);
      }
      await finalize?.(result);
      if (signal.aborted || !this.isCurrent(id)) {
        outcome = "cancelled";
        throw codedError("DOWNLOAD_CANCELLED", result);
      }
      outcome = "completed";
      return result;
    } catch (error) {
      if (signal.aborted) {
        outcome = "cancelled";
        if ((error as { code?: unknown })?.code === "DOWNLOAD_CANCELLED") throw error;
        throw codedError("DOWNLOAD_CANCELLED");
      }
      throw error;
    } finally {
      try {
        await this.options.onSettled?.(outcome);
      } catch (error) {
        throw codedError("QUICK_INDEX_CLEANUP_FAILED");
      }
    }
  }

  private async requireIndexer(): Promise<QuickIndexDocumentIndexer> {
    let indexer: QuickIndexDocumentIndexer | null;
    try {
      indexer = await this.options.getDocumentIndexer();
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (typeof code === "string" && /^[A-Z][A-Z0-9_]{2,80}$/.test(code)) throw error;
      throw codedError("QUICK_INDEX_UNAVAILABLE");
    }
    if (!indexer || typeof indexer.indexFiles !== "function") throw codedError("QUICK_INDEX_UNAVAILABLE");
    return indexer;
  }

  private async buildSelection(
    scope: QuickIndexScope,
    indexer: QuickIndexDocumentIndexer,
  ): Promise<Selection> {
    assertValidScope(scope);
    const folder = scope.type === "folder" ? normalizeRelativePath(scope.path) : null;

    const candidates: Array<{ file: TFile; normalizedPath: string }> = [];
    for (const candidate of [...this.options.vault.getFiles()]) {
      const normalizedPath = normalizeRelativePath(candidate?.path);
      if (!normalizedPath || !normalizedPath.toLowerCase().endsWith(".md")
        || candidate.extension?.toLowerCase() !== "md") continue;
      const file = snapshotFile(candidate);
      if (indexer.isExcluded(file)) continue;
      candidates.push({ file, normalizedPath });
    }
    candidates.sort((left, right) => compareText(left.normalizedPath, right.normalizedPath)
      || compareText(left.file.path, right.file.path)
      || right.file.stat.mtime - left.file.stat.mtime);
    const seen = new Set<string>();
    const all = candidates.filter(({ normalizedPath }) => {
      if (seen.has(normalizedPath)) return false;
      seen.add(normalizedPath);
      return true;
    });

    let scoped = all;
    if (scope.type === "folder") {
      scoped = all.filter(({ normalizedPath }) => normalizedPath === folder
        || normalizedPath.startsWith(`${folder}/`));
    } else if (scope.type === "recent") {
      scoped = [...all].sort((left, right) => {
        const byTime = right.file.stat.mtime - left.file.stat.mtime;
        return byTime || compareText(left.normalizedPath, right.normalizedPath);
      }).slice(0, 30);
    }

    const statuses = indexer.getAllFileStatuses(all.map(({ file }) => file));
    const statusByPath = new Map(statuses.map((status) => [
      normalizeRelativePath(status.path) ?? status.path,
      status,
    ]));
    const capacity = getIndexCapacityPlan({
      indexedCount: statuses.filter((status) => status.status !== "unindexed").length,
      limit: getCurrentPageLimit(this.options.getLicenseState()),
      candidates: scoped.map(({ normalizedPath }) => ({
        id: normalizedPath,
        countsTowardLimit: statusByPath.get(normalizedPath)?.status === "unindexed"
          || !statusByPath.has(normalizedPath),
      })),
    });
    const allowed = new Set(capacity.allowedIds);
    return {
      files: scoped.filter(({ normalizedPath }) => allowed.has(normalizedPath)).map(({ file }) => file),
      requested: scoped.length,
      blocked: capacity.blockedNewCount,
    };
  }

  private isFileAvailable(file: TFile): boolean {
    if (!this.options.vault.getAbstractFileByPath) return true;
    const current = this.options.vault.getAbstractFileByPath(file.path) as { path?: unknown } | null;
    return Boolean(current && normalizeRelativePath(current.path) === normalizeRelativePath(file.path));
  }

  private recordFailure(filePath: string, errorCategory: FileIndexErrorCategory): void {
    try {
      const pathHash = createHash("sha256")
        .update(`${this.options.hashSalt}\0${filePath.normalize("NFC")}`)
        .digest("hex");
      this.options.recordFailure?.({ pathHash, errorCategory });
    } catch {
      // Diagnostics must never interrupt indexing.
    }
  }

  private isCurrent(id: number): boolean {
    return !this.disposed && this.active?.id === id && this.generation === id;
  }
}
