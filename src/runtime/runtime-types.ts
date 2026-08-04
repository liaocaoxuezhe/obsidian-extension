export type SupportedPlatformKey =
  | "darwin-arm64"
  | "darwin-x64"
  | "win32-x64";

export type RuntimeAssetKind = "chroma" | "embedding-runtime";

export interface EmbeddingRuntimeVersions {
  node: "22.23.2";
  transformers: "4.2.0";
  onnxruntime: "1.26.0";
}

interface RuntimeAssetBase {
  id: string;
  platform: SupportedPlatformKey;
  version: string;
  url: string;
  fileName: string;
  archive: "none" | "tar.gz" | "zip";
  size: number;
  sha256: string;
  executableRelativePath: string;
  licenseName: string;
  licenseUrl: string;
  source: "published" | "development-fixture";
}

export interface ChromaRuntimeAsset extends RuntimeAssetBase {
  kind: "chroma";
}

export interface EmbeddingRuntimeAsset extends RuntimeAssetBase {
  kind: "embedding-runtime";
  runtimeVersions: EmbeddingRuntimeVersions;
  internalManifestSha256?: string;
}

export type RuntimeAsset = ChromaRuntimeAsset | EmbeddingRuntimeAsset;

export interface RuntimeManifest {
  schemaVersion: 1;
  generatedAt: string;
  assets: RuntimeAsset[];
}

export interface RuntimePaths {
  runtimeVaultId: string;
  root: string;
  downloads: string;
  staging: string;
  chromaVersions: string;
  embeddingVersions: string;
  workerVersions: string;
  current: string;
  legacyCurrent: string;
  installRecords: string;
  modelCache: string;
  vaultRoot: string;
  chromaProcessLease: string;
  onboardingState: string;
  runtimeState: string;
  chromaDataV2: string;
}
