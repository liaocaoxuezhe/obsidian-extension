import { v4 as uuidv4 } from "uuid";
import type {
  DiagnosticEvent,
  DiagnosticLevel,
  DiagnosticRecorderOptions,
  DiagnosticReport,
  DiagnosticSessionMarker,
  DiagnosticStage,
} from "./diagnostic-types";
import {
  createRedactor,
  generateReportSalt,
  redactDiagnosticReport,
} from "./diagnostic-redaction";
import { DiagnosticStorage } from "./diagnostic-storage";

const RING_CAPACITY = 200;
const PERSIST_CAPACITY = 50;
const PERSIST_DEBOUNCE_MS = 2000;
const MAX_MESSAGE_BYTES = 2048;
const MAX_STACK_BYTES = 16384;

export class DiagnosticRecorder {
  private readonly options: DiagnosticRecorderOptions;
  private readonly storage: DiagnosticStorage;
  private readonly redactor: ReturnType<typeof createRedactor>;
  private ring: DiagnosticEvent[] = [];
  private marker: DiagnosticSessionMarker;
  private previousMarker: DiagnosticSessionMarker | null = null;
  private persistTimer: number | null = null;
  private needsImmediatePersist = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private reporterId: string | null = null;

  constructor(options: DiagnosticRecorderOptions) {
    this.options = options;
    this.storage = new DiagnosticStorage({ pluginDir: options.pluginDir });
    this.redactor = createRedactor({ vaultPath: options.pluginDir });
    this.marker = this.createMarker();
  }

  async initialize(): Promise<void> {
    const previous = await this.storage.loadSessionMarker();
    if (previous) {
      this.previousMarker = previous;
    }
    const persistedEvents = await this.storage.loadRingBuffer();
    if (persistedEvents.length > 0) {
      this.ring = this.trimRing(persistedEvents);
    }
    this.reporterId = await this.loadReporterId();
    this.marker = this.createMarker();
    await this.storage.saveSessionMarker(this.marker);
  }

  private createMarker(): DiagnosticSessionMarker {
    return {
      schemaVersion: 1,
      sessionId: uuidv4(),
      pluginVersion: this.options.pluginVersion,
      buildId: this.options.buildId,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "running",
      lastStage: "plugin.onload",
      workerState: "not-started",
    };
  }

  private loadReporterId(): string | null {
    try {
      const fs = require("fs");
      const path = require("path");
      const reporterPath = path.join(this.options.pluginDir, "diagnostics", "reporter.json");
      if (fs.existsSync(reporterPath)) {
        const raw = fs.readFileSync(reporterPath, { encoding: "utf-8" });
        const parsed = JSON.parse(raw);
        return parsed.reporter_id || null;
      }
    } catch (err) {
      // ignore load failure
    }
    return null;
  }

  private async saveReporterId(id: string): Promise<void> {
    try {
      const fs = require("fs");
      const path = require("path");
      const reporterPath = path.join(this.options.pluginDir, "diagnostics", "reporter.json");
      fs.writeFileSync(reporterPath, JSON.stringify({ reporter_id: id }), { encoding: "utf-8" });
    } catch (err) {
      // ignore save failure
    }
  }

  getReporterId(): string {
    if (!this.reporterId) {
      this.reporterId = uuidv4();
      this.saveReporterId(this.reporterId).catch(() => {});
    }
    return this.reporterId;
  }

  resetReporterId(): void {
    this.reporterId = uuidv4();
    this.saveReporterId(this.reporterId).catch(() => {});
  }

  private trimRing(events: DiagnosticEvent[]): DiagnosticEvent[] {
    return this.trimEvents(
      events,
      this.options.maxRingEvents ?? RING_CAPACITY,
      this.options.maxSnapshotBytes ?? 256 * 1024,
    );
  }

  private trimEvents(
    events: DiagnosticEvent[],
    maxEvents: number,
    maxBytes: number
  ): DiagnosticEvent[] {
    const trimmed = events.slice();
    const protectedEvents = this.findProtectedEvents(events);
    const serializedBytes = () => new TextEncoder().encode(
      JSON.stringify({ events: trimmed }, null, 2),
    ).length;

    while (trimmed.length > maxEvents || serializedBytes() > maxBytes) {
      let removeIndex = trimmed.findIndex(
        (event) =>
          !protectedEvents.has(event) &&
          (event.level === "debug" || event.level === "info"),
      );
      if (removeIndex < 0) {
        removeIndex = trimmed.findIndex((event) => !protectedEvents.has(event));
      }
      if (removeIndex < 0) {
        if (trimmed.length <= 1) break;
        removeIndex = 0;
      }
      trimmed.splice(removeIndex, 1);
    }
    return trimmed;
  }

  private findProtectedEvents(events: DiagnosticEvent[]): Set<DiagnosticEvent> {
    const protectedEvents = new Set<DiagnosticEvent>();
    const protectLast = (predicate: (event: DiagnosticEvent) => boolean) => {
      for (let index = events.length - 1; index >= 0; index--) {
        if (predicate(events[index])) {
          protectedEvents.add(events[index]);
          return;
        }
      }
    };
    protectLast((event) => event.level === "error");
    protectLast((event) => event.code === "session.unclean_exit");
    protectLast((event) => event.code.includes("worker") && event.code.includes("exit"));
    return protectedEvents;
  }

  private getPersistedEvents(): DiagnosticEvent[] {
    return this.trimEvents(
      this.ring,
      this.options.maxPersistedEvents ?? PERSIST_CAPACITY,
      this.options.maxSnapshotBytes ?? 256 * 1024,
    );
  }

  private truncateMessage(message: string): string {
    const encoded = new TextEncoder().encode(message);
    if (encoded.length <= MAX_MESSAGE_BYTES) return message;
    // Decode truncated bytes safely.
    return new TextDecoder().decode(encoded.slice(0, MAX_MESSAGE_BYTES)) + "…";
  }

  private truncateStack(stack?: string): string | undefined {
    if (!stack) return undefined;
    const encoded = new TextEncoder().encode(stack);
    if (encoded.length <= MAX_STACK_BYTES) return stack;
    return new TextDecoder().decode(encoded.slice(0, MAX_STACK_BYTES)) + "\n…";
  }

  recordEvent(
    level: DiagnosticLevel,
    stage: DiagnosticStage,
    code: string,
    message: string,
    context?: Record<string, string | number | boolean | null>,
    error?: { name?: string; message?: string; stack?: string; causeCode?: string }
  ): void {
    const event: DiagnosticEvent = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      level,
      stage,
      code,
      message: this.truncateMessage(this.redactor.redactString(message)),
      context: this.redactor.redactContext(context),
      error: this.redactor.redactError(error),
    };

    // Don't include raw stack in persisted error if too large; already truncated.
    if (event.error?.stack) {
      event.error.stack = this.truncateStack(event.error.stack);
    }

    this.ring.push(event);
    this.ring = this.trimRing(this.ring);

    if (level === "error" || stage !== this.marker.lastStage || code.includes("worker.exit")) {
      this.needsImmediatePersist = true;
    }
    this.marker.lastStage = stage;
    if (code) {
      this.marker.lastEventCode = code;
    }
    this.marker.updatedAt = new Date().toISOString();
    this.schedulePersist();
  }

  info(
    stage: DiagnosticStage,
    code: string,
    message: string,
    context?: Record<string, string | number | boolean | null>
  ): void {
    this.recordEvent("info", stage, code, message, context);
  }

  warn(
    stage: DiagnosticStage,
    code: string,
    message: string,
    context?: Record<string, string | number | boolean | null>
  ): void {
    this.recordEvent("warn", stage, code, message, context);
  }

  error(
    stage: DiagnosticStage,
    code: string,
    message: string,
    context?: Record<string, string | number | boolean | null>
  ): void {
    this.recordEvent("error", stage, code, message, context);
  }

  debug(
    stage: DiagnosticStage,
    code: string,
    message: string,
    context?: Record<string, string | number | boolean | null>
  ): void {
    this.recordEvent("debug", stage, code, message, context);
  }

  captureException(
    stage: DiagnosticStage,
    code: string,
    error: unknown,
    context?: Record<string, string | number | boolean | null>
  ): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.recordEvent(
      "error",
      stage,
      code,
      err.message || String(error),
      context,
      {
        name: err.name,
        message: err.message,
        stack: err.stack,
      }
    );
  }

  setWorkerState(state: DiagnosticSessionMarker["workerState"]): void {
    this.marker.workerState = state;
    this.marker.updatedAt = new Date().toISOString();
    this.needsImmediatePersist = true;
    this.schedulePersist();
  }

  updateStage(stage: DiagnosticStage, code?: string): void {
    this.marker.lastStage = stage;
    if (code) this.marker.lastEventCode = code;
    this.marker.updatedAt = new Date().toISOString();
    this.needsImmediatePersist = true;
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (this.needsImmediatePersist) {
      if (this.persistTimer !== null) {
        window.clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      this.persist();
      this.needsImmediatePersist = false;
      return;
    }

    if (this.persistTimer !== null) return;
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persist(): Promise<void> {
    try {
      const persisted = this.getPersistedEvents();
      await this.storage.saveSessionMarker(this.marker);
      await this.storage.saveRingBuffer(persisted);
    } catch (err) {
      // Persistence must never block business logic.
      console.error("[Analogy][Diagnostics] persist failed", err);
    }
  }

  async flush(): Promise<void> {
    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persist();
  }

  async markCleanExit(): Promise<void> {
    this.marker.status = "clean-exit";
    this.marker.updatedAt = new Date().toISOString();
    await this.flush();
  }

  isSuspectedUncleanExit(): boolean {
    return this.previousMarker?.status === "running";
  }

  getPreviousMarker(): DiagnosticSessionMarker | null {
    return this.previousMarker;
  }

  getEvents(): DiagnosticEvent[] {
    return this.ring.slice();
  }

  getMarker(): DiagnosticSessionMarker {
    return { ...this.marker };
  }

  getSnapshot(): {
    marker: DiagnosticSessionMarker;
    previousMarker: DiagnosticSessionMarker | null;
    events: DiagnosticEvent[];
  } {
    return {
      marker: this.getMarker(),
      previousMarker: this.previousMarker,
      events: this.getEvents(),
    };
  }

  buildReport(options: {
    obsidianVersion: string;
    platform: string;
    arch: string;
    locale: string;
    model: string;
    transformersVersion: string;
    onnxruntimeVersion: string;
    chromaVersion: string;
    safeMode?: boolean;
    userNote?: string;
  }): DiagnosticReport {
    const report: DiagnosticReport = {
      schema_version: 1,
      report_id: uuidv4(),
      reporter_id: this.getReporterId(),
      created_at: new Date().toISOString(),
      plugin: {
        version: this.options.pluginVersion,
        build_id: this.options.buildId,
      },
      host: {
        obsidian_version: options.obsidianVersion,
        platform: options.platform,
        arch: options.arch,
        locale: options.locale,
      },
      runtime: {
        model: options.model,
        transformers_version: options.transformersVersion,
        onnxruntime_version: options.onnxruntimeVersion,
        chroma_version: options.chromaVersion,
      },
      session: {
        suspected_unclean_exit: this.isSuspectedUncleanExit(),
        last_stage: this.marker.lastStage,
        safe_mode: options.safeMode ?? false,
      },
      events: this.getEvents(),
      user_note: options.userNote || "",
    };
    return redactDiagnosticReport(report, {
      vaultPath: this.options.pluginDir,
      salt: generateReportSalt(),
    });
  }

  async clearDiagnostics(): Promise<void> {
    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.writeQueue.catch(() => {});
    this.ring = [];
    await this.storage.clear();
    this.reporterId = null;
  }
}
