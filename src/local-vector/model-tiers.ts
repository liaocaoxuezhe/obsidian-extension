import { DEFAULT_MODEL_KEY, EMBEDDING_MODELS } from "./embedding";
import { MODEL_FILE_MANIFESTS } from "./model-file-manifest";

/**
 * Device-aware model tiers: exact download sizes from the pinned file manifest, an
 * estimated resident memory figure, and which models a device should be offered.
 */

/** Models at or above this parameter count need a reasonably modern machine. */
export const HEAVY_MODEL_PARAMETERS = 200_000_000;
/** Devices below this much RAM do not get heavy models offered by default. */
export const LOW_MEMORY_THRESHOLD_GB = 8;
/** Share of CJK characters (among CJK + Latin letters) above which a vault counts as Chinese-first. */
export const CJK_VAULT_THRESHOLD = 0.3;
/**
 * Default for Chinese-first vaults. Pending decision #3 of the 1.3.0 plan (bge-small-zh vs
 * granite multilingual): granite also handles the English and code that most Chinese
 * Obsidian vaults mix in, and stays below the heavy-model tier.
 */
export const CJK_DEFAULT_MODEL_KEY = "granite-97m-multilingual-r2";

/** Embedding worker baseline (Node, ONNX Runtime, Transformers) before model weights. */
const WORKER_BASELINE_BYTES = 180 * 1024 * 1024;
/**
 * Resident memory per weight byte, calibrated on jina-nano: 247 MB of q8 weights kept the
 * worker at about 1.06 GB after loading (weights, tokenizer, activation arenas).
 */
const RESIDENT_BYTES_PER_WEIGHT_BYTE = 3.5;

export interface ModelTierInfo {
  key: string;
  parameters: number | null;
  downloadBytes: number | null;
  estimatedMemoryBytes: number | null;
  heavy: boolean;
}

export function parseParameterCount(size: string | undefined): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([MB])$/i.exec(size?.trim() ?? "");
  if (!match) return null;
  return Math.round(Number(match[1]) * (match[2].toUpperCase() === "B" ? 1e9 : 1e6));
}

export function modelDownloadBytes(key: string): number | null {
  const manifest = MODEL_FILE_MANIFESTS[key];
  if (!manifest) return null;
  return manifest.files.reduce((total, file) => total + file.size, 0);
}

export function estimatedModelMemoryBytes(key: string): number | null {
  const manifest = MODEL_FILE_MANIFESTS[key];
  if (!manifest) return null;
  const weights = manifest.files
    .filter((file) => /\.onnx(?:_data)?$/.test(file.path))
    .reduce((total, file) => total + file.size, 0);
  return Math.round(WORKER_BASELINE_BYTES + weights * RESIDENT_BYTES_PER_WEIGHT_BYTE);
}

export function modelTierInfo(key: string): ModelTierInfo {
  const parameters = parseParameterCount(EMBEDDING_MODELS[key]?.size);
  return {
    key,
    parameters,
    downloadBytes: modelDownloadBytes(key),
    estimatedMemoryBytes: estimatedModelMemoryBytes(key),
    heavy: parameters !== null && parameters >= HEAVY_MODEL_PARAMETERS,
  };
}

export function isLowMemoryDevice(totalMemoryGb: number | null | undefined): boolean {
  return typeof totalMemoryGb === "number" && Number.isFinite(totalMemoryGb) && totalMemoryGb < LOW_MEMORY_THRESHOLD_GB;
}

/**
 * Model keys to offer in the picker. Low-memory devices do not see heavy models, except the
 * one currently selected, which always stays visible so the setting is never silently lost.
 */
export function selectableModelKeys(totalMemoryGb: number | null | undefined, currentKey: string): string[] {
  const lowMemory = isLowMemoryDevice(totalMemoryGb);
  return Object.keys(EMBEDDING_MODELS).filter((key) => key === currentKey || !lowMemory || !modelTierInfo(key).heavy);
}

/** True when switching to `key` deserves an explicit confirmation (heavy model or large download). */
export function requiresSwitchConfirmation(key: string): boolean {
  const info = modelTierInfo(key);
  return info.heavy || (info.downloadBytes ?? 0) >= 100 * 1000 * 1000;
}

const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g;
const LATIN_LETTER_PATTERN = /[A-Za-z]/g;

/** Counts CJK and Latin letters, ignoring front matter, code blocks, links and URLs. */
export function scriptCounts(markdown: string): { cjk: number; latin: number } {
  const text = markdown
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/https?:\/\/\S+/g, " ");
  return {
    cjk: text.match(CJK_PATTERN)?.length ?? 0,
    latin: text.match(LATIN_LETTER_PATTERN)?.length ?? 0,
  };
}

export function cjkRatio(samples: readonly string[]): number | null {
  let cjk = 0;
  let latin = 0;
  for (const sample of samples) {
    const counts = scriptCounts(sample);
    cjk += counts.cjk;
    // One CJK character carries roughly a word; weigh Latin letters as ~1/4 of that.
    latin += counts.latin / 4;
  }
  const total = cjk + latin;
  return total >= 200 ? cjk / total : null;
}

/** Default model for a first install, from a content sample and the device memory. */
export function recommendDefaultModel(ratio: number | null, totalMemoryGb: number | null | undefined): string {
  const preferred = ratio !== null && ratio >= CJK_VAULT_THRESHOLD ? CJK_DEFAULT_MODEL_KEY : DEFAULT_MODEL_KEY;
  if (!EMBEDDING_MODELS[preferred]) return DEFAULT_MODEL_KEY;
  return isLowMemoryDevice(totalMemoryGb) && modelTierInfo(preferred).heavy ? DEFAULT_MODEL_KEY : preferred;
}

export function formatBytes(bytes: number | null, locale: "en" | "zh"): string {
  if (bytes === null || !Number.isFinite(bytes)) return locale === "zh" ? "未知" : "unknown";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}
