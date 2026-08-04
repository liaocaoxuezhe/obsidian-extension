import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { readCurrentRuntimeForAsset } from "./atomic-runtime-installer";
import { getRuntimeAsset } from "./runtime-manifest";
import { createRuntimePaths } from "./runtime-paths";
import { EmbeddingWorkerClient } from "../local-vector/embedding-worker-client";
import {
  EmbeddingRuntimeAsset,
  EmbeddingRuntimeVersions,
  RuntimePaths,
  SupportedPlatformKey,
} from "./runtime-types";

const EXPECTED_VERSIONS: EmbeddingRuntimeVersions = {
  node: "22.23.2",
  transformers: "4.2.0",
  onnxruntime: "1.26.0",
};

interface InternalRuntimeFile {
  path: string;
  size: number;
  sha256: string;
}

interface InternalEmbeddingRuntimeManifest {
  schemaVersion: 1;
  id: string;
  kind: "embedding-runtime";
  platform: SupportedPlatformKey;
  version: string;
  runtimeVersions: EmbeddingRuntimeVersions;
  executableRelativePath: string;
  moduleRootRelativePath: string;
  noticesRelativePath: string;
  files: InternalRuntimeFile[];
}

type EmbeddingRuntimeAssetWithInternalBinding = EmbeddingRuntimeAsset & {
  internalManifestSha256?: string;
};

export interface ManagedEmbeddingRuntime {
  runtimeId: string;
  root: string;
  nodeExecutable: string;
  moduleRoot: string;
  versions: EmbeddingRuntimeVersions;
  verification: ManagedEmbeddingRuntimeVerification;
  revalidate: () => Promise<ManagedEmbeddingRuntimeLaunchSnapshot>;
}

export interface ManagedEmbeddingRuntimeVerification {
  assetId: string;
  assetSha256: string;
  internalManifestPath: string;
  internalManifestSha256: string;
}

export interface ManagedEmbeddingRuntimeLaunchSnapshot {
  nodeExecutable: string;
  moduleRoot: string;
  verification: ManagedEmbeddingRuntimeVerification;
}

export interface EmbeddingRuntimeManagerOptions {
  paths?: RuntimePaths;
  localDataRoot?: string;
  runtimeVaultId?: string;
  platform: SupportedPlatformKey;
  getAsset?: (platform: SupportedPlatformKey) => EmbeddingRuntimeAsset;
  buildId?: string;
  workerBundleSource?: string;
  smokeModelId?: string;
  smokeModelRevision?: string;
  smokeDtype?: string;
}

export interface EmbeddingRuntimeSmokeResult {
  runtimeId: string;
  vectorLength: number;
  memoryUsage: { rss: number; heapUsed: number; external: number };
}

function runtimeError(code: string, cause?: unknown): Error {
  const error = new Error(code) as Error & { code?: string; cause?: unknown };
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function isContained(root: string, candidate: string, allowRoot = false): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (allowRoot || Boolean(relative))
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function resolveContained(root: string, relativePath: string, allowRoot = false): string {
  if (!relativePath || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw runtimeError("EMBEDDING_RUNTIME_UNSAFE_PATH");
  }
  const normalizedParts = relativePath.split("/");
  if (normalizedParts.some((part) => !part || part === "." || part === "..")) {
    throw runtimeError("EMBEDDING_RUNTIME_UNSAFE_PATH");
  }
  const resolved = path.resolve(root, ...normalizedParts);
  if (!isContained(root, resolved, allowRoot)) {
    throw runtimeError("EMBEDDING_RUNTIME_UNSAFE_PATH");
  }
  return resolved;
}

async function assertRealPathWithin(root: string, candidate: string, directory: boolean): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(candidate);
  } catch (error) {
    throw runtimeError("EMBEDDING_RUNTIME_FILE_INVALID", error);
  }
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw runtimeError("EMBEDDING_RUNTIME_UNSAFE_PATH");
  }
  let current = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  while (current !== resolvedRoot) {
    if (!isContained(resolvedRoot, current)) {
      throw runtimeError("EMBEDDING_RUNTIME_UNSAFE_PATH");
    }
    const currentStat = await fs.promises.lstat(current).catch((error) => {
      throw runtimeError("EMBEDDING_RUNTIME_FILE_INVALID", error);
    });
    if (currentStat.isSymbolicLink()) {
      throw runtimeError("EMBEDDING_RUNTIME_UNSAFE_PATH");
    }
    current = path.dirname(current);
  }
  const rootStat = await fs.promises.lstat(resolvedRoot).catch((error) => {
    throw runtimeError("EMBEDDING_RUNTIME_FILE_INVALID", error);
  });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw runtimeError("EMBEDDING_RUNTIME_UNSAFE_PATH");
  }
  const [realRoot, realCandidate] = await Promise.all([
    fs.promises.realpath(resolvedRoot),
    fs.promises.realpath(candidate),
  ]);
  if (!isContained(realRoot, realCandidate, candidate === root)) {
    throw runtimeError("EMBEDDING_RUNTIME_UNSAFE_PATH");
  }
}

function parseManifest(bytes: Buffer): InternalEmbeddingRuntimeManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw runtimeError("EMBEDDING_RUNTIME_MANIFEST_INVALID", error);
  }
  const manifest = value as Partial<InternalEmbeddingRuntimeManifest>;
  if (!manifest || manifest.schemaVersion !== 1 || manifest.kind !== "embedding-runtime"
    || typeof manifest.id !== "string" || typeof manifest.platform !== "string"
    || typeof manifest.version !== "string" || !manifest.runtimeVersions
    || typeof manifest.executableRelativePath !== "string"
    || typeof manifest.moduleRootRelativePath !== "string"
    || typeof manifest.noticesRelativePath !== "string" || !Array.isArray(manifest.files)) {
    throw runtimeError("EMBEDDING_RUNTIME_MANIFEST_INVALID");
  }
  return manifest as InternalEmbeddingRuntimeManifest;
}

function versionsEqual(actual: EmbeddingRuntimeVersions | undefined): boolean {
  return actual?.node === EXPECTED_VERSIONS.node
    && actual.transformers === EXPECTED_VERSIONS.transformers
    && actual.onnxruntime === EXPECTED_VERSIONS.onnxruntime;
}

async function readPackageVersion(filename: string): Promise<string> {
  try {
    const value = JSON.parse(await fs.promises.readFile(filename, "utf8"));
    return typeof value.version === "string" ? value.version : "";
  } catch (error) {
    throw runtimeError("EMBEDDING_RUNTIME_VERSION_MISMATCH", error);
  }
}

async function sha256File(filename: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filename);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function platformParts(platform: SupportedPlatformKey): { os: "darwin" | "win32"; arch: "arm64" | "x64" } {
  if (platform === "darwin-arm64") return { os: "darwin", arch: "arm64" };
  if (platform === "darwin-x64") return { os: "darwin", arch: "x64" };
  return { os: "win32", arch: "x64" };
}

export class EmbeddingRuntimeManager {
  private readonly options: EmbeddingRuntimeManagerOptions;
  private readonly paths: RuntimePaths;

  constructor(options: EmbeddingRuntimeManagerOptions) {
    this.options = options;
    if (options.paths) {
      this.paths = options.paths;
    } else if (options.localDataRoot && options.runtimeVaultId) {
      this.paths = createRuntimePaths(options.localDataRoot, options.runtimeVaultId);
    } else {
      throw runtimeError("EMBEDDING_RUNTIME_PATHS_REQUIRED");
    }
  }

  async resolve(): Promise<ManagedEmbeddingRuntime> {
    const asset = (this.options.getAsset?.(this.options.platform)
      ?? getRuntimeAsset("embedding-runtime", this.options.platform)) as EmbeddingRuntimeAssetWithInternalBinding;
    if (!asset.internalManifestSha256 || !/^[0-9a-f]{64}$/.test(asset.internalManifestSha256)) {
      throw runtimeError("EMBEDDING_RUNTIME_MANIFEST_BINDING_MISSING");
    }
    const pointer = await readCurrentRuntimeForAsset(this.paths, asset);
    if (!pointer) throw runtimeError("EMBEDDING_RUNTIME_NOT_INSTALLED");
    if (pointer.runtimeId !== asset.id || pointer.assetSha256 !== asset.sha256
      || pointer.installedPath !== path.join(this.paths.embeddingVersions, asset.id)) {
      throw runtimeError("EMBEDDING_RUNTIME_POINTER_MISMATCH");
    }

    const runtimeRoot = pointer.installedPath;
    await assertRealPathWithin(this.paths.embeddingVersions, runtimeRoot, true);
    const externalExecutable = resolveContained(runtimeRoot, asset.executableRelativePath);
    const packRelativePath = path.posix.dirname(path.posix.dirname(path.posix.dirname(asset.executableRelativePath)));
    const packRoot = packRelativePath === "." ? runtimeRoot : resolveContained(runtimeRoot, packRelativePath, true);
    const manifestPath = path.join(packRoot, "manifest.json");
    await assertRealPathWithin(runtimeRoot, manifestPath, false);
    const manifestBytes = await fs.promises.readFile(manifestPath);
    if (sha256Buffer(manifestBytes) !== asset.internalManifestSha256) {
      throw runtimeError("EMBEDDING_RUNTIME_HASH_MISMATCH");
    }
    const manifest = parseManifest(manifestBytes);
    if (manifest.id !== asset.id || manifest.platform !== asset.platform || manifest.version !== asset.version
      || !versionsEqual(asset.runtimeVersions) || !versionsEqual(manifest.runtimeVersions)) {
      throw runtimeError("EMBEDDING_RUNTIME_VERSION_MISMATCH");
    }

    const nodeExecutable = resolveContained(packRoot, manifest.executableRelativePath);
    const moduleRoot = resolveContained(packRoot, manifest.moduleRootRelativePath);
    if (nodeExecutable !== externalExecutable) {
      throw runtimeError("EMBEDDING_RUNTIME_MANIFEST_INVALID");
    }
    await assertRealPathWithin(runtimeRoot, nodeExecutable, false);
    await assertRealPathWithin(runtimeRoot, moduleRoot, true);

    const transformersVersion = await readPackageVersion(
      path.join(moduleRoot, "@huggingface", "transformers", "package.json"),
    );
    const onnxruntimeVersion = await readPackageVersion(
      path.join(moduleRoot, "onnxruntime-node", "package.json"),
    );
    if (transformersVersion !== EXPECTED_VERSIONS.transformers
      || onnxruntimeVersion !== EXPECTED_VERSIONS.onnxruntime) {
      throw runtimeError("EMBEDDING_RUNTIME_VERSION_MISMATCH");
    }

    const { os, arch } = platformParts(this.options.platform);
    const nativeRoot = path.join(moduleRoot, "onnxruntime-node", "bin", "napi-v6", os, arch);
    let nativeNames: string[];
    try {
      await assertRealPathWithin(runtimeRoot, nativeRoot, true);
      nativeNames = await fs.promises.readdir(nativeRoot);
    } catch {
      throw runtimeError("EMBEDDING_RUNTIME_NATIVE_LAYOUT_INVALID");
    }
    const nativeLibraryPattern = os === "win32" ? /\.dll$/i : /\.dylib$/i;
    if (!nativeNames.includes("onnxruntime_binding.node") || !nativeNames.some((name) => nativeLibraryPattern.test(name))) {
      throw runtimeError("EMBEDDING_RUNTIME_NATIVE_LAYOUT_INVALID");
    }
    const nativePlatformRoot = path.join(moduleRoot, "onnxruntime-node", "bin", "napi-v6");
    for (const platformName of await fs.promises.readdir(nativePlatformRoot)) {
      if (platformName !== os) throw runtimeError("EMBEDDING_RUNTIME_NATIVE_LAYOUT_INVALID");
      const platformRoot = path.join(nativePlatformRoot, platformName);
      for (const architectureName of await fs.promises.readdir(platformRoot)) {
        if (architectureName !== arch) throw runtimeError("EMBEDDING_RUNTIME_NATIVE_LAYOUT_INVALID");
      }
    }

    await this.verifyManifestFiles(packRoot, runtimeRoot, manifest.files);
    const verification: ManagedEmbeddingRuntimeVerification = {
      assetId: asset.id,
      assetSha256: asset.sha256,
      internalManifestPath: manifestPath,
      internalManifestSha256: asset.internalManifestSha256,
    };
    const runtimeIdentity = {
      runtimeId: pointer.runtimeId,
      root: runtimeRoot,
      nodeExecutable,
      moduleRoot,
    };
    return {
      ...runtimeIdentity,
      versions: { ...EXPECTED_VERSIONS },
      verification,
      revalidate: async () => {
        const candidate = await this.resolve();
        if (candidate.runtimeId !== runtimeIdentity.runtimeId
          || candidate.root !== runtimeIdentity.root
          || candidate.nodeExecutable !== runtimeIdentity.nodeExecutable
          || candidate.moduleRoot !== runtimeIdentity.moduleRoot
          || candidate.verification.assetId !== verification.assetId
          || candidate.verification.assetSha256 !== verification.assetSha256
          || candidate.verification.internalManifestPath !== verification.internalManifestPath
          || candidate.verification.internalManifestSha256 !== verification.internalManifestSha256) {
          throw runtimeError("EMBEDDING_RUNTIME_SNAPSHOT_MISMATCH");
        }
        return {
          nodeExecutable: runtimeIdentity.nodeExecutable,
          moduleRoot: runtimeIdentity.moduleRoot,
          verification: { ...verification },
        };
      },
    };
  }

  async smokeTest(): Promise<EmbeddingRuntimeSmokeResult> {
    const runtime = await this.resolve();
    if (!this.options.workerBundleSource?.trim() || !this.options.buildId?.trim()) {
      throw runtimeError("EMBEDDING_RUNTIME_SMOKE_UNAVAILABLE");
    }
    const client = new EmbeddingWorkerClient({
      pluginDir: runtime.root,
      workerRoot: path.dirname(this.paths.workerVersions),
      workerDir: this.paths.workerVersions,
      buildId: this.options.buildId,
      workerBundleSource: this.options.workerBundleSource,
      execPath: runtime.nodeExecutable,
      moduleRoot: runtime.moduleRoot,
      spawnGuard: runtime.revalidate,
    });
    try {
      await client.initialize(
        this.options.smokeModelId ?? "hf-internal-testing/tiny-random-BertModel",
        this.options.smokeDtype ?? "fp32",
        this.paths.modelCache,
        undefined,
        this.options.smokeModelRevision,
      );
      const memoryUsage = await client.health();
      const embeddings = await client.embed(["Analogy runtime smoke test"]);
      const vector = embeddings[0];
      if (!Array.isArray(vector) || vector.length === 0 || !vector.every(Number.isFinite)) {
        throw runtimeError("EMBEDDING_RUNTIME_SMOKE_FAILED");
      }
      return { runtimeId: runtime.runtimeId, vectorLength: vector.length, memoryUsage };
    } catch (error) {
      if ((error as Error).message === "EMBEDDING_RUNTIME_SMOKE_FAILED") throw error;
      throw runtimeError("EMBEDDING_RUNTIME_SMOKE_FAILED", error);
    } finally {
      await client.cancelInitialization().catch(() => undefined);
      await client.dispose().catch(() => undefined);
    }
  }

  private async verifyManifestFiles(
    packRoot: string,
    runtimeRoot: string,
    files: InternalRuntimeFile[],
  ): Promise<void> {
    const seen = new Set<string>();
    for (const file of files) {
      if (!file || typeof file.path !== "string" || !Number.isSafeInteger(file.size) || file.size < 0
        || typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)
        || seen.has(file.path)) {
        throw runtimeError("EMBEDDING_RUNTIME_MANIFEST_INVALID");
      }
      seen.add(file.path);
      const filename = resolveContained(packRoot, file.path);
      await assertRealPathWithin(runtimeRoot, filename, false);
      const stat = await fs.promises.stat(filename);
      if (stat.size !== file.size) throw runtimeError("EMBEDDING_RUNTIME_HASH_MISMATCH");
      if (await sha256File(filename) !== file.sha256) {
        throw runtimeError("EMBEDDING_RUNTIME_HASH_MISMATCH");
      }
    }
    const actualFiles = new Set<string>();
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        const stat = await fs.promises.lstat(filename);
        if (stat.isSymbolicLink()) throw runtimeError("EMBEDDING_RUNTIME_UNSAFE_PATH");
        if (stat.isDirectory()) {
          await visit(filename);
        } else if (stat.isFile()) {
          const relative = path.relative(packRoot, filename).split(path.sep).join("/");
          if (relative !== "manifest.json") actualFiles.add(relative);
        } else {
          throw runtimeError("EMBEDDING_RUNTIME_UNSAFE_PATH");
        }
      }
    };
    await visit(packRoot);
    if (actualFiles.size !== seen.size
      || [...actualFiles].some((relative) => !seen.has(relative))) {
      throw runtimeError("EMBEDDING_RUNTIME_MANIFEST_INVALID");
    }
  }
}

function sha256Buffer(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
