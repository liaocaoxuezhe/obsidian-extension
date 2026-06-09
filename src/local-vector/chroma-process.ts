import { request } from "http";
import fs from "fs";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";

const LOG_PREFIX = "[Analogy][Chroma]";
const START_TIMEOUT_MS = 15_000;
const START_POLL_MS = 500;

interface ChromaProcessHooks {
  isHealthy?: () => Promise<boolean>;
  spawn?: typeof spawn;
  waitMs?: (ms: number) => Promise<void>;
}

export class ChromaProcessManager {
  private dbPath: string = "";
  private port: number = 8000;
  private lastError: string = "";
  private process: ChildProcessWithoutNullStreams | null = null;
  private hooks: ChromaProcessHooks;

  constructor(hooks: ChromaProcessHooks = {}) {
    this.hooks = hooks;
  }

  async start(dbPath: string, port: number = 8000): Promise<boolean> {
    this.dbPath = dbPath;
    this.port = port;

    if (await this.checkHealthy()) {
      this.lastError = "";
      return true;
    }

    try {
      fs.mkdirSync(dbPath, { recursive: true });
      this.process = this.startProcess(dbPath, port);
    } catch (err) {
      this.lastError = [
        `Failed to start ChromaDB on 127.0.0.1:${port}: ${(err as Error).message}`,
        "You can still start it manually:",
        this.getManualStartCommand(),
      ].join("\n");
      console.error(`${LOG_PREFIX} start failed`, { dbPath, port, error: (err as Error).message });
      return false;
    }

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await this.wait(START_POLL_MS);
      if (await this.checkHealthy()) {
        this.lastError = "";
        console.log(`${LOG_PREFIX} started`, { dbPath, port, pid: this.process?.pid });
        return true;
      }
    }

    this.lastError = [
      `ChromaDB did not become ready on 127.0.0.1:${port} after automatic start.`,
      "You can start it manually with:",
      this.getManualStartCommand(),
    ].join("\n");
    console.error(`${LOG_PREFIX} start timed out`, { dbPath, port });
    return false;
  }

  async stop(): Promise<void> {
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.process = null;
  }

  async isHealthy(): Promise<boolean> {
    if (await this.isEndpointHealthy("/api/v2/heartbeat")) return true;
    return this.isEndpointHealthy("/api/v1/heartbeat");
  }

  private async isEndpointHealthy(path: string): Promise<boolean> {
    return new Promise((resolve) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path,
          method: "GET",
          timeout: 1000,
        },
        (res) => {
          res.resume();
          resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300);
        },
      );

      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  private startProcess(dbPath: string, port: number): ChildProcessWithoutNullStreams {
    const spawnProcess = this.hooks.spawn || spawn;
    const command = [
      `PY_USER_BIN="$(python3 - <<'PY'\nimport site\nprint(site.USER_BASE + '/bin')\nPY\n)"`,
      'export PATH="$PY_USER_BIN:$HOME/.local/bin:$PATH"',
      "(command -v chroma >/dev/null 2>&1 || python3 -m pip install --user chromadb)",
      `chroma run --path ${JSON.stringify(dbPath)} --host 127.0.0.1 --port ${port}`,
    ].join(" && ");
    const child = spawnProcess("/bin/zsh", ["-lc", command], {
      cwd: dbPath,
      env: process.env,
    }) as ChildProcessWithoutNullStreams;

    child.stdout.on("data", (data) => {
      console.log(`${LOG_PREFIX} ${String(data).trim()}`);
    });
    child.stderr.on("data", (data) => {
      const message = String(data).trim();
      if (message) this.lastError = message;
      console.error(`${LOG_PREFIX} ${message}`);
    });
    child.on("error", (err) => {
      this.lastError = err.message;
      console.error(`${LOG_PREFIX} process error`, err);
    });
    child.on("exit", (code, signal) => {
      if (code !== null && code !== 0) {
        this.lastError = `ChromaDB exited with code ${code}`;
      }
      console.log(`${LOG_PREFIX} exited`, { code, signal });
    });

    return child;
  }

  private checkHealthy(): Promise<boolean> {
    return this.hooks.isHealthy ? this.hooks.isHealthy() : this.isHealthy();
  }

  private wait(ms: number): Promise<void> {
    return this.hooks.waitMs ? this.hooks.waitMs(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  }

  getLastError(): string {
    return this.lastError;
  }

  getManualStartCommand(): string {
    return `chroma run --path "${this.dbPath}" --host 127.0.0.1 --port ${this.port}`;
  }

  getPort(): number {
    return this.port;
  }

  getDbPath(): string {
    return this.dbPath;
  }
}
