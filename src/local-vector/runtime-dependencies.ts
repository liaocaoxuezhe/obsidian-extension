import type { ManagedEmbeddingRuntime } from "../runtime/embedding-runtime-manager";

export interface LocalRuntimeStatus {
  ready: boolean;
  missing: string[];
  message: string;
}

export const REQUIRED_RUNTIME_MODULES = ["managed-embedding-runtime"];

export function getLocalRuntimeStatus(
  runtime: ManagedEmbeddingRuntime | string | null | undefined,
): LocalRuntimeStatus {
  if (runtime && typeof runtime !== "string"
    && runtime.versions.node === "22.23.2"
    && runtime.versions.transformers === "4.2.0"
    && runtime.versions.onnxruntime === "1.26.0") {
    return { ready: true, missing: [], message: "" };
  }
  return {
    ready: false,
    missing: [...REQUIRED_RUNTIME_MODULES],
    message: "The managed embedding runtime is not ready. Open Analogy managed runtime onboarding to prepare or repair it.",
  };
}

export function installLocalRuntimeDependencies(
  _pluginDir: string,
  _onLog?: (line: string) => void,
): Promise<void> {
  return Promise.reject(new Error(
    "Embedding dependencies are installed only by managed runtime onboarding; user npm installation is disabled.",
  ));
}
