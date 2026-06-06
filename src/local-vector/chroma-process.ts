import { spawn, ChildProcess } from "child_process";
import { mkdirSync } from "fs";
import { request } from "http";

interface ChromaCommand {
  cmd: string;
  args: string[];
  cwd: string;
}

const LOG_PREFIX = "[Analogy][Chroma]";
const MAX_LOG_TEXT = 2000;

function compactLogText(text: string): string {
  const normalized = text.replace(/\s+\n/g, "\n").trim();
  if (normalized.length <= MAX_LOG_TEXT) return normalized;
  return `...${normalized.slice(-MAX_LOG_TEXT)}`;
}

export class ChromaProcessManager {
  private process: ChildProcess | null = null;
  private dbPath: string = "";
  private port: number = 8000;
  private lastError: string = "";

  async start(dbPath: string, port: number = 8000): Promise<boolean> {
    if (this.process && !this.process.killed) {
      return true;
    }

    this.dbPath = dbPath;
    this.port = port;
    mkdirSync(dbPath, { recursive: true });

    if (await this.isHealthy()) {
      return true;
    }

    const candidates = this.getStartCandidates(dbPath, port);

    for (const candidate of candidates) {
      const started = await this.spawnAndHealthCheck(candidate.cmd, candidate.args, candidate.cwd);
      if (started) {
        console.log(`${LOG_PREFIX} ready`, { cmd: candidate.cmd, port });
        return true;
      }
    }

    console.error(`${LOG_PREFIX} all start candidates failed`, {
      dbPath,
      port,
      lastError: compactLogText(this.lastError),
    });
    return false;
  }

  private getStartCandidates(dbPath: string, port: number): ChromaCommand[] {
    const logPath = `${dbPath}/chroma.log`;
    const chromaArgs = ["run", "--path", dbPath, "--host", "127.0.0.1", "--port", String(port), "--log-path", logPath];
    const pythonArgs = ["-m", "chromadb.cli.cli", "run", "--path", dbPath, "--host", "127.0.0.1", "--port", String(port), "--log-path", logPath];

    const candidates: ChromaCommand[] = [
      { cmd: "chroma", args: chromaArgs, cwd: dbPath },
      { cmd: "python3", args: pythonArgs, cwd: dbPath },
      { cmd: "python", args: pythonArgs, cwd: dbPath },
      { cmd: "/opt/homebrew/bin/chroma", args: chromaArgs, cwd: dbPath },
      { cmd: "/usr/local/bin/chroma", args: chromaArgs, cwd: dbPath },
    ];

    const seen = new Set<string>();
    return candidates.filter((candidate) => {
      const key = `${candidate.cmd} ${candidate.args.join(" ")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private spawnAndHealthCheck(cmd: string, args: string[], cwd: string): Promise<boolean> {
    return new Promise((resolve) => {
      let proc: ChildProcess;
      let resolved = false;
      let stdout = "";
      let stderr = "";

      try {
        proc = spawn(cmd, args, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
        });
      } catch (err) {
        this.lastError = `${cmd}: ${err instanceof Error ? err.message : String(err)}`;
        return resolve(false);
      }

      this.process = proc;

      proc.on("error", (err: any) => {
        if (!resolved) {
          resolved = true;
          this.lastError = `${cmd}: ${err.message}`;
          if (proc && !proc.killed) proc.kill("SIGTERM");
          this.process = null;
          resolve(false);
        }
      });

      proc.stdout?.on("data", (data) => {
        const message = data.toString().trim();
        stdout = `${stdout}\n${message}`.trim();
      });

      proc.stderr?.on("data", (data) => {
        const message = data.toString().trim();
        stderr = `${stderr}\n${message}`.trim();
      });

      proc.on("exit", (code) => {
        if (!resolved) {
          resolved = true;
          this.lastError = `${cmd} exited with code ${code}. ${compactLogText([stdout, stderr].filter(Boolean).join("\n"))}`;
          this.process = null;
          resolve(false);
        }
      });

      const checkHealth = async () => {
        if (resolved) return;
        const healthy = await this.isHealthy();
        if (healthy) {
          resolved = true;
          resolve(true);
        } else {
          setTimeout(checkHealth, 1000);
        }
      };
      setTimeout(checkHealth, 1500);

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          if (proc && !proc.killed) proc.kill("SIGTERM");
          this.lastError = `${cmd} did not become healthy within 30 seconds. ${compactLogText([stdout, stderr].filter(Boolean).join("\n"))}`;
          this.process = null;
          resolve(false);
        }
      }, 30000);
    });
  }

  async stop(): Promise<void> {
    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
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

  getLastError(): string {
    return this.lastError;
  }

  getPort(): number {
    return this.port;
  }

  getDbPath(): string {
    return this.dbPath;
  }
}
