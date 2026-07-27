import { ChildProcess, spawn, spawnSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import type { DiagnosticRecorder } from "../diagnostics/diagnostic-recorder";
import {
  decodeMessage,
  encodeMessage,
  validateEmbeddings,
  validateResponse,
  type WorkerEmbedRequest,
  type WorkerHealthRequest,
  type WorkerInitializeRequest,
  type WorkerRequest,
  type WorkerResponse,
} from "./embedding-worker-protocol";

export interface EmbeddingWorkerClientOptions {
  pluginDir: string;
  buildId: string;
  workerBundlePath?: string;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  terminationGraceMs?: number;
  maxMessageBytes?: number;
  recorder?: DiagnosticRecorder | null;
  onUnexpectedExit?: (info: WorkerExitInfo) => void;
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
}

const WORKER_TIMEOUT_MS = 300_000;
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const TERMINATION_GRACE_MS = 5_000;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export interface NodeRuntimeResolutionOptions {
  preferredExecPath?: string;
  currentExecPath?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export function resolveNodeExecutable(
  options: NodeRuntimeResolutionOptions = {}
): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env.HOME ?? env.USERPROFILE ?? "";
  const candidates: string[] = [];
  const addCandidate = (candidate: string | undefined, allowCustomName = false) => {
    if (!candidate) return;
    const basename = path.basename(candidate);
    if (!allowCustomName && !/^node(?:\.exe)?$/i.test(basename)) return;
    if (!candidates.includes(candidate)) candidates.push(candidate);
  };

  addCandidate(env.ANALOGY_NODE_PATH, true);
  addCandidate(env.npm_node_execpath, true);
  addCandidate(options.preferredExecPath);
  addCandidate(options.currentExecPath ?? process.execPath);
  addCandidate(process.platform === "win32" ? "node.exe" : "node");

  if (process.platform === "win32") {
    addCandidate(env.ProgramFiles ? path.join(env.ProgramFiles, "nodejs", "node.exe") : "");
    addCandidate(env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", "nodejs", "node.exe") : "");
  } else {
    for (const candidate of [
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
      homeDir ? path.join(homeDir, ".volta", "bin", "node") : "",
      homeDir ? path.join(homeDir, ".asdf", "shims", "node") : "",
    ]) {
      addCandidate(candidate);
    }
    addVersionManagerCandidates(
      candidates,
      homeDir ? path.join(homeDir, ".nvm", "versions", "node") : "",
      path.join("bin", "node"),
    );
    addVersionManagerCandidates(
      candidates,
      homeDir ? path.join(homeDir, ".local", "share", "fnm", "node-versions") : "",
      path.join("installation", "bin", "node"),
    );
  }

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
    "A standalone Node.js runtime was not found. Install Node.js or set ANALOGY_NODE_PATH, then retry.",
  );
}

function addVersionManagerCandidates(
  candidates: string[],
  versionsDir: string,
  executableSuffix: string
): void {
  if (!versionsDir || !fs.existsSync(versionsDir)) return;
  try {
    const versionNames = fs.readdirSync(versionsDir).sort().reverse();
    for (const versionName of versionNames) {
      const candidate = path.join(versionsDir, versionName, executableSuffix);
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  } catch {
    // A missing or unreadable version-manager directory is not fatal.
  }
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
    const workerDir = path.join(this.options.pluginDir, "worker");
    const targetName = `embedding-worker-${this.options.buildId}.cjs`;
    const targetPath = path.join(workerDir, targetName);
    if (fs.existsSync(targetPath)) {
      return targetPath;
    }
    const source = this.options.workerBundlePath;
    if (!source || !fs.existsSync(source)) {
      throw new Error(`Worker bundle not found: ${source}`);
    }
    fs.mkdirSync(workerDir, { recursive: true });
    const expectedHash = this.computeSha256(source);
    fs.copyFileSync(source, targetPath);
    const actualHash = this.computeSha256(targetPath);
    if (actualHash !== expectedHash) {
      throw new Error("Worker bundle SHA-256 mismatch after copy");
    }
    // Keep only current and previous worker bundles.
    this.cleanupOldWorkers(workerDir, targetName);
    return targetPath;
  }

  private computeSha256(filePath: string): string {
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex");
  }

  private cleanupOldWorkers(workerDir: string, keepName: string): void {
    try {
      const files = fs.readdirSync(workerDir).filter((f) => f.startsWith("embedding-worker-") && f.endsWith(".cjs"));
      files.sort((a, b) => fs.statSync(path.join(workerDir, b)).mtime.getTime() - fs.statSync(path.join(workerDir, a)).mtime.getTime());
      for (const file of files.slice(2)) {
        if (file === keepName) continue;
        fs.unlinkSync(path.join(workerDir, file));
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
      ELECTRON_RUN_AS_NODE: "1",
    };
    const execPath = resolveNodeExecutable({
      preferredExecPath: this.options.execPath,
      currentExecPath: process.execPath,
      env,
    });
    this.record("info", "worker.spawn.start", `Spawning worker: ${execPath} ${workerPath}`, { model: this.currentModelId });
    const child = spawn(execPath, [workerPath], {
      cwd: this.options.pluginDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
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

  async initialize(modelId: string, dtype: string, cacheDir: string, modelHost?: string): Promise<void> {
    return this.enqueue(async () => {
      this.currentModelId = modelId;
      await this.start();
      await this.sendRequest({ id: uuidv4(), type: "initialize", modelId, dtype, cacheDir, modelHost });
    });
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
    terminateOnTimeout = true
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
      this.pending.set(req.id, { resolve, reject, timer, worker: child });
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
