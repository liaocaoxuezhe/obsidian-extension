export interface SummaryModelConfig {
  label: string;
  ollamaName: string;
  estimatedSize: string;
  noteEn: string;
  noteZh: string;
}

export const DEFAULT_SUMMARY_MODEL_KEY = "qwen3.5:0.8b";

export const SUMMARY_MODELS: Record<string, SummaryModelConfig> = {
  "qwen3:1.7b": {
    label: "Qwen3-1.7B",
    ollamaName: "qwen3:1.7b",
    estimatedSize: "about 1.4 GB",
    noteEn: "More stable summaries, heavier than 0.6B / 0.8B.",
    noteZh: "摘要质量更稳，速度和内存占用高于 0.6B / 0.8B。",
  },
  "qwen3:0.6b": {
    label: "Qwen3-0.6B",
    ollamaName: "qwen3:0.6b",
    estimatedSize: "about 500-600 MB",
    noteEn: "Fast and light; summary quality is weaker.",
    noteZh: "更快更轻，摘要质量弱一些。",
  },
  "qwen3.5:0.8b": {
    label: "qwen3.5:0.8b",
    ollamaName: "qwen3.5:0.8b",
    estimatedSize: "checked by Ollama after install",
    noteEn: "Default requested candidate. Availability is verified by local Ollama.",
    noteZh: "用户指定的默认候选；是否可用由本机 Ollama 校验。",
  },
  "qwen3.5:2b": {
    label: "qwen3.5:2b",
    ollamaName: "qwen3.5:2b",
    estimatedSize: "checked by Ollama after install",
    noteEn: "Higher quality but slower; availability is verified by local Ollama.",
    noteZh: "质量更高但更慢；是否可用由本机 Ollama 校验。",
  },
  "gemma3:1b": {
    label: "gemma3:1b",
    ollamaName: "gemma3:1b",
    estimatedSize: "about 800 MB-1 GB",
    noteEn: "Good lightweight multilingual summarization option.",
    noteZh: "轻量多语摘要候选，体积适中。",
  },
  "gemma3:270m": {
    label: "gemma3:270m",
    ollamaName: "gemma3:270m",
    estimatedSize: "about 291 MB",
    noteEn: "Smallest option; fastest, but weakest quality.",
    noteZh: "最轻量，适合低配置机器，摘要质量有限。",
  },
  "gemma4:e2b": {
    label: "gemma4:e2b",
    ollamaName: "gemma4:e2b",
    estimatedSize: "checked by Ollama after install",
    noteEn: "Requested candidate. Treat as a configurable Ollama tag.",
    noteZh: "用户指定候选；按可配置 Ollama tag 处理。",
  },
};

export function formatModelBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}
