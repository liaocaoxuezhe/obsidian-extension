import * as fs from "fs";
import * as https from "https";
import { once } from "events";
import { IncomingHttpHeaders, IncomingMessage } from "http";
import { Readable } from "stream";
import { RuntimeAsset } from "./runtime-types";

const MAX_REDIRECTS = 5;
const PROGRESS_INTERVAL_MS = 100;

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  bytesPerSecond: number | null;
}

export interface DownloadedAsset {
  path: string;
  metaPath: string;
  receivedBytes: number;
  etag: string | null;
  lastModified: string | null;
  resumed: boolean;
}

export interface RuntimeDownloadResponse extends Readable {
  statusCode?: number;
  headers: IncomingHttpHeaders;
}

export interface RuntimeRequestOptions {
  headers: Record<string, string>;
  signal: AbortSignal;
}

export type RuntimeRequest = (
  url: URL,
  options: RuntimeRequestOptions,
) => Promise<RuntimeDownloadResponse>;

export interface DownloadRuntimeAssetInput {
  asset: RuntimeAsset;
  partPath: string;
  signal: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
  request?: RuntimeRequest;
  now?: () => number;
}

interface DownloadMetadata {
  schemaVersion: 1;
  assetId: string;
  sha256: string;
  expectedSize: number;
  etag: string | null;
  lastModified: string | null;
}

interface ResumeState {
  size: number;
  metadata: DownloadMetadata | null;
}

function downloadError(code: string, cause?: unknown): Error {
  const error = new Error(code);
  const codedError = error as Error & { cause?: unknown; code?: string };
  codedError.code = code;
  if (cause !== undefined) codedError.cause = cause;
  return error;
}

function isDownloadError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("DOWNLOAD_");
}

function header(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value === undefined ? null : String(value);
}

function parseContentLength(headers: IncomingHttpHeaders): number | null {
  const value = header(headers, "content-length");
  if (value === null) return null;
  if (!/^\d+$/.test(value)) throw downloadError("DOWNLOAD_INVALID_CONTENT_LENGTH");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw downloadError("DOWNLOAD_INVALID_CONTENT_LENGTH");
  return parsed;
}

function isRedirect(statusCode: number): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303
    || statusCode === 307 || statusCode === 308;
}

async function defaultRequest(url: URL, options: RuntimeRequestOptions): Promise<RuntimeDownloadResponse> {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: "GET", headers: options.headers }, (response: IncomingMessage) => {
      cleanup();
      resolve(response);
    });
    const onAbort = () => request.destroy(downloadError("DOWNLOAD_CANCELLED"));
    const cleanup = () => options.signal.removeEventListener("abort", onAbort);
    options.signal.addEventListener("abort", onAbort, { once: true });
    request.once("error", (error) => {
      cleanup();
      reject(options.signal.aborted ? downloadError("DOWNLOAD_CANCELLED", error) : error);
    });
    if (options.signal.aborted) onAbort();
    else request.end();
  });
}

async function requestFollowingRedirects(
  startUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  request: RuntimeRequest,
): Promise<RuntimeDownloadResponse> {
  let current = new URL(startUrl);
  if (current.protocol !== "https:") throw downloadError("DOWNLOAD_INSECURE_URL");

  for (let redirects = 0; ; redirects += 1) {
    if (signal.aborted) throw downloadError("DOWNLOAD_CANCELLED");
    let response: RuntimeDownloadResponse;
    try {
      response = await request(current, { headers, signal });
    } catch (error) {
      if (signal.aborted) throw downloadError("DOWNLOAD_CANCELLED", error);
      throw isDownloadError(error) ? error : downloadError("DOWNLOAD_NETWORK_ERROR", error);
    }
    const statusCode = response.statusCode ?? 0;
    if (!isRedirect(statusCode)) return response;
    const location = header(response.headers, "location");
    response.destroy();
    if (!location) throw downloadError("DOWNLOAD_INVALID_REDIRECT");
    if (redirects >= MAX_REDIRECTS) throw downloadError("DOWNLOAD_TOO_MANY_REDIRECTS");
    const next = new URL(location, current);
    if (current.protocol !== "https:" || next.protocol !== "https:") {
      throw downloadError("DOWNLOAD_INSECURE_REDIRECT");
    }
    current = next;
  }
}

async function optionalLstat(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertRegular(stat: fs.Stats, errorCode: string): void {
  if (stat.isSymbolicLink() || !stat.isFile()) throw downloadError(errorCode);
}

function metadataMatchesAsset(metadata: DownloadMetadata, asset: RuntimeAsset): boolean {
  return metadata.schemaVersion === 1
    && metadata.assetId === asset.id
    && metadata.sha256 === asset.sha256
    && metadata.expectedSize === asset.size
    && (typeof metadata.etag === "string" || metadata.etag === null)
    && (typeof metadata.lastModified === "string" || metadata.lastModified === null);
}

function createIsolationId(): string {
  return `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
}

async function isolate(filePath: string, isolationId: string, errorCode: string): Promise<void> {
  const stat = await optionalLstat(filePath);
  if (!stat) return;
  assertRegular(stat, errorCode);
  await fs.promises.rename(filePath, `${filePath}.isolated-${isolationId}`);
}

async function isolatePartAndMetadata(partPath: string, metaPath: string): Promise<void> {
  const isolationId = createIsolationId();
  await isolate(partPath, isolationId, "DOWNLOAD_UNSAFE_PART");
  await isolate(metaPath, isolationId, "DOWNLOAD_UNSAFE_META");
}

function sameOpenedFile(expected: fs.Stats, actual: fs.Stats): boolean {
  if (expected.dev !== actual.dev) return false;
  if (expected.ino !== 0 && actual.ino !== 0 && expected.ino !== actual.ino) return false;
  return true;
}

async function readMetadataSafely(metaPath: string, expectedStat: fs.Stats): Promise<DownloadMetadata> {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(metaPath, flags);
  } catch (error) {
    throw downloadError("DOWNLOAD_UNSAFE_META", error);
  }
  try {
    const [openStat, currentStat] = await Promise.all([handle.stat(), fs.promises.lstat(metaPath)]);
    assertRegular(openStat, "DOWNLOAD_UNSAFE_META");
    assertRegular(currentStat, "DOWNLOAD_UNSAFE_META");
    if (!sameOpenedFile(expectedStat, openStat) || !sameOpenedFile(currentStat, openStat)) {
      throw downloadError("DOWNLOAD_UNSAFE_META");
    }
    return JSON.parse(await handle.readFile("utf8")) as DownloadMetadata;
  } catch (error) {
    if (error instanceof SyntaxError || isDownloadError(error)) throw error;
    throw downloadError("DOWNLOAD_UNSAFE_META", error);
  } finally {
    await handle.close();
  }
}

async function prepareResumeState(asset: RuntimeAsset, partPath: string): Promise<ResumeState> {
  const metaPath = `${partPath}.meta.json`;
  const [partStat, metaStat] = await Promise.all([optionalLstat(partPath), optionalLstat(metaPath)]);
  if (partStat) assertRegular(partStat, "DOWNLOAD_UNSAFE_PART");
  if (metaStat) assertRegular(metaStat, "DOWNLOAD_UNSAFE_META");
  if (!partStat && !metaStat) return { size: 0, metadata: null };

  let metadata: DownloadMetadata | null = null;
  if (partStat && metaStat) {
    try {
      metadata = await readMetadataSafely(metaPath, metaStat);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      metadata = null;
    }
  }
  const resumable = partStat !== null
    && metaStat !== null
    && metadata !== null
    && metadataMatchesAsset(metadata, asset)
    && partStat.size > 0
    && partStat.size <= asset.size
    && Boolean(metadata.etag || metadata.lastModified);
  if (resumable) return { size: partStat.size, metadata };

  await isolatePartAndMetadata(partPath, metaPath);
  return { size: 0, metadata: null };
}

async function writeMetadataAtomically(metaPath: string, metadata: DownloadMetadata): Promise<void> {
  const temporaryPath = `${metaPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporaryPath, metaPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function validatorsMatch(metadata: DownloadMetadata, response: RuntimeDownloadResponse): boolean {
  const etag = header(response.headers, "etag");
  const lastModified = header(response.headers, "last-modified");
  if (metadata.etag !== null) return etag === metadata.etag;
  return metadata.lastModified !== null && lastModified === metadata.lastModified;
}

function assertMatchingRange(response: RuntimeDownloadResponse, start: number, total: number): void {
  const value = header(response.headers, "content-range");
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match) throw downloadError("DOWNLOAD_INVALID_CONTENT_RANGE");
  const rangeStart = Number(match[1]);
  const rangeEnd = Number(match[2]);
  const rangeTotal = Number(match[3]);
  if (rangeStart !== start || rangeEnd !== total - 1 || rangeTotal !== total) {
    throw downloadError("DOWNLOAD_INVALID_CONTENT_RANGE");
  }
}

async function closeFileDescriptor(fd: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    fs.close(fd, (error) => error ? reject(error) : resolve());
  });
}

async function streamToPart(
  response: RuntimeDownloadResponse,
  partPath: string,
  startSize: number,
  totalBytes: number | null,
  signal: AbortSignal,
  onProgress: ((progress: DownloadProgress) => void) | undefined,
  now: () => number,
): Promise<number> {
  let output: fs.WriteStream | null = null;
  const startedAt = now();
  let lastPublishedAt = Number.NEGATIVE_INFINITY;
  let lastPublishedBytes = -1;
  let receivedBytes = startSize;
  let fd: number | null = null;
  const emitProgress = (current: number) => {
    if (!onProgress) return;
    const elapsedMs = current - startedAt;
    onProgress({
      receivedBytes,
      totalBytes,
      percent: totalBytes === null || totalBytes === 0 ? null : Math.min(100, receivedBytes / totalBytes * 100),
      bytesPerSecond: elapsedMs <= 0 ? null : Math.max(0, (receivedBytes - startSize) * 1000 / elapsedMs),
    });
    lastPublishedAt = current;
    lastPublishedBytes = receivedBytes;
  };
  const publish = () => {
    if (!onProgress || receivedBytes === lastPublishedBytes) return;
    const current = now();
    if (current - lastPublishedAt < PROGRESS_INTERVAL_MS) return;
    emitProgress(current);
  };
  const publishFinal = async () => {
    if (!onProgress || receivedBytes === lastPublishedBytes) return;
    let current = now();
    while (current - lastPublishedAt < PROGRESS_INTERVAL_MS) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(downloadError("DOWNLOAD_CANCELLED"));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, PROGRESS_INTERVAL_MS - (current - lastPublishedAt));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      current = now();
    }
    if (signal.aborted) throw downloadError("DOWNLOAD_CANCELLED");
    emitProgress(current);
  };
  const cancel = () => {
    // The AbortSignal is the authoritative cancellation reason. Destroying a
    // stream with an Error can emit before the async iterator/write pipeline
    // has attached its rejection handler (notably on Windows), surfacing an
    // uncaught exception instead of the bounded DOWNLOAD_CANCELLED result.
    response.destroy();
    output?.destroy();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (startSize === 0) {
      output = fs.createWriteStream(partPath, { flags: "wx", mode: 0o600, autoClose: false });
      output.on("error", () => undefined);
      const [openedFd] = await once(output, "open");
      fd = openedFd as number;
    } else {
      const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0);
      fd = await new Promise<number>((resolve, reject) => {
        fs.open(partPath, flags, 0o600, (error, openedFd) => error ? reject(error) : resolve(openedFd));
      });
      output = fs.createWriteStream(partPath, { fd, autoClose: false });
      output.on("error", () => undefined);
    }
    const openStat = await new Promise<fs.Stats>((resolve, reject) => fs.fstat(fd!, (error, stat) => error ? reject(error) : resolve(stat)));
    if (!openStat.isFile() || openStat.size !== startSize) throw downloadError("DOWNLOAD_PART_CHANGED");
    if (signal.aborted) throw downloadError("DOWNLOAD_CANCELLED");
    for await (const chunk of response) {
      if (signal.aborted) throw downloadError("DOWNLOAD_CANCELLED");
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      receivedBytes += bytes.length;
      if (!output.write(bytes)) await once(output, "drain");
      publish();
    }
    const finished = once(output, "finish");
    output.end();
    await finished;
    await new Promise<void>((resolve, reject) => fs.fsync(fd!, (error) => error ? reject(error) : resolve()));
    await closeFileDescriptor(fd);
    fd = null;
    await publishFinal();
    return receivedBytes;
  } catch (error) {
    response.destroy();
    output?.destroy();
    if (fd !== null) {
      const fdToClose = fd;
      await new Promise<void>((resolve) => fs.close(fdToClose, () => resolve()));
      fd = null;
    }
    if (signal.aborted || (error as Error).message === "DOWNLOAD_CANCELLED") {
      throw downloadError("DOWNLOAD_CANCELLED", error);
    }
    if ((response as RuntimeDownloadResponse & { errored?: unknown }).errored === error) {
      throw downloadError("DOWNLOAD_NETWORK_ERROR", error);
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

async function acquireLock(lockPath: string): Promise<fs.promises.FileHandle> {
  try {
    return await fs.promises.open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw downloadError("DOWNLOAD_IN_PROGRESS", error);
    }
    throw error;
  }
}

export async function downloadRuntimeAsset(input: DownloadRuntimeAssetInput): Promise<DownloadedAsset> {
  const { asset, partPath, signal, onProgress } = input;
  if (signal.aborted) throw downloadError("DOWNLOAD_CANCELLED");
  const request = input.request ?? defaultRequest;
  const now = input.now ?? Date.now;
  const metaPath = `${partPath}.meta.json`;
  const lockPath = `${partPath}.lock`;
  await fs.promises.mkdir(require("path").dirname(partPath), { recursive: true, mode: 0o700 });
  const lock = await acquireLock(lockPath);
  try {
    let state = await prepareResumeState(asset, partPath);
    if (state.size === asset.size && state.metadata) {
      return {
        path: partPath, metaPath, receivedBytes: state.size,
        etag: state.metadata.etag, lastModified: state.metadata.lastModified, resumed: true,
      };
    }

    for (;;) {
      const headers: Record<string, string> = {};
      if (state.size > 0 && state.metadata) {
        headers.Range = `bytes=${state.size}-`;
        headers["If-Range"] = state.metadata.etag ?? state.metadata.lastModified!;
      }
      const response = await requestFollowingRedirects(asset.url, headers, signal, request);
      try {
        const statusCode = response.statusCode ?? 0;
        let resumed = state.size > 0;

        if (resumed && statusCode === 206) {
          assertMatchingRange(response, state.size, asset.size);
          if (!validatorsMatch(state.metadata!, response)) {
            await isolatePartAndMetadata(partPath, metaPath);
            state = { size: 0, metadata: null };
            continue;
          }
        } else if (resumed && statusCode === 200) {
          await isolatePartAndMetadata(partPath, metaPath);
          state = { size: 0, metadata: null };
          resumed = false;
        } else if (!resumed && statusCode !== 200) {
          throw downloadError("DOWNLOAD_UNEXPECTED_STATUS");
        } else if (resumed) {
          throw downloadError("DOWNLOAD_UNEXPECTED_STATUS");
        }

        const responseLength = parseContentLength(response.headers);
        const expectedResponseLength = asset.size - state.size;
        if (responseLength !== null && responseLength !== expectedResponseLength) {
          throw downloadError("DOWNLOAD_SIZE_MISMATCH");
        }
        const etag = header(response.headers, "etag");
        const lastModified = header(response.headers, "last-modified");
        const metadata: DownloadMetadata = {
          schemaVersion: 1,
          assetId: asset.id,
          sha256: asset.sha256,
          expectedSize: asset.size,
          etag,
          lastModified,
        };
        if (!resumed) await writeMetadataAtomically(metaPath, metadata);

        const totalBytes = responseLength === null ? null : state.size + responseLength;
        const receivedBytes = await streamToPart(
          response, partPath, state.size, totalBytes, signal, onProgress, now,
        );
        if (receivedBytes !== asset.size) throw downloadError("DOWNLOAD_SIZE_MISMATCH");
        return { path: partPath, metaPath, receivedBytes, etag, lastModified, resumed };
      } finally {
        response.destroy();
      }
    }
  } finally {
    await lock.close().catch(() => undefined);
    await fs.promises.unlink(lockPath).catch(() => undefined);
  }
}
