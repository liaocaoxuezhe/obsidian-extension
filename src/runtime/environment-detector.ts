import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { readCurrentRuntimeForAsset } from "./atomic-runtime-installer";
import {
  PINNED_CHROMA_RUNTIME_VERSION,
  PINNED_CHROMA_WIRE_VERSION,
  type ChromaRuntimeManager,
  type ManagedProcessState,
} from "./chroma-runtime-manager";
import { EmbeddingRuntimeManager } from "./embedding-runtime-manager";
import { getRuntimeAsset as getPinnedRuntimeAsset } from "./runtime-manifest";
import type { RuntimeAsset, RuntimeAssetKind, RuntimePaths, SupportedPlatformKey } from "./runtime-types";
import type { EnvironmentReport, RecommendedAction } from "../onboarding/onboarding-types";

type ChromaState = EnvironmentReport["chroma"];
type EmbeddingRuntimeState = EnvironmentReport["embeddingRuntime"];
type EmbeddingModelState = EnvironmentReport["embeddingModel"];
type IndexState = EnvironmentReport["index"];

const DEFAULT_HEALTH_TIMEOUT_MS = 1000;
const MAX_HEALTH_BODY_BYTES = 4096;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_MODEL_ENTRIES = 5000;
const MAX_RUNTIME_ENTRIES = 200_000;

export interface IndexEnvironmentState {
  entries: number;
  total?: number;
  legacy?: boolean;
  corrupt?: boolean;
}

export interface ChromaHealthInput {
  host: "127.0.0.1";
  port: number;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface EnvironmentInspectors {
  chromaRuntime?: () => Promise<ChromaState>;
  embeddingRuntime?: () => Promise<EmbeddingRuntimeState>;
  embeddingModel?: () => Promise<EmbeddingModelState>;
  index?: () => Promise<IndexState>;
  chromaHealth?: (input: ChromaHealthInput) => Promise<ChromaState>;
  processExists?: (pid: number) => boolean;
}

export interface EnvironmentDetectorOptions {
  platform: SupportedPlatformKey;
  paths: RuntimePaths;
  chromaHost?: string;
  chromaPort?: number;
  healthTimeoutMs?: number;
  modelCacheKey?: string;
  indexState?: IndexEnvironmentState;
  inspectors?: EnvironmentInspectors;
  externalChromaConfirmed?: boolean;
  chromaRuntimeManager?: Pick<ChromaRuntimeManager, "getState" | "health">;
  getRuntimeAsset?: (kind: RuntimeAssetKind, platform: SupportedPlatformKey) => RuntimeAsset | null;
  signal?: AbortSignal;
}

export interface VerifiedChromaRuntimeSnapshot {
  runtimeId: string;
  executablePath: string;
  runtimeVersion: string;
  assetSha256: string;
}

export interface VerifiedChromaRuntimeInstallation extends VerifiedChromaRuntimeSnapshot {
  revalidate(): Promise<VerifiedChromaRuntimeSnapshot>;
}

interface ChromaRuntimeInspection {
  state: ChromaState;
  asset: RuntimeAsset | null;
  executablePath: string | null;
  executableRealPath: string | null;
}

function detectorError(code: string, cause?: unknown): Error {
  const error = new Error(code) as Error & { code?: string; cause?: unknown };
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw detectorError("ENVIRONMENT_DETECTION_CANCELLED");
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
    ?? ((error as Error & { cause?: NodeJS.ErrnoException })?.cause?.code);
  return code === "ENOENT";
}

function isContained(root: string, candidate: string, allowRoot = false): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (allowRoot || Boolean(relative)) && relative !== ".."
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertOwned(stat: fs.Stats): void {
  if (process.platform !== "win32" && typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw detectorError("ENVIRONMENT_UNSAFE_OWNER");
  }
}

async function assertPathChain(
  root: string,
  candidate: string,
  directory: boolean,
): Promise<"exists" | "missing"> {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (!isContained(resolvedRoot, resolvedCandidate, resolvedRoot === resolvedCandidate)) {
    throw detectorError("ENVIRONMENT_UNSAFE_PATH");
  }
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  const parts = relative ? relative.split(path.sep) : [];
  let current = resolvedRoot;
  const all = [resolvedRoot];
  for (const part of parts) {
    current = path.join(current, part);
    all.push(current);
  }
  for (let index = 0; index < all.length; index += 1) {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(all[index]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
    if (stat.isSymbolicLink()) throw detectorError("ENVIRONMENT_UNSAFE_PATH");
    const final = index === all.length - 1;
    if (final ? (directory ? !stat.isDirectory() : !stat.isFile()) : !stat.isDirectory()) {
      throw detectorError("ENVIRONMENT_UNSAFE_PATH");
    }
    assertOwned(stat);
  }
  const [realRoot, realCandidate] = await Promise.all([
    fs.promises.realpath(resolvedRoot),
    fs.promises.realpath(resolvedCandidate),
  ]);
  if (!isContained(realRoot, realCandidate, resolvedRoot === resolvedCandidate)) {
    throw detectorError("ENVIRONMENT_UNSAFE_PATH");
  }
  return "exists";
}

async function sha256File(root: string, filename: string, expectedSize: number): Promise<string> {
  if (await assertPathChain(root, filename, false) === "missing") {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }
  const before = await fs.promises.lstat(filename);
  if (before.size !== expectedSize) throw detectorError("ENVIRONMENT_HASH_MISMATCH");
  const handle = await fs.promises.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const hash = crypto.createHash("sha256");
  let offset = 0;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== expectedSize) {
      throw detectorError("ENVIRONMENT_UNSAFE_PATH");
    }
    assertOwned(opened);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (offset < expectedSize) {
      const length = Math.min(buffer.length, expectedSize - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead <= 0) throw detectorError("ENVIRONMENT_HASH_MISMATCH");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    await handle.close();
  }
  if (offset !== expectedSize) throw detectorError("ENVIRONMENT_HASH_MISMATCH");
  return hash.digest("hex");
}

async function readSmallFile(root: string, filename: string, maxBytes: number): Promise<string> {
  if (await assertPathChain(root, filename, false) === "missing") {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }
  const before = await fs.promises.lstat(filename);
  if (before.size > maxBytes) throw detectorError("ENVIRONMENT_METADATA_LIMIT");
  const handle = await fs.promises.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maxBytes) {
      throw detectorError("ENVIRONMENT_UNSAFE_PATH");
    }
    assertOwned(opened);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function assertSafeRuntimeTree(root: string, runtimeRoot: string): Promise<void> {
  if (await assertPathChain(root, runtimeRoot, true) === "missing") {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }
  let entries = 0;
  const pending = [runtimeRoot];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > MAX_RUNTIME_ENTRIES) throw detectorError("ENVIRONMENT_RUNTIME_METADATA_LIMIT");
      const filename = path.join(directory, entry.name);
      const stat = await fs.promises.lstat(filename);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw detectorError("ENVIRONMENT_UNSAFE_PATH");
      }
      assertOwned(stat);
      if (stat.isDirectory()) pending.push(filename);
    }
  }
}

async function inspectChromaRuntime(
  paths: RuntimePaths,
  platform: SupportedPlatformKey,
  assetResolver: (kind: RuntimeAssetKind, platform: SupportedPlatformKey) => RuntimeAsset | null,
): Promise<ChromaRuntimeInspection> {
  try {
    const asset = assetResolver("chroma", platform);
    if (!asset || asset.kind !== "chroma") {
      return { state: "corrupt", asset: null, executablePath: null, executableRealPath: null };
    }
    const pointer = await readCurrentRuntimeForAsset(paths, asset);
    if (!pointer) return { state: "missing", asset: null, executablePath: null, executableRealPath: null };
    const pointerPath = path.join(paths.current, "chroma.json");
    if (await assertPathChain(paths.root, pointerPath, false) === "missing") {
      return { state: "missing", asset: null, executablePath: null, executableRealPath: null };
    }
    const versionsRoot = paths.chromaVersions;
    const expectedRoot = path.join(versionsRoot, asset.id);
    if (pointer.runtimeId !== asset.id || pointer.assetSha256 !== asset.sha256
      || pointer.installedPath !== expectedRoot || !isContained(versionsRoot, expectedRoot)) {
      return { state: "corrupt", asset, executablePath: null, executableRealPath: null };
    }
    if (await assertPathChain(paths.root, expectedRoot, true) === "missing") {
      return { state: "corrupt", asset, executablePath: null, executableRealPath: null };
    }
    const executable = path.resolve(expectedRoot, ...asset.executableRelativePath.split("/"));
    if (!isContained(expectedRoot, executable)) {
      return { state: "corrupt", asset, executablePath: null, executableRealPath: null };
    }
    if (await sha256File(paths.root, executable, asset.size) !== asset.sha256) {
      return { state: "corrupt", asset, executablePath: executable, executableRealPath: null };
    }
    return {
      state: "installed",
      asset,
      executablePath: executable,
      executableRealPath: await fs.promises.realpath(executable),
    };
  } catch (error) {
    return {
      state: isMissing(error) ? "missing" : "corrupt",
      asset: null,
      executablePath: null,
      executableRealPath: null,
    };
  }
}

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function verifyManagedChromaIdentity(
  manager: Pick<ChromaRuntimeManager, "getState" | "health">,
  inspection: ChromaRuntimeInspection,
  paths: RuntimePaths,
  port: number,
  processExists: (pid: number) => boolean,
): Promise<boolean> {
  try {
    const state: ManagedProcessState = manager.getState();
    if (inspection.state !== "installed" || !inspection.asset || inspection.asset.kind !== "chroma"
      || !inspection.executablePath || !inspection.executableRealPath
      || inspection.asset.version !== PINNED_CHROMA_RUNTIME_VERSION
      || state.ownership !== "analogy"
      || !Number.isInteger(state.pid) || (state.pid as number) <= 0
      || state.port !== port
      || state.runtimeVersion !== PINNED_CHROMA_RUNTIME_VERSION
      || typeof state.executablePath !== "string"
      || !processExists(state.pid as number)) return false;
    if (await assertPathChain(paths.root, state.executablePath, false) === "missing") return false;
    const stateRealPath = await fs.promises.realpath(state.executablePath);
    if (stateRealPath !== inspection.executableRealPath) return false;
    if (await sha256File(paths.root, state.executablePath, inspection.asset.size) !== inspection.asset.sha256) {
      return false;
    }
    return await manager.health(port) === true;
  } catch {
    return false;
  }
}

async function inspectEmbeddingRuntime(
  paths: RuntimePaths,
  platform: SupportedPlatformKey,
  assetResolver: (kind: RuntimeAssetKind, platform: SupportedPlatformKey) => RuntimeAsset | null,
): Promise<EmbeddingRuntimeState> {
  try {
    const asset = assetResolver("embedding-runtime", platform);
    if (!asset || asset.kind !== "embedding-runtime") return "corrupt";
    const pointer = await readCurrentRuntimeForAsset(paths, asset);
    if (!pointer) return "missing";
    const pointerPath = path.join(paths.current, "embedding-runtime.json");
    if (await assertPathChain(paths.root, pointerPath, false) === "missing") return "missing";
    const expectedRoot = path.join(paths.embeddingVersions, asset.id);
    if (pointer.runtimeId !== asset.id || pointer.assetSha256 !== asset.sha256
      || pointer.installedPath !== expectedRoot) return "corrupt";
    await assertSafeRuntimeTree(paths.root, expectedRoot);
    const manager = new EmbeddingRuntimeManager({ paths, platform, getAsset: () => asset });
    await manager.resolve();
    return "ready";
  } catch (error) {
    return isMissing(error) || /EMBEDDING_RUNTIME_NOT_INSTALLED/.test((error as Error)?.message ?? "")
      ? "missing"
      : "corrupt";
  }
}

async function inspectModelCache(paths: RuntimePaths, modelCacheKey?: string): Promise<EmbeddingModelState> {
  try {
    if (await assertPathChain(paths.root, paths.modelCache, true) === "missing") return "missing";
    if (!modelCacheKey) return "missing";
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(modelCacheKey)) return "corrupt";
    const modelRoot = path.join(paths.modelCache, modelCacheKey);
    if (!isContained(paths.modelCache, modelRoot)) return "corrupt";
    if (await assertPathChain(paths.root, modelRoot, true) === "missing") return "missing";
    let entries = 0;
    let regularFiles = 0;
    let hasPartial = false;
    let hasReadyMarker = false;
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        entries += 1;
        if (entries > MAX_MODEL_ENTRIES) throw detectorError("ENVIRONMENT_MODEL_METADATA_LIMIT");
        const filename = path.join(directory, entry.name);
        const stat = await fs.promises.lstat(filename);
        if (stat.isSymbolicLink()) throw detectorError("ENVIRONMENT_UNSAFE_PATH");
        assertOwned(stat);
        if (stat.isDirectory()) await visit(filename);
        else if (stat.isFile()) {
          regularFiles += 1;
          if (/\.(part|partial|tmp)$/i.test(entry.name)) hasPartial = true;
          if (entry.name === ".analogy-ready.json") {
            if (stat.size > MAX_MANIFEST_BYTES) throw detectorError("ENVIRONMENT_MODEL_METADATA_LIMIT");
            const marker = JSON.parse(await readSmallFile(paths.root, filename, MAX_MANIFEST_BYTES));
            hasReadyMarker = marker?.schemaVersion === 1 && marker?.modelKey === modelCacheKey;
          }
        } else throw detectorError("ENVIRONMENT_UNSAFE_PATH");
      }
    };
    await visit(modelRoot);
    if (hasReadyMarker && !hasPartial) return "ready";
    return regularFiles > 0 ? "cached" : "missing";
  } catch (error) {
    return isMissing(error) ? "missing" : "corrupt";
  }
}

function inspectIndexState(state?: IndexEnvironmentState): IndexState {
  if (!state) return "empty";
  if (state.legacy) return "legacy";
  const entries = Number.isSafeInteger(state.entries) && state.entries > 0 ? state.entries : 0;
  const total = Number.isSafeInteger(state.total) && (state.total as number) >= 0 ? state.total as number : entries;
  if (entries === 0) return "empty";
  return !state.corrupt && total > 0 && entries >= total ? "ready" : "partial";
}

function parseVersion(body: string): string | null {
  try {
    const parsed = JSON.parse(body.trim());
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return body.trim() || null;
  }
}

function requestText(input: ChromaHealthInput, pathname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    const request = http.request({
      host: input.host,
      port: input.port,
      path: pathname,
      method: "GET",
      agent: false,
      signal: input.signal,
    }, (response) => {
      if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
        response.resume();
        reject(detectorError("ENVIRONMENT_HEALTH_UNAVAILABLE"));
        return;
      }
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_HEALTH_BODY_BYTES) {
          request.destroy(detectorError("ENVIRONMENT_HEALTH_RESPONSE_LIMIT"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.once("error", reject);
    request.end();
  });
}

async function defaultChromaHealth(input: ChromaHealthInput): Promise<ChromaState> {
  try {
    await requestText(input, "/api/v2/heartbeat");
    const version = parseVersion(await requestText(input, "/api/v2/version"));
    return version === PINNED_CHROMA_WIRE_VERSION ? "running" : "incompatible";
  } catch (error) {
    if (input.signal.aborted) throw error;
    return "installed";
  }
}

async function boundedHealth(
  probe: (input: ChromaHealthInput) => Promise<ChromaState>,
  port: number,
  timeoutMs: number,
): Promise<ChromaState> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<ChromaState>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(detectorError("ENVIRONMENT_HEALTH_TIMEOUT"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      probe({ host: "127.0.0.1", port, timeoutMs, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function recommendedAction(report: Omit<EnvironmentReport, "recommendedAction">): RecommendedAction {
  if (report.chroma === "corrupt" || report.chroma === "incompatible"
    || report.embeddingRuntime === "corrupt" || report.embeddingModel === "corrupt"
    || report.index === "legacy") return "repair";
  if (report.embeddingRuntime === "installed" || report.embeddingModel === "cached"
    || report.index === "partial") return "resume";
  if (report.chroma === "missing" || report.embeddingRuntime === "missing"
    || report.embeddingModel === "missing" || report.index === "empty") return "setup";
  if (report.chroma === "installed") return "start-services";
  return "none";
}

export async function detectEnvironment(options: EnvironmentDetectorOptions): Promise<EnvironmentReport> {
  assertNotAborted(options.signal);
  const host = options.chromaHost ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw detectorError("ENVIRONMENT_LOOPBACK_ONLY");
  }
  if (options.chromaPort !== undefined
    && (!Number.isInteger(options.chromaPort) || options.chromaPort < 1 || options.chromaPort > 65535)) {
    throw detectorError("ENVIRONMENT_INVALID_PORT");
  }
  const timeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw detectorError("ENVIRONMENT_INVALID_TIMEOUT");
  }
  const inspectors = options.inspectors ?? {};
  const assetResolver = options.getRuntimeAsset ?? ((kind, platform) => getPinnedRuntimeAsset(kind, platform));
  let chromaInspection: Promise<ChromaRuntimeInspection> | null = null;
  const inspectInstalledChroma = (): Promise<ChromaRuntimeInspection> => {
    chromaInspection ??= inspectChromaRuntime(options.paths, options.platform, assetResolver);
    return chromaInspection;
  };
  let chroma = inspectors.chromaRuntime
    ? await inspectors.chromaRuntime()
    : (await inspectInstalledChroma()).state;
  assertNotAborted(options.signal);
  const embeddingRuntime = await (inspectors.embeddingRuntime?.()
    ?? inspectEmbeddingRuntime(options.paths, options.platform, assetResolver));
  assertNotAborted(options.signal);
  const embeddingModel = await (inspectors.embeddingModel?.()
    ?? inspectModelCache(options.paths, options.modelCacheKey));
  assertNotAborted(options.signal);
  const index = await (inspectors.index?.() ?? Promise.resolve(inspectIndexState(options.indexState)));
  assertNotAborted(options.signal);
  if (options.chromaPort !== undefined) {
    const health = await boundedHealth(inspectors.chromaHealth ?? defaultChromaHealth, options.chromaPort, timeoutMs);
    const trustedManagedEndpoint = chroma === "installed" && options.chromaRuntimeManager
      ? await verifyManagedChromaIdentity(
        options.chromaRuntimeManager,
        await inspectInstalledChroma(),
        options.paths,
        options.chromaPort,
        inspectors.processExists ?? defaultProcessExists,
      )
      : false;
    const trustedEndpoint = trustedManagedEndpoint || options.externalChromaConfirmed === true;
    if (trustedEndpoint && (health === "running" || health === "incompatible" || health === "corrupt")) {
      chroma = health;
    }
  }
  const report = { platform: options.platform, chroma, embeddingRuntime, embeddingModel, index };
  assertNotAborted(options.signal);
  return { ...report, recommendedAction: recommendedAction(report) };
}

export async function resolveVerifiedChromaRuntime(
  options: Pick<EnvironmentDetectorOptions, "paths" | "platform" | "getRuntimeAsset" | "signal">,
): Promise<VerifiedChromaRuntimeInstallation> {
  const snapshot = await resolveVerifiedChromaSnapshot(options);
  return {
    ...snapshot,
    revalidate: () => resolveVerifiedChromaSnapshot(options),
  };
}

async function resolveVerifiedChromaSnapshot(
  options: Pick<EnvironmentDetectorOptions, "paths" | "platform" | "getRuntimeAsset" | "signal">,
): Promise<VerifiedChromaRuntimeSnapshot> {
  assertNotAborted(options.signal);
  const assetResolver = options.getRuntimeAsset
    ?? ((kind: RuntimeAssetKind, platform: SupportedPlatformKey) => getPinnedRuntimeAsset(kind, platform));
  const inspection = await inspectChromaRuntime(options.paths, options.platform, assetResolver);
  assertNotAborted(options.signal);
  if (inspection.state !== "installed" || inspection.asset?.kind !== "chroma" || !inspection.executablePath) {
    throw detectorError("CHROMA_RUNTIME_NOT_VERIFIED");
  }
  return {
    runtimeId: inspection.asset.id,
    executablePath: inspection.executablePath,
    runtimeVersion: inspection.asset.version,
    assetSha256: inspection.asset.sha256,
  };
}
