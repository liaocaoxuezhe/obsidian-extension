import {
  decodeMessage,
  encodeMessage,
  type WorkerEmbedRequest,
  type WorkerDisposeRequest,
  type WorkerHealthRequest,
  type WorkerInitializeRequest,
  type WorkerRequest,
  type WorkerResponse,
} from "./embedding-worker-protocol";

interface ExtractorLike {
  (
    texts: string[],
    options?: { pooling?: string; normalize?: boolean }
  ): Promise<{ data: Float32Array | number[]; dims?: number[] }>;
}

let extractor: ExtractorLike | null = null;
let currentModelId = "";

function logError(message: string, err?: unknown): void {
  // Keep stderr minimal and never include input text.
  console.error(`[AnalogyWorker] ${message}`, err instanceof Error ? err.message : "");
}

async function handleInitialize(req: WorkerInitializeRequest): Promise<WorkerResponse> {
  try {
    const transformers = require("@huggingface/transformers");
    if (req.modelHost) {
      transformers.env.remoteHost = req.modelHost;
      transformers.env.remotePathTemplate = "{model}/resolve/{revision}/";
    }
    transformers.env.cacheDir = req.cacheDir;
    extractor = await transformers.pipeline("feature-extraction", req.modelId, {
      dtype: req.dtype || "q8",
      cache_dir: req.cacheDir,
    });
    currentModelId = req.modelId;
    return { id: req.id, ok: true };
  } catch (err) {
    logError("initialize failed", err);
    return {
      id: req.id,
      ok: false,
      error: { code: "WORKER_INIT_FAILED", message: (err as Error).message },
    };
  }
}

async function handleEmbed(req: WorkerEmbedRequest): Promise<WorkerResponse> {
  if (!extractor) {
    return {
      id: req.id,
      ok: false,
      error: { code: "WORKER_NOT_INITIALIZED", message: "Worker not initialized" },
    };
  }
  try {
    const output = await extractor(req.texts, { pooling: "mean", normalize: true });
    const dims = output.dims ?? [req.texts.length, output.data.length / req.texts.length];
    const [batch, dim] = dims;
    const embeddings: number[][] = [];
    for (let i = 0; i < batch; i++) {
      const row: number[] = [];
      for (let j = 0; j < dim; j++) {
        row.push((output.data as Float32Array)[i * dim + j]);
      }
      embeddings.push(row);
    }
    return { id: req.id, ok: true, embeddings, memoryUsage: getMemoryUsage() };
  } catch (err) {
    logError("embed failed", err);
    return {
      id: req.id,
      ok: false,
      error: { code: "WORKER_EMBED_FAILED", message: (err as Error).message },
    };
  }
}

async function handleDispose(req: WorkerDisposeRequest): Promise<WorkerResponse> {
  try {
    if (extractor && typeof (extractor as any).dispose === "function") {
      await (extractor as any).dispose();
    }
  } catch (err) {
    logError("dispose failed", err);
  }
  extractor = null;
  currentModelId = "";
  return { id: req.id, ok: true };
}

function handleHealth(req: WorkerHealthRequest): WorkerResponse {
  return { id: req.id, ok: true, memoryUsage: getMemoryUsage() };
}

function getMemoryUsage() {
  const mu = process.memoryUsage();
  return {
    rss: Math.round(mu.rss / 1024 / 1024),
    heapUsed: Math.round(mu.heapUsed / 1024 / 1024),
    external: Math.round(mu.external / 1024 / 1024),
  };
}

async function handleRequest(req: WorkerRequest): Promise<WorkerResponse> {
  switch (req.type) {
    case "initialize":
      return handleInitialize(req);
    case "embed":
      return handleEmbed(req);
    case "dispose":
      return handleDispose(req);
    case "health":
      return handleHealth(req);
    default:
      return {
        id: (req as any).id || "unknown",
        ok: false,
        error: { code: "WORKER_UNKNOWN_TYPE", message: "Unknown request type" },
      };
  }
}

let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", async (chunk: string) => {
  buffer += chunk;
  let lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    const req = decodeMessage(line);
    if (!req) continue;
    const response = await handleRequest(req as WorkerRequest);
    process.stdout.write(encodeMessage(response));
  }
});

process.stdin.on("end", () => {
  if (buffer.trim()) {
    const req = decodeMessage(buffer);
    if (req) {
      handleRequest(req as WorkerRequest).then((response) => {
        process.stdout.write(encodeMessage(response));
        process.exit(0);
      });
      return;
    }
  }
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  logError("uncaughtException", err);
  process.exit(1);
});
