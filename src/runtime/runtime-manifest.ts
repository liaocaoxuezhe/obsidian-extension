import {
  GENERATED_EMBEDDING_RUNTIME_ASSETS,
} from "./generated-embedding-runtime-manifest";
import {
  RuntimeAsset,
  RuntimeAssetKind,
  RuntimeManifest,
  SupportedPlatformKey,
} from "./runtime-types";

const CHROMA_RELEASE_ROOT = "https://github.com/chroma-core/chroma/releases/download/cli-1.4.4";
const CHROMA_LICENSE_URL = "https://github.com/chroma-core/chroma/blob/cli-1.4.4/LICENSE";

const CHROMA_ASSETS: RuntimeAsset[] = [
  {
    id: "chroma-cli-1.4.4-darwin-arm64",
    kind: "chroma",
    platform: "darwin-arm64",
    version: "cli-1.4.4",
    url: `${CHROMA_RELEASE_ROOT}/chroma-macos-arm64`,
    fileName: "chroma-macos-arm64",
    archive: "none",
    size: 60527064,
    sha256: "3daa51a58f3792092e53b1a2ab574478665d07868fbd6cd6730a60a1794663e5",
    executableRelativePath: "chroma-macos-arm64",
    licenseName: "Apache-2.0",
    licenseUrl: CHROMA_LICENSE_URL,
    source: "published",
  },
  {
    id: "chroma-cli-1.4.4-darwin-x64",
    kind: "chroma",
    platform: "darwin-x64",
    version: "cli-1.4.4",
    url: `${CHROMA_RELEASE_ROOT}/chroma-macos-intel`,
    fileName: "chroma-macos-intel",
    archive: "none",
    size: 63304056,
    sha256: "cdd321ef684e6b86226faae4023c7b07a68ec1363460cecf9ac3ce5a843cff57",
    executableRelativePath: "chroma-macos-intel",
    licenseName: "Apache-2.0",
    licenseUrl: CHROMA_LICENSE_URL,
    source: "published",
  },
  {
    id: "chroma-cli-1.4.4-win32-x64",
    kind: "chroma",
    platform: "win32-x64",
    version: "cli-1.4.4",
    url: `${CHROMA_RELEASE_ROOT}/chroma-windows.exe`,
    fileName: "chroma-windows.exe",
    archive: "none",
    size: 55364096,
    sha256: "8697d3f5f55c4f982c6e114ac01cf006daa0c68d87e791d9b5558b8670f89d05",
    executableRelativePath: "chroma-windows.exe",
    licenseName: "Apache-2.0",
    licenseUrl: CHROMA_LICENSE_URL,
    source: "published",
  },
];

export const RUNTIME_MANIFEST: RuntimeManifest = {
  schemaVersion: 1,
  generatedAt: "2026-08-03T00:00:00.000Z",
  assets: [...CHROMA_ASSETS, ...GENERATED_EMBEDDING_RUNTIME_ASSETS],
};

export interface RuntimeHistoryAssetBinding {
  id: string;
  kind: RuntimeAssetKind;
  platform: SupportedPlatformKey;
  sha256: string;
}

export interface RuntimeHistoryBindingRegistry {
  schemaVersion: 1;
  retained: readonly RuntimeHistoryAssetBinding[];
}

/**
 * Version-controlled compatibility registry for runtime versions removed from the active
 * download manifest. This is intentionally empty for the first managed-runtime release:
 * the repository has no earlier released managed asset/SHA to retain. Before replacing an
 * active asset in a later release, copy its exact id/kind/platform/sha256 into `retained`.
 * See RUNTIME_HISTORY_REGISTRY.md.
 */
export const RUNTIME_HISTORY_BINDING_REGISTRY: RuntimeHistoryBindingRegistry = Object.freeze({
  schemaVersion: 1,
  retained: Object.freeze([]),
});

function validHistoryBinding(binding: RuntimeHistoryAssetBinding): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(binding.id)
    && (binding.kind === "chroma" || binding.kind === "embedding-runtime")
    && ["darwin-arm64", "darwin-x64", "win32-x64"].includes(binding.platform)
    && /^[0-9a-f]{64}$/.test(binding.sha256);
}

export function createRuntimeHistoryAssetResolver(
  manifest: RuntimeManifest,
  registry: RuntimeHistoryBindingRegistry,
  platform: SupportedPlatformKey,
): (kind: RuntimeAssetKind, runtimeId: string) => { id: string; sha256: string } | null {
  if (manifest.schemaVersion !== 1 || registry.schemaVersion !== 1) {
    throw new Error("RUNTIME_HISTORY_REGISTRY_UNSUPPORTED_SCHEMA");
  }
  const bindings: RuntimeHistoryAssetBinding[] = [
    ...manifest.assets.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      platform: asset.platform,
      sha256: asset.sha256,
    })),
    ...registry.retained,
  ];
  const trusted = new Map<string, RuntimeHistoryAssetBinding>();
  for (const binding of bindings) {
    if (!validHistoryBinding(binding)) throw new Error("RUNTIME_HISTORY_REGISTRY_INVALID_BINDING");
    const key = `${binding.platform}:${binding.kind}:${binding.id}`;
    const previous = trusted.get(key);
    if (previous && previous.sha256 !== binding.sha256) {
      throw new Error("RUNTIME_HISTORY_REGISTRY_CONFLICT");
    }
    trusted.set(key, Object.freeze({ ...binding }));
  }
  return (kind, runtimeId) => {
    const binding = trusted.get(`${platform}:${kind}:${runtimeId}`);
    return binding ? { id: binding.id, sha256: binding.sha256 } : null;
  };
}

export function getRuntimeAsset(
  kind: RuntimeAssetKind,
  platform: SupportedPlatformKey,
): RuntimeAsset {
  const asset = RUNTIME_MANIFEST.assets.find((candidate) => candidate.kind === kind && candidate.platform === platform);
  if (!asset) {
    throw new Error(`RUNTIME_ASSET_NOT_FOUND: ${kind}:${platform}`);
  }
  return asset;
}
