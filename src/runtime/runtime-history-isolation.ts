import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import type { CurrentRuntimePointer } from "./atomic-runtime-installer";
import type { RuntimeAssetKind, RuntimePaths } from "./runtime-types";

const SAFE_RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const MAX_METADATA_BYTES = 64 * 1024;

export interface RuntimeHistoryIdentity {
  kind: RuntimeAssetKind;
  runtimeId: string;
  installedAt: number;
  identity: string;
}

export interface RuntimeHistoryIsolationRequest {
  item: RuntimeHistoryIdentity;
  activeRuntimeId: string | null;
  kindLock: { filename: string; token: string };
}

export interface IsolatedRuntimeHistoryItem {
  quarantinePath: string;
  recoveryMetadataPath: string;
  quarantineIdentity: string;
}

export interface RetainedRuntimeCleanupRecovery {
  kind: RuntimeAssetKind;
  runtimeId: string;
  isolatedAt: number;
  state: "retained";
}

export interface TrustedRuntimeAssetBinding {
  id: string;
  sha256: string;
}

export type TrustedRuntimeAssetResolver = (
  kind: RuntimeAssetKind,
  runtimeId: string,
) => TrustedRuntimeAssetBinding | null;

/**
 * The security boundary for history cleanup. Implementations must perform their final
 * filesystem validation and removal from the live version tree synchronously, without
 * yielding a validated source pathname to asynchronous code.
 */
export interface RuntimeHistoryIsolationAdapter {
  isolate(request: RuntimeHistoryIsolationRequest): IsolatedRuntimeHistoryItem | null;
  readyForTrash(item: IsolatedRuntimeHistoryItem): boolean;
  trashCompleted(item: IsolatedRuntimeHistoryItem): boolean;
  listRecoveries(): RetainedRuntimeCleanupRecovery[];
}

function isContainedOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

function isStrictlyContained(root: string, candidate: string): boolean {
  return path.resolve(root) !== path.resolve(candidate) && isContainedOrEqual(root, candidate);
}

function identityFor(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

function writeBufferAtStartSync(descriptor: number, value: Buffer): void {
  let offset = 0;
  while (offset < value.length) {
    const written = fs.writeSync(descriptor, value, offset, value.length - offset, offset);
    if (written <= 0) throw new Error("RUNTIME_CLEANUP_RECOVERY_WRITE_FAILED");
    offset += written;
  }
}

function safeDirectoryChain(root: string, candidate: string): boolean {
  if (!isContainedOrEqual(root, candidate)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  const components = relative ? relative.split(path.sep) : [];
  let cursor = path.resolve(root);
  try {
    for (const component of ["", ...components]) {
      if (component) cursor = path.join(cursor, component);
      const stat = fs.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    }
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    return isContainedOrEqual(realRoot, realCandidate);
  } catch {
    return false;
  }
}

function readRegularJsonSync(filename: string, dataRoot: string): unknown | null {
  if (!safeDirectoryChain(dataRoot, path.dirname(filename))) return null;
  let descriptor: number | null = null;
  try {
    const before = fs.lstatSync(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_METADATA_BYTES) return null;
    const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || identityFor(opened) !== identityFor(before)
      || opened.size > MAX_METADATA_BYTES) return null;
    return JSON.parse(fs.readFileSync(descriptor, "utf8"));
  } catch {
    return null;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function validPointer(
  value: unknown,
  paths: RuntimePaths,
  kind: RuntimeAssetKind,
  expectedRuntimeId: string | null,
  immutableHistory: boolean,
): CurrentRuntimePointer | null {
  if (!value || typeof value !== "object") return null;
  const pointer = value as Partial<CurrentRuntimePointer>;
  if (pointer.schemaVersion !== 1 || pointer.kind !== kind
    || typeof pointer.runtimeId !== "string" || !SAFE_RUNTIME_ID.test(pointer.runtimeId)
    || (expectedRuntimeId !== null && pointer.runtimeId !== expectedRuntimeId)
    || pointer.installedPath !== path.join(
      kind === "chroma" ? paths.chromaVersions : paths.embeddingVersions,
      pointer.runtimeId,
    )
    || typeof pointer.assetSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(pointer.assetSha256)
    || typeof pointer.installedAt !== "number" || !Number.isFinite(pointer.installedAt)
    || pointer.installedAt < 0
    || (immutableHistory
      ? pointer.previousRuntimeId !== null
      : pointer.previousRuntimeId !== null
        && (typeof pointer.previousRuntimeId !== "string" || !SAFE_RUNTIME_ID.test(pointer.previousRuntimeId)))) {
    return null;
  }
  return pointer as CurrentRuntimePointer;
}

export function readTrustedRuntimeHistoryPointer(
  paths: RuntimePaths,
  kind: RuntimeAssetKind,
  runtimeId: string,
  resolveTrustedAsset: TrustedRuntimeAssetResolver,
): CurrentRuntimePointer | null {
  if (!SAFE_RUNTIME_ID.test(runtimeId)) return null;
  const filename = path.join(paths.current, "history", kind, `${runtimeId}.json`);
  const pointer = validPointer(readRegularJsonSync(filename, paths.root), paths, kind, runtimeId, true);
  let binding: TrustedRuntimeAssetBinding | null;
  try {
    binding = resolveTrustedAsset(kind, runtimeId);
  } catch {
    return null;
  }
  if (!pointer || !binding || binding.id !== pointer.runtimeId
    || binding.sha256.toLowerCase() !== pointer.assetSha256.toLowerCase()) return null;
  return pointer;
}

function readCurrentPointerSync(
  paths: RuntimePaths,
  kind: RuntimeAssetKind,
): { safe: boolean; pointer: CurrentRuntimePointer | null } {
  const filename = path.join(paths.current, `${kind}.json`);
  try {
    fs.lstatSync(filename);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { safe: true, pointer: null }
      : { safe: false, pointer: null };
  }
  const pointer = validPointer(readRegularJsonSync(filename, paths.root), paths, kind, null, false);
  return { safe: pointer !== null, pointer };
}

function validHeldKindLock(paths: RuntimePaths, kind: RuntimeAssetKind, filename: string, token: string): boolean {
  const expected = path.join(paths.current, ".locks", `${kind}.lock`);
  if (filename !== expected || !/^[0-9a-f-]{36}$/i.test(token)) return false;
  const value = readRegularJsonSync(filename, paths.root) as { token?: unknown } | null;
  return value?.token === token;
}

function installLockAbsent(paths: RuntimePaths, kind: RuntimeAssetKind, runtimeId: string): boolean {
  const root = kind === "chroma" ? paths.chromaVersions : paths.embeddingVersions;
  const directory = path.join(root, ".locks");
  try {
    fs.lstatSync(directory);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  if (!safeDirectoryChain(paths.root, directory)) return false;
  try {
    fs.lstatSync(path.join(directory, `${runtimeId}.lock`));
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function ensurePrivateDirectorySync(dataRoot: string, directory: string): boolean {
  if (!isStrictlyContained(dataRoot, directory)) return false;
  const parent = path.dirname(directory);
  if (!safeDirectoryChain(dataRoot, parent)) return false;
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
  }
  if (!safeDirectoryChain(dataRoot, directory)) return false;
  try { fs.chmodSync(directory, 0o700); } catch { return false; }
  return true;
}

export class FileSystemRuntimeHistoryIsolationAdapter implements RuntimeHistoryIsolationAdapter {
  private readonly paths: RuntimePaths;
  private readonly resolveTrustedAsset: TrustedRuntimeAssetResolver;

  constructor(paths: RuntimePaths, resolveTrustedAsset: TrustedRuntimeAssetResolver) {
    this.paths = paths;
    this.resolveTrustedAsset = resolveTrustedAsset;
  }

  isolate(request: RuntimeHistoryIsolationRequest): IsolatedRuntimeHistoryItem | null {
    const { item } = request;
    if ((item.kind !== "chroma" && item.kind !== "embedding-runtime")
      || !SAFE_RUNTIME_ID.test(item.runtimeId)
      || !validHeldKindLock(this.paths, item.kind, request.kindLock.filename, request.kindLock.token)) return null;

    const versionRoot = item.kind === "chroma" ? this.paths.chromaVersions : this.paths.embeddingVersions;
    const target = path.join(versionRoot, item.runtimeId);
    const history = readTrustedRuntimeHistoryPointer(
      this.paths,
      item.kind,
      item.runtimeId,
      this.resolveTrustedAsset,
    );
    const current = readCurrentPointerSync(this.paths, item.kind);
    if (!history || history.installedAt !== item.installedAt || !current.safe
      || current.pointer?.runtimeId === item.runtimeId
      || request.activeRuntimeId === item.runtimeId || !isStrictlyContained(versionRoot, target)
      || !safeDirectoryChain(this.paths.root, versionRoot)
      || !safeDirectoryChain(versionRoot, target) || !installLockAbsent(this.paths, item.kind, item.runtimeId)) return null;
    const stat = fs.lstatSync(target);
    if (identityFor(stat) !== item.identity) return null;

    const quarantineRoot = path.join(this.paths.staging, "runtime-history-quarantine");
    if (!ensurePrivateDirectorySync(this.paths.root, quarantineRoot)) return null;
    const containerName = `${item.kind}-${item.runtimeId}-${randomUUID()}`;
    const quarantinePath = path.join(quarantineRoot, containerName);
    if (!isStrictlyContained(quarantineRoot, quarantinePath)) return null;
    fs.mkdirSync(quarantinePath, { mode: 0o700 });
    if (!safeDirectoryChain(quarantineRoot, quarantinePath)) return null;
    const isolatedRuntimePath = path.join(quarantinePath, "runtime");
    const recoveryMetadataPath = path.join(quarantinePath, "recovery.json");
    const recovery = {
      schemaVersion: 1,
      state: "prepared",
      kind: item.kind,
      runtimeId: item.runtimeId,
      sourcePath: target,
      isolatedRuntimePath,
      isolatedAt: Date.now(),
      identity: item.identity,
    };
    const recoveryDescriptor = fs.openSync(recoveryMetadataPath, "wx", 0o600);
    try {
      let recoveryBytes = Buffer.from(JSON.stringify(recovery), "utf8");
      writeBufferAtStartSync(recoveryDescriptor, recoveryBytes);
      fs.fsyncSync(recoveryDescriptor);

      // This rename is intentionally in the same synchronous boundary as the final
      // parent-chain, pointer, lock, realpath and inode checks above.
      fs.renameSync(target, isolatedRuntimePath);
      recovery.state = "isolated";
      fs.ftruncateSync(recoveryDescriptor, 0);
      recoveryBytes = Buffer.from(JSON.stringify(recovery), "utf8");
      writeBufferAtStartSync(recoveryDescriptor, recoveryBytes);
      fs.fsyncSync(recoveryDescriptor);
    } finally {
      fs.closeSync(recoveryDescriptor);
    }
    const quarantineIdentity = identityFor(fs.lstatSync(quarantinePath));
    return { quarantinePath, recoveryMetadataPath, quarantineIdentity };
  }

  readyForTrash(item: IsolatedRuntimeHistoryItem): boolean {
    const quarantineRoot = path.join(this.paths.staging, "runtime-history-quarantine");
    if (!isStrictlyContained(quarantineRoot, item.quarantinePath)
      || item.recoveryMetadataPath !== path.join(item.quarantinePath, "recovery.json")
      || !safeDirectoryChain(this.paths.root, quarantineRoot)
      || !safeDirectoryChain(quarantineRoot, item.quarantinePath)) return false;
    try {
      const stat = fs.lstatSync(item.quarantinePath);
      return stat.isDirectory() && !stat.isSymbolicLink()
        && identityFor(stat) === item.quarantineIdentity
        && fs.lstatSync(item.recoveryMetadataPath).isFile();
    } catch {
      return false;
    }
  }

  trashCompleted(item: IsolatedRuntimeHistoryItem): boolean {
    try {
      fs.lstatSync(item.quarantinePath);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  listRecoveries(): RetainedRuntimeCleanupRecovery[] {
    const quarantineRoot = path.join(this.paths.staging, "runtime-history-quarantine");
    try {
      fs.lstatSync(quarantineRoot);
    } catch {
      return [];
    }
    if (!safeDirectoryChain(this.paths.root, quarantineRoot)) return [];
    const result: RetainedRuntimeCleanupRecovery[] = [];
    for (const name of fs.readdirSync(quarantineRoot)) {
      const recoveryContainer = path.join(quarantineRoot, name);
      if (!isStrictlyContained(quarantineRoot, recoveryContainer)
        || !safeDirectoryChain(quarantineRoot, recoveryContainer)) continue;
      const recoveryPath = path.join(recoveryContainer, "recovery.json");
      const value = readRegularJsonSync(recoveryPath, this.paths.root) as {
        schemaVersion?: unknown;
        state?: unknown;
        kind?: unknown;
        runtimeId?: unknown;
        sourcePath?: unknown;
        isolatedRuntimePath?: unknown;
        isolatedAt?: unknown;
        identity?: unknown;
      } | null;
      if (!value || value.schemaVersion !== 1 || value.state !== "isolated"
        || (value.kind !== "chroma" && value.kind !== "embedding-runtime")
        || typeof value.runtimeId !== "string" || !SAFE_RUNTIME_ID.test(value.runtimeId)
        || typeof value.isolatedAt !== "number" || !Number.isFinite(value.isolatedAt)
        || value.isolatedAt < 0 || typeof value.identity !== "string"
        || value.isolatedRuntimePath !== path.join(recoveryContainer, "runtime")
        || value.sourcePath !== path.join(
          value.kind === "chroma" ? this.paths.chromaVersions : this.paths.embeddingVersions,
          value.runtimeId,
        )
        || !safeDirectoryChain(recoveryContainer, value.isolatedRuntimePath)) continue;
      result.push({
        kind: value.kind,
        runtimeId: value.runtimeId,
        isolatedAt: value.isolatedAt,
        state: "retained",
      });
    }
    result.sort((left, right) => left.isolatedAt - right.isolatedAt
      || left.kind.localeCompare(right.kind) || left.runtimeId.localeCompare(right.runtimeId));
    return result;
  }
}
