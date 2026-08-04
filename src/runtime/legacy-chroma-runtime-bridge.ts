import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { request as httpRequest } from "http";
import { createServer } from "net";
import { spawn as nodeSpawn } from "child_process";
import type { SupportedPlatformKey } from "./runtime-types";

export interface LegacyRuntimeCandidate {
  executablePath: string;
  legacyDataPath: string;
  versionRange: ">=0.5.23 <0.6.0";
}

export interface LegacyRuntimeDiscoveryInput {
  pluginDir: string;
  legacyDataPath: string;
  platform: SupportedPlatformKey;
}

export interface LegacySourceIdentity {
  digest: string;
  totalBytes: number;
  newestMtimeMs: number;
  fileCount: number;
}

export interface LegacySnapshot {
  snapshotPath: string;
  sourceIdentity: LegacySourceIdentity;
}

export interface LegacySnapshotOptions {
  candidate: LegacyRuntimeCandidate;
  stagingRoot: string;
  migrationId: string;
  availableBytes?(): Promise<number>;
  copyFile?(source: string, target: string, flags: number): Promise<void>;
}

function legacyError(code: string, cause?: unknown): Error {
  return Object.assign(new Error(code), { code, ...(cause === undefined ? {} : { cause }) });
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function requirePlainPath(candidate: string, code: string, kind: "file" | "directory"): Promise<string> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(candidate);
  } catch (error) {
    throw legacyError(code, error);
  }
  if (stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() : !stat.isDirectory())) {
    throw legacyError(code);
  }
  try {
    return await fs.promises.realpath(candidate);
  } catch (error) {
    throw legacyError(code, error);
  }
}

export async function discoverLegacyRuntime(
  input: LegacyRuntimeDiscoveryInput,
): Promise<LegacyRuntimeCandidate> {
  const pluginDir = await requirePlainPath(input.pluginDir, "LEGACY_RUNTIME_UNTRUSTED", "directory");
  const expectedExecutable = input.platform === "win32-x64"
    ? path.join(pluginDir, "chroma-venv", "Scripts", "chroma.exe")
    : path.join(pluginDir, "chroma-venv", "bin", "chroma");
  const executablePath = await requirePlainPath(
    expectedExecutable,
    "LEGACY_RUNTIME_UNTRUSTED",
    "file",
  );
  const trustedVenv = path.join(pluginDir, "chroma-venv");
  if (!isContained(trustedVenv, executablePath)) throw legacyError("LEGACY_RUNTIME_UNTRUSTED");

  const expectedLegacyRoot = path.join(pluginDir, "chroma_data");
  const legacyDataPath = await requirePlainPath(
    input.legacyDataPath,
    "LEGACY_DATA_PATH_UNSAFE",
    "directory",
  );
  if (!isContained(expectedLegacyRoot, legacyDataPath)) throw legacyError("LEGACY_DATA_PATH_UNSAFE");

  return {
    executablePath,
    legacyDataPath,
    versionRange: ">=0.5.23 <0.6.0",
  };
}

interface SourceEntry {
  absolutePath: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

async function collectSourceEntries(root: string): Promise<SourceEntry[]> {
  const entries: SourceEntry[] = [];
  const visit = async (directory: string): Promise<void> => {
    const names = await fs.promises.readdir(directory);
    names.sort((left, right) => left.localeCompare(right, "en"));
    for (const name of names) {
      const absolutePath = path.join(directory, name);
      const stat = await fs.promises.lstat(absolutePath);
      if (stat.isSymbolicLink()) throw legacyError("LEGACY_DATA_PATH_UNSAFE");
      if (stat.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!stat.isFile()) throw legacyError("LEGACY_DATA_PATH_UNSAFE");
      const relativePath = path.relative(root, absolutePath);
      if (!relativePath || path.isAbsolute(relativePath) || relativePath.startsWith(`..${path.sep}`)) {
        throw legacyError("LEGACY_DATA_PATH_UNSAFE");
      }
      entries.push({
        absolutePath,
        relativePath: relativePath.split(path.sep).join("/"),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        dev: stat.dev,
        ino: stat.ino,
      });
    }
  };
  await visit(root);
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  return entries;
}

function identityFor(entries: readonly SourceEntry[]): LegacySourceIdentity {
  const hash = createHash("sha256");
  let totalBytes = 0;
  let newestMtimeMs = 0;
  for (const entry of entries) {
    totalBytes += entry.size;
    newestMtimeMs = Math.max(newestMtimeMs, entry.mtimeMs);
    hash.update(JSON.stringify([
      entry.relativePath, entry.size, entry.mtimeMs, entry.dev, entry.ino,
    ]), "utf8");
    hash.update("\n", "utf8");
  }
  return { digest: hash.digest("hex"), totalBytes, newestMtimeMs, fileCount: entries.length };
}

async function defaultAvailableBytes(directory: string): Promise<number> {
  const statfs = await (fs.promises as typeof fs.promises & {
    statfs(pathname: string): Promise<{ bavail: number; bsize: number }>;
  }).statfs(directory);
  return statfs.bavail * statfs.bsize;
}

export async function createLegacySnapshot(options: LegacySnapshotOptions): Promise<LegacySnapshot> {
  if (!/^[0-9a-f]{32}$/.test(options.migrationId)) throw legacyError("LEGACY_MIGRATION_ID_INVALID");
  const stagingRoot = path.resolve(options.stagingRoot);
  await fs.promises.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const snapshotPath = path.join(stagingRoot, `snapshot-${options.migrationId}`);
  if (!isContained(stagingRoot, snapshotPath)) throw legacyError("LEGACY_SNAPSHOT_PATH_UNSAFE");
  const stale = await fs.promises.lstat(snapshotPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (stale) {
    if (!stale.isDirectory() || stale.isSymbolicLink()) throw legacyError("LEGACY_SNAPSHOT_PATH_UNSAFE");
    await fs.promises.rm(snapshotPath, { recursive: true, force: true });
  }
  const sourceEntries = await collectSourceEntries(options.candidate.legacyDataPath);
  const sourceIdentity = identityFor(sourceEntries);
  const available = await (options.availableBytes ?? (() => defaultAvailableBytes(stagingRoot)))();
  if (!Number.isFinite(available) || available < sourceIdentity.totalBytes) {
    throw legacyError("INSUFFICIENT_DISK_SPACE");
  }
  const copyFile = options.copyFile ?? ((source, target, flags) => fs.promises.copyFile(source, target, flags));
  try {
    await fs.promises.mkdir(snapshotPath, { recursive: false, mode: 0o700 });
    for (const entry of sourceEntries) {
      const target = path.join(snapshotPath, ...entry.relativePath.split("/"));
      if (!isContained(snapshotPath, target)) throw legacyError("LEGACY_SNAPSHOT_PATH_UNSAFE");
      await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      try {
        await copyFile(entry.absolutePath, target, fs.constants.COPYFILE_FICLONE);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (!["ENOTSUP", "EINVAL", "EXDEV", "ENOSYS"].includes(code ?? "")) throw error;
        await copyFile(entry.absolutePath, target, 0);
      }
    }
    const afterIdentity = identityFor(await collectSourceEntries(options.candidate.legacyDataPath));
    if (afterIdentity.digest !== sourceIdentity.digest) throw legacyError("LEGACY_SOURCE_CHANGED");
    return { snapshotPath, sourceIdentity };
  } catch (error) {
    await fs.promises.rm(snapshotPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export interface LegacyBatchResponse {
  ids?: string[] | string[][];
  documents?: (string | null)[] | (string | null)[][];
  metadatas?: unknown[] | unknown[][];
  embeddings?: number[][] | number[][][];
}

export interface LegacyQueryResponse {
  ids?: string[][];
  distances?: number[][];
  documents?: (string | null)[][];
  metadatas?: unknown[][];
}

export interface LegacySourceSession {
  readonly port: number;
  readonly collectionId: string;
  readonly collectionName: string;
  readonly snapshot: LegacySnapshot;
  count(): Promise<number>;
  readBatch(offset: number, limit: number): Promise<LegacyBatchResponse>;
  query(embedding: readonly number[], topK: number): Promise<LegacyQueryResponse>;
  close(): Promise<void>;
}

export interface LegacyHttpRequest {
  port: number;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}

interface LegacyChildProcess {
  pid?: number;
  killed?: boolean;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | string | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export interface LegacyChromaRuntimeBridgeOptions {
  candidate: LegacyRuntimeCandidate;
  stagingRoot: string;
  migrationId: string;
  collectionName: string;
  platform: SupportedPlatformKey;
  createSnapshot?(options: LegacySnapshotOptions): Promise<LegacySnapshot>;
  allocatePort?(): Promise<number>;
  spawn?(
    executable: string,
    args: readonly string[],
    options: { shell: false; cwd: string; windowsHide?: boolean },
  ): LegacyChildProcess;
  requestJson?(request: LegacyHttpRequest): Promise<unknown>;
  waitMs?(milliseconds: number): Promise<void>;
  startupTimeoutMs?: number;
}

function validPort(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
}

function abortError(): Error {
  return legacyError("LEGACY_MIGRATION_CANCELLED");
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function requestJsonDefault(input: LegacyHttpRequest): Promise<unknown> {
  const payload = input.body === undefined ? undefined : JSON.stringify(input.body);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: input.port,
      path: input.path,
      method: input.method,
      timeout: 5_000,
      headers: payload ? {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      } : undefined,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(legacyError("LEGACY_CHROMA_HTTP_ERROR"));
          return;
        }
        if (!body) { resolve(undefined); return; }
        try { resolve(JSON.parse(body)); }
        catch { reject(legacyError("LEGACY_CHROMA_RESPONSE_INVALID")); }
      });
    });
    request.once("error", reject);
    request.once("timeout", () => {
      request.destroy(legacyError("LEGACY_CHROMA_HTTP_TIMEOUT"));
    });
    if (payload) request.write(payload);
    request.end();
  });
}

function parseLegacyVersion(value: unknown): readonly [number, number, number] | null {
  const text = typeof value === "string" ? value : "";
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\D.*)?$/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compatibleLegacyVersion(value: unknown): boolean {
  const version = parseLegacyVersion(value);
  if (!version || version[0] !== 0 || version[1] !== 5) return false;
  return version[2] >= 23;
}

async function stopChild(child: LegacyChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null && child.exitCode !== undefined) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    child.once("exit", finish);
    try {
      if (!child.kill("SIGTERM")) finish();
    } catch {
      finish();
    }
    timer = setTimeout(finish, 2_000);
  });
}

export class LegacyChromaRuntimeBridge {
  private readonly options: LegacyChromaRuntimeBridgeOptions;
  private child: LegacyChildProcess | null = null;
  private snapshot: LegacySnapshot | null = null;

  constructor(options: LegacyChromaRuntimeBridgeOptions) {
    this.options = options;
  }

  async prepare(signal: AbortSignal): Promise<LegacySourceSession> {
    if (signal.aborted) throw abortError();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/.test(this.options.collectionName)) {
      throw legacyError("LEGACY_COLLECTION_UNTRUSTED");
    }
    const createSnapshotHook = this.options.createSnapshot ?? createLegacySnapshot;
    const snapshot = await createSnapshotHook({
      candidate: this.options.candidate,
      stagingRoot: this.options.stagingRoot,
      migrationId: this.options.migrationId,
    });
    this.snapshot = snapshot;
    if (signal.aborted) {
      await this.cleanupSnapshot();
      throw abortError();
    }
    const port = await (this.options.allocatePort ?? allocateLoopbackPort)();
    if (!validPort(port)) throw legacyError("LEGACY_CHROMA_PORT_INVALID");
    const spawnHook = this.options.spawn ?? ((executable, args, options) =>
      nodeSpawn(executable, [...args], options) as unknown as LegacyChildProcess);
    const spawnOptions: { shell: false; cwd: string; windowsHide?: boolean } = {
      shell: false,
      cwd: snapshot.snapshotPath,
    };
    if (this.options.platform === "win32-x64") spawnOptions.windowsHide = true;
    this.child = spawnHook(this.options.candidate.executablePath, [
      "run", "--path", snapshot.snapshotPath, "--host", "127.0.0.1", "--port", String(port),
    ], spawnOptions);
    const abort = () => { void stopChild(this.child); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await this.waitUntilReady(port, signal);
      const requestJson = this.options.requestJson ?? requestJsonDefault;
      const version = await requestJson({ port, method: "GET", path: "/api/v1/version" });
      if (!compatibleLegacyVersion(version)) throw legacyError("LEGACY_CHROMA_VERSION_MISMATCH");
      const collection = await requestJson({
        port,
        method: "GET",
        path: `/api/v1/collections/${encodeURIComponent(this.options.collectionName)}`,
      }) as { id?: unknown; name?: unknown };
      if (!collection || typeof collection.id !== "string"
        || collection.name !== this.options.collectionName) {
        throw legacyError("LEGACY_COLLECTION_UNTRUSTED");
      }
      return this.createSession(port, collection.id, requestJson, signal, abort);
    } catch (error) {
      signal.removeEventListener("abort", abort);
      await stopChild(this.child);
      this.child = null;
      await this.cleanupSnapshot();
      throw signal.aborted ? abortError() : error;
    }
  }

  private async waitUntilReady(port: number, signal: AbortSignal): Promise<void> {
    const requestJson = this.options.requestJson ?? requestJsonDefault;
    const wait = this.options.waitMs ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 120_000);
    let lastError: unknown = null;
    while (Date.now() <= deadline) {
      if (signal.aborted) throw abortError();
      try {
        await requestJson({ port, method: "GET", path: "/api/v1/heartbeat" });
        return;
      } catch (error) {
        lastError = error;
      }
      await wait(250);
    }
    throw legacyError("LEGACY_CHROMA_START_TIMEOUT", lastError);
  }

  private createSession(
    port: number,
    collectionId: string,
    requestJson: (request: LegacyHttpRequest) => Promise<unknown>,
    signal: AbortSignal,
    abort: () => void,
  ): LegacySourceSession {
    const collectionPath = `/api/v1/collections/${encodeURIComponent(collectionId)}`;
    let closed = false;
    const assertOpen = () => {
      if (closed) throw legacyError("LEGACY_SOURCE_SESSION_CLOSED");
      if (signal.aborted) throw abortError();
    };
    return {
      port,
      collectionId,
      collectionName: this.options.collectionName,
      snapshot: this.snapshot as LegacySnapshot,
      count: async () => {
        assertOpen();
        const value = await requestJson({ port, method: "GET", path: `${collectionPath}/count` });
        if (!Number.isSafeInteger(value) || (value as number) < 0) throw legacyError("LEGACY_RECORD_COUNT_INVALID");
        return value as number;
      },
      readBatch: async (offset, limit) => {
        assertOpen();
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1024) {
          throw legacyError("LEGACY_BATCH_RANGE_INVALID");
        }
        return await requestJson({
          port,
          method: "POST",
          path: `${collectionPath}/get`,
          body: { offset, limit, include: ["documents", "metadatas", "embeddings"] },
        }) as LegacyBatchResponse;
      },
      query: async (embedding, topK) => {
        assertOpen();
        if (!embedding.length || embedding.some((value) => !Number.isFinite(value))
          || !Number.isSafeInteger(topK) || topK < 1 || topK > 100) {
          throw legacyError("LEGACY_QUERY_INVALID");
        }
        return await requestJson({
          port,
          method: "POST",
          path: `${collectionPath}/query`,
          body: { query_embeddings: [[...embedding]], n_results: topK },
        }) as LegacyQueryResponse;
      },
      close: async () => {
        if (closed) return;
        closed = true;
        signal.removeEventListener("abort", abort);
        await stopChild(this.child);
        this.child = null;
        await this.cleanupSnapshot();
      },
    };
  }

  private async cleanupSnapshot(): Promise<void> {
    const snapshot = this.snapshot;
    this.snapshot = null;
    if (!snapshot) return;
    const stagingRoot = path.resolve(this.options.stagingRoot);
    const target = path.resolve(snapshot.snapshotPath);
    if (!isContained(stagingRoot, target)) throw legacyError("LEGACY_SNAPSHOT_PATH_UNSAFE");
    await fs.promises.rm(target, { recursive: true, force: true });
  }
}
