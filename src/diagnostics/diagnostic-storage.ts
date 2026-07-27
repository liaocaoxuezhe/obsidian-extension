import type { DiagnosticEvent, DiagnosticSessionMarker } from "./diagnostic-types";

export interface DiagnosticStorageOptions {
  pluginDir: string;
}

export class DiagnosticStorage {
  private readonly pluginDir: string;
  private readonly diagnosticsDir: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: DiagnosticStorageOptions) {
    this.pluginDir = options.pluginDir;
    this.diagnosticsDir = this.joinPath(options.pluginDir, "diagnostics");
  }

  private joinPath(...parts: string[]): string {
    return require("path").join(...parts);
  }

  private ensureDir(): void {
    try {
      const fs = require("fs");
      if (!fs.existsSync(this.diagnosticsDir)) {
        fs.mkdirSync(this.diagnosticsDir, { recursive: true });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[Analogy][Diagnostics] failed to create diagnostics dir", err);
    }
  }

  private path(name: string): string {
    return this.joinPath(this.diagnosticsDir, name);
  }

  async loadSessionMarker(): Promise<DiagnosticSessionMarker | null> {
    return this.readJson<DiagnosticSessionMarker>("session.json");
  }

  async saveSessionMarker(marker: DiagnosticSessionMarker): Promise<void> {
    await this.writeJson("session.json", marker);
  }

  async loadRingBuffer(): Promise<DiagnosticEvent[]> {
    const data = await this.readJson<{ events: DiagnosticEvent[] }>("ring-buffer.json");
    return Array.isArray(data?.events) ? data.events : [];
  }

  async saveRingBuffer(events: DiagnosticEvent[]): Promise<void> {
    await this.writeJson("ring-buffer.json", { events });
  }

  async clear(): Promise<void> {
    this.ensureDir();
    const fs = require("fs");
    try {
      fs.rmSync(this.diagnosticsDir, { recursive: true, force: true });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[Analogy][Diagnostics] failed to clear diagnostics dir", err);
    }
  }

  private async readJson<T>(name: string): Promise<T | null> {
    this.ensureDir();
    const fs = require("fs");
    const fullPath = this.path(name);
    try {
      if (!fs.existsSync(fullPath)) return null;
      const raw = fs.readFileSync(fullPath, { encoding: "utf-8" });
      return JSON.parse(raw) as T;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[Analogy][Diagnostics] failed to read ${name}`, err);
      return null;
    }
  }

  private async writeJson(name: string, data: unknown): Promise<void> {
    this.ensureDir();
    const fullPath = this.path(name);
    const tempPath = `${fullPath}.tmp`;
    const fs = require("fs");

    const task = this.writeQueue
      .catch(() => {})
      .then(async () => {
        try {
          const raw = JSON.stringify(data, null, 2);
          fs.writeFileSync(tempPath, raw, { encoding: "utf-8" });
          fs.renameSync(tempPath, fullPath);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[Analogy][Diagnostics] failed to write ${name}`, err);
          try {
            fs.unlinkSync(tempPath);
          } catch {
            // ignore cleanup failure
          }
        }
      });

    this.writeQueue = task;
    await task;
  }
}
