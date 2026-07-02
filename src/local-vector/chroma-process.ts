import { request } from "http";
import fs from "fs";
import path from "path";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";

const LOG_PREFIX = "[Analogy][Chroma]";
const START_TIMEOUT_MS = 120_000;
const START_POLL_MS = 500;
const CHROMADB_PIP_SPEC = "chromadb>=0.5.23,<0.6";
const MIN_CHROMA_VERSION = [0, 5, 23] as const;

interface ChromaProcessHooks {
  isHealthy?: () => Promise<boolean>;
  isCompatible?: () => Promise<boolean>;
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
      if (!(await this.checkCompatible())) {
        this.lastError = [
          `ChromaDB on 127.0.0.1:${port} is running but is older than ${this.formatVersion(MIN_CHROMA_VERSION)}.`,
          `Install a compatible version in the plugin virtualenv, or remove the old process on this port.`,
          "Then stop the old ChromaDB process and restart Obsidian.",
        ].join("\n");
        return false;
      }
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
      if ((await this.checkHealthy()) && (await this.checkCompatible())) {
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
    const venvDir = this.getVenvDir(dbPath);
    const command = [
      'PYTHON_BIN="$(command -v python3.9 || command -v /opt/homebrew/bin/python3.9 || command -v /usr/local/bin/python3.9 || command -v python3 || command -v python)"',
      `VENV_DIR=${JSON.stringify(venvDir)}`,
      '([ -x "$VENV_DIR/bin/python" ] || "$PYTHON_BIN" -m venv "$VENV_DIR")',
      `("$VENV_DIR/bin/python" -c 'import importlib.metadata as m, sys; v=tuple(int(p) for p in m.version("chromadb").split(".")[:3]); sys.exit(0 if v >= (0, 5, 23) else 1)' || "$VENV_DIR/bin/python" -m pip install ${JSON.stringify(CHROMADB_PIP_SPEC)})`,
      `"$VENV_DIR/bin/chroma" run --path ${JSON.stringify(dbPath)} --host 127.0.0.1 --port ${port}`,
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

  private checkCompatible(): Promise<boolean> {
    return this.hooks.isCompatible ? this.hooks.isCompatible() : this.isCompatible();
  }

  private async isCompatible(): Promise<boolean> {
    try {
      const version = await this.requestText("/api/v1/version");
      const parsed = this.parseVersion(version.replace(/^"|"$/g, ""));
      return this.compareVersions(parsed, MIN_CHROMA_VERSION) >= 0;
    } catch {
      return false;
    }
  }

  private requestText(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path,
          method: "GET",
          timeout: 1000,
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => {
            const statusCode = res.statusCode ?? 0;
            if (statusCode >= 200 && statusCode < 300) {
              resolve(body.trim());
            } else {
              reject(new Error(`HTTP ${statusCode}`));
            }
          });
        },
      );

      req.on("error", (err) => reject(err));
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
      req.end();
    });
  }

  private parseVersion(version: string): readonly [number, number, number] {
    const parts = version
      .split(".")
      .slice(0, 3)
      .map((part) => Number(part.replace(/\D+.*$/, "")) || 0);
    while (parts.length < 3) parts.push(0);
    return [parts[0], parts[1], parts[2]];
  }

  private compareVersions(left: readonly number[], right: readonly number[]): number {
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const diff = (left[i] || 0) - (right[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  private formatVersion(version: readonly number[]): string {
    return version.join(".");
  }

  private getVenvDir(dbPath: string): string {
    const pluginDir = path.dirname(path.dirname(dbPath));
    return path.join(pluginDir, "chroma-venv");
  }

  private wait(ms: number): Promise<void> {
    return this.hooks.waitMs ? this.hooks.waitMs(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  }

  getLastError(): string {
    return this.lastError;
  }

  getManualStartCommand(): string {
    const chromaBin = this.dbPath ? path.join(this.getVenvDir(this.dbPath), "bin", "chroma") : "chroma";
    return `"${chromaBin}" run --path "${this.dbPath}" --host 127.0.0.1 --port ${this.port}`;
  }

  getPort(): number {
    return this.port;
  }

  getDbPath(): string {
    return this.dbPath;
  }
}
