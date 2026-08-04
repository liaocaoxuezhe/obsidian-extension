import type { EmbeddingRuntimeVersions, RuntimeAsset } from "./runtime-types";

// Task 6 replaces this development-only input with the generated release manifest.
export const EMBEDDING_RUNTIME_MANIFEST_SOURCE = "development-fixture" as const;
export const EMBEDDING_RUNTIME_PUBLIC_MANIFEST_SHA256 = "a783c0cece40249bfd1377d2ff0fc2921905d7bfb74d8d14c350da50e15b2676" as const;
export const EMBEDDING_RUNTIME_BUILD_BINDING = "ANALOGY_EMBEDDING_RUNTIME_MANIFEST_SHA256:a783c0cece40249bfd1377d2ff0fc2921905d7bfb74d8d14c350da50e15b2676" as const;
export const EMBEDDING_RUNTIME_VERSIONS: EmbeddingRuntimeVersions = {
  node: "22.23.2",
  transformers: "4.2.0",
  onnxruntime: "1.26.0",
};

export const GENERATED_EMBEDDING_RUNTIME_ASSETS: RuntimeAsset[] = [
  {
    id: "embedding-runtime-node22-v1-darwin-arm64-development-fixture",
    kind: "embedding-runtime",
    platform: "darwin-arm64",
    version: "node22-v1-development-fixture",
    url: "https://example.invalid/analogy/embedding-runtime-node22-v1-darwin-arm64.tar.gz",
    fileName: "embedding-runtime-node22-v1-darwin-arm64.tar.gz",
    archive: "tar.gz",
    size: 1024,
    sha256: "80250258c81670d88d1d4b3709cfbe0a96fc72d37b295e546f12bb1a13e0239f",
    executableRelativePath: "bin/node",
    licenseName: "development-fixture",
    licenseUrl: "https://example.invalid/analogy/development-fixture-license",
    source: EMBEDDING_RUNTIME_MANIFEST_SOURCE,
    runtimeVersions: EMBEDDING_RUNTIME_VERSIONS,
  },
  {
    id: "embedding-runtime-node22-v1-darwin-x64-development-fixture",
    kind: "embedding-runtime",
    platform: "darwin-x64",
    version: "node22-v1-development-fixture",
    url: "https://example.invalid/analogy/embedding-runtime-node22-v1-darwin-x64.tar.gz",
    fileName: "embedding-runtime-node22-v1-darwin-x64.tar.gz",
    archive: "tar.gz",
    size: 1025,
    sha256: "43ca27b4511220b05ac32b1cdeebfd05c72364285aa9910fbee9807f96930539",
    executableRelativePath: "bin/node",
    licenseName: "development-fixture",
    licenseUrl: "https://example.invalid/analogy/development-fixture-license",
    source: EMBEDDING_RUNTIME_MANIFEST_SOURCE,
    runtimeVersions: EMBEDDING_RUNTIME_VERSIONS,
  },
  {
    id: "embedding-runtime-node22-v1-win32-x64-development-fixture",
    kind: "embedding-runtime",
    platform: "win32-x64",
    version: "node22-v1-development-fixture",
    url: "https://example.invalid/analogy/embedding-runtime-node22-v1-win32-x64.zip",
    fileName: "embedding-runtime-node22-v1-win32-x64.zip",
    archive: "zip",
    size: 1026,
    sha256: "1d691a35090b24d408c0076abbede1e77c68f671feb8482a74d76a4ee31e5e81",
    executableRelativePath: "bin/node.exe",
    licenseName: "development-fixture",
    licenseUrl: "https://example.invalid/analogy/development-fixture-license",
    source: EMBEDDING_RUNTIME_MANIFEST_SOURCE,
    runtimeVersions: EMBEDDING_RUNTIME_VERSIONS,
  },
];
