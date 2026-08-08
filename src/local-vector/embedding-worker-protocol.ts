export type WorkerRequestType = "initialize" | "embed" | "dispose" | "health";
export type WorkerResponseType = "ok" | "error";

export interface EmbeddingInitializationProgress {
  phase: "downloading" | "loading" | "ready";
  file: string | null;
  loadedBytes: number | null;
  totalBytes: number | null;
  percent: number | null;
}

export interface WorkerInitializeRequest {
  id: string;
  type: "initialize";
  modelId: string;
  dtype: string;
  pooling: "mean" | "cls" | "last_token";
  cacheDir: string;
  modelHost?: string;
  modelRevision?: string;
}

export interface WorkerEmbedRequest {
  id: string;
  type: "embed";
  texts: string[];
}

export interface WorkerDisposeRequest {
  id: string;
  type: "dispose";
}

export interface WorkerHealthRequest {
  id: string;
  type: "health";
}

export type WorkerRequest =
  | WorkerInitializeRequest
  | WorkerEmbedRequest
  | WorkerDisposeRequest
  | WorkerHealthRequest;

export interface WorkerOkResponse {
  id: string;
  ok: true;
  embeddings?: number[][];
  memoryUsage?: {
    rss: number;
    heapUsed: number;
    external: number;
  };
}

export interface WorkerErrorResponse {
  id: string;
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export interface WorkerProgressResponse {
  id: string;
  type: "progress";
  progress: EmbeddingInitializationProgress;
}

export type WorkerTerminalResponse = WorkerOkResponse | WorkerErrorResponse;
export type WorkerResponse = WorkerTerminalResponse | WorkerProgressResponse;

export function encodeMessage(msg: WorkerRequest | WorkerResponse): string {
  return JSON.stringify(msg) + "\n";
}

export function decodeMessage(line: string): WorkerRequest | WorkerResponse | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as WorkerRequest | WorkerResponse;
  } catch {
    return null;
  }
}

export function validateResponse(
  response: WorkerTerminalResponse | null,
  expectedId: string
): { ok: boolean; result?: number[][]; memory?: WorkerOkResponse["memoryUsage"]; error?: string } {
  if (!response) {
    return { ok: false, error: "Empty response from worker" };
  }
  if (response.id !== expectedId) {
    return { ok: false, error: `Response id mismatch: expected ${expectedId}, got ${response.id}` };
  }
  if (!response.ok) {
    return { ok: false, error: response.error?.message || "Worker error" };
  }
  return { ok: true, result: response.embeddings, memory: response.memoryUsage };
}

export function isWorkerProgressResponse(response: WorkerResponse): response is WorkerProgressResponse {
  return "type" in response && response.type === "progress";
}

export function sanitizeWorkerProgress(
  value: unknown,
): EmbeddingInitializationProgress | null {
  if (!value || typeof value !== "object") return null;
  const progress = value as Partial<EmbeddingInitializationProgress>;
  if (progress.phase !== "downloading" && progress.phase !== "loading" && progress.phase !== "ready") {
    return null;
  }
  const sanitizeNumber = (candidate: unknown): number | null => (
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
      ? candidate
      : null
  );
  let file: string | null = null;
  if (typeof progress.file === "string" && progress.file.trim()) {
    const withoutQuery = progress.file.trim().split(/[?#]/, 1)[0].replace(/\\/g, "/");
    const basename = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
    if (basename && basename !== "." && basename !== "..") file = basename;
  }
  const percent = sanitizeNumber(progress.percent);
  return {
    phase: progress.phase,
    file,
    loadedBytes: sanitizeNumber(progress.loadedBytes),
    totalBytes: sanitizeNumber(progress.totalBytes),
    percent: percent === null ? null : Math.max(0, Math.min(100, percent)),
  };
}

export function validateEmbeddings(
  embeddings: number[][] | undefined,
  expectedCount: number
): number[][] {
  if (!Array.isArray(embeddings)) {
    throw new Error("Worker returned no embeddings");
  }
  if (embeddings.length !== expectedCount) {
    throw new Error(
      `Worker returned ${embeddings.length} embeddings for ${expectedCount} texts`
    );
  }
  if (expectedCount === 0) {
    return embeddings;
  }
  const dimension = Array.isArray(embeddings[0]) ? embeddings[0].length : 0;
  if (dimension <= 0) {
    throw new Error("Worker returned an empty embedding dimension");
  }
  for (let rowIndex = 0; rowIndex < embeddings.length; rowIndex++) {
    const row = embeddings[rowIndex];
    if (!Array.isArray(row) || row.length !== dimension) {
      throw new Error(
        `Worker returned inconsistent embedding dimension at row ${rowIndex}`
      );
    }
    for (const value of row) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Worker returned a non-finite embedding value at row ${rowIndex}`);
      }
    }
  }
  return embeddings;
}
