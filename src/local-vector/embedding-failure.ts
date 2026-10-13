/**
 * Shared classification of embedding failures. Used by the worker process and
 * the renderer so a failure keeps its real cause and the step it happened in.
 *
 * Only allowlisted evidence tokens (error codes, signals, exit codes, HTTP
 * statuses, system library names) leave this module; raw messages may contain
 * paths, URLs or note text and are never forwarded to onboarding state.
 */

export type EmbeddingFailureStage =
  | "worker-start"
  | "native-load"
  | "model-files"
  | "model-download"
  | "session-build"
  | "inference";

export const EMBEDDING_FAILURE_STAGES: readonly EmbeddingFailureStage[] = [
  "worker-start", "native-load", "model-files", "model-download", "session-build", "inference",
];

export type EmbeddingFailureCode =
  | "EMBEDDING_NATIVE_LOAD_FAILED"
  | "EMBEDDING_MODEL_NETWORK_FAILED"
  | "EMBEDDING_MODEL_OOM"
  | "EMBEDDING_WORKER_CRASHED"
  | "EMBEDDING_MODEL_CACHE_CORRUPT"
  | "EMBEDDING_WORKER_TIMEOUT"
  | "EMBEDDING_MODEL_WARMUP_FAILED"
  | "RUNTIME_EXECUTION_BLOCKED";

export interface EmbeddingFailure {
  code: EmbeddingFailureCode;
  subStage: EmbeddingFailureStage;
  evidence: string[];
}

export type EmbeddingFailureError = Error & {
  code: EmbeddingFailureCode;
  subStage: EmbeddingFailureStage;
  evidence: string[];
};

const NATIVE_RE = /ERR_DLOPEN_FAILED|specified module could not be found|specified procedure could not be found|dlopen|Library not loaded|image not found|not a valid Win32 application|onnxruntime_binding|Cannot find module ['"]onnxruntime-node|wrong ELF class|incompatible architecture|Illegal instruction|SIGILL/i;
const OOM_RE = /bad_alloc|out of memory|Cannot allocate memory|ENOMEM|Array buffer allocation failed|allocation failed|heap out of memory|Failed to allocate/i;
const NETWORK_RE = /fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR|socket hang up|certificate|CERT_|self[- ]signed|unable to verify|network|status(?: code)? (?:4|5)\d\d|HTTP (?:4|5)\d\d|DOWNLOAD_[A-Z_]+/i;
const CORRUPT_RE = /protobuf|Protobuf parsing failed|invalid model|Load model .*failed|ModelProto|corrupt|unexpected end|Unexpected token|in JSON at position|Could not locate file|not found locally|ENOENT|no such file|MODEL_FILE_[A-Z_]+|MODEL_HASH_MISMATCH/i;
const BLOCKED_RE = /\bEACCES\b|\bEPERM\b|spawn UNKNOWN|operation not permitted|Access is denied|blocked by|quarantine/i;

const EVIDENCE_RE = /\b(?:ERR_[A-Z0-9_]{3,60}|UND_ERR_[A-Z_]{3,40}|E[A-Z]{3,15}|SIG[A-Z]{2,8}|DOWNLOAD_[A-Z_]{3,40}|MODEL_[A-Z_]{3,40})\b|\b(?:HTTP|status(?: code)?) ?[1-5]\d\d\b|\b[A-Za-z0-9_.-]{1,40}\.(?:dll|dylib|node|so)\b|\bbad_alloc\b/g;
const SAFE_TOKEN_RE = /^[A-Za-z0-9._:-]{1,40}$/;

/** Extracts at most four non-sensitive tokens that explain a failure. */
export function extractFailureEvidence(text: string, extra: Array<string | number | null | undefined> = []): string[] {
  const tokens: string[] = [];
  const push = (value: string) => {
    const token = value.replace(/\s+/g, "-");
    if (SAFE_TOKEN_RE.test(token) && !tokens.includes(token) && tokens.length < 4) tokens.push(token);
  };
  for (const value of extra) {
    if (value === null || value === undefined || value === "") continue;
    push(String(value));
  }
  for (const match of String(text || "").matchAll(EVIDENCE_RE)) push(match[0]);
  return tokens;
}

export function classifyEmbeddingFailure(
  text: string,
  stage: EmbeddingFailureStage,
  extra: Array<string | number | null | undefined> = [],
): EmbeddingFailure {
  const message = String(text || "");
  const evidence = extractFailureEvidence(message, extra);
  let code: EmbeddingFailureCode;
  if (stage === "worker-start" && BLOCKED_RE.test(message)) code = "RUNTIME_EXECUTION_BLOCKED";
  else if (OOM_RE.test(message)) code = "EMBEDDING_MODEL_OOM";
  else if (stage === "native-load" || NATIVE_RE.test(message)) code = "EMBEDDING_NATIVE_LOAD_FAILED";
  else if (stage === "model-download" && NETWORK_RE.test(message)) code = "EMBEDDING_MODEL_NETWORK_FAILED";
  else if (CORRUPT_RE.test(message) && stage !== "inference") code = "EMBEDDING_MODEL_CACHE_CORRUPT";
  else if (NETWORK_RE.test(message) && stage !== "inference") code = "EMBEDDING_MODEL_NETWORK_FAILED";
  else if (/timed out|timeout/i.test(message)) code = "EMBEDDING_WORKER_TIMEOUT";
  else code = "EMBEDDING_MODEL_WARMUP_FAILED";
  return { code, subStage: stage, evidence };
}

/** Classifies an unexpected worker exit from its exit code, signal and stderr tail. */
export function classifyWorkerExit(
  exitCode: number | null,
  signal: string | null,
  stderrTail: string,
  stage: EmbeddingFailureStage,
): EmbeddingFailure {
  const extra = [exitCode === null ? null : `exit:${exitCode}`, signal];
  const evidence = extractFailureEvidence(stderrTail, extra);
  if (OOM_RE.test(stderrTail)) return { code: "EMBEDDING_MODEL_OOM", subStage: stage, evidence };
  if (NATIVE_RE.test(stderrTail) || signal === "SIGILL" || exitCode === 3221225501) {
    // 0xC000001D: illegal instruction (CPU lacks a required instruction set).
    return { code: "EMBEDDING_NATIVE_LOAD_FAILED", subStage: stage, evidence };
  }
  return { code: "EMBEDDING_WORKER_CRASHED", subStage: stage, evidence };
}

export function embeddingFailureError(failure: EmbeddingFailure, message?: string): EmbeddingFailureError {
  return Object.assign(new Error(message || failure.code), failure) as EmbeddingFailureError;
}

export function isEmbeddingFailureStage(value: unknown): value is EmbeddingFailureStage {
  return typeof value === "string" && (EMBEDDING_FAILURE_STAGES as readonly string[]).includes(value);
}

/** Finds structured failure details anywhere in an error's cause chain. */
export function findEmbeddingFailureDetails(error: unknown): { subStage: EmbeddingFailureStage | null; evidence: string[] } {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { subStage?: unknown; evidence?: unknown; cause?: unknown };
    if (isEmbeddingFailureStage(candidate.subStage)) {
      const evidence = Array.isArray(candidate.evidence)
        ? candidate.evidence.filter((item): item is string => typeof item === "string" && SAFE_TOKEN_RE.test(item)).slice(0, 4)
        : [];
      return { subStage: candidate.subStage, evidence };
    }
    current = candidate.cause;
  }
  return { subStage: null, evidence: [] };
}
