import { createRequire } from "module";
import * as fs from "fs";
import * as path from "path";
import type { EmbeddingModelConfig } from "../../../mcp-server/src/embedding";

/**
 * Query embedding for the bundled MCP server. Transformers and ONNX Runtime come from the
 * plugin's verified managed runtime (ANALOGY_RUNTIME_MODULE_ROOT) and the model is loaded
 * offline from the plugin's verified model cache; nothing is downloaded or installed.
 */
export class OfflineQueryEmbedder {
  private extractor: ((input: string, options: { pooling: string; normalize: true }) => Promise<{ data: Float32Array }>) | null = null;

  constructor(
    private readonly model: EmbeddingModelConfig,
    private readonly moduleRoot: string,
    private readonly modelCacheDir: string,
  ) {}

  async initialize(): Promise<void> {
    if (!path.isAbsolute(this.moduleRoot) || !fs.existsSync(path.join(this.moduleRoot, "@huggingface", "transformers"))) {
      throw new Error("The Analogy managed runtime was not found. Open Obsidian so the plugin can install it, then rewrite the MCP configuration.");
    }
    if (!fs.existsSync(this.modelCacheDir)) {
      throw new Error(`The embedding model "${this.model.shortName}" is not downloaded yet. Open Obsidian and let the Analogy plugin finish setup.`);
    }
    const runtimeRequire = createRequire(path.join(this.moduleRoot, "package.json"));
    runtimeRequire(path.join(this.moduleRoot, "onnxruntime-node"));
    const transformers = runtimeRequire(path.join(this.moduleRoot, "@huggingface", "transformers"));
    transformers.env.allowRemoteModels = false;
    transformers.env.allowLocalModels = true;
    transformers.env.localModelPath = this.modelCacheDir;
    transformers.env.cacheDir = this.modelCacheDir;
    transformers.env.useFSCache = false;
    if (transformers.env.backends?.onnx) transformers.env.backends.onnx.logLevel = "error";
    this.extractor = await transformers.pipeline("feature-extraction", this.model.id, {
      dtype: this.model.dtype,
      cache_dir: this.modelCacheDir,
      local_files_only: true,
    });
  }

  async embedQuery(text: string): Promise<number[]> {
    if (!this.extractor) throw new Error("Embedding model not initialized.");
    const input = `${this.model.queryPrefix}${text}`.slice(0, this.model.maxInputChars);
    const output = await this.extractor(input, { pooling: this.model.pooling, normalize: true });
    return Array.from(output.data);
  }
}
