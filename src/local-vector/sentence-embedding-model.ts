import * as fs from "fs";
import * as path from "path";

/**
 * Loader for ONNX exports that compute their own pooled `sentence_embedding`
 * (EmbeddingGemma 2). The managed Transformers.js 4.2.0 does not know these
 * architectures, so only the tokenizer comes from Transformers and the text graph
 * runs directly on ONNX Runtime. Multimodal feature inputs get empty tensors, so
 * the vision and audio encoders are never downloaded or loaded.
 */

const GRAPH_FILE_BY_DTYPE: Record<string, string> = {
  fp32: "model.onnx",
  fp16: "model_fp16.onnx",
  q8: "model_quantized.onnx",
  q4: "model_q4.onnx",
};

interface TokenizerTensor {
  data: ArrayLike<bigint | number>;
  dims: number[];
}

interface TokenizerLike {
  (texts: string[], options: { padding: true; truncation: true }): {
    input_ids: TokenizerTensor;
    attention_mask: TokenizerTensor;
  };
}

interface TransformersLike {
  AutoTokenizer: { from_pretrained(id: string, options: { local_files_only: true }): Promise<TokenizerLike> };
}

interface OrtTensorLike {
  data: Float32Array;
  dims: readonly number[];
}

interface OrtSessionLike {
  inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>;
  release?(): Promise<void>;
}

interface OrtLike {
  Tensor: new (type: string, data: unknown, dims: readonly number[]) => unknown;
  InferenceSession: { create(file: string): Promise<OrtSessionLike> };
}

export interface SentenceEmbeddingExtractor {
  (texts: string[]): Promise<{ data: Float32Array; dims: number[] }>;
  dispose(): Promise<void>;
}

function hiddenSize(modelDir: string): number {
  const config = JSON.parse(fs.readFileSync(path.join(modelDir, "config.json"), "utf8"));
  const size = config.text_config?.hidden_size ?? config.hidden_size;
  if (!Number.isInteger(size) || size <= 0) throw new Error("Model config has no hidden_size");
  return size;
}

/**
 * Loads `modelId` from verified local files under `cacheDir` (Transformers' local model
 * path must already point there). Returned vectors are L2-normalized.
 */
export async function loadSentenceEmbeddingModel(
  transformers: TransformersLike,
  ort: OrtLike,
  cacheDir: string,
  modelId: string,
  dtype: string,
): Promise<SentenceEmbeddingExtractor> {
  const graphFile = GRAPH_FILE_BY_DTYPE[dtype];
  if (!graphFile) throw new Error(`Unsupported dtype for sentence-embedding models: ${dtype}`);
  const modelDir = path.join(cacheDir, ...modelId.split("/"));
  const featureWidth = hiddenSize(modelDir);
  const tokenizer = await transformers.AutoTokenizer.from_pretrained(modelId, { local_files_only: true });
  const session = await ort.InferenceSession.create(path.join(modelDir, "onnx", graphFile));

  const extractor = (async (texts: string[]) => {
    const encoded = tokenizer(texts, { padding: true, truncation: true });
    const feeds: Record<string, unknown> = {};
    for (const name of session.inputNames) {
      if (name === "input_ids" || name === "attention_mask") {
        const tensor = encoded[name];
        feeds[name] = new ort.Tensor("int64", BigInt64Array.from(tensor.data, (value) => BigInt(value)), tensor.dims);
      } else {
        feeds[name] = new ort.Tensor("float32", new Float32Array(0), [0, featureWidth]);
      }
    }
    const output = (await session.run(feeds)).sentence_embedding;
    if (!output) throw new Error("Model graph has no sentence_embedding output");
    const [batch, dim] = output.dims;
    const data = new Float32Array(output.data);
    for (let i = 0; i < batch; i++) {
      const row = data.subarray(i * dim, (i + 1) * dim);
      let norm = 0;
      for (const value of row) norm += value * value;
      norm = Math.sqrt(norm) || 1;
      for (let j = 0; j < dim; j++) row[j] /= norm;
    }
    return { data, dims: [batch, dim] };
  }) as SentenceEmbeddingExtractor;
  extractor.dispose = async () => {
    await session.release?.();
  };
  return extractor;
}
