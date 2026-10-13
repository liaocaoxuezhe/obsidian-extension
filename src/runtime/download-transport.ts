import { Readable } from "stream";
import type { IncomingHttpHeaders } from "http";
import type { RuntimeDownloadResponse, RuntimeRequest } from "./runtime-downloader";

/**
 * Minimal shape of Obsidian's `requestUrl`. It runs in Electron's network
 * stack, so it honours the system proxy / PAC configuration and is not
 * subject to CORS — unlike Node's `https`, which connects directly.
 */
export type ProxyAwareFetch = (request: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  throw?: boolean;
}) => Promise<{ status: number; headers: Record<string, string>; arrayBuffer: ArrayBuffer }>;

export interface ChunkedTransportOptions {
  chunkSize?: number;
  /** Maximum time for one chunk; a slower chunk is treated as a stall. */
  chunkTimeoutMs?: number;
}

const DEFAULT_CHUNK_SIZE = 2 * 1024 * 1024;
const DEFAULT_CHUNK_TIMEOUT_MS = 90_000;

function transportError(code: string, cause?: unknown): Error {
  return Object.assign(new Error(code), { code, ...(cause === undefined ? {} : { cause }) });
}

function lowerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) result[key.toLowerCase()] = String(value);
  return result;
}

function parseContentRange(value: string | undefined): { start: number; end: number; total: number } | null {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(transportError("DOWNLOAD_STALLED")), timeoutMs);
        onAbort = () => reject(transportError("DOWNLOAD_CANCELLED"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Adapts a proxy-aware, whole-response fetch into the downloader's streaming
 * request contract by fetching sequential byte ranges. Resume, progress, stall
 * detection and SHA-256 verification in the downloader keep working unchanged.
 */
export function createChunkedTransport(fetch: ProxyAwareFetch, options: ChunkedTransportOptions = {}): RuntimeRequest {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkTimeoutMs = options.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS;
  return async (url, requestOptions) => {
    const incoming = lowerHeaders(requestOptions.headers);
    const requestedStart = /^bytes=(\d+)-$/.exec(incoming.range ?? "");
    const start = requestedStart ? Number(requestedStart[1]) : 0;
    const fetchRange = async (from: number, validator: string | null) => {
      const headers: Record<string, string> = { Range: `bytes=${from}-${from + chunkSize - 1}` };
      if (validator) headers["If-Range"] = validator;
      try {
        return await withTimeout(fetch({ url: url.toString(), method: "GET", headers, throw: false }), chunkTimeoutMs, requestOptions.signal);
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (code === "DOWNLOAD_STALLED" || code === "DOWNLOAD_CANCELLED") throw error;
        throw transportError("DOWNLOAD_NETWORK_ERROR", error);
      }
    };

    const first = await fetchRange(start, incoming["if-range"] ?? null);
    const firstHeaders = lowerHeaders(first.headers);
    const etag = firstHeaders.etag ?? null;
    const lastModified = firstHeaders["last-modified"] ?? null;
    const headers: IncomingHttpHeaders = {};
    if (etag) headers.etag = etag;
    if (lastModified) headers["last-modified"] = lastModified;

    // A server that ignores ranges returns the whole object at once.
    if (first.status === 200) {
      const body = Buffer.from(first.arrayBuffer);
      headers["content-length"] = String(body.length);
      return Object.assign(Readable.from([body]), { statusCode: 200, headers }) as RuntimeDownloadResponse;
    }
    if (first.status !== 206) {
      return Object.assign(Readable.from([]), { statusCode: first.status, headers }) as RuntimeDownloadResponse;
    }
    const range = parseContentRange(firstHeaders["content-range"]);
    if (!range || range.start !== start) throw transportError("DOWNLOAD_INVALID_CONTENT_RANGE");
    const total = range.total;
    const validator = etag ?? lastModified;
    async function* chunks(): AsyncGenerator<Buffer> {
      yield Buffer.from(first.arrayBuffer);
      let next = range!.end + 1;
      while (next < total) {
        if (requestOptions.signal.aborted) throw transportError("DOWNLOAD_CANCELLED");
        const response = await fetchRange(next, validator);
        const current = parseContentRange(lowerHeaders(response.headers)["content-range"]);
        if (response.status !== 206 || !current || current.start !== next || current.total !== total) {
          throw transportError("DOWNLOAD_PART_CHANGED");
        }
        yield Buffer.from(response.arrayBuffer);
        next = current.end + 1;
      }
    }
    if (requestedStart) {
      headers["content-range"] = `bytes ${start}-${total - 1}/${total}`;
      headers["content-length"] = String(total - start);
      return Object.assign(Readable.from(chunks()), { statusCode: 206, headers }) as RuntimeDownloadResponse;
    }
    headers["content-length"] = String(total);
    return Object.assign(Readable.from(chunks()), { statusCode: 200, headers }) as RuntimeDownloadResponse;
  };
}
