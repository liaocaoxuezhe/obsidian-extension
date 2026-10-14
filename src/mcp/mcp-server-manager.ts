import { ChildProcess, spawn } from "child_process";

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

/** How to launch the bundled MCP server: the managed runtime's Node, the materialized entry, its env. */
export interface McpLaunch {
  nodeExecutable: string;
  entry: string;
  env: NodeJS.ProcessEnv;
}

export interface McpServerManagerOptions {
  /** Materializes the server bundled in main.js and resolves the managed runtime; throws when unavailable. */
  prepare(): Promise<McpLaunch>;
  readinessTimeoutMs?: number;
}

const READINESS_TIMEOUT_MS = 120 * 1000;
const MAX_LOG_LINES = 500;

interface PendingReply {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Runs the bundled MCP server inside Obsidian to prove it starts and can read the index.
 * MCP clients launch their own copy from the same materialized file; no npm or tsc is used.
 */
export class McpServerManager {
  private readonly prepareLaunch: () => Promise<McpLaunch>;
  private readonly readinessTimeoutMs: number;

  private child: ChildProcess | null = null;
  private pending = new Map<string, PendingReply>();
  private logs: string[] = [];
  private state: McpServiceState = { status: "stopped", message: "" };
  private listeners = new Set<() => void>();

  constructor(options: McpServerManagerOptions) {
    this.prepareLaunch = () => options.prepare();
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
      const launch = await this.prepareLaunch();
      if (this.getState().status !== "building") return;
      this.setState({ status: "starting", message: "Starting MCP server" });
      await this.spawnAndWaitReady(launch);
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

  private spawnAndWaitReady(launch: McpLaunch): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(launch.nodeExecutable, [launch.entry], {
        env: { ...process.env, ...launch.env },
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
}
