import { request } from "http";

const LOG_PREFIX = "[Analogy][Chroma]";

export class ChromaProcessManager {
  private dbPath: string = "";
  private port: number = 8000;
  private lastError: string = "";

  async start(dbPath: string, port: number = 8000): Promise<boolean> {
    this.dbPath = dbPath;
    this.port = port;

    if (await this.isHealthy()) {
      this.lastError = "";
      return true;
    }

    this.lastError = [
      `ChromaDB is not running on 127.0.0.1:${port}.`,
      "Start it manually before enabling local search:",
      this.getManualStartCommand(),
    ].join("\n");
    console.error(`${LOG_PREFIX} service unavailable`, { dbPath, port });
    return false;
  }

  async stop(): Promise<void> {
    // The community-review runtime only connects to a user-managed ChromaDB service.
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
