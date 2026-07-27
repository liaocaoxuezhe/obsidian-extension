import * as fs from "fs";
import * as path from "path";
import type { DiagnosticRecorder } from "../diagnostics/diagnostic-recorder";
import { EmbeddingServiceOptions, LocalEmbeddingService } from "./embedding";
import { EmbeddingWorkerClient } from "./embedding-worker-client";
import { SafeModeManager } from "./safe-mode";

export interface UnifiedEmbeddingServiceOptions extends EmbeddingServiceOptions {
  pluginVersion?: string;
  buildId?: string;
  recorder?: DiagnosticRecorder | null;
  safeModeManager?: SafeModeManager | null;
  allowInProcessFallback?: boolean;
  onSafeModeEntered?: () => void | Promise<void>;
}

export type EmbeddingServiceErrorCode =
  | "EMBEDDING_SAFE_MODE"
  | "EMBEDDING_WORKER_UNAVAILABLE"
  | "EMBEDDING_WORKER_FAILED";

export class EmbeddingServiceError extends Error {
  readonly code: EmbeddingServiceErrorCode;

  constructor(code: EmbeddingServiceErrorCode, message: string) {
    super(message);
    this.name = "EmbeddingServiceError";
    this.code = code;
  }
}

export class EmbeddingService {
  private inProcess: LocalEmbeddingService | null = null;
  private worker: EmbeddingWorkerClient | null = null;
  private options: UnifiedEmbeddingServiceOptions;
  private useWorker = false;
  private workerInitFailed = false;

  constructor(options: UnifiedEmbeddingServiceOptions) {
    this.options = options;
  }

  private shouldTryWorker(): boolean {
    if (this.workerInitFailed) return false;
    if (!this.options.buildId) return false;
    const workerPath = path.join(this.options.pluginDir, "embedding-worker.js");
    return fs.existsSync(workerPath);
  }

  private getInProcessService(): LocalEmbeddingService {
    if (!this.inProcess) {
      this.inProcess = new LocalEmbeddingService(this.options);
    }
    return this.inProcess;
  }

  private assertSafeModeDisabled(): void {
    if (this.options.safeModeManager?.isEnabled()) {
      throw new EmbeddingServiceError(
        "EMBEDDING_SAFE_MODE",
        "Embedding is disabled because Analogy is in safe mode.",
      );
    }
  }

  private record(level: "info" | "warn" | "error", code: string, message: string, context?: Record<string, unknown>) {
    this.options.recorder?.[level]("embedding.worker-start", code, message, context as Record<string, string | number | boolean | null>);
  }

  async initialize(onProgress?: (progress: number) => void): Promise<void> {
    this.assertSafeModeDisabled();
    if (this.shouldTryWorker()) {
      try {
        await this.initializeWorker(onProgress);
        this.useWorker = true;
        this.record("info", "worker.ready", "Embedding worker initialized", {
          model: this.options.modelConfig.shortName,
        });
        return;
      } catch (err) {
        this.workerInitFailed = true;
        this.useWorker = false;
        this.record("error", "worker.init.failed", (err as Error).message, {
          model: this.options.modelConfig.shortName,
        });
        if (!this.options.allowInProcessFallback) {
          throw new EmbeddingServiceError(
            "EMBEDDING_WORKER_FAILED",
            `Embedding worker initialization failed: ${(err as Error).message}`,
          );
        }
      }
    }
    if (!this.options.allowInProcessFallback) {
      throw new EmbeddingServiceError(
        "EMBEDDING_WORKER_UNAVAILABLE",
        "Embedding worker bundle is unavailable. Reinstall the complete Analogy runtime.",
      );
    }
    await this.getInProcessService().initialize(onProgress);
  }

  private async initializeWorker(onProgress?: (progress: number) => void): Promise<void> {
    const workerPath = path.join(this.options.pluginDir, "embedding-worker.js");
    this.worker = new EmbeddingWorkerClient({
      pluginDir: this.options.pluginDir,
      buildId: this.options.buildId || `${this.options.pluginVersion || "unknown"}+dev`,
      workerBundlePath: workerPath,
      execPath: process.execPath,
      recorder: this.options.recorder,
      onUnexpectedExit: (info) => {
        this.useWorker = false;
        const wasSafeModeEnabled = this.options.safeModeManager?.isEnabled() ?? false;
        this.options.safeModeManager?.recordWorkerExit();
        const isSafeModeEnabled = this.options.safeModeManager?.isEnabled() ?? false;
        if (!wasSafeModeEnabled && isSafeModeEnabled) {
          void Promise.resolve(this.options.onSafeModeEntered?.()).catch((error) => {
            this.record(
              "error",
              "safe-mode.enter-handler.failed",
              `Failed to stop background work after entering safe mode: ${(error as Error).message}`,
            );
          });
        }
        this.record("error", "worker.unexpected-exit", "Embedding worker exited unexpectedly", {
          code: info.code,
          signal: info.signal,
          lastTaskType: info.lastTaskType || "none",
          uptimeMs: info.uptimeMs,
        });
      },
    });
    await this.worker.initialize(
      this.options.modelConfig.id,
      this.options.modelConfig.dtype,
      this.options.cacheDir,
      this.options.remoteHost
    );
    onProgress?.(100);
  }

  isReady(): boolean {
    return this.useWorker || Boolean(this.inProcess?.isReady());
  }

  getMaxInputChars(): number {
    return this.options.modelConfig.maxInputChars;
  }

  getInferenceCount(): number {
    return this.inProcess?.getInferenceCount() ?? 0;
  }

  async resetSession(): Promise<void> {
    if (this.useWorker && this.worker) {
      try {
        await this.worker.dispose();
        await this.initializeWorker();
        return;
      } catch (err) {
        this.record("error", "worker.reset.failed", (err as Error).message);
        this.useWorker = false;
      }
    }
    if (this.options.allowInProcessFallback) {
      await this.getInProcessService().resetSession();
      return;
    }
    throw new EmbeddingServiceError(
      "EMBEDDING_WORKER_FAILED",
      "Embedding worker session could not be reset.",
    );
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedQuery(text: string): Promise<number[]> {
    const prefix = this.options.modelConfig.queryPrefix;
    return this.embed(prefix ? prefix + text : text);
  }

  async embedDocument(text: string): Promise<number[]> {
    const prefix = this.options.modelConfig.documentPrefix;
    return this.embed(prefix ? prefix + text : text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    this.assertSafeModeDisabled();
    if (this.useWorker && this.worker) {
      try {
        const prepared = texts.map((t) => this.truncate(this.applyDocumentPrefix(t)));
        const embeddings = await this.worker.embed(prepared);
        if (embeddings.length !== prepared.length) {
          throw new Error(`Worker returned ${embeddings.length} embeddings for ${prepared.length} texts`);
        }
        return embeddings;
      } catch (err) {
        this.record("error", "worker.embed.failed", (err as Error).message, {
          count: texts.length,
        });
        if (this.options.safeModeManager?.isEnabled()) {
          this.useWorker = false;
        }
        if (!this.options.allowInProcessFallback) {
          throw new EmbeddingServiceError(
            "EMBEDDING_WORKER_FAILED",
            `Embedding worker inference failed: ${(err as Error).message}`,
          );
        }
      }
    }
    if (this.options.allowInProcessFallback) {
      return this.getInProcessService().embedBatch(texts);
    }
    throw new EmbeddingServiceError(
      "EMBEDDING_WORKER_UNAVAILABLE",
      "Embedding worker is not ready.",
    );
  }

  private applyDocumentPrefix(text: string): string {
    const prefix = this.options.modelConfig.documentPrefix;
    return prefix ? prefix + text : text;
  }

  private truncate(text: string): string {
    const limit = this.options.modelConfig.maxInputChars;
    if (text.length <= limit) return text;
    return text.slice(0, limit);
  }

  async dispose(): Promise<void> {
    if (this.worker) {
      try {
        await this.worker.dispose();
      } catch (err) {
        this.record("warn", "worker.dispose.failed", (err as Error).message);
      }
      this.worker = null;
    }
    this.useWorker = false;
    // In-process dispose is handled by main.ts via embedder access.
  }
}
