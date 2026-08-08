import { ChildProcess, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type McpServiceStatus =
  | "stopped"
  | "building"
  | "starting"
  | "running"
  | "error";

export interface McpServiceState {
  status: McpServiceStatus;
  message: string;
}

export interface McpServerManagerOptions {
  serverDir: string;
  env: NodeJS.ProcessEnv;
  installTimeoutMs?: number;
  buildTimeoutMs?: number;
  readinessTimeoutMs?: number;
}

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const BUILD_TIMEOUT_MS = 5 * 60 * 1000;
const READINESS_TIMEOUT_MS = 120 * 1000;
const MAX_LOG_LINES = 500;

interface PendingReply {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function mergeEnv(base: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, ...extra };
}

function probeVersion(executable: string, env: NodeJS.ProcessEnv): string | null {
  if (executable.includes(path.sep) && !fs.existsSync(executable)) return null;
  try {
    const probe = spawnSync(executable, ["--version"], {
      env,
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    if (probe.status !== 0) return null;
    return `${probe.stdout || ""}${probe.stderr || ""}`.trim();
  } catch {
    return null;
  }
}

function resolveNodeExecutable(env: NodeJS.ProcessEnv): string {
  const candidates: string[] = [];
  if (env.ANALOGY_NODE_PATH) candidates.push(env.ANALOGY_NODE_PATH);

  try {
    const dataRoot =
      process.platform === "win32"
        ? env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local", "Analogy")
        : path.join(os.homedir(), "Library", "Application Support", "Analogy");
    const currentPointer = path.join(dataRoot, "runtime", "current", "embedding-runtime.json");
    if (fs.existsSync(currentPointer)) {
      const pointer = JSON.parse(fs.readFileSync(currentPointer, "utf8"));
      const installed = typeof pointer?.installedPath === "string" ? pointer.installedPath : "";
      if (installed && fs.existsSync(installed)) {
        for (const name of fs.readdirSync(installed)) {
          const dir = path.join(installed, name);
          try {
            if (!fs.statSync(dir).isDirectory()) continue;
          } catch {
            continue;
          }
          const candidate =
            process.platform === "win32"
              ? path.join(dir, "node", "node.exe")
              : path.join(dir, "node", "bin", "node");
          if (fs.existsSync(candidate)) candidates.push(candidate);
        }
      }
    }
  } catch {
    // ignore; fall back to PATH
  }

  const pathName = process.platform === "win32" ? "node.exe" : "node";
  for (const dir of (env.PATH || "").split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(dir, pathName));
  }
  candidates.push(pathName);

  for (const candidate of candidates) {
    const version = probeVersion(candidate, env);
    if (version && /^v?\d+\.\d+\.\d+/.test(version)) return candidate;
  }
  throw new Error(
    "A Node.js runtime is required to start the MCP server. Enable the Analogy managed runtime, or set ANALOGY_NODE_PATH.",
  );
}

function resolveNpmExecutable(env: NodeJS.ProcessEnv): string {
  if (env.ANALOGY_NPM_PATH) {
    const version = probeVersion(env.ANALOGY_NPM_PATH, env);
    if (version && /^\d+\.\d+\.\d+/.test(version)) return env.ANALOGY_NPM_PATH;
  }
  let nodeDir = "";
  try {
    nodeDir = path.dirname(resolveNodeExecutable(env));
  } catch {
    nodeDir = "";
  }
  const name = process.platform === "win32" ? "npm.cmd" : "npm";
  const candidates: string[] = [];
  if (nodeDir) candidates.push(path.join(nodeDir, name));
  for (const dir of (env.PATH || "").split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(dir, name));
  }
  for (const candidate of candidates) {
    const version = probeVersion(candidate, env);
    if (version && /^\d+\.\d+\.\d+/.test(version)) return candidate;
  }
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export class McpServerManager {
  private readonly serverDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly installTimeoutMs: number;
  private readonly buildTimeoutMs: number;
  private readonly readinessTimeoutMs: number;

  private child: ChildProcess | null = null;
  private activeBuild: ChildProcess | null = null;
  private pending = new Map<string, PendingReply>();
  private logs: string[] = [];
  private state: McpServiceState = { status: "stopped", message: "" };
  private listeners = new Set<() => void>();

  constructor(options: McpServerManagerOptions) {
    this.serverDir = options.serverDir;
    this.env = options.env;
    this.installTimeoutMs = options.installTimeoutMs ?? INSTALL_TIMEOUT_MS;
    this.buildTimeoutMs = options.buildTimeoutMs ?? BUILD_TIMEOUT_MS;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS;
  }

  getState(): McpServiceState {
    return { status: this.state.status, message: this.state.message };
  }

  getLogTail(maxLines = 30): string {
    return this.logs.slice(-maxLines).join("\n");
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (
      this.state.status === "building" ||
      this.state.status === "starting" ||
      this.state.status === "running"
    ) {
      return;
    }
    this.setState({ status: "building", message: "Preparing MCP server" });
    try {
      await this.ensureBuilt();
      if (this.getState().status !== "building") return;
      this.setState({ status: "starting", message: "Starting MCP server" });
      await this.spawnAndWaitReady();
      if (this.getState().status !== "starting") return;
      this.setState({ status: "running", message: "MCP service is running" });
    } catch (err) {
      if (this.getState().status === "stopped") return;
      this.setState({
        status: "error",
        message: (err as Error).message || String(err),
      });
    }
  }

  async stop(): Promise<void> {
    this.setState({ status: "stopped", message: "MCP service stopped" });
    this.killActiveBuild();
    await this.killChild();
  }

  dispose(): Promise<void> {
    return this.stop();
  }

  private setState(next: McpServiceState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private pushLog(line: string): void {
    for (const part of line.split(/\r?\n/)) {
      const trimmed = part.trim();
      if (trimmed) this.logs.push(trimmed);
    }
    if (this.logs.length > MAX_LOG_LINES) {
      this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
    }
  }

  private getEnv(): NodeJS.ProcessEnv {
    return mergeEnv(process.env, this.env);
  }

  private async ensureBuilt(): Promise<void> {
    const distEntry = path.join(this.serverDir, "dist", "index.js");
    if (fs.existsSync(distEntry)) return;

    if (!fs.existsSync(path.join(this.serverDir, "package.json"))) {
      throw new Error(`The MCP server is not installed in ${this.serverDir}`);
    }
    const hasLockfile = fs.existsSync(path.join(this.serverDir, "package-lock.json"));

    this.setState({ status: "building", message: "Installing MCP server dependencies" });
    await this.runNpmCommand(hasLockfile ? ["ci"] : ["install"], this.installTimeoutMs);
    if (this.getState().status !== "building") return;

    this.setState({ status: "building", message: "Building MCP server" });
    await this.runNpmCommand(["run", "build"], this.buildTimeoutMs);
    if (this.getState().status !== "building") return;

    if (!fs.existsSync(distEntry)) {
      throw new Error(`MCP server build finished but ${distEntry} was not produced`);
    }
  }

  private runNpmCommand(args: string[], timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const env = this.getEnv();
      const npmExecutable = resolveNpmExecutable(env);
      const child = spawn(npmExecutable, args, {
        cwd: this.serverDir,
        env,
        shell: process.platform === "win32",
        windowsHide: true,
      });
      this.activeBuild = child;
      const timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, 3000);
      }, timeoutMs);

      let stderrTail = "";
      child.stdout?.setEncoding("utf-8");
      child.stderr?.setEncoding("utf-8");
      child.stdout?.on("data", (chunk) => this.pushLog(String(chunk)));
      child.stderr?.on("data", (chunk) => {
        this.pushLog(String(chunk));
        stderrTail = `${stderrTail}${String(chunk)}`.slice(-4000);
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        if (this.activeBuild === child) this.activeBuild = null;
        if (this.state.status === "stopped") {
          reject(new Error("Cancelled"));
        } else {
          reject(new Error(`Failed to run ${npmExecutable}: ${err.message}`));
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (this.activeBuild === child) this.activeBuild = null;
        if (this.state.status === "stopped") {
          reject(new Error("Cancelled"));
          return;
        }
        if (code !== 0) {
          reject(
            new Error(
              `${npmExecutable} ${args.join(" ")} exited with code ${code}${stderrTail ? `\n${stderrTail}` : ""}`,
            ),
          );
        } else {
          resolve();
        }
      });
    });
  }

  private spawnAndWaitReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const env = this.getEnv();
      let nodeExecutable: string;
      try {
        nodeExecutable = resolveNodeExecutable(env);
      } catch (err) {
        reject(err as Error);
        return;
      }

      const entry = path.join(this.serverDir, "dist", "index.js");
      const child = spawn(nodeExecutable, [entry], {
        cwd: this.serverDir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;

      let settled = false;
      const finish = (err: Error | null) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      child.stdout?.setEncoding("utf-8");
      child.stderr?.setEncoding("utf-8");

      let stdoutBuffer = "";
      child.stdout?.on("data", (chunk) => {
        stdoutBuffer += String(chunk);
        let newlineIndex = stdoutBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          newlineIndex = stdoutBuffer.indexOf("\n");
          if (!line) continue;
          this.pushLog(line);
          let message: { id?: unknown } | null = null;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message && (typeof message.id === "string" || typeof message.id === "number")) {
            const id = String(message.id);
            const pending = this.pending.get(id);
            if (pending) {
              this.pending.delete(id);
              clearTimeout(pending.timer);
              pending.resolve(line);
            }
          }
        }
      });
      child.stderr?.on("data", (chunk) => this.pushLog(String(chunk)));

      const fail = (err: Error) => {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(err);
        }
        this.pending.clear();
        finish(err);
      };

      child.on("error", (err) => {
        if (this.child === child) this.child = null;
        fail(new Error(`Failed to spawn the MCP server: ${err.message}`));
      });
      child.on("exit", (code, signal) => {
        if (this.child === child) this.child = null;
        if (this.state.status === "running") {
          this.setState({
            status: "error",
            message: `MCP server exited unexpectedly (code=${code}, signal=${signal})`,
          });
          return;
        }
        fail(
          new Error(
            `MCP server exited before it became ready (code=${code}, signal=${signal})`,
          ),
        );
      });

      const send = (payload: object) => {
        try {
          child.stdin?.write(`${JSON.stringify(payload)}\n`);
        } catch (err) {
          fail(new Error(`Failed to write to the MCP server: ${(err as Error).message}`));
        }
      };

      const waitForReply = (id: string, timeoutMs: number): Promise<string> =>
        new Promise<string>((res, rej) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            rej(new Error(`MCP server did not respond to ${id} within ${timeoutMs}ms`));
          }, timeoutMs);
          this.pending.set(id, { resolve: res, reject: rej, timer });
        });

      void (async () => {
        try {
          await waitForReply("1", 30_000);
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "vault_index_status", arguments: {} },
          });
          const statusReply = await waitForReply("2", this.readinessTimeoutMs);
          const status = JSON.parse(statusReply) as {
            result?: { isError?: boolean; content?: Array<{ text?: string }> };
          };
          const text = status.result?.content?.[0]?.text ?? "";
          if (status.result?.isError || /"error"\s*:/.test(text)) {
            throw new Error(`MCP server reported an error: ${text}`);
          }
          finish(null);
        } catch (err) {
          fail(err as Error);
        }
      })();

      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "analogy-obsidian", version: "1.0.0" },
        },
      });
    });
  }

  private killChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return Promise.resolve();
    const exited = new Promise<boolean>((resolve) => {
      child.once("exit", () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
    child.kill("SIGTERM");
    return exited.then((ok) => {
      if (!ok && child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    });
  }

  private killActiveBuild(): void {
    const child = this.activeBuild;
    this.activeBuild = null;
    if (!child || child.exitCode !== null) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}
