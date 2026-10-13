import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import type { ChromaVectorRecord } from "../local-vector/vector-store";
import type { VectorStoreOperations } from "../local-vector/vector-store-protocol";

/**
 * One-time copy of an existing Chroma index into the SQLite vector store.
 *
 * Chroma data and the Chroma-era state files are only ever read. The SQLite
 * store keeps its own copies of runtime-state.json, index-states/ and
 * generation-evidence/ under `storeRoot`, so installing the previous plugin
 * version restores the untouched Chroma setup.
 */

export const CHROMA_IMPORT_MARKER = "import-from-chroma.json";
export const CHROMA_IMPORT_MAX_ATTEMPTS = 2;
const IMPORT_BATCH_SIZE = 256;
const SAMPLE_LIMIT = 8;

export type ChromaImportStatus = "completed" | "not-needed" | "failed" | "rebuild-required";

export interface ChromaImportMarker {
  schemaVersion: 1;
  status: ChromaImportStatus;
  attempts: number;
  collections: Array<{ name: string; records: number; digest: string }>;
  errorCode: string | null;
  updatedAt: number;
}

export interface ChromaImportSource {
  /** Returns false when the collection does not exist; must never create it. */
  openCollection(name: string): Promise<boolean>;
  count(): Promise<number>;
  readPage(offset: number, limit: number): Promise<ChromaVectorRecord[]>;
}

export interface ChromaImportDestination {
  request<K extends keyof VectorStoreOperations>(
    op: K,
    params: VectorStoreOperations[K]["params"],
  ): Promise<VectorStoreOperations[K]["result"]>;
}

export interface ChromaImportOptions {
  legacyRoot: string;
  storeRoot: string;
  destination: ChromaImportDestination;
  /** Starts Chroma read-only for the duration of `run`, then stops it. */
  withChromaSource<T>(run: (createSource: () => ChromaImportSource) => Promise<T>): Promise<T>;
  signal?: AbortSignal;
  onProgress?(progress: { collection: string; copied: number; total: number }): void;
  now?: () => number;
}

interface LegacyPointer {
  generation?: unknown;
  collectionName?: unknown;
}

interface ImportPlan {
  hasLegacyState: boolean;
  required: string[];
  optional: string[];
}

function importError(code: string, cause?: unknown): Error & { code: string } {
  return Object.assign(new Error(code), { code, ...(cause === undefined ? {} : { cause }) });
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,80}$/.test(code) ? code : "CHROMA_IMPORT_FAILED";
}

function validCollection(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/.test(value);
}

function addIdsToDigest(digest: string, ids: readonly string[]): string {
  const hash = createHash("sha256").update(digest, "hex");
  for (const id of ids) hash.update(id, "utf8").update("\0");
  return hash.digest("hex");
}

async function atomicWriteJson(filename: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.promises.rename(temporary, filename);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function copyTree(source: string, target: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) throw importError("CHROMA_IMPORT_STATE_UNSAFE");
  if (stat.isDirectory()) {
    await fs.promises.mkdir(target, { recursive: true, mode: 0o700 });
    for (const name of await fs.promises.readdir(source)) {
      await copyTree(path.join(source, name), path.join(target, name));
    }
    return;
  }
  if (!stat.isFile()) throw importError("CHROMA_IMPORT_STATE_UNSAFE");
  await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.promises.copyFile(source, target);
}

function stripNullMetadata(record: ChromaVectorRecord): ChromaVectorRecord {
  if (!record.metadata) return record;
  const metadata: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(record.metadata)) {
    if (value !== null && value !== undefined) metadata[key] = value;
  }
  return { ...record, metadata };
}

export async function readChromaImportMarker(storeRoot: string): Promise<ChromaImportMarker | null> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(path.join(storeRoot, CHROMA_IMPORT_MARKER), "utf8"));
    if (parsed?.schemaVersion !== 1 || !["completed", "not-needed", "failed", "rebuild-required"].includes(parsed.status)) {
      return null;
    }
    return parsed as ChromaImportMarker;
  } catch {
    return null;
  }
}

/** True once the SQLite store owns its state and Chroma never needs to start again. */
export function isChromaImportSettled(marker: ChromaImportMarker | null): boolean {
  return marker?.status === "completed" || marker?.status === "not-needed" || marker?.status === "rebuild-required";
}

export async function planChromaImport(legacyRoot: string): Promise<ImportPlan> {
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(await fs.promises.readFile(path.join(legacyRoot, "runtime-state.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hasLegacyState: false, required: [], optional: [] };
    throw importError("CHROMA_IMPORT_STATE_INVALID", error);
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) throw importError("CHROMA_IMPORT_STATE_INVALID");
  const required: string[] = [];
  const optional: string[] = [];
  if (state.activeGeneration === "v2" && validCollection(state.collectionName)) {
    required.push(state.collectionName);
  }
  for (const pointer of [state.previousGeneration, state.pendingGeneration] as LegacyPointer[]) {
    if (pointer && pointer.generation === "v2" && validCollection(pointer.collectionName)
      && !required.includes(pointer.collectionName) && !optional.includes(pointer.collectionName)) {
      optional.push(pointer.collectionName);
    }
  }
  return { hasLegacyState: true, required, optional };
}

async function copyCollection(
  name: string,
  source: ChromaImportSource,
  destination: ChromaImportDestination,
  options: Pick<ChromaImportOptions, "signal" | "onProgress">,
): Promise<{ name: string; records: number; digest: string }> {
  const total = await source.count();
  if (!Number.isSafeInteger(total) || total < 0) throw importError("CHROMA_IMPORT_COUNT_INVALID");
  // A previous interrupted attempt may have left a partial copy; start clean.
  await destination.request("deleteCollection", { name });
  await destination.request("ensureCollection", { name });
  let digest = "0".repeat(64);
  let copied = 0;
  const samples: ChromaVectorRecord[] = [];
  const sampleEvery = Math.max(1, Math.floor(total / (SAMPLE_LIMIT - 1)));
  while (copied < total) {
    if (options.signal?.aborted) throw importError("CHROMA_IMPORT_CANCELLED");
    const limit = Math.min(IMPORT_BATCH_SIZE, total - copied);
    const page = (await source.readPage(copied, limit)).map(stripNullMetadata);
    if (page.length !== limit) throw importError("CHROMA_IMPORT_SOURCE_CHANGED");
    await destination.request("upsert", {
      collection: name,
      records: page.map((record) => ({
        id: record.id,
        document: record.document,
        metadata: record.metadata,
        embedding: record.embedding,
      })),
    });
    page.forEach((record, index) => {
      const position = copied + index;
      if ((position % sampleEvery === 0 || position === total - 1) && samples.length < SAMPLE_LIMIT) {
        samples.push(record);
      }
    });
    digest = addIdsToDigest(digest, page.map((record) => record.id));
    copied += page.length;
    options.onProgress?.({ collection: name, copied, total });
  }

  if (await source.count() !== total || await destination.request("count", { collection: name }) !== total) {
    throw importError("CHROMA_IMPORT_COUNT_MISMATCH");
  }
  let destinationDigest = "0".repeat(64);
  for (let offset = 0; offset < total; offset += IMPORT_BATCH_SIZE) {
    const ids = await destination.request("identityPage", {
      collection: name,
      offset,
      limit: Math.min(IMPORT_BATCH_SIZE, total - offset),
    });
    destinationDigest = addIdsToDigest(destinationDigest, ids);
  }
  if (destinationDigest !== digest) throw importError("CHROMA_IMPORT_DIGEST_MISMATCH");

  if (samples.length > 0) {
    const stored = await destination.request("get", {
      collection: name,
      ids: samples.map((record) => record.id),
      includeDocuments: true,
      includeEmbeddings: true,
    });
    const byId = new Map(stored.ids.map((id, index) => [id, index]));
    for (const sample of samples) {
      const index = byId.get(sample.id);
      const embedding = index === undefined ? undefined : stored.embeddings?.[index];
      if (index === undefined || !embedding || embedding.length !== sample.embedding.length
        || embedding.some((value, position) => value !== Math.fround(sample.embedding[position]))
        || (stored.documents?.[index] ?? null) !== sample.document) {
        throw importError("CHROMA_IMPORT_SAMPLE_MISMATCH");
      }
    }
    const probe = samples[0];
    const nearest = await destination.request("query", { collection: name, embedding: probe.embedding, topK: 1 });
    if (nearest.length !== 1 || nearest[0].distance > 1e-6) throw importError("CHROMA_IMPORT_SMOKE_MISMATCH");
  }
  return { name, records: total, digest };
}

/**
 * Runs the import when it has not settled yet. Safe to call on every start:
 * once the marker is settled this only reads one small file.
 */
export async function runChromaImportIfNeeded(options: ChromaImportOptions): Promise<ChromaImportMarker> {
  const now = options.now ?? Date.now;
  const markerPath = path.join(options.storeRoot, CHROMA_IMPORT_MARKER);
  const existing = await readChromaImportMarker(options.storeRoot);
  if (isChromaImportSettled(existing)) return existing!;
  const attempts = (existing?.attempts ?? 0) + 1;

  const plan = await planChromaImport(options.legacyRoot);
  // State is copied only after a verified import, so an existing store state means the
  // vault was already indexed into SQLite; never overwrite it with the Chroma-era copy.
  const storeInitialized = fs.existsSync(path.join(options.storeRoot, "runtime-state.json"));
  if (!plan.hasLegacyState || storeInitialized) {
    const marker: ChromaImportMarker = {
      schemaVersion: 1, status: "not-needed", attempts, collections: [], errorCode: null, updatedAt: now(),
    };
    await atomicWriteJson(markerPath, marker);
    return marker;
  }

  try {
    const collections = plan.required.length + plan.optional.length === 0 ? [] : await options.withChromaSource(
      async (createSource) => {
        const imported: ChromaImportMarker["collections"] = [];
        for (const name of [...plan.required, ...plan.optional]) {
          const source = createSource();
          if (!await source.openCollection(name)) {
            if (plan.required.includes(name)) throw importError("CHROMA_IMPORT_COLLECTION_MISSING");
            continue;
          }
          imported.push(await copyCollection(name, source, options.destination, options));
        }
        return imported;
      },
    );
    // State files are copied only after every vector has been verified.
    await copyTree(path.join(options.legacyRoot, "runtime-state.json"), path.join(options.storeRoot, "runtime-state.json"));
    await copyTree(path.join(options.legacyRoot, "index-states"), path.join(options.storeRoot, "index-states"));
    await copyTree(path.join(options.legacyRoot, "generation-evidence"), path.join(options.storeRoot, "generation-evidence"));
    const marker: ChromaImportMarker = {
      schemaVersion: 1, status: "completed", attempts, collections, errorCode: null, updatedAt: now(),
    };
    await atomicWriteJson(markerPath, marker);
    return marker;
  } catch (error) {
    const code = options.signal?.aborted ? "CHROMA_IMPORT_CANCELLED" : errorCode(error);
    const giveUp = code !== "CHROMA_IMPORT_CANCELLED"
      && (code === "CHROMA_IMPORT_RUNTIME_UNAVAILABLE" || attempts >= CHROMA_IMPORT_MAX_ATTEMPTS);
    const marker: ChromaImportMarker = {
      schemaVersion: 1,
      status: giveUp ? "rebuild-required" : "failed",
      // A cancelled run (for example a plugin reload) does not count as a failed attempt.
      attempts: code === "CHROMA_IMPORT_CANCELLED" ? attempts - 1 : attempts,
      collections: [],
      errorCode: code,
      updatedAt: now(),
    };
    await atomicWriteJson(markerPath, marker).catch(() => undefined);
    if (giveUp) {
      // Leave no partial SQLite state behind; the vault will be re-indexed through onboarding.
      for (const name of [...plan.required, ...plan.optional]) {
        await options.destination.request("deleteCollection", { name }).catch(() => undefined);
      }
      return marker;
    }
    throw Object.assign(importError(code, error), { marker });
  }
}
