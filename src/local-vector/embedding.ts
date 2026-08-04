import * as http from "http";
import * as https from "https";
import type { EmbeddingInitializationProgress } from "./embedding-worker-protocol";
import type { ManagedEmbeddingRuntime } from "../runtime/embedding-runtime-manager";

const DEFAULT_MODEL_HOST = "https://hf-mirror.com/";
const EMBEDDING_TIMEOUT_MS = 300_000; // 5 min for large models (e.g. 239M jina-nano)
const MAX_EMBED_BATCH_SIZE = 4;
const MAX_EMBED_BATCH_CHARS = 1_800;

export interface EmbeddingModelConfig {
  id: string;
  shortName: string;
  displayName: string;
  queryPrefix: string;
  documentPrefix?: string;
  dtype: EmbeddingDType;
  localModelDir?: string;
  maxInputChars: number;
  /** Approximate parameter count, e.g. "33M". Shown in UI. */
  size: string;
  /** Short marketing description (English). */
  description: string;
  /** Short marketing description (Chinese). */
  descriptionZh: string;
}

type EmbeddingDType =
  | "auto"
  | "uint8"
  | "int8"
  | "fp32"
  | "fp16"
  | "q8"
  | "q4"
  | "bnb4"
  | "q4f16"
  | "q2"
  | "q2f16"
  | "q1"
  | "q1f16";

interface EmbeddingOutput {
  data: Float32Array | number[];
  dims: number[];
}

interface FeatureExtractionPipeline {
  (
    inputs: string | string[],
    options: { pooling: "mean"; normalize: true },
  ): Promise<EmbeddingOutput>;
}

export const EMBEDDING_MODELS: Record<string, EmbeddingModelConfig> = {
  "bge-small-en-v1.5": {
    id: "Xenova/bge-small-en-v1.5",
    shortName: "bge-small-en-v1.5",
    displayName: "BGE-small-en-v1.5 (33M) — Default",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
    dtype: "q8",
    maxInputChars: 1500,
    size: "33M",
    description:
      "Default. Small (33M), runs on almost any laptop. Strong English retrieval accuracy, mild support for Chinese — best balance of size and quality.",
    descriptionZh:
      "默认模型。体积小（33M），几乎所有电脑都能跑。英文检索精度强，对中文也有基础支持，体积与精度平衡最佳。",
  },
  "all-MiniLM-L6-v2": {
    id: "Xenova/all-MiniLM-L6-v2",
    shortName: "all-MiniLM-L6-v2",
    displayName: "all-MiniLM-L6-v2 (22M) — Fastest",
    queryPrefix: "",
    dtype: "q8",
    maxInputChars: 1500,
    size: "22M",
    description:
      "Smallest and fastest (22M). Great for low-end machines or quick experiments. English only; precision lower than BGE.",
    descriptionZh:
      "最小、最快的模型（22M）。适合配置较低的电脑或快速试验。仅支持英文，精度低于 BGE。",
  },
  "bge-small-zh": {
    id: "Xenova/bge-small-zh-v1.5",
    shortName: "bge-small-zh",
    displayName: "BGE-small-zh-v1.5 (33M) — Chinese",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
    dtype: "q8",
    maxInputChars: 1500,
    size: "33M",
    description:
      "Chinese-optimized small model (33M). Best choice when your vault is mostly Chinese.",
    descriptionZh:
      "中文优化的小型模型（33M）。当你的笔记主要是中文时，首选这个。",
  },
  "embedding-gemma-300m": {
    id: "onnx-community/embeddinggemma-300m-ONNX",
    shortName: "embedding-gemma-300m",
    displayName: "EmbeddingGemma-300M — Analogy-tuned",
    queryPrefix: "task: search result | query: ",
    dtype: "q8",
    maxInputChars: 4000,
    size: "300M",
    description:
      "Google's 300M open embedding model. Strongest for analogy / relational similarity. Needs a reasonably modern machine (200M+ params).",
    descriptionZh:
      "Google 开源的 300M 嵌入模型。在类比 / 关系相似度判断上最强。需要相对现代的机器（200M+ 参数）。",
  },
  "jina-nano": {
    id: "jinaai/jina-embeddings-v5-text-nano-retrieval",
    shortName: "jina-nano",
    displayName: "Jina Embeddings v5 Nano (239M) — STS Best",
    queryPrefix: "Query: ",
    documentPrefix: "Document: ",
    dtype: "q8",
    localModelDir: "models/jina-nano",
    maxInputChars: 8000,
    size: "239M",
    description:
      "Jina v5 Nano (239M). Top STS / semantic-textual-similarity scores in this lineup. Picks for users whose machine can run 200M+ models.",
    descriptionZh:
      "Jina v5 Nano（239M）。本列表中 STS / 语义相似度得分最高。适合能跑 200M+ 模型的用户。",
  },
};

export const DEFAULT_MODEL_KEY = "bge-small-en-v1.5";

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function sanitizeProgressFile(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const withoutQuery = value.trim().split(/[?#]/, 1)[0].replace(/\\/g, "/");
  const basename = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
  if (!basename || basename === "." || basename === "..") return null;
  try {
    return decodeURIComponent(basename);
  } catch {
    return basename;
  }
}

export function normalizeEmbeddingInitializationProgress(
  progressInfo: unknown,
): EmbeddingInitializationProgress | null {
  if (!progressInfo || typeof progressInfo !== "object") return null;
  const progress = progressInfo as Record<string, unknown>;
  const status = typeof progress.status === "string" ? progress.status.toLowerCase() : "";
  let phase: EmbeddingInitializationProgress["phase"];
  if (status === "ready") phase = "ready";
  else if (["progress", "download", "downloading", "initiate"].includes(status)) phase = "downloading";
  else if (["done", "loading", "loaded"].includes(status)) phase = "loading";
  else return null;

  const loadedBytes = finiteNonNegative(progress.loaded);
  const totalCandidate = finiteNonNegative(progress.total);
  const totalBytes = totalCandidate !== null && totalCandidate > 0 ? totalCandidate : null;
  let percent = finiteNonNegative(progress.progress);
  if (percent !== null && percent <= 1) percent *= 100;
  if (loadedBytes !== null && totalBytes !== null) percent = (loadedBytes / totalBytes) * 100;
  if (phase === "ready") percent = 100;
  if (percent !== null) percent = Math.max(0, Math.min(100, Math.round(percent * 100) / 100));

  return {
    phase,
    file: sanitizeProgressFile(progress.file),
    loadedBytes,
    totalBytes,
    percent,
  };
}

type TransformersModule = typeof import("@huggingface/transformers");

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isEmbeddingTimeout(err: unknown): boolean {
  return /timed out after/i.test((err as Error)?.message || String(err));
}

function isDisposedSessionError(err: unknown): boolean {
  return /Session already disposed/i.test((err as Error)?.message || String(err));
}

export interface EmbeddingServiceOptions {
  cacheDir: string;
  pluginDir: string;
  remoteHost?: string;
  modelConfig: EmbeddingModelConfig;
}

export class LocalEmbeddingService {
  private embedder: FeatureExtractionPipeline | null = null;
  private ready = false;
  private options: EmbeddingServiceOptions;
  private inferenceCount = 0;
  private activeOperations = 0;
  private idleResolvers: Array<() => void> = [];
  private resetPromise: Promise<void> | null = null;

  constructor(options: EmbeddingServiceOptions) {
    this.options = options;
  }

  private async loadPipeline(): Promise<FeatureExtractionPipeline> {
    const { env, pipeline } = await loadTransformers(this.options.pluginDir);
    env.cacheDir = this.options.cacheDir;
    env.remoteHost = normalizeRemoteHost(this.options.remoteHost || DEFAULT_MODEL_HOST);
    env.allowLocalModels = true;
    env.allowRemoteModels = true;

    const modelConfig = this.options.modelConfig;

    return await pipeline("feature-extraction", modelConfig.id, {
      dtype: modelConfig.dtype,
    }) as unknown as FeatureExtractionPipeline;
  }

  async initialize(onProgress?: (progress: number) => void): Promise<void> {
    if (this.ready) return;
    try {
      const { env, pipeline } = await loadTransformers(this.options.pluginDir);
      env.cacheDir = this.options.cacheDir;
      env.remoteHost = normalizeRemoteHost(this.options.remoteHost || DEFAULT_MODEL_HOST);

      env.allowLocalModels = true;
      env.allowRemoteModels = true;

      const modelConfig = this.options.modelConfig;

      this.embedder = await withTimeout(
        pipeline("feature-extraction", modelConfig.id, {
          dtype: modelConfig.dtype,
          progress_callback: (progressInfo: any) => {
            if (typeof progressInfo === "object" && progressInfo.status === "progress") {
              const pct = Math.round((progressInfo.loaded / progressInfo.total) * 100);
              onProgress?.(pct);
            }
          },
        }),
        EMBEDDING_TIMEOUT_MS,
        `Embedding model ${modelConfig.shortName} initialization`,
      ) as unknown as FeatureExtractionPipeline;
      this.ready = true;
      this.inferenceCount = 0;
      onProgress?.(100);
    } catch (err) {
      throw err;
    }
  }

  async resetSession(): Promise<void> {
    if (!this.ready) return;
    if (this.resetPromise) {
      await this.resetPromise;
      return;
    }
    this.resetPromise = (async () => {
      await this.waitForIdle();
      this.inferenceCount = 0;
    })();
    try {
      await this.resetPromise;
    } finally {
      if (this.resetPromise) {
        this.resetPromise = null;
      }
    }
  }

  getInferenceCount(): number {
    return this.inferenceCount;
  }

  isReady(): boolean {
    return this.ready;
  }

  getMaxInputChars(): number {
    return this.options.modelConfig.maxInputChars;
  }

  private truncate(text: string): string {
    const limit = this.options.modelConfig.maxInputChars;
    if (text.length <= limit) return text;
    return text.slice(0, limit);
  }

  private async runWithSession<T>(operation: () => Promise<T>): Promise<T> {
    while (this.resetPromise) {
      await this.resetPromise;
    }
    this.activeOperations++;
    try {
      return await operation();
    } finally {
      this.activeOperations--;
      if (this.activeOperations === 0) {
        for (const resolve of this.idleResolvers.splice(0)) {
          resolve();
        }
      }
    }
  }

  private waitForIdle(): Promise<void> {
    if (this.activeOperations === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  async embed(text: string): Promise<number[]> {
    return this.runWithSession(async () => {
      return this.embedWithCurrentSession(this.truncate(text), "Embedding inference");
    });
  }

  async embedQuery(text: string): Promise<number[]> {
    const prefix = this.options.modelConfig.queryPrefix;
    return this.embed(prefix ? prefix + text : text);
  }

  async embedDocument(text: string): Promise<number[]> {
    const prefix = this.options.modelConfig.documentPrefix;
    return this.embed(prefix ? prefix + text : text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return this.runWithSession(async () => {
      if (!this.embedder) throw new Error("Embedding model not initialized");
      if (texts.length === 0) return [];
      if (texts.length === 1) {
        return [
          await this.embedWithCurrentSession(
            this.truncate(this.formatDocumentInput(texts[0])),
            "Embedding inference"
          ),
        ];
      }

      const results: number[][] = [];
      try {
        for (let i = 0; i < texts.length;) {
          const batch: string[] = [];
          let batchChars = 0;

          while (i < texts.length && batch.length < MAX_EMBED_BATCH_SIZE) {
            const text = this.truncate(this.formatDocumentInput(texts[i]));
            const wouldExceedBudget =
              batch.length > 0 && batchChars + text.length > MAX_EMBED_BATCH_CHARS;
            if (wouldExceedBudget) break;
            batch.push(text);
            batchChars += text.length;
            i++;
          }

          if (batch.length === 0) {
            batch.push(this.truncate(this.formatDocumentInput(texts[i])));
            i++;
          }

          const output = await withTimeout(
            this.embedder(batch, { pooling: "mean", normalize: true }),
            EMBEDDING_TIMEOUT_MS,
            `Embedding batch inference (${batch.length} texts)`
          );
          this.inferenceCount++;
          if (output.dims.length !== 2 || output.dims[0] !== batch.length) {
            throw new Error(
              `Unexpected embedding output shape: [${output.dims.join(", ")}], expected [${batch.length}, dim]`,
            );
          }
          const dim = output.dims[1];
          for (let j = 0; j < batch.length; j++) {
            const start = j * dim;
            results.push(Array.from((output.data as Float32Array).slice(start, start + dim)));
          }
          if (i < texts.length) await new Promise((r) => setTimeout(r, 100));
        }
      } catch (err) {
        if (isEmbeddingTimeout(err) || isDisposedSessionError(err)) {
          throw err;
        }
        results.length = 0;
        for (const text of texts) {
          results.push(
            await this.embedWithCurrentSession(
              this.truncate(this.formatDocumentInput(text)),
              "Embedding inference"
            )
          );
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      return results;
    });
  }

  private async embedWithCurrentSession(input: string, label: string): Promise<number[]> {
    if (!this.embedder) {
      throw new Error("Embedding model not initialized");
    }
    const result = await withTimeout(
      this.embedder(input, { pooling: "mean", normalize: true }),
      EMBEDDING_TIMEOUT_MS,
      label
    );
    this.inferenceCount++;
    return Array.from(result.data as Float32Array);
  }

  private formatDocumentInput(text: string): string {
    const prefix = this.options.modelConfig.documentPrefix;
    return prefix ? prefix + text : text;
  }
}

async function loadTransformers(pluginDir: string): Promise<TransformersModule> {
  const path = require("path");
  const Module = require("module");

  const pluginRequire = Module.createRequire(path.join(pluginDir, "main.js"));
  let transformers: TransformersModule;
  try {
    transformers = pluginRequire("@huggingface/transformers") as TransformersModule;
  } catch (err) {
    const message = (err as Error).message || String(err);
    throw new Error(
      "Missing managed embedding runtime dependency @huggingface/transformers. " +
        "Open Analogy runtime onboarding to prepare or repair the managed runtime. " +
        `Original error: ${message}`,
    );
  }

  // The transformers library captures `globalThis.fetch` at module-load time
  // (DEFAULT_FETCH) and uses its own `env.fetch` for every model download.
  // Overriding `globalThis.fetch` later is too late — the library never re-reads
  // it. Replace `env.fetch` directly so http(s) downloads go through Node's
  // http/https modules instead of the original Electron `fetch`, which can fail
  // in Obsidian's runtime with `TypeError: Failed to fetch`.
  installNodeFetch(transformers);

  return transformers;
}

export function ensureEmbeddingRuntime(runtime: ManagedEmbeddingRuntime | null | undefined): void {
  if (runtime && typeof runtime === "object" && runtime.versions
    && runtime.versions.node === "22.23.2"
    && runtime.versions.transformers === "4.2.0"
    && runtime.versions.onnxruntime === "1.26.0") return;
  throw new Error(
    "The managed embedding runtime is not ready. Use Analogy runtime onboarding; automatic npm installation is disabled.",
  );
}

/**
 * Replace `transformers.env.fetch` with a Node-based implementation that uses
 * `http.request` / `https.request`. Non-http(s) URLs (e.g. file paths used by
 * `env.useFS` flows) fall back to the original fetch captured at load time.
 *
 * Exported for testability.
 */
export function installNodeFetch(transformers: TransformersModule): void {
  const env: any = (transformers as any).env;
  if (!env) return;
  // Avoid double-wrapping if this function is called more than once.
  if ((env as any).__nodeFetchInstalled) return;
  const originalFetch: (input: any, init?: RequestInit) => Promise<Response> = env.fetch;

  env.fetch = (input: any, init?: RequestInit): Promise<Response> => {
    const url: string =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input && (input as { url?: string }).url) || "";

    if (!/^https?:\/\//i.test(url)) {
      return originalFetch(input, init);
    }
    return fetchWithNode(url, init);
  };
  (env as any).__nodeFetchInstalled = true;
}

export function normalizeRemoteHost(remoteHost: string): string {
  const trimmed = remoteHost.trim();
  if (!trimmed) return DEFAULT_MODEL_HOST;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export function getEmbeddingErrorMessage(err: unknown): string {
  const error = err as Error & { cause?: { code?: string; message?: string } };
  const causeCode = error.cause?.code;
  const causeMessage = error.cause?.message;
  const message = error.message || String(err);

  if (
    causeCode === "UND_ERR_CONNECT_TIMEOUT" ||
    /fetch failed|timeout|ERR_CONTENT_LENGTH_MISMATCH/i.test(message)
  ) {
    return "Embedding model failed to load: model download failed. Check network or change the model host in settings.";
  }

  if (/Cannot read properties of undefined \(reading 'create'\)/i.test(message)) {
    return "Embedding model failed to load: the managed ONNX runtime backend failed to initialize. Repair the Analogy embedding runtime and retry.";
  }

  if (/Missing managed embedding runtime dependency|Cannot find module '@huggingface\/transformers'|Cannot find module 'onnxruntime-node'/i.test(message)) {
    return "Embedding model failed to load: managed runtime dependencies are missing or invalid. Open Analogy runtime onboarding to repair them.";
  }

  return `Embedding model failed to load: ${causeMessage || message}`;
}

function fetchWithNode(url: string, init?: RequestInit, redirects = 0): Promise<Response> {
  const parsedUrl = new URL(url);
  const client = parsedUrl.protocol === "http:" ? http : https;
  const headers = headersToRecord(init?.headers);
  const method = init?.method || "GET";

  return new Promise((resolve, reject) => {
    const request = client.request(parsedUrl, { method, headers }, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;

      if (location && [301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        if (redirects >= 5) {
          reject(new Error(`Too many redirects while downloading ${url}`));
          return;
        }
        const nextUrl = new URL(location, parsedUrl).toString();
        fetchWithNode(nextUrl, init, redirects + 1).then(resolve, reject);
        return;
      }

      const contentLength = response.headers["content-length"];
      const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      let lastLogBytes = 0;

      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        receivedBytes += chunk.length;
        // Log progress every ~10 MB for large files to help diagnose stalls
        if (totalBytes > 0 && receivedBytes - lastLogBytes > 10 * 1024 * 1024) {
          console.log(`[Analogy][Download] ${url.split("/").pop()} ${Math.round((receivedBytes / totalBytes) * 100)}% (${(receivedBytes / 1024 / 1024).toFixed(1)}MB / ${(totalBytes / 1024 / 1024).toFixed(1)}MB)`);
          lastLogBytes = receivedBytes;
        } else if (totalBytes === 0 && receivedBytes - lastLogBytes > 10 * 1024 * 1024) {
          console.log(`[Analogy][Download] ${url.split("/").pop()} ${(receivedBytes / 1024 / 1024).toFixed(1)}MB downloaded (unknown total)`);
          lastLogBytes = receivedBytes;
        }
      });
      response.on("error", reject);
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        // Ensure Content-Length is present in the synthetic Response so
        // @huggingface/transformers can pre-allocate buffers and avoid the
        // "Unable to determine content-length" warning.
        const syntheticHeaders = responseHeadersToRecord(response.headers);
        if (!syntheticHeaders["content-length"] && body.byteLength > 0) {
          syntheticHeaders["content-length"] = String(body.byteLength);
        }
        resolve(new Response(sliceArrayBuffer(body), {
          status,
          statusText: response.statusMessage,
          headers: syntheticHeaders,
        }));
      });
    });

    request.on("error", reject);
    // 300s timeout for large models (e.g. 239M jina-nano ONNX weights)
    request.setTimeout(300_000, () => {
      request.destroy(new Error(`Model download timed out: ${url}`));
    });

    if (typeof init?.body === "string" || init?.body instanceof ArrayBuffer) {
      request.write(init.body);
    }
    request.end();
  });
}

function sliceArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy.buffer;
}

function responseHeadersToRecord(headers: http.IncomingHttpHeaders): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      record[key] = value;
    } else if (Array.isArray(value)) {
      record[key] = value.join(", ");
    }
  }
  return record;
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return headers;
}
