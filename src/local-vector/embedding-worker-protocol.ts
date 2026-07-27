export type WorkerRequestType = "initialize" | "embed" | "dispose" | "health";
export type WorkerResponseType = "ok" | "error";

export interface WorkerInitializeRequest {
  id: string;
  type: "initialize";
  modelId: string;
  dtype: string;
  cacheDir: string;
  modelHost?: string;
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

export type WorkerResponse = WorkerOkResponse | WorkerErrorResponse;

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
  response: WorkerResponse | null,
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
