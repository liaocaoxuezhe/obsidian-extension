import { ChildProcess, spawn, spawnSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import type { DiagnosticRecorder } from "../diagnostics/diagnostic-recorder";
import type { EmbeddingPooling } from "./embedding";
import {
  decodeMessage,
  encodeMessage,
  isWorkerProgressResponse,
  sanitizeWorkerProgress,
  validateEmbeddings,
  validateResponse,
  type EmbeddingInitializationProgress,
  type WorkerEmbedRequest,
  type WorkerHealthRequest,
  type WorkerInitializeRequest,
  type WorkerRequest,
  type WorkerResponse,
} from "./embedding-worker-protocol";

export interface EmbeddingWorkerClientOptions {
  pluginDir: string;
  workerRoot?: string;
  workerDir?: string;
  buildId: string;
  workerBundleSource: string;
  execPath?: string;
  moduleRoot?: string;
  spawnGuard?: () => Promise<WorkerRuntimeLaunchSnapshot | void>;
  allowDeveloperNodeOverride?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  terminationGraceMs?: number;
  maxMessageBytes?: number;
  recorder?: DiagnosticRecorder | null;
  onUnexpectedExit?: (info: WorkerExitInfo) => void;
}

export interface WorkerRuntimeLaunchSnapshot {
  nodeExecutable: string;
  moduleRoot: string;
  verification: {
    assetId: string;
    assetSha256: string;
    internalManifestPath: string;
    internalManifestSha256: string;
  };
}

export interface WorkerExitInfo {
  code: number | null;
  signal: string | null;
  lastTaskType: string | null;
  modelId: string;
  uptimeMs: number;
  stderrTail: string;
}

interface PendingRequest {
  resolve: (value: { embeddings?: number[][]; memory?: { rss: number; heapUsed: number; external: number } }) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  worker: ChildProcess;
  failure?: Error;
  onProgress?: (progress: EmbeddingInitializationProgress) => void;
}

interface ActiveInitialization {
  id: string;
  worker: ChildProcess;
}

const WORKER_TIMEOUT_MS = 300_000;
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const TERMINATION_GRACE_MS = 5_000;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export interface NodeRuntimeResolutionOptions {
  managedExecPath?: string;
  preferredExecPath?: string;
  env?: NodeJS.ProcessEnv;
  allowDeveloperOverride?: boolean;
}

export function resolveNodeExecutable(
  options: NodeRuntimeResolutionOptions = {}
): string {
  const env = options.env ?? process.env;
  const managedExecPath = options.managedExecPath ?? options.preferredExecPath;
  const candidates = managedExecPath
    ? [managedExecPath]
    : options.allowDeveloperOverride && env.ANALOGY_NODE_PATH
      ? [env.ANALOGY_NODE_PATH]
      : [];

  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && !fs.existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ["--version"], {
      env,
      encoding: "utf-8",
      timeout: 3_000,
      windowsHide: true,
    });
    const version = `${probe.stdout || ""}${probe.stderr || ""}`.trim();
    if (probe.status === 0 && /^v\d+\.\d+\.\d+/.test(version)) {
      return candidate;
    }
  }

  throw new Error(
    managedExecPath
      ? "The managed Node.js runtime is invalid. Repair the Analogy embedding runtime, then retry."
      : "The managed Node.js runtime is required. ANALOGY_NODE_PATH is available only in explicit developer override mode.",
  );
}

export interface WorkerSpawnConfigurationInput {
  execPath: string;
  workerPath: string;
  moduleRoot: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function createWorkerSpawnConfiguration(input: WorkerSpawnConfigurationInput): {
  executable: string;
  args: string[];
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
    shell: false;
    windowsHide: true;
  };
} {
  if (!path.isAbsolute(input.execPath) || !path.isAbsolute(input.moduleRoot)) {
    throw new Error("Managed embedding runtime paths must be absolute");
  }
  const env = { ...input.env };
  delete env.NODE_PATH;
  delete env.npm_node_execpath;
  delete env.npm_execpath;
  delete env.ANALOGY_NODE_PATH;
  env.ANALOGY_RUNTIME_MODULE_ROOT = input.moduleRoot;
  env.ELECTRON_RUN_AS_NODE = "1";
  return {
    executable: input.execPath,
    args: [input.workerPath],
    options: {
      cwd: input.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    },
  };
}

export class EmbeddingWorkerClient {
  private readonly options: EmbeddingWorkerClientOptions;
  private worker: ChildProcess | null = null;
  private pending = new Map<string, PendingRequest>();
  private stdoutBuffers = new WeakMap<ChildProcess, string>();
  private stderrBuffers = new WeakMap<ChildProcess, string>();
  private startedAt = new WeakMap<ChildProcess, number>();
  private expectedExits = new WeakSet<ChildProcess>();
  private exitCount = 0;
  private firstExitAt: number | null = null;
  private lastTaskType: string | null = null;
  private currentModelId = "";
  private disposed = false;
  private requestQueue: Promise<void> = Promise.resolve();
  private activeInitialization: ActiveInitialization | null = null;

  constructor(options: EmbeddingWorkerClientOptions) {
    this.options = {
      timeoutMs: WORKER_TIMEOUT_MS,
      terminationGraceMs: TERMINATION_GRACE_MS,
      maxMessageBytes: MAX_MESSAGE_BYTES,
      ...options,
    };
  }

  private record(level: "info" | "warn" | "error", code: string, message: string, context?: Record<string, unknown>) {
    this.options.recorder?.[level]("embedding.worker-start", code, message, context as Record<string, string | number | boolean | null>);
  }

  async ensureMaterialized(): Promise<string> {
    const source = this.options.workerBundleSource;
    if (!source?.trim()) {
      throw new Error("Embedded worker bundle is unavailable");
    }

    const expectedHash = this.computeSha256(source);
    const safeBuildId = this.options.buildId.replace(/[^a-zA-Z0-9._+-]/g, "_");
    const workerDir = this.options.workerDir ?? path.join(this.options.pluginDir, "worker");
    const workerRoot = this.options.workerRoot ?? this.options.pluginDir;
    this.prepareWorkerDirectory(workerRoot, workerDir);
    const targetName = `embedding-worker-${safeBuildId}-${expectedHash.slice(0, 12)}.cjs`;
    const targetPath = path.join(workerDir, targetName);
    if (fs.existsSync(targetPath)) {
      this.validateMaterializedWorker(workerRoot, targetPath, expectedHash);
      return targetPath;
    }

    const tempPath = path.join(
      workerDir,
      `.${targetName}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
    );
    let descriptor: number | null = null;
    try {
      const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
      descriptor = fs.openSync(
        tempPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
        0o600,
      );
      fs.writeFileSync(descriptor, source, { encoding: "utf8" });
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      this.validateMaterializedWorker(workerRoot, tempPath, expectedHash);
      try {
        fs.linkSync(tempPath, targetPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } catch (error) {
      throw error;
    } finally {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch { /* Preserve the original error. */ }
      }
      try {
        const temporaryStat = fs.lstatSync(tempPath);
        if (temporaryStat.isFile() && !temporaryStat.isSymbolicLink()) fs.unlinkSync(tempPath);
      } catch {
        // A missing temporary file is expected after cleanup.
      }
    }

    this.validateMaterializedWorker(workerRoot, targetPath, expectedHash);
    // Keep only current and previous worker bundles.
    this.cleanupOldWorkers(workerRoot, workerDir, targetName);
    this.validateMaterializedWorker(workerRoot, targetPath, expectedHash);
    return targetPath;
  }

  private prepareWorkerDirectory(workerRoot: string, workerDir: string): void {
    if (!path.isAbsolute(workerRoot) || !path.isAbsolute(workerDir)) {
      throw new Error("Managed worker paths must be absolute");
    }
    const relative = path.relative(workerRoot, workerDir);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Managed worker directory escapes its root");
    }
    const rootStat = fs.lstatSync(workerRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("Managed worker root must be a real directory");
    }
    let current = workerRoot;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Managed worker directory contains a symlink or non-directory");
      }
    }
    if (process.platform !== "win32") fs.chmodSync(workerDir, 0o700);
    const realRoot = fs.realpathSync(workerRoot);
    const realWorkerDir = fs.realpathSync(workerDir);
    const realRelative = path.relative(realRoot, realWorkerDir);
    if (!realRelative || realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      throw new Error("Managed worker directory resolves outside its root");
    }
  }

  private validateMaterializedWorker(workerRoot: string, filename: string, expectedHash: string): void {
    const workerDir = path.dirname(filename);
    const directoryRelative = path.relative(workerRoot, workerDir);
    if (!directoryRelative || directoryRelative === ".."
      || directoryRelative.startsWith(`..${path.sep}`) || path.isAbsolute(directoryRelative)) {
      throw new Error("Managed worker target directory escapes its root");
    }
    let current = workerRoot;
    for (const segment of directoryRelative.split(path.sep)) {
      current = path.join(current, segment);
      const directoryStat = fs.lstatSync(current);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new Error("Managed worker target directory contains a symlink or non-directory");
      }
    }
    const workerDirStat = fs.lstatSync(workerDir);
    if (process.platform !== "win32") {
      if ((workerDirStat.mode & 0o077) !== 0) {
        throw new Error("Managed worker target directory permissions are not private");
      }
      if (typeof process.getuid === "function" && workerDirStat.uid !== process.getuid()) {
        throw new Error("Managed worker target directory owner mismatch");
      }
    }
    const realRoot = fs.realpathSync(workerRoot);
    const realFilename = fs.realpathSync(filename);
    const relative = path.relative(realRoot, realFilename);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Managed worker target resolves outside its root");
    }
    const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    let descriptor: number | null = null;
    let bytes: Buffer;
    let verifiedStat: fs.Stats;
    try {
      descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollow);
      const before = fs.fstatSync(descriptor);
      if (!before.isFile()) throw new Error("Managed worker target must be a regular file");
      if (process.platform !== "win32") {
        if ((before.mode & 0o777) !== 0o600) {
          throw new Error("Managed worker target permissions must be 0600");
        }
        if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
          throw new Error("Managed worker target owner mismatch");
        }
      }
      bytes = fs.readFileSync(descriptor);
      verifiedStat = fs.fstatSync(descriptor);
      if (before.dev !== verifiedStat.dev || before.ino !== verifiedStat.ino
        || before.size !== verifiedStat.size || before.mtimeMs !== verifiedStat.mtimeMs) {
        throw new Error("Managed worker target changed during verification");
      }
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
    }
    const pathStat = fs.lstatSync(filename);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()
      || pathStat.dev !== verifiedStat.dev || pathStat.ino !== verifiedStat.ino) {
      throw new Error("Managed worker target changed during verification");
    }
    if (this.computeSha256(bytes) !== expectedHash) {
      throw new Error("Managed worker immutable content hash mismatch");
    }
  }

  private computeSha256(value: string | Buffer): string {
    const hash = crypto.createHash("sha256");
    hash.update(value);
    return hash.digest("hex");
  }

  private cleanupOldWorkers(workerRoot: string, workerDir: string, keepName: string): void {
    try {
      const files = fs.readdirSync(workerDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink()
          && entry.name.startsWith("embedding-worker-") && entry.name.endsWith(".cjs"))
        .map((entry) => entry.name);
      files.sort((a, b) => fs.lstatSync(path.join(workerDir, b)).mtime.getTime() - fs.lstatSync(path.join(workerDir, a)).mtime.getTime());
      for (const file of files.slice(2)) {
        if (file === keepName) continue;
        const filename = path.join(workerDir, file);
        const realRoot = fs.realpathSync(workerRoot);
        const realFilename = fs.realpathSync(filename);
        const relative = path.relative(realRoot, realFilename);
        if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
          fs.unlinkSync(filename);
        }
      }
    } catch (err) {
      this.record("warn", "worker.cleanup.failed", "Failed to clean up old worker bundles", { error: (err as Error).message });
    }
  }

  private async start(): Promise<void> {
    if (this.disposed) {
      throw new Error("Embedding worker client is disposed");
    }
    if (this.worker) return;
    const workerPath = await this.ensureMaterialized();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.options.env,
    };
    const moduleRoot = this.options.moduleRoot;
    if (!moduleRoot) {
      throw new Error("Managed embedding runtime module root is required");
    }
    const launchSnapshot = await this.options.spawnGuard?.();
    if (launchSnapshot
      && (launchSnapshot.nodeExecutable !== this.options.execPath
        || launchSnapshot.moduleRoot !== moduleRoot)) {
      throw new Error("Managed runtime snapshot paths do not match the worker launch configuration");
    }
    const workerRoot = this.options.workerRoot ?? this.options.pluginDir;
    this.validateMaterializedWorker(
      workerRoot,
      workerPath,
      this.computeSha256(this.options.workerBundleSource),
    );
    const execPath = resolveNodeExecutable({
      managedExecPath: this.options.execPath,
      env,
      allowDeveloperOverride: this.options.allowDeveloperNodeOverride,
    });
    const spawnConfiguration = createWorkerSpawnConfiguration({
      execPath,
      workerPath,
      moduleRoot,
      cwd: this.options.pluginDir,
      env,
    });
    this.record("info", "worker.spawn.start", `Spawning worker: ${execPath} ${workerPath}`, { model: this.currentModelId });
    const child = spawn(
      spawnConfiguration.executable,
      spawnConfiguration.args,
      spawnConfiguration.options,
    );
    this.worker = child;
    this.stdoutBuffers.set(child, "");
    this.stderrBuffers.set(child, "");
    this.startedAt.set(child, Date.now());
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(child, chunk));
    child.stderr?.on("data", (chunk: string) => this.onStderr(child, chunk));
    child.on("error", (err) => this.onWorkerError(child, err));
    child.on("exit", (code, signal) => this.onWorkerExit(child, code, signal));
  }

  private onStdout(child: ChildProcess, chunk: string): void {
    const buffer = (this.stdoutBuffers.get(child) || "") + chunk;
    const lines = buffer.split("\n");
    const remainder = lines.pop() || "";
    this.stdoutBuffers.set(child, remainder);
    if (Buffer.byteLength(remainder, "utf-8") > (this.options.maxMessageBytes ?? MAX_MESSAGE_BYTES)) {
      this.failWorkerProtocol(child, new Error("Worker response is too large"));
      return;
    }
    for (const line of lines) {
      if (Buffer.byteLength(line, "utf-8") > (this.options.maxMessageBytes ?? MAX_MESSAGE_BYTES)) {
        this.failWorkerProtocol(child, new Error("Worker response is too large"));
        return;
      }
      const response = decodeMessage(line);
      if (!response) continue;
      this.handleResponse(child, response as WorkerResponse);
    }
  }

  private onStderr(child: ChildProcess, chunk: string): void {
    let stderrBuffer = (this.stderrBuffers.get(child) || "") + chunk;
    const maxLen = 16 * 1024;
    if (stderrBuffer.length > maxLen) {
      stderrBuffer = stderrBuffer.slice(-maxLen);
    }
    this.stderrBuffers.set(child, stderrBuffer);
  }

  private handleResponse(child: ChildProcess, response: WorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending || pending.worker !== child) return;
    if (isWorkerProgressResponse(response)) {
      const progress = sanitizeWorkerProgress(response.progress);
      if (progress) {
        try {
          pending.onProgress?.(progress);
        } catch (error) {
          this.record("warn", "worker.progress-listener.failed", (error as Error).message);
        }
      }
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    const validated = validateResponse(response, response.id);
    if (validated.ok) {
      pending.resolve({ embeddings: validated.result, memory: validated.memory });
    } else {
      pending.reject(new Error(validated.error));
    }
  }

  private onWorkerError(child: ChildProcess, err: Error): void {
    this.record("error", "worker.process.error", err.message);
    this.rejectPendingFor(child, new Error(`Worker process error: ${err.message}`));
  }

  private onWorkerExit(child: ChildProcess, code: number | null, signal: string | null): void {
    const expected = this.expectedExits.has(child);
    const stderrTail = (this.stderrBuffers.get(child) || "").slice(-500);
    this.record(expected ? "info" : "error", "worker.process.exit", `Worker exited code=${code} signal=${signal}`, {
      code,
      signal,
      lastTaskType: this.lastTaskType || "none",
      stderrTail,
    });
    this.rejectPendingFor(child, new Error(`Worker exited code=${code} signal=${signal}`));
    if (this.worker === child) {
      this.worker = null;
    }
    if (!expected) {
      this.updateExitStats();
      this.options.onUnexpectedExit?.({
        code,
        signal,
        lastTaskType: this.lastTaskType,
        modelId: this.currentModelId,
        uptimeMs: Math.max(0, Date.now() - (this.startedAt.get(child) || Date.now())),
        stderrTail,
      });
    }
  }

  private updateExitStats(): void {
    const now = Date.now();
    if (!this.firstExitAt || now - this.firstExitAt > RESTART_WINDOW_MS) {
      this.firstExitAt = now;
      this.exitCount = 1;
    } else {
      this.exitCount += 1;
    }
  }

  private rejectPendingFor(child: ChildProcess, error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      if (pending.worker !== child) continue;
      clearTimeout(pending.timer);
      pending.reject(pending.failure || error);
      this.pending.delete(id);
    }
  }

  async initialize(
    modelId: string,
    dtype: string,
    pooling: EmbeddingPooling,
    cacheDir: string,
    modelHost?: string,
    modelRevision?: string,
    onProgress?: (progress: EmbeddingInitializationProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.enqueue(async () => {
      if (signal?.aborted) throw new Error("EMBEDDING_INITIALIZATION_CANCELLED");
      this.currentModelId = modelId;
      await this.start();
      const child = this.worker;
      if (!child) throw new Error("Worker not running");
      const id = uuidv4();
      this.activeInitialization = { id, worker: child };
      const abort = () => { void this.cancelInitialization(); };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        await this.sendRequest(
          { id, type: "initialize", modelId, dtype, pooling, cacheDir, modelHost, modelRevision },
          true,
          onProgress,
        );
      } finally {
        signal?.removeEventListener("abort", abort);
        if (this.activeInitialization?.id === id) this.activeInitialization = null;
      }
    });
  }

  async cancelInitialization(): Promise<void> {
    const active = this.activeInitialization;
    if (!active) return;
    const pending = this.pending.get(active.id);
    if (pending && pending.worker === active.worker) {
      clearTimeout(pending.timer);
      this.pending.delete(active.id);
      pending.reject(new Error("EMBEDDING_INITIALIZATION_CANCELLED"));
    }
    this.activeInitialization = null;
    await this.terminateWorker(active.worker, true);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return this.enqueue(async () => {
      await this.start();
      this.lastTaskType = "embed";
      const result = await this.sendRequest({ id: uuidv4(), type: "embed", texts } as WorkerEmbedRequest);
      return validateEmbeddings(result.embeddings, texts.length);
    });
  }

  async health(): Promise<{ rss: number; heapUsed: number; external: number }> {
    return this.enqueue(async () => {
      await this.start();
      const result = await this.sendRequest({ id: uuidv4(), type: "health" } as WorkerHealthRequest);
      return result.memory || { rss: 0, heapUsed: 0, external: 0 };
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    return this.enqueue(async () => {
      const child = this.worker;
      if (!child) return;
      this.expectedExits.add(child);
      try {
        await this.sendRequest({ id: uuidv4(), type: "dispose" } as WorkerRequest, false);
      } catch (err) {
        this.record("warn", "worker.dispose.failed", (err as Error).message);
      }
      await this.terminateWorker(child, true);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.requestQueue.then(operation, operation);
    this.requestQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private sendRequest(
    req: WorkerRequest,
    terminateOnTimeout = true,
    onProgress?: (progress: EmbeddingInitializationProgress) => void,
  ): Promise<{ embeddings?: number[][]; memory?: { rss: number; heapUsed: number; external: number } }> {
    return new Promise((resolve, reject) => {
      const child = this.worker;
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        reject(new Error("Worker not running"));
        return;
      }
      const encoded = encodeMessage(req);
      if (Buffer.byteLength(encoded, "utf-8") > (this.options.maxMessageBytes ?? MAX_MESSAGE_BYTES)) {
        reject(new Error(`Worker request ${req.type} is too large`));
        return;
      }
      const timer = setTimeout(() => {
        const pending = this.pending.get(req.id);
        if (!pending) return;
        pending.failure = new Error(`Worker request ${req.type} timed out`);
        if (terminateOnTimeout) {
          void this.terminateWorker(child, false);
        } else {
          clearTimeout(pending.timer);
          this.pending.delete(req.id);
          reject(pending.failure);
        }
      }, this.options.timeoutMs);
      this.pending.set(req.id, { resolve, reject, timer, worker: child, onProgress });
      child.stdin?.write(encoded);
    });
  }

  private failWorkerProtocol(child: ChildProcess, error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.worker === child) {
        pending.failure = error;
      }
    }
    void this.terminateWorker(child, false);
  }

  private async terminateWorker(child: ChildProcess, expected: boolean): Promise<void> {
    if (expected) {
      this.expectedExits.add(child);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      if (this.worker === child) this.worker = null;
      return;
    }

    const exitPromise = new Promise<boolean>((resolve) => {
      child.once("exit", () => resolve(true));
    });
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may have exited between the state check and kill.
    }

    const exitedGracefully = await Promise.race([
      exitPromise,
      new Promise<boolean>((resolve) => {
        setTimeout(
          () => resolve(false),
          this.options.terminationGraceMs ?? TERMINATION_GRACE_MS,
        );
      }),
    ]);

    if (
      !exitedGracefully &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may have exited before the forced kill.
      }
      await Promise.race([
        exitPromise,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
      ]);
    }
    if (this.worker === child && (child.exitCode !== null || child.signalCode !== null)) {
      this.worker = null;
    }
  }

  shouldEnterSafeMode(): boolean {
    return this.exitCount >= 2;
  }

  getExitCount(): number {
    return this.exitCount;
  }

  isRunning(): boolean {
    return Boolean(
      this.worker &&
      this.worker.exitCode === null &&
      this.worker.signalCode === null
    );
  }
}
