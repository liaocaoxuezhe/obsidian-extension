import * as fs from "fs";
import * as path from "path";

export interface SafeModeState {
  enabled: boolean;
  consecutiveUncleanExits: number;
  lastUncleanStages: string[];
  workerExitCount: number;
  workerExitTimestamps: number[];
  reason?: string;
}

export interface SafeModeOptions {
  pluginDir: string;
}

const SAFE_MODE_FILENAME = "safe-mode.json";
const UNCLEAN_EXIT_THRESHOLD = 2;
const UNCLEAN_STAGE_WINDOW = 3;
const WORKER_EXIT_WINDOW_MS = 10 * 60 * 1000;

export class SafeModeManager {
  private readonly pluginDir: string;
  private state: SafeModeState;

  constructor(options: SafeModeOptions) {
    this.pluginDir = options.pluginDir;
    this.state = this.load();
  }

  private filePath(): string {
    return path.join(this.pluginDir, "diagnostics", SAFE_MODE_FILENAME);
  }

  private load(): SafeModeState {
    try {
      const fp = this.filePath();
      if (fs.existsSync(fp)) {
        const raw = fs.readFileSync(fp, { encoding: "utf-8" });
        const parsed = JSON.parse(raw);
        return {
          enabled: Boolean(parsed.enabled),
          consecutiveUncleanExits: Number(parsed.consecutiveUncleanExits) || 0,
          lastUncleanStages: Array.isArray(parsed.lastUncleanStages) ? parsed.lastUncleanStages : [],
          workerExitCount: Number(parsed.workerExitCount) || 0,
          workerExitTimestamps: Array.isArray(parsed.workerExitTimestamps)
            ? parsed.workerExitTimestamps.filter((value: unknown) => Number.isFinite(value))
            : [],
          reason: parsed.reason,
        };
      }
    } catch {
      // ignore corrupt file
    }
    return {
      enabled: false,
      consecutiveUncleanExits: 0,
      lastUncleanStages: [],
      workerExitCount: 0,
      workerExitTimestamps: [],
    };
  }

  private save(): void {
    try {
      const fp = this.filePath();
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, JSON.stringify(this.state, null, 2), { encoding: "utf-8" });
    } catch {
      // persistence failure must not block business logic
    }
  }

  isEnabled(): boolean {
    return this.state.enabled;
  }

  getState(): SafeModeState {
    return { ...this.state };
  }

  recordUncleanExit(lastStage: string): void {
    this.state.lastUncleanStages.push(lastStage);
    if (this.state.lastUncleanStages.length > UNCLEAN_STAGE_WINDOW) {
      this.state.lastUncleanStages.shift();
    }

    const embeddingStages = ["embedding.worker-start", "embedding.model-load", "embedding.inference"];
    const recentEmbeddingCount = this.state.lastUncleanStages.filter((s) => embeddingStages.includes(s)).length;
    if (recentEmbeddingCount >= UNCLEAN_EXIT_THRESHOLD) {
      this.state.consecutiveUncleanExits += 1;
    } else {
      this.state.consecutiveUncleanExits = 1;
    }

    if (this.state.consecutiveUncleanExits >= UNCLEAN_EXIT_THRESHOLD) {
      this.enterSafeMode(`Recent unclean exits in embedding stages: ${this.state.lastUncleanStages.join(", ")}`);
    }
    this.save();
  }

  recordWorkerExit(timestamp = Date.now()): void {
    const windowStart = timestamp - WORKER_EXIT_WINDOW_MS;
    this.state.workerExitTimestamps = this.state.workerExitTimestamps.filter(
      (exitTimestamp) => exitTimestamp >= windowStart && exitTimestamp <= timestamp,
    );
    this.state.workerExitTimestamps.push(timestamp);
    this.state.workerExitCount = this.state.workerExitTimestamps.length;
    if (this.state.workerExitCount >= 2) {
      this.enterSafeMode("Worker exited unexpectedly multiple times");
    }
    this.save();
  }

  enterSafeMode(reason: string): void {
    this.state.enabled = true;
    this.state.reason = reason;
    this.save();
  }

  clearSafeMode(): void {
    this.state.enabled = false;
    this.state.consecutiveUncleanExits = 0;
    this.state.lastUncleanStages = [];
    this.state.workerExitCount = 0;
    this.state.workerExitTimestamps = [];
    this.state.reason = undefined;
    this.save();
  }
}
