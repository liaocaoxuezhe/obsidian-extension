import { execFile, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import { request } from "http";
import * as net from "net";
import { StringDecoder } from "string_decoder";
import { stripVTControlCharacters } from "util";
import type { PersistedChromaProcessLease } from "./chroma-process-lease";

export const PINNED_CHROMA_RUNTIME_VERSION = "cli-1.4.4";
export const PINNED_CHROMA_WIRE_VERSION = "1.0.0";

const DEFAULT_PORT = 8000;
const LAST_SCANNED_PORT = 8099;
const START_TIMEOUT_MS = 30_000;
const START_POLL_MS = 100;
const START_STABLE_MS = 100;
const STOP_TIMEOUT_MS = 5_000;
const FORCE_KILL_VERIFY_MS = 100;
const HEALTH_REQUEST_TIMEOUT_MS = 1_000;
const MAX_LOG_LINES = 200;
const MAX_LOG_BYTES = 32 * 1024;

export interface ManagedProcessState {
  ownership: "analogy" | "external" | "none";
  pid: number | null;
  executablePath: string | null;
  port: number;
  runtimeVersion: string | null;
  startedAt: number | null;
}

export interface StopOwnedProcessResult {
  stopped: boolean;
  reason: "stopped" | "no-owned-process" | "lease-mismatch";
}

export interface ChromaStartOptions {
  executablePath: string;
  dataPath: string;
  preferredPort?: number;
  runtimeVersion?: string;
  external?: boolean;
}

interface HealthProbe {
  healthy: boolean;
  compatible: boolean;
  version: string | null;
}

type SpawnHook = (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
type StreamName = "stdout" | "stderr";

export interface ChromaRuntimeManagerHooks {
  platform?: NodeJS.Platform;
  spawn?: SpawnHook;
  isPortAvailable?: (port: number, timeoutMs?: number) => Promise<boolean>;
  probeHealth?: (port: number) => Promise<HealthProbe>;
  requestText?: (port: number, pathname: string, timeoutMs?: number) => Promise<string>;
  waitMs?: (ms: number) => Promise<void>;
  now?: () => number;
  processExists?: (pid: number) => boolean;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  healthRequestTimeoutMs?: number;
  startStableMs?: number;
  leaseStore?: {
    runtimeVaultId: string;
    read(): Promise<PersistedChromaProcessLease | null>;
    publish(lease: PersistedChromaProcessLease): Promise<void>;
    clearIfTokenMatches(token: string): Promise<boolean>;
    isolate(lease: PersistedChromaProcessLease): Promise<void>;
  };
  inspectProcessIdentity?: (lease: PersistedChromaProcessLease) => Promise<boolean>;
  terminateProcess?: (pid: number) => Promise<void>;
}

interface ChildTerminal {
  kind: "error" | "exit" | "close";
  error: (Error & { code?: string }) | null;
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ChildLifecycle {
  child: ChildProcess;
  terminal: Promise<ChildTerminal>;
  ready: Promise<void>;
  readySeen: boolean;
  spawned: boolean;
  lastProcessError: (Error & { code?: string }) | null;
  result: ChildTerminal | null;
  settled: boolean;
  dispose: () => void;
}

interface OwnedLifecycleContext {
  configKey: string;
  executablePath: string;
  port: number;
  runtimeVersion: string;
  startedAt: number;
}

type TimedResult<T> = { kind: "value"; value: T } | { kind: "timeout" };

export class ChromaRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ChromaRuntimeError";
    this.code = code;
  }
}

function initialState(port: number = DEFAULT_PORT): ManagedProcessState {
  return {
    ownership: "none",
    pid: null,
    executablePath: null,
    port,
    runtimeVersion: null,
    startedAt: null,
  };
}

function errorWithCode(code: string, detail?: string): ChromaRuntimeError {
  return new ChromaRuntimeError(code, detail);
}

function parsedVersion(body: string): string | null {
  const trimmed = body.trim();
  try {
    const value = JSON.parse(trimmed);
    return typeof value === "string" ? value : null;
  } catch {
    return trimmed || null;
  }
}

function utf8Tail(value: string, maxBytes: number): string {
  const total = Buffer.byteLength(value, "utf8");
  if (total <= maxBytes) return value;
  let removedBytes = 0;
  let removedCodeUnits = 0;
  for (const character of value) {
    removedBytes += Buffer.byteLength(character, "utf8");
    removedCodeUnits += character.length;
    if (total - removedBytes <= maxBytes) return value.slice(removedCodeUnits);
  }
  return "";
}

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function inspectDefaultProcessIdentity(
  lease: PersistedChromaProcessLease,
  platform: NodeJS.Platform,
): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (error: Error | null, stdout: string) => {
      if (error) { resolve(false); return; }
      const normalized = stdout.replace(/\\/g, "/");
      const executable = fs.realpathSync.native?.(lease.executablePath)?.replace(/\\/g, "/")
        ?? lease.executablePath.replace(/\\/g, "/");
      const dataPath = fs.realpathSync.native?.(lease.dataPath)?.replace(/\\/g, "/")
        ?? lease.dataPath.replace(/\\/g, "/");
      resolve(normalized.includes(executable)
        && /(?:^|\s)run(?:\s|$)/.test(normalized)
        && normalized.includes(dataPath)
        && normalized.includes("--host") && normalized.includes("127.0.0.1")
        && normalized.includes("--port") && normalized.includes(String(lease.port)));
    };
    if (platform === "darwin") {
      execFile("/bin/ps", ["-p", String(lease.pid), "-o", "command="], {
        timeout: 2_000, maxBuffer: 32 * 1024,
      }, finish);
    } else if (platform === "win32") {
      const script = "$p=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $args[0]); if($p){$p.ExecutablePath; $p.CommandLine}";
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, String(lease.pid)], {
        windowsHide: true, timeout: 2_000, maxBuffer: 32 * 1024,
      }, finish);
    } else resolve(false);
  });
}

function finitePositive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export class ChromaRuntimeManager {
  private readonly hooks: ChromaRuntimeManagerHooks;
  private readonly platform: NodeJS.Platform;
  private readonly startTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly healthRequestTimeoutMs: number;
  private readonly startStableMs: number;
  private state: ManagedProcessState = initialState();
  private activeLifecycle: ChildLifecycle | null = null;
  private activeConfigKey: string | null = null;
  private activeLease: PersistedChromaProcessLease | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private stopRequested = false;
  private stopWaiters = new Set<() => void>();
  private lastError = "";
  private logLines: string[] = [];
  private logRemainders: Record<StreamName, string> = { stdout: "", stderr: "" };
  private logRemainderOrder: Record<StreamName, number> = { stdout: 0, stderr: 0 };
  private logSequence = 0;

  constructor(hooks: ChromaRuntimeManagerHooks = {}) {
    this.hooks = hooks;
    this.platform = hooks.platform ?? process.platform;
    this.startTimeoutMs = finitePositive(hooks.startTimeoutMs, START_TIMEOUT_MS);
    this.stopTimeoutMs = finitePositive(hooks.stopTimeoutMs, STOP_TIMEOUT_MS);
    this.healthRequestTimeoutMs = finitePositive(hooks.healthRequestTimeoutMs, HEALTH_REQUEST_TIMEOUT_MS);
    this.startStableMs = hooks.startStableMs === undefined
      ? (hooks.spawn ? 0 : START_STABLE_MS)
      : Math.max(0, hooks.startStableMs);
  }

  start(options: ChromaStartOptions): Promise<ManagedProcessState> {
    const snapshot = { ...options };
    return this.enqueue(() => this.startLocked(snapshot));
  }

  async health(port: number = this.state.port): Promise<boolean> {
    if (!this.isExternalPort(port)) return false;
    const deadline = this.now() + this.healthRequestTimeoutMs;
    const probe = await this.probeBefore(port, deadline);
    return probe?.healthy === true && probe.compatible;
  }

  stopOwnedProcess(expectedLease?: ManagedProcessState): Promise<StopOwnedProcessResult> {
    if (!expectedLease) this.requestStop();
    return this.enqueue(async () => {
      if (expectedLease && !this.sameOwnedLease(expectedLease, this.state)) {
        return { stopped: false, reason: "lease-mismatch" };
      }
      const hasOwnedProcess = this.state.ownership === "analogy" || this.activeLifecycle !== null;
      if (!hasOwnedProcess) {
        if (!expectedLease) this.stopRequested = false;
        return { stopped: false, reason: "no-owned-process" };
      }
      if (expectedLease) this.requestStop();
      try {
        if (this.activeLease && !await this.activeLeaseStillMatches()) {
          await this.hooks.leaseStore?.isolate(this.activeLease);
          this.activeLease = null;
          this.clearActiveState(this.state.port);
          return { stopped: false, reason: "lease-mismatch" };
        }
        if (this.activeLease && !this.activeLifecycle) {
          await this.terminateAdoptedLease(this.activeLease);
          return { stopped: true, reason: "stopped" };
        }
        await this.stopActiveLifecycle(this.stopTimeoutMs);
        return { stopped: true, reason: "stopped" };
      } finally {
        this.stopRequested = false;
      }
    });
  }

  getState(): ManagedProcessState {
    return { ...this.state };
  }

  getLastError(): string {
    return this.lastError;
  }

  getLogTail(): string {
    return [
      ...this.logLines,
      ...(["stdout", "stderr"] as StreamName[])
        .filter((stream) => this.logRemainders[stream])
        .sort((left, right) => this.logRemainderOrder[left] - this.logRemainderOrder[right])
        .map((stream) => this.logRemainders[stream]),
    ].join("\n");
  }

  private requestStop(): void {
    this.stopRequested = true;
    for (const wake of this.stopWaiters) wake();
    this.stopWaiters.clear();
  }

  private sameOwnedLease(expected: ManagedProcessState, current: ManagedProcessState): boolean {
    return expected.ownership === "analogy" && current.ownership === "analogy"
      && expected.pid !== null && expected.pid === current.pid
      && expected.startedAt !== null && expected.startedAt === current.startedAt
      && expected.executablePath !== null && expected.executablePath === current.executablePath
      && expected.port === current.port
      && expected.runtimeVersion !== null && expected.runtimeVersion === current.runtimeVersion;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async startLocked(options: ChromaStartOptions): Promise<ManagedProcessState> {
    const preferredPort = options.preferredPort ?? DEFAULT_PORT;
    this.validatePort(preferredPort, Boolean(options.external));
    const configKey = this.configKey(options, preferredPort);

    if (this.activeLifecycle?.settled && this.state.ownership === "analogy") {
      await this.stopActiveLifecycle(0);
    }
    if (this.state.ownership !== "none") {
      if (configKey !== this.activeConfigKey) throw errorWithCode("CHROMA_ALREADY_RUNNING");
      if (this.state.ownership === "external") {
        const probe = await this.probeBefore(this.state.port, this.now() + this.healthRequestTimeoutMs);
        if (probe?.healthy && probe.compatible) return this.getState();
        this.clearActiveState(this.state.port);
      } else if (this.activeLifecycle && !this.activeLifecycle.settled && await this.health(this.state.port)) {
        return this.getState();
      } else {
        await this.stopActiveLifecycle(this.stopTimeoutMs);
      }
    }

    this.lastError = "";
    this.resetLogs();
    if (options.external) return this.startExternal(options, preferredPort, configKey);
    return this.startManaged(options, preferredPort, configKey);
  }

  private async startExternal(
    _options: ChromaStartOptions,
    port: number,
    configKey: string,
  ): Promise<ManagedProcessState> {
    const probe = await this.probeBefore(port, this.now() + this.healthRequestTimeoutMs);
    if (!probe?.healthy || !probe.compatible) {
      this.clearActiveState(port);
      const failure = errorWithCode("CHROMA_VERSION_MISMATCH", `127.0.0.1:${port}`);
      this.lastError = failure.message;
      throw failure;
    }
    this.activeConfigKey = configKey;
    this.state = {
      ownership: "external",
      pid: null,
      executablePath: null,
      port,
      runtimeVersion: probe.version,
      startedAt: null,
    };
    return this.getState();
  }

  private async startManaged(
    options: ChromaStartOptions,
    preferredPort: number,
    configKey: string,
  ): Promise<ManagedProcessState> {
    if (!options.executablePath) throw errorWithCode("CHROMA_EXECUTABLE_INVALID");
    if (this.platform === "win32" && !options.executablePath.toLowerCase().endsWith(".exe")) {
      throw errorWithCode("CHROMA_EXECUTABLE_INVALID", "Windows Chroma runtime must be an .exe");
    }

    const recovered = await this.recoverPersistedLease(options, preferredPort, configKey);
    if (recovered) return recovered;

    const startedAt = this.now();
    const totalDeadline = startedAt + this.startTimeoutMs;
    const readinessDeadline = Math.max(startedAt, totalDeadline - this.stopTimeoutMs);

    for (let port = preferredPort; port <= LAST_SCANNED_PORT; port += 1) {
      if (this.stopRequested) throw errorWithCode("CHROMA_START_CANCELLED");
      const remaining = readinessDeadline - this.now();
      if (remaining <= 0) break;
      const availability = await this.withTimeout(
        this.withStopSignal((this.hooks.isPortAvailable ?? this.isPortAvailable)(port, remaining)),
        remaining,
      );
      if (availability.kind === "timeout") break;
      if (availability.value.kind === "cancelled") throw errorWithCode("CHROMA_START_CANCELLED");
      if (!availability.value.value) continue;
      const mkdirRemaining = Math.max(0, readinessDeadline - this.now());
      const mkdir = await this.withTimeout(
        this.withStopSignal(fs.promises.mkdir(options.dataPath, { recursive: true })),
        mkdirRemaining,
      );
      if (mkdir.kind === "timeout") break;
      if (mkdir.value.kind === "cancelled") throw errorWithCode("CHROMA_START_CANCELLED");
      if (this.stopRequested) throw errorWithCode("CHROMA_START_CANCELLED");
      if (this.now() >= readinessDeadline) break;

      const lifecycle = this.spawnLifecycle(options, port);
      this.activeLifecycle = lifecycle;
      const ownedContext: OwnedLifecycleContext = {
        configKey,
        executablePath: options.executablePath,
        port,
        runtimeVersion: options.runtimeVersion ?? PINNED_CHROMA_RUNTIME_VERSION,
        startedAt,
      };
      let readiness: "ready" | "early-exit" | "timeout";
      try {
        if (this.now() >= readinessDeadline) {
          await this.cleanupFailedStart(lifecycle, ownedContext, totalDeadline);
          break;
        }
        readiness = await this.waitForReadiness(lifecycle, port, readinessDeadline);
      } catch (error) {
        await this.cleanupFailedStart(lifecycle, ownedContext, totalDeadline);
        throw error;
      }

      if (readiness === "ready") {
        this.activeConfigKey = configKey;
        this.state = {
          ownership: "analogy",
          pid: lifecycle.child.pid ?? null,
          executablePath: options.executablePath,
          port,
          runtimeVersion: ownedContext.runtimeVersion,
          startedAt,
        };
        if (this.hooks.leaseStore && this.state.pid) {
          const lease: PersistedChromaProcessLease = {
            schemaVersion: 1,
            runtimeVaultId: this.hooks.leaseStore.runtimeVaultId,
            pid: this.state.pid,
            port,
            executablePath: options.executablePath,
            dataPath: options.dataPath,
            runtimeVersion: ownedContext.runtimeVersion,
            startedAt,
            token: randomUUID(),
          };
          try {
            await this.hooks.leaseStore.publish(lease);
            this.activeLease = lease;
          } catch (error) {
            await this.stopActiveLifecycle(this.stopTimeoutMs);
            throw errorWithCode("CHROMA_LEASE_PUBLISH_FAILED", (error as Error).message);
          }
        }
        return this.getState();
      }

      if (readiness === "timeout") {
        await this.cleanupFailedStart(lifecycle, ownedContext, totalDeadline);
        const failure = errorWithCode("CHROMA_START_TIMEOUT", `127.0.0.1:${port}\n${this.getLogTail()}`.trim());
        this.lastError = failure.message;
        throw failure;
      }

      const terminal = lifecycle.result;
      this.releaseLifecycle(lifecycle);
      if (terminal?.kind === "error" && terminal.error?.code === "ENOENT") {
        const failure = errorWithCode("CHROMA_EXECUTABLE_NOT_FOUND", terminal.error.message);
        this.lastError = failure.message;
        throw failure;
      }
      if (terminal?.kind === "error" && terminal.error?.code === "EADDRINUSE") continue;
      if (terminal?.kind === "error") {
        const failure = errorWithCode("CHROMA_EXITED", terminal.error?.message ?? "spawn failed");
        this.lastError = failure.message;
        throw failure;
      }
      if (await this.portOccupiedAfterExit(port, readinessDeadline)) continue;
      const terminalDetail = terminal
        ? `${terminal.kind} code ${terminal.code ?? "null"}${terminal.signal ? ` signal ${terminal.signal}` : ""}`
        : "child terminated without an exit result";
      const failure = errorWithCode("CHROMA_EXITED", `${terminalDetail}\n${this.getLogTail()}`.trim());
      this.lastError = failure.message;
      throw failure;
    }

    this.clearActiveState(preferredPort);
    const failure = this.now() >= readinessDeadline
      ? errorWithCode("CHROMA_START_TIMEOUT", `127.0.0.1:${preferredPort}\n${this.getLogTail()}`.trim())
      : errorWithCode("CHROMA_PORT_CONFLICT", `${preferredPort}-${LAST_SCANNED_PORT}`);
    this.lastError = failure.message;
    throw failure;
  }

  private spawnLifecycle(options: ChromaStartOptions, port: number): ChildLifecycle {
    const args = [
      "run", "--path", options.dataPath,
      "--host", "127.0.0.1", "--port", String(port),
    ];
    const spawnOptions: SpawnOptions = this.platform === "win32"
      ? { shell: false, windowsHide: true }
      : { shell: false };
    const spawnProcess = this.hooks.spawn ?? (nodeSpawn as SpawnHook);
    try {
      return this.createLifecycle(spawnProcess(options.executablePath, args, spawnOptions), port);
    } catch (error) {
      const failure = error as Error & { code?: string };
      if (failure.code === "ENOENT") throw errorWithCode("CHROMA_EXECUTABLE_NOT_FOUND", failure.message);
      throw errorWithCode("CHROMA_EXITED", failure.message);
    }
  }

  private createLifecycle(child: ChildProcess, port: number): ChildLifecycle {
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let resolveTerminal: (terminal: ChildTerminal) => void = () => undefined;
    let resolveReady: () => void = () => undefined;
    const readyNeedle = `Frontend server listening on address, addr: 127.0.0.1:${port}`;
    const readyText: Record<StreamName, string> = { stdout: "", stderr: "" };
    const lifecycle: ChildLifecycle = {
      child,
      terminal: new Promise((resolve) => { resolveTerminal = resolve; }),
      ready: new Promise((resolve) => { resolveReady = resolve; }),
      readySeen: false,
      spawned: false,
      lastProcessError: null,
      result: null,
      settled: false,
      dispose: () => undefined,
    };

    const inspectReady = (stream: StreamName, text: string) => {
      if (lifecycle.readySeen) return;
      readyText[stream] = `${readyText[stream]}${text}`.slice(-1024);
      if (stripVTControlCharacters(readyText[stream]).includes(readyNeedle)) {
        lifecycle.readySeen = true;
        resolveReady();
      }
    };

    const onStdout = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk);
      if (text) {
        inspectReady("stdout", text);
        this.recordLog("stdout", text);
      }
    };
    const onStderr = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : stderrDecoder.write(chunk);
      if (text) {
        inspectReady("stderr", text);
        this.recordLog("stderr", text);
      }
    };
    const cleanup = () => {
      child.removeListener("error", onError);
      child.removeListener("spawn", onSpawn);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
    };
    const flushStreams = () => {
      const stdoutTail = stdoutDecoder.end();
      const stderrTail = stderrDecoder.end();
      if (stdoutTail) this.recordLog("stdout", stdoutTail);
      if (stderrTail) this.recordLog("stderr", stderrTail);
      this.flushLogRemainders();
    };
    const settle = (terminal: ChildTerminal) => {
      if (lifecycle.settled) return;
      lifecycle.settled = true;
      lifecycle.result = terminal;
      cleanup();
      flushStreams();
      resolveTerminal(terminal);
      queueMicrotask(() => this.clearTerminatedOwnership(lifecycle));
    };
    const onSpawn = () => { lifecycle.spawned = true; };
    const onError = (error: Error & { code?: string }) => {
      if (!lifecycle.spawned) {
        settle({ kind: "error", error, code: null, signal: null });
        return;
      }
      lifecycle.lastProcessError = error;
      this.lastError = errorWithCode(
        "CHROMA_PROCESS_ERROR",
        `${error.code ?? error.name}: ${error.message}`,
      ).message;
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => settle({
      kind: "exit", error: null, code, signal,
    });
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => settle({
      kind: "close", error: null, code, signal,
    });
    lifecycle.dispose = () => {
      cleanup();
      if (!lifecycle.settled) flushStreams();
    };

    child.on("error", onError);
    child.once("spawn", onSpawn);
    child.once("exit", onExit);
    child.once("close", onClose);
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    if (child.exitCode !== null || child.signalCode !== null) {
      queueMicrotask(() => settle({
        kind: "exit",
        error: null,
        code: child.exitCode,
        signal: child.signalCode as NodeJS.Signals | null,
      }));
    }
    return lifecycle;
  }

  private async waitForReadiness(
    lifecycle: ChildLifecycle,
    port: number,
    deadline: number,
  ): Promise<"ready" | "early-exit" | "timeout"> {
    while (this.now() < deadline) {
      if (this.stopRequested) throw errorWithCode("CHROMA_START_CANCELLED");
      if (lifecycle.settled) return "early-exit";
      const probe = await this.probeOrTerminal(lifecycle, port, deadline);
      if (probe.kind === "terminal") return "early-exit";
      if (probe.kind === "timeout") return "timeout";
      if (probe.value.healthy && !probe.value.compatible) {
        throw errorWithCode(
          "CHROMA_VERSION_MISMATCH",
          `expected ${PINNED_CHROMA_WIRE_VERSION}, received ${probe.value.version ?? "unknown"}`,
        );
      }
      if (probe.value.healthy && probe.value.compatible) {
        if (!lifecycle.readySeen) {
          const signal = await this.waitForReady(lifecycle, Math.min(
            START_POLL_MS,
            Math.max(0, deadline - this.now()),
          ));
          if (signal === "terminal") return "early-exit";
          if (signal === "timeout") continue;
        }
        const stable = await this.waitForLifecycle(
          lifecycle,
          Math.min(this.startStableMs, Math.max(0, deadline - this.now())),
        );
        if (stable) return "early-exit";
        if (this.now() >= deadline) return "timeout";
        if (!this.lifecycleProcessExists(lifecycle)) return "early-exit";
        const confirmation = await this.probeOrTerminal(lifecycle, port, deadline);
        if (confirmation.kind === "terminal") return "early-exit";
        if (confirmation.kind === "timeout") return "timeout";
        if (confirmation.value.healthy && confirmation.value.compatible && !lifecycle.settled) return "ready";
        if (confirmation.value.healthy) {
          throw errorWithCode(
            "CHROMA_VERSION_MISMATCH",
            `expected ${PINNED_CHROMA_WIRE_VERSION}, received ${confirmation.value.version ?? "unknown"}`,
          );
        }
      }
      const terminal = await this.waitForLifecycle(
        lifecycle,
        Math.min(START_POLL_MS, Math.max(0, deadline - this.now())),
      );
      if (terminal) return "early-exit";
    }
    return "timeout";
  }

  private async cleanupFailedStart(
    lifecycle: ChildLifecycle,
    context: OwnedLifecycleContext,
    totalDeadline: number,
  ): Promise<void> {
    await this.stopActiveLifecycle(
      Math.min(this.stopTimeoutMs, Math.max(0, totalDeadline - this.now())),
      context,
    );
  }

  private async portOccupiedAfterExit(port: number, deadline: number): Promise<boolean> {
    const probeDeadline = Math.min(deadline, this.now() + this.healthRequestTimeoutMs);
    const probeOutcome = await this.withStopSignal(this.probeBefore(port, probeDeadline));
    if (probeOutcome.kind === "cancelled") throw errorWithCode("CHROMA_START_CANCELLED");
    const probe = probeOutcome.value;
    if (probe?.healthy) return true;
    const remaining = Math.max(0, deadline - this.now());
    if (remaining === 0) return false;
    const availability = await this.withTimeout(
      this.withStopSignal((this.hooks.isPortAvailable ?? this.isPortAvailable)(port, remaining)),
      remaining,
    );
    if (availability.kind === "timeout") return false;
    if (availability.value.kind === "cancelled") throw errorWithCode("CHROMA_START_CANCELLED");
    return !availability.value.value;
  }

  private async probeOrTerminal(
    lifecycle: ChildLifecycle,
    port: number,
    deadline: number,
  ): Promise<
    | { kind: "probe"; value: HealthProbe }
    | { kind: "terminal"; value: ChildTerminal }
    | { kind: "timeout" }
  > {
    const remaining = Math.max(0, deadline - this.now());
    if (remaining === 0) return { kind: "timeout" };
    const stopWaiter = this.createStopWaiter();
    try {
      const outcome = await this.withTimeout(Promise.race([
        this.probe(port, deadline).then((value) => ({ kind: "probe" as const, value })),
        lifecycle.terminal.then((value) => ({ kind: "terminal" as const, value })),
        stopWaiter.promise.then(() => ({ kind: "cancelled" as const })),
      ]), remaining);
      if (outcome.kind === "timeout") return { kind: "timeout" };
      if (outcome.value.kind === "cancelled") throw errorWithCode("CHROMA_START_CANCELLED");
      return outcome.value;
    } finally {
      stopWaiter.cancel();
    }
  }

  private async stopActiveLifecycle(
    maxWaitMs: number,
    failedStartContext?: OwnedLifecycleContext,
  ): Promise<void> {
    const lifecycle = this.activeLifecycle;
    const port = failedStartContext?.port ?? this.state.port;
    if (!lifecycle) {
      if (this.state.ownership === "analogy") this.clearActiveState(port);
      return;
    }

    if (!lifecycle.settled) {
      try {
        lifecycle.child.kill(this.platform === "win32" ? undefined : "SIGTERM");
      } catch {
        // The lifecycle event or PID verification below determines the result.
      }
      await Promise.resolve();
    }
    if (!lifecycle.settled && maxWaitMs > 0) {
      const verifyMs = this.platform === "win32"
        ? 0
        : Math.min(FORCE_KILL_VERIFY_MS, Math.max(1, Math.floor(maxWaitMs / 5)));
      const gracefulMs = Math.max(0, maxWaitMs - verifyMs);
      await this.waitForLifecycle(lifecycle, gracefulMs);
      if (!lifecycle.settled && this.platform !== "win32") {
        try {
          lifecycle.child.kill("SIGKILL");
        } catch {
          // PID verification below determines whether termination succeeded.
        }
        await this.waitForLifecycle(lifecycle, verifyMs);
      }
    }
    if (!lifecycle.settled && this.lifecycleProcessExists(lifecycle)) {
      if (failedStartContext && this.state.ownership !== "analogy") {
        this.activeConfigKey = failedStartContext.configKey;
        this.state = {
          ownership: "analogy",
          pid: lifecycle.child.pid ?? null,
          executablePath: failedStartContext.executablePath,
          port: failedStartContext.port,
          runtimeVersion: failedStartContext.runtimeVersion,
          startedAt: failedStartContext.startedAt,
        };
      }
      const processError = lifecycle.lastProcessError
        ? `; ${lifecycle.lastProcessError.code ?? lifecycle.lastProcessError.name}: ${lifecycle.lastProcessError.message}`
        : "";
      const failure = errorWithCode(
        "CHROMA_STOP_FAILED",
        `PID ${lifecycle.child.pid ?? "unknown"} is still running${processError}`,
      );
      this.lastError = failure.message;
      throw failure;
    }
    this.releaseLifecycle(lifecycle);
    await this.clearActiveLease();
    this.clearActiveState(port);
  }

  private clearTerminatedOwnership(lifecycle: ChildLifecycle): void {
    if (this.activeLifecycle !== lifecycle || this.state.ownership !== "analogy") return;
    const port = this.state.port;
    this.releaseLifecycle(lifecycle);
    void this.clearActiveLease();
    this.clearActiveState(port);
  }

  private processExists(pid: number): boolean {
    return this.hooks.processExists ? this.hooks.processExists(pid) : defaultProcessExists(pid);
  }

  private async inspectLease(lease: PersistedChromaProcessLease): Promise<boolean> {
    return this.hooks.inspectProcessIdentity
      ? this.hooks.inspectProcessIdentity(lease)
      : inspectDefaultProcessIdentity(lease, this.platform);
  }

  private async recoverPersistedLease(
    options: ChromaStartOptions,
    preferredPort: number,
    configKey: string,
  ): Promise<ManagedProcessState | null> {
    const store = this.hooks.leaseStore;
    if (!store) return null;
    const lease = await store.read();
    if (!lease) return null;
    if (!this.processExists(lease.pid)) {
      await store.clearIfTokenMatches(lease.token);
      return null;
    }
    const expectedVersion = options.runtimeVersion ?? PINNED_CHROMA_RUNTIME_VERSION;
    const configMatches = lease.executablePath === options.executablePath
      && lease.dataPath === options.dataPath
      && lease.runtimeVersion === expectedVersion
      && lease.port >= preferredPort && lease.port <= LAST_SCANNED_PORT;
    if (!configMatches || !await this.inspectLease(lease)) {
      await store.isolate(lease);
      return null;
    }
    const probe = await this.probeBefore(lease.port, this.now() + this.healthRequestTimeoutMs);
    if (probe?.healthy && probe.compatible) {
      this.activeLease = lease;
      this.activeConfigKey = configKey;
      this.state = {
        ownership: "analogy",
        pid: lease.pid,
        executablePath: lease.executablePath,
        port: lease.port,
        runtimeVersion: lease.runtimeVersion,
        startedAt: lease.startedAt,
      };
      return this.getState();
    }
    if (!this.processExists(lease.pid)) {
      await store.clearIfTokenMatches(lease.token);
      return null;
    }
    if (!await this.inspectLease(lease)) {
      await store.isolate(lease);
      return null;
    }
    await this.terminateLeaseProcess(lease);
    if (!await this.waitForProcessExit(lease.pid, this.stopTimeoutMs)) {
      throw errorWithCode("CHROMA_STOP_FAILED", `PID ${lease.pid} is still running`);
    }
    await store.clearIfTokenMatches(lease.token);
    return null;
  }

  private async activeLeaseStillMatches(): Promise<boolean> {
    const lease = this.activeLease;
    const store = this.hooks.leaseStore;
    if (!lease || !store) return true;
    const current = await store.read();
    return current?.token === lease.token && this.processExists(lease.pid) && await this.inspectLease(lease);
  }

  private async terminateLeaseProcess(lease: PersistedChromaProcessLease): Promise<void> {
    if (this.hooks.terminateProcess) await this.hooks.terminateProcess(lease.pid);
    else process.kill(lease.pid, this.platform === "win32" ? undefined : "SIGTERM");
  }

  private async waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
    let remainingMs = Math.max(0, timeoutMs);
    while (this.processExists(pid) && remainingMs > 0) {
      const delayMs = Math.min(100, remainingMs);
      await (this.hooks.waitMs?.(delayMs)
        ?? new Promise((resolve) => setTimeout(resolve, delayMs)));
      remainingMs -= delayMs;
    }
    return !this.processExists(pid);
  }

  private async terminateAdoptedLease(lease: PersistedChromaProcessLease): Promise<void> {
    await this.terminateLeaseProcess(lease);
    const deadline = this.now() + this.stopTimeoutMs;
    while (this.processExists(lease.pid) && this.now() < deadline) {
      await (this.hooks.waitMs?.(Math.min(100, deadline - this.now()))
        ?? new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - this.now()))));
    }
    if (this.processExists(lease.pid)) throw errorWithCode("CHROMA_STOP_FAILED", `PID ${lease.pid} is still running`);
    await this.clearActiveLease();
    this.clearActiveState(lease.port);
  }

  private async clearActiveLease(): Promise<void> {
    const lease = this.activeLease;
    this.activeLease = null;
    if (lease) await this.hooks.leaseStore?.clearIfTokenMatches(lease.token);
  }

  private releaseLifecycle(lifecycle: ChildLifecycle): void {
    lifecycle.dispose();
    if (this.activeLifecycle === lifecycle) this.activeLifecycle = null;
  }

  private clearActiveState(port: number): void {
    this.activeConfigKey = null;
    this.state = initialState(port);
  }

  private lifecycleProcessExists(lifecycle: ChildLifecycle): boolean {
    if (lifecycle.settled) return false;
    const pid = lifecycle.child.pid;
    if (pid === undefined) return false;
    if (this.hooks.processExists) return this.hooks.processExists(pid);
    if (this.hooks.spawn) return true;
    return defaultProcessExists(pid);
  }

  private async probeBefore(port: number, deadline: number): Promise<HealthProbe | null> {
    const remaining = Math.max(0, deadline - this.now());
    if (remaining === 0) return null;
    const outcome = await this.withTimeout(this.probe(port, deadline), remaining);
    return outcome.kind === "value" ? outcome.value : null;
  }

  private async probe(port: number, deadline: number): Promise<HealthProbe> {
    if (this.hooks.probeHealth) {
      try {
        return await this.hooks.probeHealth(port);
      } catch {
        return { healthy: false, compatible: false, version: null };
      }
    }
    const requestText = this.hooks.requestText ?? this.requestText;
    try {
      const heartbeatTimeout = Math.min(this.healthRequestTimeoutMs, Math.max(1, deadline - this.now()));
      await requestText(port, "/api/v2/heartbeat", heartbeatTimeout);
    } catch {
      return { healthy: false, compatible: false, version: null };
    }
    try {
      const versionTimeout = Math.min(this.healthRequestTimeoutMs, Math.max(1, deadline - this.now()));
      const version = parsedVersion(await requestText(port, "/api/v2/version", versionTimeout));
      return { healthy: true, compatible: version === PINNED_CHROMA_WIRE_VERSION, version };
    } catch {
      return { healthy: true, compatible: false, version: null };
    }
  }

  private readonly requestText = (port: number, pathname: string, timeoutMs?: number): Promise<string> => new Promise((resolve, reject) => {
    let settled = false;
    let responseRef: import("http").IncomingMessage | null = null;
    let deadlineTimer: NodeJS.Timeout | null = null;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const req = request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method: "GET",
    }, (response) => {
      responseRef = response;
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.once("end", () => {
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) finish(undefined, body);
        else finish(new Error(`HTTP ${status}`));
      });
      response.once("error", (error) => finish(error));
    });
    req.once("error", (error) => finish(error));
    const absoluteTimeoutMs = finitePositive(timeoutMs, this.healthRequestTimeoutMs);
    deadlineTimer = setTimeout(() => {
      const failure = errorWithCode("CHROMA_HEALTH_TIMEOUT");
      responseRef?.destroy(failure);
      req.destroy(failure);
      finish(failure);
    }, absoluteTimeoutMs);
    deadlineTimer.unref?.();
    req.end();
  });

  private readonly isPortAvailable = (port: number, timeoutMs?: number): Promise<boolean> => new Promise((resolve) => {
    let settled = false;
    const server = net.createServer();
    let timer: NodeJS.Timeout | null = null;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server.removeAllListeners();
      if (server.listening) server.close(() => resolve(available));
      else resolve(available);
    };
    server.unref();
    server.once("error", () => finish(false));
    server.listen(port, "127.0.0.1", () => finish(true));
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
      timer.unref?.();
    }
  });

  private async waitForLifecycle(lifecycle: ChildLifecycle, ms: number): Promise<ChildTerminal | null> {
    if (lifecycle.settled) return lifecycle.result;
    if (ms <= 0) {
      await Promise.resolve();
      return lifecycle.result;
    }
    const outcome = await this.withTimeout(lifecycle.terminal, ms, true);
    return outcome.kind === "value" ? outcome.value : null;
  }

  private async waitForReady(
    lifecycle: ChildLifecycle,
    ms: number,
  ): Promise<"ready" | "terminal" | "timeout"> {
    if (lifecycle.readySeen) return "ready";
    if (lifecycle.settled) return "terminal";
    const outcome = await this.withTimeout(Promise.race([
      lifecycle.ready.then(() => "ready" as const),
      lifecycle.terminal.then(() => "terminal" as const),
    ]), ms, true);
    return outcome.kind === "value" ? outcome.value : "timeout";
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, useWaitHook: boolean = false): Promise<TimedResult<T>> {
    if (ms <= 0) return { kind: "timeout" };
    if (useWaitHook && this.hooks.waitMs) {
      return Promise.race([
        promise.then((value) => ({ kind: "value" as const, value })),
        this.hooks.waitMs(ms).then(() => ({ kind: "timeout" as const })),
      ]);
    }
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<TimedResult<T>>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        promise.then((value) => ({ kind: "value" as const, value })),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private withStopSignal<T>(promise: Promise<T>): Promise<
    { kind: "value"; value: T } | { kind: "cancelled" }
  > {
    const stopWaiter = this.createStopWaiter();
    return Promise.race([
      promise.then((value) => ({ kind: "value" as const, value })),
      stopWaiter.promise.then(() => ({ kind: "cancelled" as const })),
    ]).finally(stopWaiter.cancel);
  }

  private createStopWaiter(): { promise: Promise<void>; cancel: () => void } {
    if (this.stopRequested) return { promise: Promise.resolve(), cancel: () => undefined };
    let wake: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => { wake = resolve; });
    this.stopWaiters.add(wake);
    return {
      promise,
      cancel: () => { this.stopWaiters.delete(wake); },
    };
  }

  private recordLog(stream: StreamName, chunk: string): void {
    const parts = `${this.logRemainders[stream]}${chunk}`.split(/\r?\n/);
    this.logRemainders[stream] = parts.pop() ?? "";
    this.logLines.push(...parts);
    if (this.logRemainders[stream]) this.logRemainderOrder[stream] = ++this.logSequence;
    this.trimLogs();
  }

  private flushLogRemainders(): void {
    for (const stream of (["stdout", "stderr"] as StreamName[])
      .sort((left, right) => this.logRemainderOrder[left] - this.logRemainderOrder[right])) {
      if (this.logRemainders[stream]) this.logLines.push(this.logRemainders[stream]);
      this.logRemainders[stream] = "";
    }
    this.trimLogs();
  }

  private trimLogs(): void {
    const remainderCount = (["stdout", "stderr"] as StreamName[])
      .filter((stream) => this.logRemainders[stream]).length;
    while (this.logLines.length + remainderCount > MAX_LOG_LINES && this.logLines.length > 0) {
      this.logLines.shift();
    }
    while (Buffer.byteLength(this.getLogTail(), "utf8") > MAX_LOG_BYTES && this.logLines.length > 0) {
      this.logLines.shift();
    }
    const ordered = (["stdout", "stderr"] as StreamName[])
      .filter((stream) => this.logRemainders[stream])
      .sort((left, right) => this.logRemainderOrder[left] - this.logRemainderOrder[right]);
    for (const stream of ordered) {
      const total = Buffer.byteLength(this.getLogTail(), "utf8");
      if (total <= MAX_LOG_BYTES) break;
      const streamBytes = Buffer.byteLength(this.logRemainders[stream], "utf8");
      this.logRemainders[stream] = utf8Tail(
        this.logRemainders[stream],
        Math.max(0, streamBytes - (total - MAX_LOG_BYTES)),
      );
    }
  }

  private resetLogs(): void {
    this.logLines = [];
    this.logRemainders = { stdout: "", stderr: "" };
    this.logRemainderOrder = { stdout: 0, stderr: 0 };
    this.logSequence = 0;
  }

  private validatePort(port: number, external: boolean): void {
    if (!Number.isInteger(port)) {
      throw errorWithCode(external ? "CHROMA_EXTERNAL_PORT_INVALID" : "CHROMA_PORT_INVALID");
    }
    if (external) {
      if (!this.isExternalPort(port)) throw errorWithCode("CHROMA_EXTERNAL_PORT_INVALID");
    } else if (port < DEFAULT_PORT || port > LAST_SCANNED_PORT) {
      throw errorWithCode("CHROMA_PORT_INVALID");
    }
  }

  private isExternalPort(port: number): boolean {
    return Number.isInteger(port) && port >= 1 && port <= 65_535;
  }

  private configKey(options: ChromaStartOptions, preferredPort: number): string {
    return JSON.stringify({
      external: Boolean(options.external),
      executablePath: options.executablePath,
      dataPath: options.dataPath,
      preferredPort,
      runtimeVersion: options.runtimeVersion ?? PINNED_CHROMA_RUNTIME_VERSION,
    });
  }

  private now(): number {
    return this.hooks.now ? this.hooks.now() : Date.now();
  }
}
