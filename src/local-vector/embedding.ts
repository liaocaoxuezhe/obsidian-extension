import * as http from "http";
import * as https from "https";

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
  dtype: string;
  localModelDir?: string;
  maxInputChars: number;
  /** Approximate parameter count, e.g. "33M". Shown in UI. */
  size: string;
  /** Short marketing description (English). */
  description: string;
  /** Short marketing description (Chinese). */
  descriptionZh: string;
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
  private embedder: any = null;
  private ready = false;
  private options: EmbeddingServiceOptions;
  private inferenceCount = 0;
  private activeOperations = 0;
  private idleResolvers: Array<() => void> = [];
  private resetPromise: Promise<void> | null = null;

  constructor(options: EmbeddingServiceOptions) {
    this.options = options;
  }

  private async loadPipeline(): Promise<any> {
    const { env, pipeline } = await loadTransformers(this.options.pluginDir);
    env.cacheDir = this.options.cacheDir;
    env.remoteHost = normalizeRemoteHost(this.options.remoteHost || DEFAULT_MODEL_HOST);
    env.allowLocalModels = true;
    env.allowRemoteModels = true;

    const modelConfig = this.options.modelConfig;

    return await pipeline("feature-extraction", modelConfig.id, {
      dtype: modelConfig.dtype,
    });
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

      this.embedder = await pipeline("feature-extraction", modelConfig.id, {
        dtype: modelConfig.dtype,
        progress_callback: (progressInfo: any) => {
          if (typeof progressInfo === "object" && progressInfo.status === "progress") {
            const pct = Math.round((progressInfo.loaded / progressInfo.total) * 100);
            onProgress?.(pct);
          }
        },
      });
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
            throw new Error(`Unexpected embedding output shape: [${output.dims}], expected [${batch.length}, dim]`);
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
    ensureEmbeddingRuntime(pluginDir);
    try {
      transformers = pluginRequire("@huggingface/transformers") as TransformersModule;
    } catch (retryErr) {
      const message = (retryErr as Error).message || String(retryErr);
      throw new Error(
        "Missing local RAG runtime dependency @huggingface/transformers. " +
          "Analogy tried to install the embedding runtime automatically. " +
          "If this keeps failing, run `npm run setup:local` in the plugin folder. " +
          `Original error: ${message}`
      );
    }
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

const EMBEDDING_RUNTIME_PACKAGE = {
  name: "analogy-rag-runtime",
  version: "1.0.8",
  private: true,
  scripts: {
    "setup:local": "npm install --omit=dev",
  },
  dependencies: {
    "@huggingface/transformers": "^4.2.0",
    "onnxruntime-node": "^1.26.0",
  },
};

interface RuntimeInstallHooks {
  canLoad?: (pluginDir: string) => boolean;
  install?: (pluginDir: string) => void;
}

export function ensureEmbeddingRuntime(pluginDir: string, hooks: RuntimeInstallHooks = {}): void {
  const canLoad = hooks.canLoad || canLoadEmbeddingRuntime;
  if (canLoad(pluginDir)) return;

  writeEmbeddingRuntimePackage(pluginDir);
  const install = hooks.install || installEmbeddingRuntimeDependencies;
  install(pluginDir);

  if (!canLoad(pluginDir)) {
    throw new Error("Embedding runtime install finished, but @huggingface/transformers still cannot be loaded.");
  }
}

function canLoadEmbeddingRuntime(pluginDir: string): boolean {
  const path = require("path");
  const Module = require("module");
  const pluginRequire = Module.createRequire(path.join(pluginDir, "main.js"));
  try {
    pluginRequire("@huggingface/transformers");
    return true;
  } catch {
    return false;
  }
}

function writeEmbeddingRuntimePackage(pluginDir: string): void {
  const fs = require("fs");
  const path = require("path");
  const packagePath = path.join(pluginDir, "package.json");
  let pkg = { ...EMBEDDING_RUNTIME_PACKAGE };

  if (fs.existsSync(packagePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      pkg = {
        ...existing,
        private: existing.private ?? true,
        scripts: {
          ...(existing.scripts || {}),
          "setup:local": existing.scripts?.["setup:local"] || "npm install --omit=dev",
        },
        dependencies: {
          ...(existing.dependencies || {}),
          ...EMBEDDING_RUNTIME_PACKAGE.dependencies,
        },
      };
    } catch {
      pkg = { ...EMBEDDING_RUNTIME_PACKAGE };
    }
  }

  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, "\t") + "\n", "utf8");
}

export function installEmbeddingRuntimeDependencies(pluginDir: string): void {
  const { spawnSync } = require("child_process");
  const result = spawnSync("/bin/zsh", ["-lc", "npm install --omit=dev"], {
    cwd: pluginDir,
    encoding: "utf8",
    stdio: "pipe",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const details = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    throw new Error(`npm install --omit=dev failed${details ? `: ${details}` : ""}`);
  }
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
    return "Embedding model failed to load: ONNX runtime backend failed to initialize. Run `npm run setup:local` in the plugin folder and reload Obsidian.";
  }

  if (/Missing local RAG runtime dependency|Cannot find module '@huggingface\/transformers'|Cannot find module 'onnxruntime-node'/i.test(message)) {
    return "Embedding model failed to load: local RAG runtime dependencies are missing or not installed. Analogy will try to install them automatically with `npm install --omit=dev`. If this keeps failing, check that npm is available and run `npm run setup:local` in the plugin folder, then reload Obsidian.";
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
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
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
