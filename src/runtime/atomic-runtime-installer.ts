import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { extractRuntimeArchive } from "./archive-extractor";
import { RuntimeAsset, RuntimeAssetKind, RuntimePaths } from "./runtime-types";

const QUARANTINE_LIMIT = 3;
const RECOVERY_LIMIT = 10;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface CurrentRuntimePointer {
  schemaVersion: 1;
  kind: RuntimeAsset["kind"];
  runtimeId: string;
  installedPath: string;
  assetSha256: string;
  installedAt: number;
  previousRuntimeId: string | null;
}

export interface InstalledRuntime extends CurrentRuntimePointer {
  executablePath: string;
}

interface InstalledRuntimeRecord {
  schemaVersion: 1;
  kind: RuntimeAssetKind;
  runtimeId: string;
  installedPath: string;
  assetSha256: string;
  installedAt: number;
}

export interface InstallRuntimeInput {
  asset: RuntimeAsset;
  verifiedAssetPath: string;
  paths: RuntimePaths;
  smokeTest(installedPath: string): Promise<void>;
  now?: () => number;
}

interface RecoveryState {
  schemaVersion: 1;
  state: "pre-smoke" | "publishing" | "published-not-current";
  kind: RuntimeAssetKind;
  runtimeId: string;
  installedPath: string;
  stagingPath: string;
  updatedAt: number;
  lockToken: string;
}

interface LockMetadata {
  schemaVersion: 1;
  pid: number;
  token: string;
  createdAt: number;
}

interface HeldLock {
  filename: string;
  metadata: LockMetadata;
}

function runtimeError(code: string, cause?: unknown): Error {
  const error = new Error(code);
  const coded = error as Error & { code?: string; cause?: unknown };
  coded.code = code;
  if (cause !== undefined) coded.cause = cause;
  return error;
}

function versionRoot(paths: RuntimePaths, kind: RuntimeAssetKind): string {
  return kind === "chroma" ? paths.chromaVersions : paths.embeddingVersions;
}

function currentFile(paths: RuntimePaths, kind: RuntimeAssetKind): string {
  return path.join(paths.current, `${kind}.json`);
}

function historyDirectory(paths: RuntimePaths, kind: RuntimeAssetKind): string {
  return path.join(paths.current, "history", kind);
}

function historyFile(paths: RuntimePaths, kind: RuntimeAssetKind, runtimeId: string): string {
  return path.join(historyDirectory(paths, kind), `${runtimeId}.json`);
}

function installRecordDirectory(paths: RuntimePaths, kind: RuntimeAssetKind): string {
  return path.join(paths.installRecords, kind);
}

function installRecordFile(paths: RuntimePaths, kind: RuntimeAssetKind, runtimeId: string): string {
  return path.join(installRecordDirectory(paths, kind), `${runtimeId}.json`);
}

function recoveryDirectory(paths: RuntimePaths, kind: RuntimeAssetKind): string {
  return path.join(paths.current, "recovery", kind);
}

function recoveryFile(paths: RuntimePaths, kind: RuntimeAssetKind, runtimeId: string): string {
  return path.join(recoveryDirectory(paths, kind), `${runtimeId}.json`);
}

function quarantineDirectory(paths: RuntimePaths, kind: RuntimeAssetKind): string {
  return path.join(paths.staging, "quarantine", kind);
}

function assertSafeComponent(value: string, code: string): void {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\")
    || /[\x00-\x1f<>:"|?*]/.test(value) || /[. ]$/.test(value) || path.isAbsolute(value)) {
    throw runtimeError(code);
  }
  const windowsBaseName = value.split(".", 1)[0].toUpperCase();
  if (/^(CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])$/.test(windowsBaseName)) {
    throw runtimeError(code);
  }
}

function assertSafeRuntimeId(runtimeId: string): void {
  assertSafeComponent(runtimeId, "RUNTIME_INVALID_ID");
}

function assertContained(root: string, candidate: string, code: string, allowRoot = false): void {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if ((!allowRoot && !relative) || relative === ".." || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw runtimeError(code);
  }
}

function resolveExecutable(runtimeRoot: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) throw runtimeError("RUNTIME_EXECUTABLE_OUTSIDE_ROOT");
  const executablePath = path.resolve(runtimeRoot, relativePath);
  assertContained(runtimeRoot, executablePath, "RUNTIME_EXECUTABLE_OUTSIDE_ROOT");
  return executablePath;
}

async function openRegularFile(
  filename: string,
  flags: number,
  mode?: number,
  code = "RUNTIME_UNSAFE_FILE",
): Promise<fs.promises.FileHandle> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filename, flags | (fs.constants.O_NOFOLLOW ?? 0), mode);
  } catch (error) {
    throw runtimeError(code, error);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw runtimeError(code);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function assertRegularFile(filePath: string, code: string): Promise<fs.Stats> {
  const handle = await openRegularFile(filePath, fs.constants.O_RDONLY, undefined, code);
  try {
    return await handle.stat();
  } finally {
    await handle.close();
  }
}

async function managedRootRealPath(paths: RuntimePaths, create: boolean): Promise<string> {
  if (create) await fs.promises.mkdir(paths.root, { recursive: true, mode: 0o700 });
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(paths.root);
  } catch (error) {
    throw runtimeError("RUNTIME_UNSAFE_DIRECTORY", error);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw runtimeError("RUNTIME_UNSAFE_DIRECTORY");
  if (create) await fs.promises.chmod(paths.root, 0o700);
  return fs.promises.realpath(paths.root);
}

async function assertExistingDirectoryChain(paths: RuntimePaths, candidate: string): Promise<void> {
  const root = path.resolve(paths.root);
  const resolvedCandidate = path.resolve(candidate);
  assertContained(root, resolvedCandidate, "RUNTIME_UNSAFE_DIRECTORY", true);
  const realRoot = await managedRootRealPath(paths, false);
  const relative = path.relative(root, resolvedCandidate);
  let cursor = root;
  for (const component of relative ? relative.split(path.sep) : []) {
    cursor = path.join(cursor, component);
    const stat = await fs.promises.lstat(cursor).catch((error) => {
      throw runtimeError("RUNTIME_UNSAFE_DIRECTORY", error);
    });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw runtimeError("RUNTIME_UNSAFE_DIRECTORY");
    const realCursor = await fs.promises.realpath(cursor);
    assertContained(realRoot, realCursor, "RUNTIME_UNSAFE_DIRECTORY", true);
  }
}

async function ensurePrivateDirectory(paths: RuntimePaths, candidate: string): Promise<void> {
  const root = path.resolve(paths.root);
  const resolvedCandidate = path.resolve(candidate);
  assertContained(root, resolvedCandidate, "RUNTIME_UNSAFE_DIRECTORY", true);
  const realRoot = await managedRootRealPath(paths, true);
  const relative = path.relative(root, resolvedCandidate);
  let cursor = root;
  for (const component of relative ? relative.split(path.sep) : []) {
    cursor = path.join(cursor, component);
    try {
      await fs.promises.mkdir(cursor, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw runtimeError("RUNTIME_UNSAFE_DIRECTORY", error);
      }
    }
    const stat = await fs.promises.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw runtimeError("RUNTIME_UNSAFE_DIRECTORY");
    await fs.promises.chmod(cursor, 0o700);
    const realCursor = await fs.promises.realpath(cursor);
    assertContained(realRoot, realCursor, "RUNTIME_UNSAFE_DIRECTORY", true);
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EISDIR" && code !== "EINVAL")) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function fsyncRegularFile(handle: fs.promises.FileHandle): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EINVAL" && code !== "ENOTSUP")) {
      throw error;
    }
  }
}

async function syncTree(root: string): Promise<void> {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    const stat = await fs.promises.lstat(entryPath);
    if (stat.isSymbolicLink()) throw runtimeError("RUNTIME_UNSAFE_INSTALLED_TREE");
    if (stat.isDirectory()) {
      await fs.promises.chmod(entryPath, 0o700);
      await syncTree(entryPath);
      continue;
    }
    if (!stat.isFile()) throw runtimeError("RUNTIME_UNSAFE_INSTALLED_TREE");
    const handle = await openRegularFile(entryPath, fs.constants.O_RDONLY, undefined, "RUNTIME_UNSAFE_INSTALLED_TREE");
    try {
      await fsyncRegularFile(handle);
    } finally {
      await handle.close();
    }
  }
  await fs.promises.chmod(root, 0o700);
  await fsyncDirectory(root);
}

async function writeSyncedTemporaryJson(filename: string, value: unknown): Promise<string> {
  const directory = path.dirname(filename);
  const temporary = path.join(directory, `.${path.basename(filename)}.${randomUUID()}.tmp`);
  const handle = await openRegularFile(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temporary;
}

async function atomicWriteJson(filename: string, value: unknown): Promise<void> {
  const temporary = await writeSyncedTemporaryJson(filename, value);
  try {
    await fs.promises.rename(temporary, filename);
    await fsyncDirectory(path.dirname(filename));
  } catch (error) {
    await fs.promises.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function atomicCreateJson(filename: string, value: unknown): Promise<void> {
  const temporary = await writeSyncedTemporaryJson(filename, value);
  try {
    await fs.promises.link(temporary, filename);
    await fs.promises.unlink(temporary);
    await fsyncDirectory(path.dirname(filename));
  } catch (error) {
    await fs.promises.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function isRuntimeKind(value: unknown): value is RuntimeAssetKind {
  return value === "chroma" || value === "embedding-runtime";
}

function validatePointer(
  value: unknown,
  paths: RuntimePaths,
  expectedKind: RuntimeAssetKind,
): CurrentRuntimePointer {
  if (!value || typeof value !== "object") throw runtimeError("RUNTIME_CURRENT_INVALID");
  const pointer = value as Partial<CurrentRuntimePointer>;
  if (pointer.schemaVersion !== 1 || !isRuntimeKind(pointer.kind) || pointer.kind !== expectedKind
    || typeof pointer.runtimeId !== "string" || typeof pointer.installedPath !== "string"
    || typeof pointer.assetSha256 !== "string" || !/^[0-9a-f]{64}$/.test(pointer.assetSha256)
    || typeof pointer.installedAt !== "number" || !Number.isFinite(pointer.installedAt)
    || (pointer.previousRuntimeId !== null && typeof pointer.previousRuntimeId !== "string")) {
    throw runtimeError("RUNTIME_CURRENT_INVALID");
  }
  assertSafeRuntimeId(pointer.runtimeId);
  if (pointer.previousRuntimeId !== null) assertSafeRuntimeId(pointer.previousRuntimeId);
  const expectedPath = path.join(versionRoot(paths, expectedKind), pointer.runtimeId);
  if (pointer.installedPath !== expectedPath) throw runtimeError("RUNTIME_CURRENT_INVALID");
  return pointer as CurrentRuntimePointer;
}

async function readPointerFile(
  filename: string,
  paths: RuntimePaths,
  kind: RuntimeAssetKind,
  missingIsNull: boolean,
): Promise<CurrentRuntimePointer | null> {
  try {
    const parentStat = await fs.promises.lstat(path.dirname(filename));
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw runtimeError("RUNTIME_UNSAFE_DIRECTORY");
    }
  } catch (error) {
    if (missingIsNull && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    await assertExistingDirectoryChain(paths, path.dirname(filename));
  } catch (error) {
    throw error;
  }
  let handle: fs.promises.FileHandle;
  try {
    handle = await openRegularFile(filename, fs.constants.O_RDONLY, undefined, "RUNTIME_CURRENT_INVALID");
  } catch (error) {
    const cause = (error as Error & { cause?: NodeJS.ErrnoException }).cause;
    if (missingIsNull && cause?.code === "ENOENT") return null;
    throw error;
  }
  let json: string;
  try {
    json = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  try {
    return validatePointer(JSON.parse(json), paths, kind);
  } catch (error) {
    if (error instanceof SyntaxError) throw runtimeError("RUNTIME_CURRENT_INVALID", error);
    throw error;
  }
}

export async function readCurrentRuntime(
  paths: RuntimePaths,
  kind: RuntimeAssetKind,
): Promise<CurrentRuntimePointer | null> {
  return readPointerFile(currentFile(paths, kind), paths, kind, true);
}

async function readLegacyCurrentRuntime(
  paths: RuntimePaths,
  kind: RuntimeAssetKind,
): Promise<CurrentRuntimePointer | null> {
  try {
    return await readPointerFile(path.join(paths.legacyCurrent, `${kind}.json`), paths, kind, true);
  } catch (error) {
    if ((error as Error).message === "RUNTIME_CURRENT_INVALID") return null;
    throw error;
  }
}

function pointerMatchesAsset(pointer: CurrentRuntimePointer, paths: RuntimePaths, asset: RuntimeAsset): boolean {
  return pointer.kind === asset.kind
    && pointer.runtimeId === asset.id
    && pointer.assetSha256 === asset.sha256
    && pointer.installedPath === path.join(versionRoot(paths, asset.kind), asset.id);
}

export async function readCurrentRuntimeForAsset(
  paths: RuntimePaths,
  asset: RuntimeAsset,
): Promise<CurrentRuntimePointer | null> {
  const current = await readCurrentRuntime(paths, asset.kind);
  if (current) return current;
  const legacy = await readLegacyCurrentRuntime(paths, asset.kind);
  if (!legacy || !pointerMatchesAsset(legacy, paths, asset)) return null;
  await assertInstalledPointerTarget(paths, legacy, "RUNTIME_CURRENT_TARGET_INVALID");
  await ensurePrivateDirectory(paths, paths.current);
  const kindLock = await acquireKindLock(paths, asset.kind, Date.now());
  try {
    const existing = await readCurrentRuntime(paths, asset.kind);
    if (existing) return existing;
    await createImmutableHistory(paths, legacy);
    await syncTree(paths.current);
    await atomicWriteJson(currentFile(paths, asset.kind), legacy);
    return legacy;
  } finally {
    await releaseLock(kindLock);
  }
}

async function readInstallRecord(
  paths: RuntimePaths,
  kind: RuntimeAssetKind,
  runtimeId: string,
): Promise<InstalledRuntimeRecord | null> {
  const filename = installRecordFile(paths, kind, runtimeId);
  let handle: fs.promises.FileHandle;
  try {
    handle = await openRegularFile(filename, fs.constants.O_RDONLY, undefined, "RUNTIME_INSTALL_RECORD_INVALID");
  } catch (error) {
    if (lockErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    throw runtimeError("RUNTIME_INSTALL_RECORD_INVALID", error);
  } finally {
    await handle.close();
  }
  const record = value as Partial<InstalledRuntimeRecord>;
  if (!record || record.schemaVersion !== 1 || record.kind !== kind || record.runtimeId !== runtimeId
    || typeof record.installedPath !== "string" || typeof record.assetSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(record.assetSha256)
    || typeof record.installedAt !== "number" || !Number.isFinite(record.installedAt)
    || record.installedPath !== path.join(versionRoot(paths, kind), runtimeId)) {
    throw runtimeError("RUNTIME_INSTALL_RECORD_INVALID");
  }
  return record as InstalledRuntimeRecord;
}

async function createInstallRecord(
  paths: RuntimePaths,
  asset: RuntimeAsset,
  installedPath: string,
  installedAt: number,
): Promise<InstalledRuntimeRecord> {
  const directory = installRecordDirectory(paths, asset.kind);
  await ensurePrivateDirectory(paths, directory);
  const record: InstalledRuntimeRecord = {
    schemaVersion: 1,
    kind: asset.kind,
    runtimeId: asset.id,
    installedPath,
    assetSha256: asset.sha256,
    installedAt,
  };
  try {
    await atomicCreateJson(installRecordFile(paths, asset.kind, asset.id), record);
  } catch (error) {
    if (lockErrorCode(error) !== "EEXIST") throw error;
    const existing = await readInstallRecord(paths, asset.kind, asset.id);
    if (!existing || existing.installedPath !== record.installedPath
      || existing.assetSha256 !== record.assetSha256) {
      throw runtimeError("RUNTIME_IDENTITY_CONFLICT", error);
    }
    return existing;
  }
  return record;
}

async function createImmutableHistory(paths: RuntimePaths, pointer: CurrentRuntimePointer): Promise<void> {
  const identity: CurrentRuntimePointer = { ...pointer, previousRuntimeId: null };
  const directory = historyDirectory(paths, pointer.kind);
  await ensurePrivateDirectory(paths, directory);
  const filename = historyFile(paths, pointer.kind, pointer.runtimeId);
  try {
    await atomicCreateJson(filename, identity);
  } catch (error) {
    const code = ((error as Error & { cause?: NodeJS.ErrnoException }).cause?.code
      ?? (error as NodeJS.ErrnoException).code);
    if (code !== "EEXIST") throw error;
    const existing = await readPointerFile(filename, paths, pointer.kind, false);
    if (!existing || existing.schemaVersion !== identity.schemaVersion || existing.kind !== identity.kind
      || existing.runtimeId !== identity.runtimeId || existing.installedPath !== identity.installedPath
      || existing.assetSha256 !== identity.assetSha256 || existing.installedAt !== identity.installedAt) {
      throw runtimeError("RUNTIME_HISTORY_CONFLICT", error);
    }
  }
}

async function assertInstalledPointerTarget(
  paths: RuntimePaths,
  pointer: CurrentRuntimePointer,
  code: string,
): Promise<void> {
  try {
    await assertExistingDirectoryChain(paths, pointer.installedPath);
    const stat = await fs.promises.lstat(pointer.installedPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw runtimeError(code);
  } catch (error) {
    if ((error as Error).message === code) throw error;
    throw runtimeError(code, error);
  }
}

async function removeRecoveryState(paths: RuntimePaths, kind: RuntimeAssetKind, runtimeId: string): Promise<void> {
  const filename = recoveryFile(paths, kind, runtimeId);
  await fs.promises.unlink(filename).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  if (fs.existsSync(path.dirname(filename))) await fsyncDirectory(path.dirname(filename));
}

async function readRecoveryState(
  paths: RuntimePaths,
  kind: RuntimeAssetKind,
  runtimeId: string,
  missingIsNull: boolean,
): Promise<RecoveryState | null> {
  const filename = recoveryFile(paths, kind, runtimeId);
  let handle: fs.promises.FileHandle;
  try {
    handle = await openRegularFile(filename, fs.constants.O_RDONLY, undefined, "RUNTIME_RECOVERY_INVALID");
  } catch (error) {
    if (missingIsNull && lockErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    throw runtimeError("RUNTIME_RECOVERY_INVALID", error);
  } finally {
    await handle.close();
  }
  if (!value || typeof value !== "object") throw runtimeError("RUNTIME_RECOVERY_INVALID");
  const state = value as Partial<RecoveryState>;
  if (state.schemaVersion !== 1 || state.kind !== kind || state.runtimeId !== runtimeId
    || (state.state !== "pre-smoke" && state.state !== "publishing" && state.state !== "published-not-current")
    || typeof state.installedPath !== "string" || typeof state.stagingPath !== "string"
    || typeof state.updatedAt !== "number" || !Number.isFinite(state.updatedAt)
    || typeof state.lockToken !== "string" || !UUID_PATTERN.test(state.lockToken)) {
    throw runtimeError("RUNTIME_RECOVERY_INVALID");
  }
  assertSafeRuntimeId(runtimeId);
  if (state.installedPath !== path.join(versionRoot(paths, kind), runtimeId)
    || path.dirname(state.stagingPath) !== paths.staging
    || !isRuntimeStagingName(runtimeId, path.basename(state.stagingPath))) {
    throw runtimeError("RUNTIME_RECOVERY_INVALID");
  }
  return state as RecoveryState;
}

async function pruneRecoveryStates(paths: RuntimePaths, kind: RuntimeAssetKind, limit: number): Promise<void> {
  const directory = recoveryDirectory(paths, kind);
  const files: Array<{ runtimeId: string; name: string; mtimeMs: number }> = [];
  for (const name of await fs.promises.readdir(directory)) {
    if (!name.endsWith(".json")) throw runtimeError("RUNTIME_RECOVERY_INVALID");
    const runtimeId = name.slice(0, -5);
    const state = await readRecoveryState(paths, kind, runtimeId, false);
    const stat = await fs.promises.lstat(path.join(directory, name));
    if (!state || !stat.isFile() || stat.isSymbolicLink()) throw runtimeError("RUNTIME_RECOVERY_INVALID");
    if (state.state === "published-not-current") files.push({ runtimeId, name, mtimeMs: stat.mtimeMs });
  }
  files.sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
  for (const file of files.slice(0, Math.max(0, files.length - limit))) {
    await fs.promises.unlink(path.join(directory, file.name));
  }
  await fsyncDirectory(directory);
}

async function writeRecoveryState(paths: RuntimePaths, state: RecoveryState, prune = true): Promise<void> {
  const directory = recoveryDirectory(paths, state.kind);
  await ensurePrivateDirectory(paths, directory);
  await atomicWriteJson(recoveryFile(paths, state.kind, state.runtimeId), state);
  if (prune) await pruneRecoveryStates(paths, state.kind, RECOVERY_LIMIT);
}

async function removeStagingCandidate(paths: RuntimePaths, candidate: string): Promise<void> {
  if (path.dirname(candidate) !== paths.staging) throw runtimeError("RUNTIME_RECOVERY_INVALID");
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw runtimeError("RUNTIME_UNSAFE_DIRECTORY");
  await fs.promises.rm(candidate, { recursive: true, force: false });
}

function isRuntimeStagingName(runtimeId: string, name: string): boolean {
  const prefix = `${runtimeId}-`;
  return name.startsWith(prefix) && UUID_PATTERN.test(name.slice(prefix.length));
}

async function reconcileRuntimeAttempt(
  paths: RuntimePaths,
  kind: RuntimeAssetKind,
  runtimeId: string,
): Promise<void> {
  const recovery = await readRecoveryState(paths, kind, runtimeId, true);
  let protectedStagingPath: string | null = null;
  if (recovery?.state === "pre-smoke") {
    await removeStagingCandidate(paths, recovery.stagingPath);
    await removeRecoveryState(paths, kind, runtimeId);
  } else if (recovery?.state === "publishing") {
    const finalStat = await fs.promises.lstat(recovery.installedPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!finalStat) {
      await removeStagingCandidate(paths, recovery.stagingPath);
      await removeRecoveryState(paths, kind, runtimeId);
    } else {
      if (!finalStat.isDirectory() || finalStat.isSymbolicLink()) {
        throw runtimeError("RUNTIME_RECOVERY_INVALID");
      }
      protectedStagingPath = recovery.stagingPath;
    }
  } else if (recovery) {
    protectedStagingPath = recovery.stagingPath;
  }
  for (const name of await fs.promises.readdir(paths.staging)) {
    if (name === "quarantine" || !isRuntimeStagingName(runtimeId, name)) continue;
    const candidate = path.join(paths.staging, name);
    if (candidate === protectedStagingPath) continue;
    await removeStagingCandidate(paths, candidate);
  }
  await fsyncDirectory(paths.staging);
}

async function quarantineCandidate(
  paths: RuntimePaths,
  kind: RuntimeAssetKind,
  runtimeId: string,
  stagingPath: string,
  now: () => number,
): Promise<void> {
  const directory = quarantineDirectory(paths, kind);
  await ensurePrivateDirectory(paths, directory);
  const destination = path.join(directory, `${runtimeId}-${now()}-${randomUUID()}`);
  await fs.promises.rename(stagingPath, destination);
  await fsyncDirectory(paths.staging);
  await fsyncDirectory(directory);
  const entries: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of await fs.promises.readdir(directory)) {
    const candidate = path.join(directory, name);
    const stat = await fs.promises.lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw runtimeError("RUNTIME_UNSAFE_DIRECTORY");
    entries.push({ name, mtimeMs: stat.mtimeMs });
  }
  entries.sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
  for (const entry of entries.slice(0, Math.max(0, entries.length - QUARANTINE_LIMIT))) {
    await fs.promises.rm(path.join(directory, entry.name), { recursive: true, force: false });
  }
  await fsyncDirectory(directory);
}

function lockErrorCode(error: unknown): string | undefined {
  return ((error as Error & { cause?: NodeJS.ErrnoException }).cause?.code
    ?? (error as NodeJS.ErrnoException).code);
}

async function readLockMetadata(filename: string): Promise<LockMetadata> {
  const handle = await openRegularFile(filename, fs.constants.O_RDONLY, undefined, "RUNTIME_LOCK_INVALID");
  let value: unknown;
  try {
    value = JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    throw runtimeError("RUNTIME_LOCK_INVALID", error);
  } finally {
    await handle.close();
  }
  if (!value || typeof value !== "object") throw runtimeError("RUNTIME_LOCK_INVALID");
  const metadata = value as Partial<LockMetadata>;
  if (metadata.schemaVersion !== 1 || !Number.isSafeInteger(metadata.pid) || metadata.pid! <= 0
    || typeof metadata.token !== "string" || !UUID_PATTERN.test(metadata.token)
    || typeof metadata.createdAt !== "number" || !Number.isFinite(metadata.createdAt)) {
    throw runtimeError("RUNTIME_LOCK_INVALID");
  }
  return metadata as LockMetadata;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function tryCreateLock(filename: string, metadata: LockMetadata): Promise<boolean> {
  try {
    await atomicCreateJson(filename, metadata);
    return true;
  } catch (error) {
    if (lockErrorCode(error) === "EEXIST") return false;
    throw error;
  }
}

async function acquireRecoverableLock(
  paths: RuntimePaths,
  directory: string,
  filename: string,
  createdAt: number,
  waitForLive: boolean,
  liveErrorCode: string,
): Promise<HeldLock> {
  await ensurePrivateDirectory(paths, directory);
  const metadata: LockMetadata = {
    schemaVersion: 1,
    pid: process.pid,
    token: randomUUID(),
    createdAt,
  };
  for (;;) {
    if (await tryCreateLock(filename, metadata)) return { filename, metadata };
    const existing = await readLockMetadata(filename);
    if (processIsAlive(existing.pid)) {
      if (!waitForLive) throw runtimeError(liveErrorCode);
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    const latest = await readLockMetadata(filename);
    if (latest.token !== existing.token) continue;
    await fs.promises.unlink(filename).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    await fsyncDirectory(directory);
  }
}

async function releaseLock(lock: HeldLock): Promise<void> {
  const existing = await readLockMetadata(lock.filename).catch((error) => {
    if (lockErrorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (!existing) return;
  if (existing.token !== lock.metadata.token) throw runtimeError("RUNTIME_LOCK_REPLACED");
  await fs.promises.unlink(lock.filename).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  await fsyncDirectory(path.dirname(lock.filename));
}

async function acquireInstallLock(
  paths: RuntimePaths,
  targetRoot: string,
  runtimeId: string,
  createdAt: number,
): Promise<HeldLock> {
  const directory = path.join(targetRoot, ".locks");
  return acquireRecoverableLock(
    paths,
    directory,
    path.join(directory, `${runtimeId}.lock`),
    createdAt,
    false,
    "RUNTIME_INSTALL_IN_PROGRESS",
  );
}

async function acquireKindLock(
  paths: RuntimePaths,
  kind: RuntimeAssetKind,
  createdAt: number,
): Promise<HeldLock> {
  const directory = path.join(paths.current, ".locks");
  return acquireRecoverableLock(
    paths,
    directory,
    path.join(directory, `${kind}.lock`),
    createdAt,
    true,
    "RUNTIME_KIND_BUSY",
  );
}

async function assertVersionAbsent(finalPath: string): Promise<void> {
  try {
    await fs.promises.lstat(finalPath);
    throw runtimeError("RUNTIME_VERSION_EXISTS");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function publishWithoutReplace(stagingPath: string, finalPath: string): Promise<void> {
  try {
    await fs.promises.mkdir(finalPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw runtimeError("RUNTIME_VERSION_EXISTS", error);
    }
    throw error;
  }
  for (const name of await fs.promises.readdir(stagingPath)) {
    await fs.promises.rename(path.join(stagingPath, name), path.join(finalPath, name));
  }
  await fs.promises.rmdir(stagingPath);
}

async function publishVaultPointerLocked(
  paths: RuntimePaths,
  asset: RuntimeAsset,
  finalPath: string,
  installedAt: number,
): Promise<CurrentRuntimePointer> {
  const oldPointer = await readCurrentRuntime(paths, asset.kind);
  if (oldPointer) {
    await assertInstalledPointerTarget(paths, oldPointer, "RUNTIME_CURRENT_TARGET_INVALID");
    await createImmutableHistory(paths, oldPointer);
  }
  const pointer: CurrentRuntimePointer = {
    schemaVersion: 1,
    kind: asset.kind,
    runtimeId: asset.id,
    installedPath: finalPath,
    assetSha256: asset.sha256,
    installedAt,
    previousRuntimeId: oldPointer?.runtimeId ?? null,
  };
  await createImmutableHistory(paths, pointer);
  await syncTree(paths.current);
  await atomicWriteJson(currentFile(paths, asset.kind), pointer);
  return pointer;
}

async function removeInstallRecord(paths: RuntimePaths, asset: RuntimeAsset): Promise<void> {
  const filename = installRecordFile(paths, asset.kind, asset.id);
  await fs.promises.unlink(filename).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  if (fs.existsSync(path.dirname(filename))) await fsyncDirectory(path.dirname(filename));
}

async function reuseInstalledRuntime(
  paths: RuntimePaths,
  asset: RuntimeAsset,
  finalPath: string,
  finalExecutable: string,
  smokeTest: (installedPath: string) => Promise<void>,
  operationTime: number,
): Promise<InstalledRuntime | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (await readInstallRecord(paths, asset.kind, asset.id)) await removeInstallRecord(paths, asset);
    return null;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw runtimeError("RUNTIME_VERSION_EXISTS");
  let record = await readInstallRecord(paths, asset.kind, asset.id);
  if (!record) {
    const legacy = await readLegacyCurrentRuntime(paths, asset.kind);
    if (!legacy || !pointerMatchesAsset(legacy, paths, asset)) {
      throw runtimeError("RUNTIME_VERSION_EXISTS");
    }
    await assertInstalledPointerTarget(paths, legacy, "RUNTIME_CURRENT_TARGET_INVALID");
    record = await createInstallRecord(paths, asset, finalPath, legacy.installedAt);
  }
  if (record.assetSha256 !== asset.sha256 || record.installedPath !== finalPath) {
    throw runtimeError("RUNTIME_IDENTITY_CONFLICT");
  }
  try {
    await smokeTest(finalPath);
  } catch (error) {
    throw runtimeError("RUNTIME_SMOKE_TEST_FAILED", error);
  }
  const kindLock = await acquireKindLock(paths, asset.kind, operationTime);
  try {
    const pointer = await publishVaultPointerLocked(paths, asset, finalPath, operationTime);
    return { ...pointer, executablePath: finalExecutable };
  } finally {
    await releaseLock(kindLock);
  }
}

export async function installRuntime(input: InstallRuntimeInput): Promise<InstalledRuntime> {
  const { asset, paths, smokeTest } = input;
  const operationTime = (input.now ?? Date.now)();
  if (!Number.isFinite(operationTime)) throw runtimeError("RUNTIME_INVALID_TIME");
  assertSafeRuntimeId(asset.id);
  await assertRegularFile(input.verifiedAssetPath, "RUNTIME_UNSAFE_VERIFIED_ASSET");

  const targetRoot = versionRoot(paths, asset.kind);
  const finalPath = path.join(targetRoot, asset.id);
  const finalExecutable = resolveExecutable(finalPath, asset.executableRelativePath);
  await ensurePrivateDirectory(paths, paths.staging);
  await ensurePrivateDirectory(paths, targetRoot);
  await ensurePrivateDirectory(paths, paths.current);

  const initialPointer = await readCurrentRuntime(paths, asset.kind);
  if (initialPointer) {
    await assertInstalledPointerTarget(paths, initialPointer, "RUNTIME_CURRENT_TARGET_INVALID");
  }
  const lock = await acquireInstallLock(paths, targetRoot, asset.id, operationTime);
  const stagingPath = path.join(paths.staging, `${asset.id}-${randomUUID()}`);
  let stagingExists = false;
  let publishStarted = false;
  let quarantined = false;
  let preSmokeRecovery = false;
  try {
    await reconcileRuntimeAttempt(paths, asset.kind, asset.id);
    const reused = await reuseInstalledRuntime(
      paths, asset, finalPath, finalExecutable, smokeTest, operationTime,
    );
    if (reused) return reused;
    await assertVersionAbsent(finalPath);
    await ensurePrivateDirectory(paths, stagingPath);
    stagingExists = true;
    await fsyncDirectory(paths.staging);
    const baseRecovery: RecoveryState = {
      schemaVersion: 1,
      state: "pre-smoke",
      kind: asset.kind,
      runtimeId: asset.id,
      installedPath: finalPath,
      stagingPath,
      updatedAt: operationTime,
      lockToken: lock.metadata.token,
    };
    await writeRecoveryState(paths, baseRecovery, false);
    preSmokeRecovery = true;
    await extractRuntimeArchive({
      archivePath: input.verifiedAssetPath,
      archive: asset.archive,
      stagingRoot: stagingPath,
      singleFileName: asset.fileName,
    });
    const candidateExecutable = resolveExecutable(stagingPath, asset.executableRelativePath);
    const executableStat = await assertRegularFile(candidateExecutable, "RUNTIME_EXECUTABLE_INVALID");
    await fs.promises.chmod(candidateExecutable, executableStat.mode | 0o100);

    try {
      await smokeTest(stagingPath);
    } catch (error) {
      await quarantineCandidate(paths, asset.kind, asset.id, stagingPath, () => operationTime);
      stagingExists = false;
      quarantined = true;
      await removeRecoveryState(paths, asset.kind, asset.id);
      preSmokeRecovery = false;
      throw runtimeError("RUNTIME_SMOKE_TEST_FAILED", error);
    }

    const kindLock = await acquireKindLock(paths, asset.kind, operationTime);
    let installRecordCreated = false;
    try {
      const recovery: RecoveryState = { ...baseRecovery, state: "publishing" };
      await writeRecoveryState(paths, recovery);
      preSmokeRecovery = false;
      await createInstallRecord(paths, asset, finalPath, operationTime);
      installRecordCreated = true;
      try {
        await publishWithoutReplace(stagingPath, finalPath);
      } catch (error) {
        if (installRecordCreated) await removeInstallRecord(paths, asset);
        if ((error as Error).message === "RUNTIME_VERSION_EXISTS") {
          await removeRecoveryState(paths, asset.kind, asset.id);
        }
        throw error;
      }
      stagingExists = false;
      publishStarted = true;
      await fsyncDirectory(paths.staging);
      await syncTree(finalPath);
      await fsyncDirectory(targetRoot);
      await writeRecoveryState(paths, { ...recovery, state: "published-not-current" });

      const pointer = await publishVaultPointerLocked(paths, asset, finalPath, operationTime);
      await removeRecoveryState(paths, asset.kind, asset.id);
      return { ...pointer, executablePath: finalExecutable };
    } finally {
      await releaseLock(kindLock);
    }
  } catch (error) {
    if (stagingExists && !publishStarted && !quarantined) {
      await fs.promises.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
      await fsyncDirectory(paths.staging).catch(() => undefined);
    }
    if (preSmokeRecovery) {
      await removeRecoveryState(paths, asset.kind, asset.id).catch(() => undefined);
    }
    throw error;
  } finally {
    await releaseLock(lock);
  }
}

export async function rollbackRuntime(
  paths: RuntimePaths,
  kind: RuntimeAssetKind,
): Promise<CurrentRuntimePointer> {
  await ensurePrivateDirectory(paths, paths.current);
  const kindLock = await acquireKindLock(paths, kind, Date.now());
  try {
    const current = await readCurrentRuntime(paths, kind);
    if (!current || current.previousRuntimeId === null) throw runtimeError("RUNTIME_ROLLBACK_UNAVAILABLE");
    const previous = await readPointerFile(
      historyFile(paths, kind, current.previousRuntimeId),
      paths,
      kind,
      false,
    );
    if (!previous || previous.runtimeId !== current.previousRuntimeId) {
      throw runtimeError("RUNTIME_ROLLBACK_UNAVAILABLE");
    }
    await assertExistingDirectoryChain(paths, previous.installedPath);
    const stat = await fs.promises.lstat(previous.installedPath).catch((error) => {
      throw runtimeError("RUNTIME_ROLLBACK_UNAVAILABLE", error);
    });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw runtimeError("RUNTIME_ROLLBACK_UNAVAILABLE");

    const rolledBack: CurrentRuntimePointer = { ...previous, previousRuntimeId: current.runtimeId };
    await atomicWriteJson(currentFile(paths, kind), rolledBack);
    return rolledBack;
  } finally {
    await releaseLock(kindLock);
  }
}
