import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import {
  defaultRequest,
  downloadRuntimeAsset,
  type RuntimeRequest,
} from "../runtime/runtime-downloader";
import { MODEL_FILE_MANIFESTS, type ModelFileEntry, type ModelFileManifest } from "./model-file-manifest";
import { embeddingFailureError, extractFailureEvidence } from "./embedding-failure";
import type { EmbeddingInitializationProgress } from "./embedding-worker-protocol";

/** Default download sources, tried after a user-configured host. */
export const DEFAULT_MODEL_HOSTS: readonly string[] = ["https://hf-mirror.com/", "https://huggingface.co/"];
const STAMP_FILE = ".analogy-files.json";
const PROBE_TIMEOUT_MS = 6_000;

export interface EnsureModelFilesInput {
  shortName: string;
  /** Model cache root for this model; files land in `<cacheDir>/<repo id>/<file>`. */
  cacheDir: string;
  /** Preferred host first (for example the user's custom mirror). */
  hosts?: readonly string[];
  /** Transports in fallback order (direct Node HTTPS, then the proxy-aware one). */
  transports?: readonly RuntimeRequest[];
  signal?: AbortSignal;
  onProgress?: (progress: EmbeddingInitializationProgress) => void;
  /** Test seams. */
  probe?: (hosts: readonly string[], manifest: ModelFileManifest) => Promise<string[]>;
  stallTimeoutMs?: number;
}

interface Stamp {
  schemaVersion: 1;
  revision: string;
  files: Record<string, { size: number; mtimeMs: number }>;
}

export function getModelFileManifest(shortName: string): ModelFileManifest | null {
  return MODEL_FILE_MANIFESTS[shortName] ?? null;
}

function normalizeHost(host: string): string | null {
  const trimmed = host.trim();
  if (!/^https:\/\/[^\s/]+/i.test(trimmed)) return null;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export function modelHosts(preferred?: string | null): string[] {
  const hosts: string[] = [];
  for (const candidate of [preferred ?? "", ...DEFAULT_MODEL_HOSTS]) {
    const host = candidate ? normalizeHost(candidate) : null;
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

function fileUrl(host: string, manifest: ModelFileManifest, file: ModelFileEntry): string {
  return `${host}${manifest.id}/resolve/${manifest.revision}/${file.path}`;
}

function targetPath(cacheDir: string, manifest: ModelFileManifest, file: ModelFileEntry): string {
  const target = path.join(cacheDir, ...manifest.id.split("/"), ...file.path.split("/"));
  const relative = path.relative(cacheDir, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw embeddingFailureError({ code: "EMBEDDING_MODEL_CACHE_CORRUPT", subStage: "model-files", evidence: ["MODEL_FILE_UNSAFE_PATH"] });
  }
  return target;
}

async function sha256File(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function readStamp(cacheDir: string): Promise<Stamp | null> {
  try {
    const stamp = JSON.parse(await fs.promises.readFile(path.join(cacheDir, STAMP_FILE), "utf8"));
    return stamp?.schemaVersion === 1 && typeof stamp.revision === "string" && stamp.files ? stamp as Stamp : null;
  } catch {
    return null;
  }
}

async function writeStamp(cacheDir: string, stamp: Stamp): Promise<void> {
  const filename = path.join(cacheDir, STAMP_FILE);
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temporary, `${JSON.stringify(stamp)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.promises.rename(temporary, filename);
}

/** A file is current when it matches the stamp (size + mtime) or its SHA-256. */
async function isFileCurrent(filename: string, file: ModelFileEntry, stamp: Stamp | null, revision: string): Promise<boolean> {
  let stat: fs.Stats;
  try { stat = await fs.promises.lstat(filename); } catch { return false; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size) return false;
  const stamped = stamp?.revision === revision ? stamp.files[file.path] : undefined;
  if (stamped && stamped.size === stat.size && stamped.mtimeMs === stat.mtimeMs) return true;
  return await sha256File(filename) === file.sha256;
}

/** Orders hosts by time to first byte of a tiny range request; unreachable ones go last. */
async function probeHosts(hosts: readonly string[], manifest: ModelFileManifest): Promise<string[]> {
  if (hosts.length < 2) return [...hosts];
  const smallest = [...manifest.files].sort((left, right) => left.size - right.size)[0];
  const results = await Promise.all(hosts.map(async (host, index) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const started = Date.now();
    try {
      const response = await defaultRequest(new URL(fileUrl(host, manifest, smallest)), {
        headers: { Range: "bytes=0-0" },
        signal: controller.signal,
      });
      response.destroy();
      const status = response.statusCode ?? 0;
      return { host, index, latency: status >= 200 && status < 400 ? Date.now() - started : Number.POSITIVE_INFINITY };
    } catch {
      return { host, index, latency: Number.POSITIVE_INFINITY };
    } finally {
      clearTimeout(timer);
    }
  }));
  return results
    .sort((left, right) => left.latency - right.latency || left.index - right.index)
    .map((result) => result.host);
}

/**
 * Makes sure every pinned file of a model exists and is verified, downloading
 * only what is missing. Returns false for models without a pinned manifest.
 */
export async function ensureModelFiles(input: EnsureModelFilesInput): Promise<boolean> {
  const manifest = getModelFileManifest(input.shortName);
  if (!manifest) return false;
  const signal = input.signal ?? new AbortController().signal;
  await fs.promises.mkdir(input.cacheDir, { recursive: true, mode: 0o700 });
  const stamp = await readStamp(input.cacheDir);
  const nextStamp: Stamp = { schemaVersion: 1, revision: manifest.revision, files: {} };
  const missing: ModelFileEntry[] = [];
  for (const file of manifest.files) {
    if (signal.aborted) throw Object.assign(new Error("DOWNLOAD_CANCELLED"), { code: "DOWNLOAD_CANCELLED" });
    const filename = targetPath(input.cacheDir, manifest, file);
    if (await isFileCurrent(filename, file, stamp, manifest.revision)) {
      const stat = await fs.promises.stat(filename);
      nextStamp.files[file.path] = { size: stat.size, mtimeMs: stat.mtimeMs };
    } else {
      missing.push(file);
    }
  }
  if (missing.length > 0) {
    const totalBytes = missing.reduce((sum, file) => sum + file.size, 0);
    let completedBytes = 0;
    const hosts = await (input.probe ?? probeHosts)(input.hosts?.length ? input.hosts : DEFAULT_MODEL_HOSTS, manifest);
    const downloads = path.join(input.cacheDir, ".downloads");
    await fs.promises.mkdir(downloads, { recursive: true, mode: 0o700 });
    for (const file of missing) {
      const partPath = path.join(downloads, `${file.sha256}.part`);
      const report = (loaded: number) => input.onProgress?.({
        phase: "downloading",
        file: path.posix.basename(file.path),
        loadedBytes: completedBytes + loaded,
        totalBytes,
        percent: totalBytes > 0 ? Math.min(100, ((completedBytes + loaded) / totalBytes) * 100) : null,
      });
      report(0);
      let downloadedPath: string;
      try {
        const urls = hosts.map((host) => fileUrl(host, manifest, file));
        const downloaded = await downloadRuntimeAsset({
          asset: { id: `model-${input.shortName}-${file.sha256.slice(0, 16)}`, url: urls[0], size: file.size, sha256: file.sha256 },
          alternateUrls: urls.slice(1),
          partPath,
          signal,
          requests: input.transports?.length ? [...input.transports] : undefined,
          stallTimeoutMs: input.stallTimeoutMs,
          onProgress: (progress) => report(progress.receivedBytes),
        });
        downloadedPath = downloaded.path;
      } catch (error) {
        const code = (error as { code?: string })?.code ?? "";
        if (code === "DOWNLOAD_CANCELLED" || signal.aborted) throw error;
        if (code === "ENOSPC" || code === "EACCES" || code === "EPERM") throw error;
        throw embeddingFailureError({
          code: "EMBEDDING_MODEL_NETWORK_FAILED",
          subStage: "model-download",
          evidence: extractFailureEvidence(String((error as Error)?.message ?? ""), [code, path.posix.basename(file.path)]),
        }, `Model file download failed: ${code || (error as Error)?.message}`);
      }
      if (await sha256File(downloadedPath) !== file.sha256) {
        await fs.promises.rm(downloadedPath, { force: true });
        await fs.promises.rm(`${downloadedPath}.meta.json`, { force: true });
        throw embeddingFailureError({
          code: "EMBEDDING_MODEL_CACHE_CORRUPT",
          subStage: "model-download",
          evidence: ["MODEL_HASH_MISMATCH", path.posix.basename(file.path)],
        });
      }
      const filename = targetPath(input.cacheDir, manifest, file);
      await fs.promises.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await fs.promises.rename(downloadedPath, filename);
      await fs.promises.rm(`${downloadedPath}.meta.json`, { force: true });
      const stat = await fs.promises.stat(filename);
      nextStamp.files[file.path] = { size: stat.size, mtimeMs: stat.mtimeMs };
      completedBytes += file.size;
      report(0);
    }
  }
  await writeStamp(input.cacheDir, nextStamp);
  return true;
}

/**
 * Offline import: copies a model's pinned files from a local folder (either the
 * cache layout `<repo id>/<file>` or the files themselves) after verifying each one.
 */
export async function importModelFiles(shortName: string, sourceDir: string, cacheDir: string): Promise<{ imported: number }> {
  const manifest = getModelFileManifest(shortName);
  if (!manifest) throw Object.assign(new Error("MODEL_IMPORT_UNSUPPORTED"), { code: "MODEL_IMPORT_UNSUPPORTED" });
  const candidates = (file: ModelFileEntry) => [
    path.join(sourceDir, ...manifest.id.split("/"), ...file.path.split("/")),
    path.join(sourceDir, ...file.path.split("/")),
    path.join(sourceDir, path.posix.basename(file.path)),
  ];
  const plan: Array<{ file: ModelFileEntry; source: string }> = [];
  for (const file of manifest.files) {
    let source: string | null = null;
    for (const candidate of candidates(file)) {
      try {
        const stat = await fs.promises.lstat(candidate);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size === file.size && await sha256File(candidate) === file.sha256) {
          source = candidate;
          break;
        }
      } catch {
        // Try the next layout.
      }
    }
    if (!source) {
      throw Object.assign(new Error(`MODEL_IMPORT_FILE_MISSING: ${file.path}`), {
        code: "MODEL_IMPORT_FILE_MISSING",
        file: file.path,
      });
    }
    plan.push({ file, source });
  }
  for (const { file, source } of plan) {
    const target = targetPath(cacheDir, manifest, file);
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.import`;
    await fs.promises.copyFile(source, temporary);
    await fs.promises.rename(temporary, target);
  }
  await ensureModelFiles({ shortName, cacheDir, hosts: [], probe: async () => [] });
  return { imported: plan.length };
}
