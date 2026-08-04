import * as os from "os";
import * as path from "path";
import { RuntimePaths } from "./runtime-types";

type PathModule = typeof path.posix;

function getPathModule(platform: string): PathModule {
  if (platform === "darwin") return path.posix;
  if (platform === "win32") return path.win32;
  throw new Error(`UNSUPPORTED_PLATFORM: ${platform}`);
}

function assertRuntimeVaultId(runtimeVaultId: string): void {
  if (!/^vault-v2-[0-9a-f]{16}$/.test(runtimeVaultId)) {
    throw new Error("INVALID_RUNTIME_VAULT_ID");
  }
}

function assertContained(pathModule: PathModule, root: string, candidate: string): void {
  const relative = pathModule.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${pathModule.sep}`) || pathModule.isAbsolute(relative)) {
    throw new Error("INVALID_RUNTIME_PATH");
  }
}

export function resolveAnalogyLocalDataRoot(
  platform: string = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
): string {
  const pathModule = getPathModule(platform);
  if (platform === "darwin") {
    return pathModule.join(homeDirectory, "Library", "Application Support", "Analogy");
  }

  const localAppData = environment.LOCALAPPDATA || pathModule.join(homeDirectory, "AppData", "Local");
  return pathModule.join(localAppData, "Analogy");
}

export function createRuntimePaths(localDataRoot: string, runtimeVaultId: string): RuntimePaths {
  assertRuntimeVaultId(runtimeVaultId);
  const pathModule = path.posix.isAbsolute(localDataRoot) ? path.posix : path.win32;
  if (!pathModule.isAbsolute(localDataRoot)) {
    throw new Error("INVALID_LOCAL_DATA_ROOT: an absolute local data root is required");
  }

  const root = pathModule.resolve(localDataRoot);
  const runtimeRoot = pathModule.join(root, "runtime");
  const vaultRoot = pathModule.join(root, "vaults", runtimeVaultId);
  const paths: RuntimePaths = {
    root,
    downloads: pathModule.join(runtimeRoot, "downloads"),
    staging: pathModule.join(runtimeRoot, "staging"),
    chromaVersions: pathModule.join(runtimeRoot, "chroma"),
    embeddingVersions: pathModule.join(runtimeRoot, "embedding"),
    workerVersions: pathModule.join(runtimeRoot, "worker"),
    current: pathModule.join(runtimeRoot, "current"),
    modelCache: pathModule.join(root, "models", "transformers-cache"),
    vaultRoot,
    onboardingState: pathModule.join(vaultRoot, "onboarding-state.json"),
    runtimeState: pathModule.join(vaultRoot, "runtime-state.json"),
    chromaDataV2: pathModule.join(vaultRoot, "chroma_data_v2"),
  };

  for (const candidate of Object.values(paths)) {
    assertContained(pathModule, root, candidate);
  }
  assertContained(pathModule, vaultRoot, paths.onboardingState);
  assertContained(pathModule, vaultRoot, paths.runtimeState);
  assertContained(pathModule, vaultRoot, paths.chromaDataV2);
  return paths;
}
