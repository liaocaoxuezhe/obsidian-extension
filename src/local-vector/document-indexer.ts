import { TFile, Vault, EventRef, Notice, Workspace } from "obsidian";
import { EmbeddingService } from "./embedding-service";
import { LocalVectorStore } from "./vector-store";
import { isPathExcludedFromIndex, normalizeExcludedIndexPaths } from "./excluded-paths";
import { cleanMarkdown, splitByHeaders } from "./strip-markdown";

const MAX_CHUNK_CHARS = 900;
const MIN_SHORT_CHUNK_CHARS = 50;
const MAX_SECTION_CHARS = 2000;
const MAX_SENTENCES_PER_CHUNK_PASS = 24;
const BREAKPOINT_PERCENTILE = 90;
const QUEUE_CONCURRENCY = 1;
const PROGRESS_INTERVAL = 100;
const ONNX_RESET_INTERVAL = 300;
const MAX_FILE_SIZE = 15_000;
const MAX_FILE_BYTES = MAX_FILE_SIZE * 3;
const SEMANTIC_CHUNK_CHAR_LIMIT = 800;
const UPSERT_BATCH = 8;
const AUTO_INDEX_DELAY_MS = 3000;
const SAVE_THROTTLE_MS = 5000;
const STARTUP_SUPPRESS_MS_BASE = 10_000;
const STARTUP_SUPPRESS_MS_MAX = 120_000;
const MAX_PENDING_AUTO_INDEX = 50;

function normalizeDocumentPath(value: string): string {
  return value.replace(/\\/g, "/").normalize("NFC");
}

export interface IndexStateEntry {
  path?: string;
  mtime: number;
  chunkCount: number;
  muted?: boolean;
  skipped?: boolean;
  skipReason?: string;
}

export interface IndexState {
  [docId: string]: IndexStateEntry;
}

export interface IndexStateStore {
  load: () => Promise<IndexState | undefined>;
  save: (state: IndexState) => Promise<void>;
}

export interface FileIndexStatus {
  path: string;
  name: string;
  status: "indexed" | "outdated" | "unindexed";
  mtime: number;
  chunkCount: number;
  muted: boolean;
}

export interface RebuildProgress {
  current: number;
  total: number;
  currentFile: string;
}

export interface RebuildVerificationEvidence {
  expectedFileCount: number;
  selectedDocuments: Array<{ docId: string; path: string; mtime: number }>;
  indexState: IndexState;
  collectionDocuments: Array<{ docId: string; path: string; mtime: number; chunkCount: number }>;
  chunkCount: number;
  smokeResults: readonly unknown[];
}

export interface MigratedDocumentEvidence {
  docId: string;
  path: string;
  mtime: number;
  chunkCount: number;
  metadataComplete: boolean;
}

export type FileIndexErrorCategory =
  | "deleted"
  | "read"
  | "chunk"
  | "embedding"
  | "vector-store"
  | "unknown";

export interface FileIndexResult {
  path: string;
  status: "indexed" | "skipped" | "failed";
  chunkCount: number;
  errorCategory?: FileIndexErrorCategory;
}

export interface IndexFilesResult {
  requested: number;
  indexed: number;
  skipped: number;
  failed: number;
  chunkCount: number;
  cancelled: boolean;
  files: FileIndexResult[];
}

export interface IndexFilesOptions {
  signal?: AbortSignal;
  onProgress?: (progress: { current: number; total: number; currentFileName: string }) => void;
  isFileAvailable?: (file: TFile) => boolean;
}

interface QueueItem {
  file: TFile;
  resolve: (result: FileIndexResult) => void;
  reject: (err: Error) => void;
}

interface ChunkSentence {
  text: string;
  leadingSeparator: string;
}

interface ChunkDraft {
  content: string;
  sectionLabel: string;
}

function boundedIndexerError(code: "INDEXER_MAINTENANCE_FAILED", cause: unknown): Error {
  return Object.assign(new Error(code), { code, cause });
}

export class DocumentIndexer {
  private embedding: EmbeddingService;
  private vectorStore: LocalVectorStore;
  private vault: Vault;
  private workspace: Workspace | null;
  private stateStore: IndexStateStore;
  private indexState: IndexState = {};
  private excludedIndexPaths: string[] = [];
  private isIndexing = false;
  private modifyRef: EventRef | null = null;
  private deleteRef: EventRef | null = null;
  private createRef: EventRef | null = null;
  private renameRef: EventRef | null = null;
  private activeLeafRef: EventRef | null = null;

  private queue: QueueItem[] = [];
  private activeWorkers = 0;
  private queueProcessed = 0;
  private queueTotal = 0;
  private queueDrainPromise: Promise<void> | null = null;
  private autoIndexTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingActiveFiles = new Map<string, TFile>();
  private startupSuppressed = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveDirty = false;
  private savePromise: Promise<void> | null = null;
  private lastSaveTime = 0;
  private stopped = false;

  constructor(
    embedding: EmbeddingService,
    vectorStore: LocalVectorStore,
    vault: Vault,
    stateStore: IndexStateStore,
    excludedIndexPaths: string[] = [],
    workspace?: Workspace
  ) {
    this.embedding = embedding;
    this.vectorStore = vectorStore;
    this.vault = vault;
    this.workspace = workspace ?? null;
    this.stateStore = stateStore;
    this.excludedIndexPaths = normalizeExcludedIndexPaths(excludedIndexPaths);
  }

  async loadState(): Promise<void> {
    let needsSave = false;
    try {
      const raw = await this.stateStore.load();
      if (raw) {
        const newState: IndexState = {};
        for (const [key, entry] of Object.entries(raw)) {
          if (key.includes("::")) {
            const filePath = key.split("::")[0];
            const migratedEntry = { ...entry, path: entry.path ?? filePath };
            if (!newState[filePath] || newState[filePath].mtime < migratedEntry.mtime) {
              newState[filePath] = migratedEntry;
            }
            needsSave = true;
          } else {
            newState[key] = { ...entry, path: entry.path ?? key };
          }
        }
        this.indexState = newState;
      }
    } catch {
      this.indexState = {};
    }
    if (await this.recoverStateFromVectorStore()) {
      needsSave = true;
    }
    if (needsSave) {
      await this.saveState();
    }
  }

  async saveState(): Promise<void> {
    try {
      await this.stateStore.save(this.indexState);
    } catch {}
  }

  private throttledSaveState(): void {
    this.saveDirty = true;
    if (this.saveTimer) return;
    const elapsed = Date.now() - this.lastSaveTime;
    const delay = Math.max(0, SAVE_THROTTLE_MS - elapsed);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.lastSaveTime = Date.now();
      this.savePromise = (async () => {
        try {
          await this.saveState();
          this.saveDirty = false;
        } catch {}
        this.savePromise = null;
      })();
    }, delay);
  }

  async flushState(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.savePromise) {
      await this.savePromise;
    }
    if (this.saveDirty) {
      await this.saveState();
      this.saveDirty = false;
    }
  }

  flushStateSync(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.saveDirty) {
      this.saveState().catch(() => {});
      this.saveDirty = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.isIndexing = false;
    for (const timer of this.autoIndexTimers.values()) {
      clearTimeout(timer);
    }
    this.autoIndexTimers.clear();
    this.pendingActiveFiles.clear();
    for (const item of this.queue.splice(0)) {
      item.resolve({ path: item.file.path, status: "skipped", chunkCount: 0 });
    }
    while (this.activeWorkers > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  shutdown(): void {
    this.unwatchVault();
  }

  private async beginIndexing(queueTotal = 0): Promise<void> {
    this.stopped = false;
    this.isIndexing = true;
    const activeDrain = this.queueDrainPromise;
    if (activeDrain) {
      await activeDrain.catch(() => undefined);
    }
    this.queue = [];
    this.queueProcessed = 0;
    this.queueTotal = queueTotal;
  }

  buildDocId(file: TFile): string {
    return normalizeDocumentPath(file.path);
  }

  isExcluded(file: TFile): boolean {
    return isPathExcludedFromIndex(file.path, this.excludedIndexPaths);
  }

  async setExcludedIndexPaths(paths: string[]): Promise<void> {
    this.excludedIndexPaths = normalizeExcludedIndexPaths(paths);
    await this.removeExcludedDocuments();
  }

  private async removeExcludedDocuments(): Promise<number> {
    let removed = 0;
    for (const docId of Object.keys(this.indexState)) {
      if (isPathExcludedFromIndex(docId, this.excludedIndexPaths)) {
        try {
          await this.vectorStore.deleteDocument(docId);
        } catch {}
        delete this.indexState[docId];
        removed++;
      }
    }
    if (removed > 0) {
      await this.saveState();
    }
    return removed;
  }

  private buildLegacyDocId(file: TFile): string {
    return `${normalizeDocumentPath(file.path)}::${file.stat.ctime}`;
  }

  private markDocumentProcessed(file: TFile, chunkCount: number, skipReason?: string): void {
    const docId = this.buildDocId(file);
    const existing = this.indexState[docId];
    this.indexState[docId] = {
      path: normalizeDocumentPath(file.path),
      mtime: file.stat.mtime,
      chunkCount,
      muted: existing?.muted,
      skipped: Boolean(skipReason),
      skipReason,
    };
    this.throttledSaveState();
  }

  private async recoverStateFromVectorStore(): Promise<boolean> {
    let recovered = false;
    try {
      const entries = await this.vectorStore.listIndexedDocumentEntries();
      for (const entry of entries) {
        const existing = this.indexState[entry.docId];
        if (existing && existing.chunkCount > 0 && existing.mtime >= entry.mtime) {
          continue;
        }
        this.indexState[entry.docId] = {
          path: entry.path,
          mtime: entry.mtime,
          chunkCount: entry.chunkCount,
          muted: existing?.muted,
          skipped: false,
        };
        recovered = true;
      }
    } catch {}
    return recovered;
  }

  private splitIntoSentences(text: string): ChunkSentence[] {
    const sentences: ChunkSentence[] = [];
    const regex = /([\s\S]*?[。！？!?\.\n])(\s*)/g;
    let match: RegExpExecArray | null;
    let cursor = 0;
    let leadingSeparator = "";

    while ((match = regex.exec(text)) !== null) {
      let sentence = match[1];
      let separator = match[2] || "";
      const trailingWhitespace = sentence.match(/\s+$/)?.[0] || "";
      if (trailingWhitespace) {
        sentence = sentence.slice(0, -trailingWhitespace.length);
        separator = trailingWhitespace + separator;
      }
      const trimmed = sentence.trim();
      if (trimmed) {
        sentences.push({ text: trimmed, leadingSeparator });
      }
      leadingSeparator = separator;
      cursor = regex.lastIndex;
    }

    const tail = text.slice(cursor).trim();
    if (tail) {
      sentences.push({ text: tail, leadingSeparator });
    }

    return sentences;
  }

  private sentenceJoiner(separator: string): string {
    if (/\n\s*\n/.test(separator)) {
      return "\n\n";
    }
    if (/\n/.test(separator)) {
      return "\n";
    }
    return " ";
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  private percentile(values: number[], pct: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const idx = (pct / 100) * (sorted.length - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
  }

  private splitOversizedText(text: string, limit: number): string[] {
    if (text.length <= limit) return [text];

    const separators = [/\n#{1,3}\s/, /\n\n/, /\n/, /[。！？!?\.]\s*/];
    for (const sep of separators) {
      const mid = Math.floor(text.length / 2);
      const searchWindow = text.slice(Math.max(0, mid - 500), Math.min(text.length, mid + 500));
      const match = searchWindow.match(sep);
      if (match && match.index !== undefined) {
        const splitPos = Math.max(0, mid - 500) + match.index + match[0].length;
        const left = text.slice(0, splitPos).trim();
        const right = text.slice(splitPos).trim();
        if (left && right) {
          return [
            ...this.splitOversizedText(left, limit),
            ...this.splitOversizedText(right, limit),
          ];
        }
      }
    }

    const parts: string[] = [];
    for (let i = 0; i < text.length; i += limit) {
      const part = text.slice(i, i + limit).trim();
      if (part) parts.push(part);
    }
    return parts;
  }

  private mergeShortChunks(chunks: string[]): string[] {
    const merged: string[] = [];
    let pending = "";

    for (const chunk of chunks) {
      const text = chunk.trim();
      if (!text) continue;

      if (pending) {
        const combined = `${pending}\n${text}`.trim();
        if (combined.length <= MIN_SHORT_CHUNK_CHARS) {
          pending = combined;
        } else {
          merged.push(combined);
          pending = "";
        }
        continue;
      }

      if (text.length <= MIN_SHORT_CHUNK_CHARS) {
        pending = text;
      } else {
        merged.push(text);
      }
    }

    if (pending) {
      if (merged.length > 0) {
        merged[merged.length - 1] = `${merged[merged.length - 1]}\n${pending}`.trim();
      } else {
        merged.push(pending);
      }
    }

    return merged;
  }

  async splitIntoChunks(text: string): Promise<string[]> {
    if (text.length > SEMANTIC_CHUNK_CHAR_LIMIT) {
      return this.splitOversizedText(text, MAX_CHUNK_CHARS);
    }

    const sentences = this.splitIntoSentences(text);
    if (sentences.length <= 1) {
      return sentences.map((sentence) => sentence.text);
    }

    if (sentences.length > MAX_SENTENCES_PER_CHUNK_PASS) {
      return this.splitOversizedText(text, MAX_CHUNK_CHARS);
    }

    const sentenceTexts = sentences.map((sentence) => sentence.text);
    const embeddings = await this.embedding.embedBatch(sentenceTexts);

    const distances: number[] = [];
    for (let i = 0; i < embeddings.length - 1; i++) {
      const sim = this.cosineSimilarity(embeddings[i], embeddings[i + 1]);
      distances.push(1 - sim);
    }

    const threshold = this.percentile(distances, BREAKPOINT_PERCENTILE);

    const chunks: string[] = [];
    let current = sentences[0].text;
    for (let i = 0; i < distances.length; i++) {
      const next = sentences[i + 1];
      const joiner = this.sentenceJoiner(next.leadingSeparator);
      const nextText = next.text;
      if (distances[i] >= threshold || (current.length + joiner.length + nextText.length) > MAX_CHUNK_CHARS) {
        chunks.push(current.trim());
        current = nextText;
      } else {
        current += joiner + nextText;
      }
    }
    if (current.trim()) {
      chunks.push(current.trim());
    }
    return chunks;
  }

  async indexDocument(file: TFile): Promise<FileIndexResult> {
    const skipped = (errorCategory?: FileIndexErrorCategory): FileIndexResult => ({
      path: file.path,
      status: "skipped",
      chunkCount: 0,
      ...(errorCategory ? { errorCategory } : {}),
    });
    const failed = (errorCategory: FileIndexErrorCategory): FileIndexResult => ({
      path: file.path,
      status: "failed",
      chunkCount: 0,
      errorCategory,
    });
    if (this.stopped) return skipped();
    const docId = this.buildDocId(file);
    const existing = this.indexState[docId];
    if (this.isExcluded(file)) {
      if (existing) {
        await this.removeDocument(file);
      }
      return skipped();
    }
    if (existing && !this.isEntryOutdated(existing, file)) {
      return skipped();
    }

    if (file.stat.size > MAX_FILE_BYTES) {
      const reason = `large file bytes: ${file.stat.size} > ${MAX_FILE_BYTES}`;
      if (existing) {
        await this.vectorStore.deleteDocument(docId);
      }
      this.markDocumentProcessed(file, 0, reason);
      return skipped();
    }

    let chunkCount = 0;
    let stage: FileIndexErrorCategory = "read";
    try {
      const content = await this.vault.adapter.read(file.path);
      if (this.stopped) return skipped();
      if (content.length > MAX_FILE_SIZE) {
        const reason = `oversized content: ${content.length} > ${MAX_FILE_SIZE}`;
        if (existing) {
          await this.vectorStore.deleteDocument(docId);
        }
        this.markDocumentProcessed(file, 0, reason);
        return skipped();
      }

      stage = "chunk";
      const cleaned = cleanMarkdown(content);
      const sections = splitByHeaders(cleaned);
      if (sections.length === 0) {
        if (existing) {
          await this.vectorStore.deleteDocument(docId);
        }
        this.markDocumentProcessed(file, 0, "empty after markdown cleanup");
        return skipped();
      }

      const allChunks: ChunkDraft[] = [];
      for (const section of sections) {
        if (this.stopped) return skipped();
        const text = section.header
          ? `${section.header}\n${section.content}`
          : section.content;

        const subTexts = this.splitOversizedText(text, MAX_SECTION_CHARS);
        for (const sub of subTexts) {
          if (this.stopped) return skipped();
          const sectionChunks = await this.splitIntoChunks(sub);
          if (this.stopped) return skipped();
          allChunks.push(...this.mergeShortChunks(sectionChunks).map((content) => ({
            content,
            sectionLabel: section.header,
          })));
        }
      }
      if (allChunks.length === 0) {
        if (existing) {
          await this.vectorStore.deleteDocument(docId);
        }
        this.markDocumentProcessed(file, 0, "no chunks generated");
        return skipped();
      }
      const chunks = allChunks.filter((chunk) => chunk.content.length >= 10);
      if (chunks.length === 0) {
        if (existing) {
          await this.vectorStore.deleteDocument(docId);
        }
        this.markDocumentProcessed(file, 0, "chunks below minimum length");
        return skipped();
      }
      chunkCount = chunks.length;

      stage = "vector-store";
      if (existing) {
        await this.vectorStore.deleteDocument(docId);
      }
      const legacyDocId = this.buildLegacyDocId(file);
      if (legacyDocId !== docId) {
        try { await this.vectorStore.deleteDocument(legacyDocId); } catch {}
      }

      const metadata = {
        title: file.name,
        path: normalizeDocumentPath(file.path),
        mtime: file.stat.mtime,
      };

      for (let i = 0; i < chunks.length; i += UPSERT_BATCH) {
        if (this.stopped) return skipped();
        const batch = chunks.slice(i, i + UPSERT_BATCH);
        stage = "embedding";
        const embeddings = await this.embedding.embedBatch(batch.map((chunk) => chunk.content));
        if (this.stopped) return skipped();
        const chunkData = batch.map((chunk, j) => ({
          chunkId: `${docId}::chunk-${i + j}`,
          content: chunk.content,
          embedding: embeddings[j],
          chunkIndex: i + j,
          chunkCount: chunks.length,
          sectionLabel: chunk.sectionLabel,
        }));
        stage = "vector-store";
        await this.vectorStore.upsertDocument(docId, chunkData, metadata);
        if (i + UPSERT_BATCH < chunks.length) {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    } catch (err) {
      try {
        await this.embedding.resetSession();
      } catch {}
      const message = (err as Error)?.message || String(err);
      if (/Embedding .*timed out after/i.test(message)) {
        this.markDocumentProcessed(file, 0, `embedding timeout: ${message}`);
      }
      const code = (err as { code?: unknown })?.code;
      if (code === "ENOENT") return skipped("deleted");
      return failed(stage);
    }

    this.markDocumentProcessed(file, chunkCount);
    return { path: file.path, status: "indexed", chunkCount };
  }

  async removeDocument(file: TFile): Promise<void> {
    const docId = this.buildDocId(file);
    if (this.indexState[docId]) {
      await this.vectorStore.deleteDocument(docId);
      delete this.indexState[docId];
      this.throttledSaveState();
    }
  }

  async reindexDocument(file: TFile): Promise<void> {
    this.stopped = false;
    await this.removeDocument(file);
    await this.indexDocument(file);
  }

  async handleRename(file: TFile, oldPath: string): Promise<void> {
    const oldIsMarkdown = oldPath.toLowerCase().endsWith(".md");
    const newIsMarkdown = file.extension === "md";

    this.clearPendingFile(oldPath);
    this.clearPendingFile(file.path);

    if (oldIsMarkdown) {
      try {
        await this.vectorStore.deleteDocument(oldPath);
      } catch {}
    }

    const oldEntry = this.indexState[oldPath];
    if (oldEntry) {
      delete this.indexState[oldPath];
    }

    if (!newIsMarkdown || this.isExcluded(file)) {
      if (oldEntry) this.throttledSaveState();
      return;
    }

    if (oldEntry) {
      const docId = this.buildDocId(file);
      this.indexState[docId] = {
        ...oldEntry,
        path: oldEntry.path ?? oldPath,
      };
      this.throttledSaveState();
    } else {
      this.debouncedEnqueue(file);
    }
  }

  private enqueue(file: TFile, countTowardTotal = true): Promise<FileIndexResult> {
    if (this.stopped) {
      return Promise.resolve({ path: file.path, status: "skipped", chunkCount: 0 });
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ file, resolve, reject });
      if (countTowardTotal) this.queueTotal++;
      this.startQueueDrain();
    });
  }

  private startQueueDrain(): void {
    if (this.queueDrainPromise || this.stopped || this.queue.length === 0) return;
    const operation = this.drainQueue();
    let tracked!: Promise<void>;
    tracked = operation.finally(() => {
      if (this.queueDrainPromise === tracked) this.queueDrainPromise = null;
      if (!this.stopped && this.queue.length > 0) this.startQueueDrain();
    });
    this.queueDrainPromise = tracked;
    // Queue callers receive their own bounded result/rejection; this observer
    // prevents maintenance failures from becoming unhandled drain rejections.
    void tracked.catch(() => undefined);
  }

  private async drainQueue(): Promise<void> {
    if (this.activeWorkers >= QUEUE_CONCURRENCY) return;
    this.activeWorkers++;
    let maintenanceFailure: Error | null = null;
    let currentItem: QueueItem | null = null;

    try {
      while (!this.stopped && this.queue.length > 0) {
        currentItem = this.queue.shift()!;
        let result: FileIndexResult;
        try {
          result = await this.indexDocument(currentItem.file);
        } catch {
          result = {
            path: currentItem.file.path,
            status: "failed",
            chunkCount: 0,
            errorCategory: "unknown",
          };
        }
        this.markQueueItemProcessed();

        if (this.embedding.getInferenceCount() >= ONNX_RESET_INTERVAL) {
          await this.flushState();
          await this.embedding.resetSession();
          await new Promise((r) => setTimeout(r, 1000));
        } else {
          await new Promise((r) => setTimeout(r, 200));
        }
        currentItem.resolve(result);
        currentItem = null;
      }
    } catch (error) {
      maintenanceFailure = boundedIndexerError("INDEXER_MAINTENANCE_FAILED", error);
      currentItem?.reject(maintenanceFailure);
      currentItem = null;
      for (const pending of this.queue.splice(0)) {
        pending.reject(maintenanceFailure);
      }
    } finally {
      this.activeWorkers--;
    }
    if (maintenanceFailure) throw maintenanceFailure;
  }

  private markQueueItemProcessed(): void {
    this.queueProcessed++;
    if (this.queueProcessed % PROGRESS_INTERVAL === 0 || this.queueProcessed === this.queueTotal) {
      new Notice(
        `[Analogy] 索引进度: ${this.queueProcessed} / ${this.queueTotal}`,
        3000
      );
    }
  }

  async indexFiles(files: TFile[], options: IndexFilesOptions = {}): Promise<IndexFilesResult> {
    if (this.isIndexing) {
      throw Object.assign(new Error("INDEXER_BUSY"), { code: "INDEXER_BUSY" });
    }
    const snapshot = files.slice();
    const queueFiles = new Set<TFile>();
    const unavailableFiles = new Set<TFile>();
    for (const file of snapshot) {
      if (file.extension.toLowerCase() !== "md" || this.isExcluded(file)) continue;
      if (options.isFileAvailable && !options.isFileAvailable(file)) {
        unavailableFiles.add(file);
      } else {
        queueFiles.add(file);
      }
    }
    await this.beginIndexing(queueFiles.size);
    const outcomes: FileIndexResult[] = [];
    let cancelled = Boolean(options.signal?.aborted);

    try {
      for (const file of snapshot) {
        if (options.signal?.aborted) {
          cancelled = true;
          break;
        }
        let outcome: FileIndexResult;
        if (unavailableFiles.has(file)) {
          outcome = { path: file.path, status: "skipped", chunkCount: 0, errorCategory: "deleted" };
        } else if (!queueFiles.has(file)) {
          outcome = { path: file.path, status: "skipped", chunkCount: 0 };
        } else if (options.isFileAvailable && !options.isFileAvailable(file)) {
          outcome = { path: file.path, status: "skipped", chunkCount: 0, errorCategory: "deleted" };
          this.markQueueItemProcessed();
        } else {
          outcome = await this.enqueue(file, false);
        }
        outcomes.push(outcome);
        options.onProgress?.({
          current: outcomes.length,
          total: snapshot.length,
          currentFileName: file.name,
        });
        if (options.signal?.aborted) {
          cancelled = true;
          break;
        }
      }
      if (cancelled) {
        for (const file of snapshot.slice(outcomes.length)) {
          outcomes.push({ path: file.path, status: "skipped", chunkCount: 0 });
        }
      }
    } finally {
      try {
        try {
          await this.flushState();
        } catch (error) {
          throw boundedIndexerError("INDEXER_MAINTENANCE_FAILED", error);
        }
      } finally {
        this.isIndexing = false;
        this.queueProcessed = 0;
        this.queueTotal = 0;
      }
    }

    return {
      requested: snapshot.length,
      indexed: outcomes.filter((outcome) => outcome.status === "indexed").length,
      skipped: outcomes.filter((outcome) => outcome.status === "skipped").length,
      failed: outcomes.filter((outcome) => outcome.status === "failed").length,
      chunkCount: outcomes.reduce((sum, outcome) => sum + outcome.chunkCount, 0),
      cancelled,
      files: outcomes,
    };
  }

  async rebuildIndex(
    files: TFile[],
    options?: { force?: boolean; onProgress?: (progress: RebuildProgress) => void }
  ): Promise<void> {
    const mdFiles = files.filter((f) => f.extension === "md" && !this.isExcluded(f));
    await this.beginIndexing(mdFiles.length);

    try {
      const promises: Promise<void>[] = [];
      for (let i = 0; i < mdFiles.length; i++) {
        if (this.stopped) break;
        const file = mdFiles[i];
        if (options?.force) {
          const docId = this.buildDocId(file);
          if (this.indexState[docId]) {
            await this.vectorStore.deleteDocument(docId);
            delete this.indexState[docId];
          }
        }

        const p = (async () => {
          await this.enqueue(file, false);
          if (this.stopped) return;
          options?.onProgress?.({
            current: this.queueProcessed,
            total: mdFiles.length,
            currentFile: file.path,
          });
        })();
        promises.push(p);
      }

      await Promise.all(promises);
      if (!this.stopped) {
        await this.saveState();
      }
    } finally {
      this.isIndexing = false;
      this.queueProcessed = 0;
      this.queueTotal = 0;
    }
  }

  async rebuildIndexVerified(
    files: TFile[],
    options?: { force?: boolean; onProgress?: (progress: RebuildProgress) => void },
  ): Promise<RebuildVerificationEvidence> {
    const selectedDocuments = files
      .filter((file) => file.extension === "md" && !this.isExcluded(file))
      .map((file) => Object.freeze({
        docId: this.buildDocId(file),
        path: normalizeDocumentPath(file.path),
        mtime: file.stat.mtime,
      }));
    const existingDocuments = await this.vectorStore.listIndexedDocumentEntries();
    for (const document of existingDocuments) {
      await this.vectorStore.deleteDocument(document.docId);
    }
    this.indexState = {};
    await this.saveState();
    await this.rebuildIndex(files, options);
    return this.verifyCurrentGeneration(selectedDocuments);
  }

  async reconcileMigratedIndex(
    files: TFile[],
    migratedDocuments: readonly MigratedDocumentEvidence[],
    options: IndexFilesOptions = {},
  ): Promise<RebuildVerificationEvidence> {
    if (this.isIndexing) throw Object.assign(new Error("INDEXER_BUSY"), { code: "INDEXER_BUSY" });
    const selectedFiles = files.filter((file) => file.extension.toLowerCase() === "md" && !this.isExcluded(file));
    const selectedDocuments = selectedFiles.map((file) => ({
      docId: this.buildDocId(file),
      path: normalizeDocumentPath(file.path),
      mtime: file.stat.mtime,
    }));
    const selectedById = new Map(selectedDocuments.map((item, index) => [item.docId, {
      evidence: item,
      file: selectedFiles[index],
    }]));
    if (selectedById.size !== selectedDocuments.length) {
      throw Object.assign(new Error("CHROMA_MIGRATION_DOCUMENT_EVIDENCE_INVALID"), {
        code: "CHROMA_MIGRATION_DOCUMENT_EVIDENCE_INVALID",
      });
    }
    const migratedById = new Map<string, MigratedDocumentEvidence>();
    for (const raw of migratedDocuments) {
      const docId = normalizeDocumentPath(raw.docId);
      const itemPath = normalizeDocumentPath(raw.path);
      if (!docId || !itemPath || migratedById.has(docId)
        || !Number.isFinite(raw.mtime) || raw.mtime < 0
        || !Number.isSafeInteger(raw.chunkCount) || raw.chunkCount < 1
        || typeof raw.metadataComplete !== "boolean") {
        throw Object.assign(new Error("CHROMA_MIGRATION_DOCUMENT_EVIDENCE_INVALID"), {
          code: "CHROMA_MIGRATION_DOCUMENT_EVIDENCE_INVALID",
        });
      }
      migratedById.set(docId, { ...raw, docId, path: itemPath });
    }

    this.indexState = {};
    const reindex: TFile[] = [];
    for (const [docId, migrated] of migratedById) {
      if (!selectedById.has(docId)) {
        await this.vectorStore.deleteDocument(docId);
        continue;
      }
      const selected = selectedById.get(docId)!.evidence;
      if (migrated.path === selected.path && migrated.mtime === selected.mtime && migrated.metadataComplete) {
        this.indexState[docId] = {
          path: migrated.path,
          mtime: migrated.mtime,
          chunkCount: migrated.chunkCount,
          skipped: false,
        };
      } else {
        await this.vectorStore.deleteDocument(docId);
        reindex.push(selectedById.get(docId)!.file);
      }
    }
    for (const [docId, selected] of selectedById) {
      if (!migratedById.has(docId)) reindex.push(selected.file);
    }
    await this.saveState();
    const result = await this.indexFiles(reindex, options);
    if (result.cancelled) {
      throw Object.assign(new Error("LEGACY_MIGRATION_CANCELLED"), { code: "LEGACY_MIGRATION_CANCELLED" });
    }
    if (result.failed > 0) {
      throw Object.assign(new Error("CHROMA_MIGRATION_RECONCILIATION_FAILED"), {
        code: "CHROMA_MIGRATION_RECONCILIATION_FAILED",
      });
    }
    await this.flushState();
    return this.verifyCurrentGeneration(selectedDocuments);
  }

  /**
   * Adopts an exactly copied legacy collection without deleting or embedding any note.
   * Current Vault files absent from, or newer than, this state remain visible as pending
   * and are only processed when the user explicitly chooses Continue Index.
   */
  async adoptMigratedIndex(files: TFile[]): Promise<RebuildVerificationEvidence> {
    if (this.isIndexing) throw Object.assign(new Error("INDEXER_BUSY"), { code: "INDEXER_BUSY" });
    const collectionDocuments = await this.vectorStore.listIndexedDocumentEntries();
    const nextState: IndexState = {};
    for (const raw of collectionDocuments) {
      const docId = normalizeDocumentPath(raw.docId);
      const itemPath = normalizeDocumentPath(raw.path);
      if (!docId || !itemPath || nextState[docId]
        || !Number.isFinite(raw.mtime) || raw.mtime < 0
        || !Number.isSafeInteger(raw.chunkCount) || raw.chunkCount < 1) {
        throw Object.assign(new Error("CHROMA_MIGRATION_DOCUMENT_EVIDENCE_INVALID"), {
          code: "CHROMA_MIGRATION_DOCUMENT_EVIDENCE_INVALID",
        });
      }
      nextState[docId] = {
        path: itemPath,
        mtime: raw.mtime,
        chunkCount: raw.chunkCount,
        skipped: false,
      };
    }
    this.indexState = nextState;
    await this.saveState();

    // Evaluate now so callers can immediately report an accurate per-model backlog.
    // This is read-only: old metadata is still a valid embedding record and is not pending by itself.
    this.getAllFileStatuses(files);

    const chunkCount = await this.vectorStore.count();
    const expectedChunks = collectionDocuments.reduce((sum, item) => sum + item.chunkCount, 0);
    if (chunkCount !== expectedChunks) {
      throw Object.assign(new Error("CHROMA_REBUILD_CHUNK_COUNT_MISMATCH"), {
        code: "CHROMA_REBUILD_CHUNK_COUNT_MISMATCH",
      });
    }
    return {
      expectedFileCount: collectionDocuments.length,
      selectedDocuments: collectionDocuments.map(({ docId, path: itemPath, mtime }) => ({
        docId: normalizeDocumentPath(docId),
        path: normalizeDocumentPath(itemPath),
        mtime,
      })),
      indexState: JSON.parse(JSON.stringify(this.indexState)) as IndexState,
      collectionDocuments: collectionDocuments.map((item) => ({
        ...item,
        docId: normalizeDocumentPath(item.docId),
        path: normalizeDocumentPath(item.path),
      })),
      chunkCount,
      smokeResults: [],
    };
  }

  async verifyCurrentGeneration(
    selection: number | readonly { docId: string; path: string; mtime: number }[],
  ): Promise<RebuildVerificationEvidence> {
    const selectedDocuments = typeof selection === "number"
      ? Object.entries(this.indexState).slice(0, selection).map(([docId, entry]) => ({
        docId,
        path: entry.path ?? docId,
        mtime: entry.mtime,
      }))
      : selection.map((item) => ({
        ...item,
        docId: normalizeDocumentPath(item.docId),
        path: normalizeDocumentPath(item.path),
      }));
    const collectionDocuments = await this.vectorStore.listIndexedDocumentEntries();
    const chunkCount = await this.vectorStore.count();
    const smokeResults = await this.runSmokeQuery("Analogy 固定重建验证查询");
    return {
      expectedFileCount: selectedDocuments.length,
      selectedDocuments,
      indexState: JSON.parse(JSON.stringify(this.indexState)) as IndexState,
      collectionDocuments,
      chunkCount,
      smokeResults,
    };
  }

  async runSmokeQuery(query: string): Promise<readonly unknown[]> {
    const queryEmbedding = await this.embedding.embedQuery(query);
    return this.vectorStore.search(queryEmbedding, 1);
  }

  async clearState(): Promise<void> {
    this.indexState = {};
    await this.saveState();
  }

  async getIndexedStatus(file: TFile): Promise<"indexed" | "pending" | "unindexed"> {
    if (this.isExcluded(file)) return "unindexed";
    const docId = this.buildDocId(file);
    const existing = this.indexState[docId];
    if (!existing) return "unindexed";
    if (this.isEntryOutdated(existing, file)) return "pending";
    return "indexed";
  }

  private isEntryOutdated(entry: IndexStateEntry, file: TFile): boolean {
    return entry.mtime < file.stat.mtime
      || (entry.path !== undefined && entry.path !== file.path);
  }

  private clearPendingFile(filePath: string): void {
    const timer = this.autoIndexTimers.get(filePath);
    if (timer) {
      clearTimeout(timer);
      this.autoIndexTimers.delete(filePath);
    }
    this.pendingActiveFiles.delete(filePath);
  }

  private debouncedEnqueue(file: TFile): void {
    if (this.startupSuppressed) return;
    if (this.autoIndexTimers.size >= MAX_PENDING_AUTO_INDEX) return;
    const existing = this.autoIndexTimers.get(file.path);
    if (existing) clearTimeout(existing);
    if (this.isCurrentActiveFile(file)) {
      this.pendingActiveFiles.set(file.path, file);
      return;
    }
    const timer = setTimeout(() => {
      this.autoIndexTimers.delete(file.path);
      if (this.isCurrentActiveFile(file)) {
        this.pendingActiveFiles.set(file.path, file);
        return;
      }
      if (!this.isIndexing) {
        this.enqueue(file).catch(() => {});
      }
    }, AUTO_INDEX_DELAY_MS);
    this.autoIndexTimers.set(file.path, timer);
  }

  private isCurrentActiveFile(file: TFile): boolean {
    const activeFile = this.workspace?.getActiveFile();
    return activeFile?.path === file.path;
  }

  private enqueueInactivePendingFiles(): void {
    for (const [filePath, file] of this.pendingActiveFiles) {
      if (this.isCurrentActiveFile(file)) continue;
      this.pendingActiveFiles.delete(filePath);
      this.debouncedEnqueue(file);
    }
  }

  watchVault(): void {
    this.startupSuppressed = true;
    const fileCount = this.vault.getFiles().length;
    const suppressMs = Math.min(
      STARTUP_SUPPRESS_MS_BASE + Math.floor(fileCount / 500) * 1000,
      STARTUP_SUPPRESS_MS_MAX
    );
    setTimeout(() => { this.startupSuppressed = false; }, suppressMs);

    this.modifyRef = this.vault.on("modify", (file) => {
      if (file instanceof TFile && file.extension === "md") {
        this.debouncedEnqueue(file);
      }
    });

    this.deleteRef = this.vault.on("delete", async (file) => {
      if (file instanceof TFile && file.extension === "md") {
        this.clearPendingFile(file.path);
        try {
          await this.removeDocument(file);
        } catch {}
      }
    });

    this.createRef = this.vault.on("create", (file) => {
      if (file instanceof TFile && file.extension === "md") {
        this.debouncedEnqueue(file);
      }
    });

    this.renameRef = this.vault.on("rename", async (file, oldPath) => {
      if (file instanceof TFile) {
        try {
          await this.handleRename(file, oldPath);
        } catch {}
      }
    });

    if (this.workspace) {
      this.activeLeafRef = this.workspace.on("active-leaf-change", () => {
        this.enqueueInactivePendingFiles();
      });
    }
  }

  unwatchVault(): void {
    if (this.modifyRef) {
      this.vault.offref(this.modifyRef);
      this.modifyRef = null;
    }
    if (this.deleteRef) {
      this.vault.offref(this.deleteRef);
      this.deleteRef = null;
    }
    if (this.createRef) {
      this.vault.offref(this.createRef);
      this.createRef = null;
    }
    if (this.renameRef) {
      this.vault.offref(this.renameRef);
      this.renameRef = null;
    }
    if (this.activeLeafRef && this.workspace) {
      this.workspace.offref(this.activeLeafRef);
      this.activeLeafRef = null;
    }
    for (const timer of this.autoIndexTimers.values()) {
      clearTimeout(timer);
    }
    this.autoIndexTimers.clear();
    this.pendingActiveFiles.clear();
  }

  async continueIndex(
    files: TFile[],
    options?: { onProgress?: (progress: RebuildProgress) => void }
  ): Promise<void> {
    const pending = files.filter((f) => {
      if (f.extension !== "md" || this.isExcluded(f)) return false;
      const docId = this.buildDocId(f);
      const entry = this.indexState[docId];
      return !entry || this.isEntryOutdated(entry, f);
    });
    await this.beginIndexing(pending.length);

    try {
      const promises: Promise<void>[] = [];
      for (const file of pending) {
        if (this.stopped) break;
        const p = (async () => {
          await this.enqueue(file, false);
          if (this.stopped) return;
          options?.onProgress?.({
            current: this.queueProcessed,
            total: pending.length,
            currentFile: file.path,
          });
        })();
        promises.push(p);
      }
      await Promise.all(promises);
      if (!this.stopped) {
        await this.saveState();
      }
    } finally {
      this.isIndexing = false;
      this.queueProcessed = 0;
      this.queueTotal = 0;
    }
  }

  getAllFileStatuses(files: TFile[]): FileIndexStatus[] {
    const mdFiles = files.filter((f) => f.extension === "md" && !this.isExcluded(f));
    return mdFiles.map((file) => {
        const docId = this.buildDocId(file);
        const entry = this.indexState[docId];
        let status: FileIndexStatus["status"];
        if (!entry) {
          status = "unindexed";
        } else if (this.isEntryOutdated(entry, file)) {
          status = "outdated";
        } else {
          status = "indexed";
        }
        return {
          path: file.path,
          name: file.name,
          status,
          mtime: file.stat.mtime,
          chunkCount: entry?.chunkCount ?? 0,
          muted: entry?.muted ?? false,
        };
      });
  }

  async setMuted(filePath: string, muted: boolean): Promise<void> {
    const entry = this.indexState[filePath];
    if (!entry) return;
    entry.muted = muted;
    await this.saveState();
  }

  getMutedPaths(): Set<string> {
    const paths = new Set<string>();
    for (const [docId, entry] of Object.entries(this.indexState)) {
      if (entry.muted) paths.add(docId);
    }
    return paths;
  }

  getIsIndexing(): boolean {
    return this.isIndexing;
  }

  getQuickStats(): { indexed: number; stateEntries: number } {
    return {
      indexed: Object.keys(this.indexState).length,
      stateEntries: Object.keys(this.indexState).length,
    };
  }
}
