import { ChildProcess, spawn } from "child_process";
import { randomUUID } from "crypto";
import type { DiagnosticRecorder } from "../diagnostics/diagnostic-recorder";
import {
  EmbeddingWorkerClient,
  createWorkerSpawnConfiguration,
  resolveNodeExecutable,
  type WorkerRuntimeLaunchSnapshot,
} from "./embedding-worker-client";
import {
  VECTOR_STORE_WORKER_ROLE,
  vectorStoreError,
  type VectorStoreOperation,
  type VectorStoreOperations,
  type VectorStoreResponse,
} from "./vector-store-protocol";

export interface VectorStoreHostOptions {
  databasePath: string;
  execPath: string;
  moduleRoot: string;
  pluginDir: string;
  workerRoot: string;
  workerDir: string;
  buildId: string;
  workerBundleSource: string;
  spawnGuard?: () => Promise<WorkerRuntimeLaunchSnapshot | void>;
  recorder?: DiagnosticRecorder | null;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  terminationGraceMs?: number;
  maxMessageBytes?: number;
  /** Test seam: replaces process creation. */
  spawnProcess?: typeof spawn;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  child: ChildProcess;
}

const REQUEST_TIMEOUT_MS = 120_000;
const TERMINATION_GRACE_MS = 3_000;
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;
const CRASH_WINDOW_MS = 10 * 60 * 1000;
const MAX_CRASHES_PER_WINDOW = 3;

/**
 * Owns the vector-store child process. Every SQLite read and write happens in
 * that process so Obsidian's renderer never blocks on storage or search.
 */
export class VectorStoreHost {
  private readonly options: VectorStoreHostOptions;
  private child: ChildProcess | null = null;
  private starting: Promise<ChildProcess> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly stdoutBuffers = new WeakMap<ChildProcess, string>();
  private readonly stderrTails = new WeakMap<ChildProcess, string>();
  private readonly expectedExits = new WeakSet<ChildProcess>();
  private crashTimestamps: number[] = [];
  private disposed = false;
  private lastError = "";

  constructor(options: VectorStoreHostOptions) {
    this.options = options;
  }

  get databasePath(): string {
    return this.options.databasePath;
  }

  getLastError(): string {
    return this.lastError;
  }

  getPid(): number | null {
    return this.child?.pid ?? null;
  }

  isRunning(): boolean {
    const child = this.child;
    return Boolean(child && child.exitCode === null && child.signalCode === null);
  }

  async request<K extends VectorStoreOperation>(
    op: K,
    params: VectorStoreOperations[K]["params"],
  ): Promise<VectorStoreOperations[K]["result"]> {
    const child = await this.ensureStarted();
    return await this.send(child, op, params) as VectorStoreOperations[K]["result"];
  }

  async healthy(): Promise<boolean> {
    if (this.disposed) return false;
    try {
      await this.request("health", {});
      return true;
    } catch (error) {
      this.lastError = (error as Error).message;
      return false;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child ?? await this.starting?.catch(() => null) ?? null;
    if (!child) return;
    this.expectedExits.add(child);
    try {
      await this.send(child, "close", {}, 5_000);
    } catch {
      // Termination below still releases the database.
    }
    await this.terminate(child);
  }

  private ensureStarted(): Promise<ChildProcess> {
    if (this.disposed) return Promise.reject(vectorStoreError("VECTOR_STORE_DISPOSED"));
    if (this.child && this.isRunning()) return Promise.resolve(this.child);
    if (this.starting) return this.starting;
    const now = Date.now();
    this.crashTimestamps = this.crashTimestamps.filter((at) => now - at < CRASH_WINDOW_MS);
    if (this.crashTimestamps.length >= MAX_CRASHES_PER_WINDOW) {
      return Promise.reject(vectorStoreError(
        "VECTOR_STORE_PROCESS_CRASHED",
        `Vector store process exited repeatedly: ${this.lastError || "unknown reason"}`,
      ));
    }
    const operation = this.start();
    this.starting = operation;
    void operation.then(
      () => { if (this.starting === operation) this.starting = null; },
      () => { if (this.starting === operation) this.starting = null; },
    );
    return operation;
  }

  private async start(): Promise<ChildProcess> {
    const materializer = new EmbeddingWorkerClient({
      pluginDir: this.options.pluginDir,
      workerRoot: this.options.workerRoot,
      workerDir: this.options.workerDir,
      buildId: this.options.buildId,
      workerBundleSource: this.options.workerBundleSource,
      execPath: this.options.execPath,
      moduleRoot: this.options.moduleRoot,
    });
    const workerPath = await materializer.ensureMaterialized();
    const snapshot = await this.options.spawnGuard?.();
    if (snapshot && (snapshot.nodeExecutable !== this.options.execPath
      || snapshot.moduleRoot !== this.options.moduleRoot)) {
      throw vectorStoreError("VECTOR_STORE_RUNTIME_SNAPSHOT_MISMATCH");
    }
    // Re-validate the immutable bundle immediately before launch.
    await materializer.ensureMaterialized();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.options.env,
      ANALOGY_WORKER_ROLE: VECTOR_STORE_WORKER_ROLE,
      NODE_NO_WARNINGS: "1",
    };
    const execPath = resolveNodeExecutable({ managedExecPath: this.options.execPath, env });
    const configuration = createWorkerSpawnConfiguration({
      execPath,
      workerPath,
      moduleRoot: this.options.moduleRoot,
      cwd: this.options.pluginDir,
      env,
    });
    this.options.recorder?.info("vector-store.initialize", "vector-store.spawn.start", "Starting vector store process");
    const child = (this.options.spawnProcess ?? spawn)(
      configuration.executable,
      configuration.args,
      configuration.options,
    );
    this.stdoutBuffers.set(child, "");
    this.stderrTails.set(child, "");
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(child, chunk));
    child.stderr?.on("data", (chunk: string) => {
      const tail = ((this.stderrTails.get(child) || "") + chunk).slice(-4096);
      this.stderrTails.set(child, tail);
    });
    child.on("error", (error) => this.onExit(child, null, null, error));
    child.on("exit", (code, signal) => this.onExit(child, code, signal));
    this.child = child;
    try {
      await this.send(child, "open", { databasePath: this.options.databasePath });
    } catch (error) {
      this.expectedExits.add(child);
      await this.terminate(child);
      if (this.child === child) this.child = null;
      throw error;
    }
    return child;
  }

  private send(
    child: ChildProcess,
    op: VectorStoreOperation,
    params: unknown,
    timeoutMs = this.options.timeoutMs ?? REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null || !child.stdin) {
        reject(vectorStoreError("VECTOR_STORE_PROCESS_UNAVAILABLE"));
        return;
      }
      const id = randomUUID();
      const encoded = `${JSON.stringify({ id, op, params })}\n`;
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(vectorStoreError("VECTOR_STORE_TIMEOUT", `Vector store ${op} timed out`));
        void this.terminate(child);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, child });
      child.stdin.write(encoded);
    });
  }

  private onStdout(child: ChildProcess, chunk: string): void {
    const buffer = (this.stdoutBuffers.get(child) || "") + chunk;
    const lines = buffer.split("\n");
    const remainder = lines.pop() || "";
    const limit = this.options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
    if (remainder.length > limit) {
      this.failAll(child, vectorStoreError("VECTOR_STORE_RESPONSE_TOO_LARGE"));
      void this.terminate(child);
      return;
    }
    this.stdoutBuffers.set(child, remainder);
    for (const line of lines) {
      if (!line.trim()) continue;
      let response: VectorStoreResponse;
      try {
        response = JSON.parse(line) as VectorStoreResponse;
      } catch {
        continue;
      }
      const pending = this.pending.get(response.id);
      if (!pending || pending.child !== child) continue;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(vectorStoreError(response.error.code, response.error.message));
    }
  }

  private onExit(child: ChildProcess, code: number | null, signal: string | null, error?: Error): void {
    const expected = this.expectedExits.has(child) || this.disposed;
    const stderrTail = (this.stderrTails.get(child) || "").slice(-500);
    const reason = error?.message || `exit code=${code} signal=${signal}`;
    if (!expected) {
      this.lastError = stderrTail ? `${reason}: ${stderrTail}` : reason;
      this.crashTimestamps.push(Date.now());
      this.options.recorder?.error("vector-store.initialize", "vector-store.process.exit", "Vector store process exited", {
        code,
        signal,
        stderrTail,
      });
    }
    this.failAll(child, vectorStoreError(
      "VECTOR_STORE_PROCESS_EXITED",
      `Vector store process exited (${reason})`,
    ));
    if (this.child === child) this.child = null;
  }

  private failAll(child: ChildProcess, error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      if (pending.child !== child) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private async terminate(child: ChildProcess): Promise<void> {
    this.expectedExits.add(child);
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
    try { child.stdin?.end(); } catch { /* The process may already be gone. */ }
    const graceful = await Promise.race([
      exited,
      new Promise<boolean>((resolve) => setTimeout(
        () => resolve(false),
        this.options.terminationGraceMs ?? TERMINATION_GRACE_MS,
      )),
    ]);
    if (!graceful && child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* The process may have exited. */ }
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    }
  }
}
