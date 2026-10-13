import { execFile } from "child_process";
import {
  classifyEmbeddingFailure,
  embeddingFailureError,
  type EmbeddingFailureStage,
} from "../local-vector/embedding-failure";

/**
 * Self-contained script run by the managed Node runtime. It loads
 * onnxruntime-node and runs one inference on a tiny in-memory ONNX graph
 * (Y = X + X), so it proves the native binding, its DLL/dylib dependencies and
 * the CPU kernels work without any network access or model download.
 */
export const NATIVE_PROBE_SOURCE = String.raw`
"use strict";
const path = require("path");
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const varint = (value) => { const bytes = []; while (value > 127) { bytes.push((value & 127) | 128); value >>>= 7; } bytes.push(value); return bytes; };
const field = (number, type, payload) => {
  const key = varint((number << 3) | type);
  if (type === 0) return key.concat(varint(payload));
  const bytes = typeof payload === "string" ? Array.from(Buffer.from(payload, "utf8")) : payload;
  return key.concat(varint(bytes.length), bytes);
};
const tensorType = field(1, 2, field(1, 0, 1).concat(field(2, 2, field(1, 2, field(1, 0, 4)))));
const valueInfo = (name) => field(1, 2, name).concat(field(2, 2, tensorType));
const node = field(1, 2, "X").concat(field(1, 2, "X"), field(2, 2, "Y"), field(3, 2, "probe"), field(4, 2, "Add"));
const graph = field(1, 2, node).concat(field(2, 2, "analogy-probe"), field(11, 2, valueInfo("X")), field(12, 2, valueInfo("Y")));
const model = Uint8Array.from(field(1, 0, 7).concat(field(2, 2, "analogy"), field(7, 2, graph), field(8, 2, field(1, 2, "").concat(field(2, 0, 13)))));
const root = process.env.ANALOGY_RUNTIME_MODULE_ROOT;
let ort;
try {
  if (!root || !path.isAbsolute(root)) throw new Error("ANALOGY_RUNTIME_MODULE_ROOT is required");
  ort = require(path.join(root, "onnxruntime-node"));
} catch (error) {
  emit({ ok: false, stage: "native-load", code: error && error.code || null, message: String(error && error.message || error) });
  process.exit(0);
}
(async () => {
  try {
    const session = await ort.InferenceSession.create(model);
    const result = await session.run({ X: new ort.Tensor("float32", Float32Array.from([1, 2, 3, 4]), [4]) });
    const output = Array.from(result.Y.data);
    if (output.join(",") !== "2,4,6,8") throw new Error("PROBE_OUTPUT_MISMATCH");
    emit({ ok: true, onnxruntime: ort.env && ort.env.versions ? ort.env.versions.common || null : null });
  } catch (error) {
    emit({ ok: false, stage: "session-build", code: error && error.code || null, message: String(error && error.message || error) });
  }
})();
`;

export interface NativeProbeInput {
  nodeExecutable: string;
  moduleRoot: string;
  timeoutMs?: number;
  /** Test seam. */
  execFileImpl?: typeof execFile;
}

/**
 * Runs the native probe and throws a classified EMBEDDING_NATIVE_LOAD_FAILED
 * (or RUNTIME_EXECUTION_BLOCKED) error with evidence when it fails.
 */
export function runNativeProbe(input: NativeProbeInput): Promise<void> {
  const run = input.execFileImpl ?? execFile;
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ANALOGY_RUNTIME_MODULE_ROOT: input.moduleRoot, ELECTRON_RUN_AS_NODE: "1" };
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
    run(input.nodeExecutable, ["-e", NATIVE_PROBE_SOURCE], {
      env,
      timeout: input.timeoutMs ?? 60_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const line = String(stdout || "").trim().split("\n").pop() || "";
      let result: { ok?: boolean; stage?: string; code?: string | null; message?: string } | null = null;
      try { result = line ? JSON.parse(line) : null; } catch { result = null; }
      if (result?.ok === true) {
        resolve();
        return;
      }
      if (!result && error) {
        const errno = (error as NodeJS.ErrnoException).code;
        const signal = (error as { signal?: string | null }).signal ?? null;
        const failure = classifyEmbeddingFailure(
          `${String(errno ?? "")} ${error.message} ${String(stderr || "")}`,
          "worker-start",
          [typeof errno === "string" ? errno : null, signal],
        );
        // A process that cannot even start is blocked (antivirus, permissions); one that
        // crashed while loading the binding is a native failure.
        if (/^(ENOENT|EACCES|EPERM|UNKNOWN)$/.test(String(errno))) failure.code = "RUNTIME_EXECUTION_BLOCKED";
        else if (failure.code !== "RUNTIME_EXECUTION_BLOCKED") failure.code = "EMBEDDING_NATIVE_LOAD_FAILED";
        failure.subStage = failure.code === "RUNTIME_EXECUTION_BLOCKED" ? "worker-start" : "native-load";
        reject(embeddingFailureError(failure, error.message));
        return;
      }
      const stage: EmbeddingFailureStage = result?.stage === "session-build" ? "session-build" : "native-load";
      const failure = classifyEmbeddingFailure(
        `${result?.message ?? ""} ${String(stderr || "")}`,
        stage,
        [result?.code ?? null],
      );
      // Any probe failure is a native runtime problem: the probe uses no model files or network.
      failure.code = failure.code === "EMBEDDING_MODEL_OOM" ? failure.code : "EMBEDDING_NATIVE_LOAD_FAILED";
      reject(embeddingFailureError(failure, result?.message ?? "native probe failed"));
    });
  });
}
