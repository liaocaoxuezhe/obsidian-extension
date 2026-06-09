import * as path from "path";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";

export interface EmbeddingModelConfig {
  id: string;
  shortName: string;
  queryPrefix: string;
  dtype: string;
  localModelDir?: string;
  maxInputChars: number;
}

export const EMBEDDING_MODELS: Record<string, EmbeddingModelConfig> = {
  "jina-nano": {
    id: "jinaai/jina-embeddings-v5-text-nano-retrieval",
    shortName: "jina-nano",
    queryPrefix: "Query: ",
    dtype: "q8",
    localModelDir: "models/jina-nano",
    maxInputChars: 8000,
  },
  "bge-small-zh": {
    id: "Xenova/bge-small-zh-v1.5",
    shortName: "bge-small-zh",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
    dtype: "q8",
    maxInputChars: 1500,
  },
};

type TransformersModule = typeof import("@huggingface/transformers");
// Use `any` for the pipeline instance — the Transformers.js union type is intentionally broad
type Pipeline = any;

const MAX_REDIRECTS = 5;

function fetchWithNode(url: string, redirectsLeft: number = MAX_REDIRECTS): Promise<Response> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: 120_000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects (>${MAX_REDIRECTS}) following: ${url}`));
          return;
        }
        fetchWithNode(res.headers.location, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve(new Response(body, {
          status: res.statusCode ?? 200,
          statusText: res.statusMessage ?? "OK",
          headers: res.headers as Record<string, string>,
        }));
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Download timed out")); });
  });
}

export class EmbeddingService {
  private pipeline: Pipeline | null = null;
  private modelConfig: EmbeddingModelConfig;
  private pluginDir: string;
  private remoteHost: string;

  constructor(opts: {
    pluginDir: string;
    remoteHost?: string;
    modelConfig: EmbeddingModelConfig;
  }) {
    this.pluginDir = opts.pluginDir;
    this.remoteHost = opts.remoteHost || "https://hf-mirror.com/";
    this.modelConfig = opts.modelConfig;
  }

  async initialize(): Promise<void> {
    const { env, pipeline } = (await import("@huggingface/transformers")) as TransformersModule;
    env.backends.onnx.logLevel = "error";
    (env as any).allowLocalModels = true;
    env.remoteHost = this.remoteHost;

    let modelSource: string = this.modelConfig.id;
    if (this.modelConfig.localModelDir) {
      const localDir = path.resolve(this.pluginDir, this.modelConfig.localModelDir);
      if (fs.existsSync(path.join(localDir, "config.json"))) {
        modelSource = localDir;
        (env as any).allowRemoteModels = false;
      }
    }

    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchWithNode as any;
    try {
      this.pipeline = await pipeline("feature-extraction", modelSource, {
        dtype: this.modelConfig.dtype as any,
        device: "cpu",
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  isReady(): boolean {
    return this.pipeline !== null;
  }

  get maxInputChars(): number {
    return this.modelConfig.maxInputChars;
  }

  get modelShortName(): string {
    return this.modelConfig.shortName;
  }

  async embedQuery(text: string): Promise<number[]> {
    const prefix = this.modelConfig.queryPrefix;
    const input = prefix ? prefix + text : text;
    return this.embed(input);
  }

  private async embed(text: string): Promise<number[]> {
    if (!this.pipeline) {
      throw new Error(
        "Embedding model not initialized. Call initialize() first, or check that the Analogy Obsidian plugin has finished loading the model."
      );
    }
    const truncated = text.slice(0, this.modelConfig.maxInputChars);
    const output = await this.pipeline(truncated, {
      pooling: "mean",
      normalize: true,
    });
    return Array.from(output.data as Float32Array);
  }
}
