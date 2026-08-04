import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import type { IndexState, IndexStateEntry, IndexStateStore } from "../local-vector/document-indexer";
import type { LegacyVectorMigrationEvidence } from "./legacy-vector-migration";

export const CHROMA_DATA_GENERATION = "v2" as const;
export const CHROMA_RUNTIME_ID = "chroma-cli-1.4.4" as const;
export const CHROMA_REBUILD_SMOKE_QUERY = "Analogy 固定重建验证查询";
export const LEGACY_CLEANUP_CONFIRMATION = "DELETE LEGACY DATA";

export interface ChromaDataGeneration {
  schemaVersion: 1;
  generation: "v2";
  runtimeId: "chroma-cli-1.4.4";
  runtimeVaultId: `vault-v2-${string}`;
  modelShortName: string;
  collectionName: string;
  dataPath: string;
  port: number;
  rebuildCompletedAt: number | null;
  legacyDataPath: string | null;
  /** Unique rebuild transaction identity; never synchronized. */
  transitionToken: string;
  /** Runtime-state revision observed by the transaction. Null until begin(). */
  stateRevision: number | null;
}

export interface SelectedDocumentEvidence {
  docId: string;
  path: string;
  mtime: number;
}

export interface CollectionDocumentEvidence extends SelectedDocumentEvidence {
  chunkCount: number;
}

export interface ChromaScopeCompletion {
  schemaVersion: 1;
  evidenceId: string;
  scopeType: "recent" | "folder" | "vault";
  selectionDigest: string;
  fileCount: number;
  chunkCount: number;
  completedAt: number;
}

export interface ChromaRuntimeState {
  schemaVersion: 1;
  revision: number;
  runtimeVaultId: `vault-v2-${string}`;
  activeGeneration: "legacy" | "v2" | null;
  previousGeneration: ChromaGenerationPointer | null;
  pendingGeneration: {
    generation: "v2";
    runtimeId: "chroma-cli-1.4.4";
    transitionToken: string;
    startedAt: number;
    modelShortName: string;
    collectionName: string;
    port: number;
    rebuildCompletedAt: null;
  } | null;
  runtimeId: string;
  port: number;
  modelShortName: string;
  collectionName: string;
  rebuildCompletedAt: number | null;
  scopeCompletion: ChromaScopeCompletion | null;
}

export interface ChromaGenerationPointer {
  generation: "legacy" | "v2";
  runtimeId: string;
  port: number;
  modelShortName: string;
  collectionName: string;
  rebuildCompletedAt: number | null;
  scopeCompletion: ChromaScopeCompletion | null;
}

export interface RebuildVerificationInput {
  expectedFileCount?: number;
  scopeType?: "recent" | "folder" | "vault";
  selectedDocuments?: readonly SelectedDocumentEvidence[];
  indexState: IndexState;
  collectionDocuments?: readonly CollectionDocumentEvidence[];
  chunkCount: number;
  smokeQuery(query: string): Promise<readonly unknown[]>;
  cleanupCollection?(collectionName: string): Promise<void>;
}

export interface LegacyCleanupResult {
  removed: number;
  failed: number;
  skipped: number;
}

export function extractDeviceLocalSettings(settings: Record<string, unknown>): {
  synchronizedSettings: Record<string, unknown>;
  legacyPort: number | null;
  legacyIndexStates: Record<string, IndexState>;
} {
  const { chromaPort, indexStates, ...synchronizedSettings } = settings;
  const legacyPort = Number.isSafeInteger(chromaPort) && (chromaPort as number) >= 1
    && (chromaPort as number) <= 65_535 ? chromaPort as number : null;
  const legacyIndexStates: Record<string, IndexState> = {};
  if (indexStates && typeof indexStates === "object" && !Array.isArray(indexStates)) {
    for (const [model, state] of Object.entries(indexStates as Record<string, unknown>)) {
      try { validateModelShortName(model); } catch { continue; }
      if (state && typeof state === "object" && !Array.isArray(state)
        && Object.values(state as Record<string, unknown>).every(isIndexStateEntry)) {
        legacyIndexStates[model] = state as IndexState;
      }
    }
  }
  return { synchronizedSettings, legacyPort, legacyIndexStates };
}

function migrationError(code: string, cause?: unknown): Error {
  const error = new Error(code) as Error & { code?: string; cause?: unknown };
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function validateRuntimeVaultId(value: string): asserts value is `vault-v2-${string}` {
  if (!/^vault-v2-[0-9a-f]{16}$/.test(value)) throw migrationError("INVALID_RUNTIME_VAULT_ID");
}

function validateModelShortName(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw migrationError("INVALID_MODEL_SHORT_NAME");
  }
}

function validatePort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw migrationError("INVALID_CHROMA_PORT");
}

function validateTransitionToken(value: string): void {
  if (!/^[0-9a-f]{32}$/.test(value)) throw migrationError("INVALID_CHROMA_TRANSITION_TOKEN");
}

function validateRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw migrationError("RUNTIME_STATE_INVALID");
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function normalizeRelativeDocumentPath(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0")) return null;
  const normalized = value.replace(/\\/g, "/").normalize("NFC");
  return !normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized)
    && normalized.split("/").every((part) => Boolean(part) && part !== "." && part !== "..")
    ? normalized : null;
}

function validRelativeDocumentPath(value: unknown): value is string {
  const normalized = normalizeRelativeDocumentPath(value);
  return normalized !== null && normalized === value;
}

function validCollectionName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/.test(value);
}

function validRuntimeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value);
}

function collectionPrefix(runtimeVaultId: string, modelShortName: string): string {
  return `analogy_${runtimeVaultId}_${modelShortName}`;
}

function validV2Collection(value: string, runtimeVaultId: string, modelShortName: string): boolean {
  const prefix = collectionPrefix(runtimeVaultId, modelShortName);
  return value === prefix || new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_[0-9a-f]{12}$`).test(value);
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw migrationError("UNSAFE_CHROMA_DATA_PATH");
  }
}

function toGenerationPointer(state: ChromaRuntimeState): ChromaGenerationPointer | null {
  if (state.activeGeneration === null) return null;
  return {
    generation: state.activeGeneration,
    runtimeId: state.runtimeId,
    port: state.port,
    modelShortName: state.modelShortName,
    collectionName: state.collectionName,
    rebuildCompletedAt: state.rebuildCompletedAt,
    scopeCompletion: state.scopeCompletion ? { ...state.scopeCompletion } : null,
  };
}

async function atomicWriteJson(filename: string, value: unknown): Promise<void> {
  const directory = path.dirname(filename);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(directory, `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(temp, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temp, filename);
    let directoryHandle: fs.promises.FileHandle | null = null;
    try {
      directoryHandle = await fs.promises.open(directory, fs.constants.O_RDONLY);
      await directoryHandle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "EISDIR" && code !== "EINVAL")) {
        throw error;
      }
    } finally {
      await directoryHandle?.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.promises.unlink(temp).catch(() => undefined);
    throw error;
  }
}

export function createChromaDataGeneration(input: {
  localDataRoot: string;
  runtimeVaultId: string;
  modelShortName: string;
  port: number;
  legacyDataPath?: string | null;
  transitionToken?: string;
}): ChromaDataGeneration {
  validateRuntimeVaultId(input.runtimeVaultId);
  validateModelShortName(input.modelShortName);
  validatePort(input.port);
  if (!path.isAbsolute(input.localDataRoot)) throw migrationError("INVALID_LOCAL_DATA_ROOT");
  const vaultRoot = path.join(path.resolve(input.localDataRoot), "vaults", input.runtimeVaultId);
  const dataPath = path.join(vaultRoot, "chroma_data_v2");
  assertContained(path.resolve(input.localDataRoot), dataPath);
  const legacyDataPath = input.legacyDataPath ?? null;
  if (legacyDataPath !== null && !path.isAbsolute(legacyDataPath)) {
    throw migrationError("INVALID_LEGACY_DATA_PATH");
  }
  const transitionToken = input.transitionToken ?? randomUUID().replace(/-/g, "");
  validateTransitionToken(transitionToken);
  const collectionName = `${collectionPrefix(input.runtimeVaultId, input.modelShortName)}_${transitionToken.slice(0, 12)}`;
  if (!validCollectionName(collectionName)) throw migrationError("INVALID_COLLECTION_NAME");
  return {
    schemaVersion: 1,
    generation: CHROMA_DATA_GENERATION,
    runtimeId: CHROMA_RUNTIME_ID,
    runtimeVaultId: input.runtimeVaultId,
    modelShortName: input.modelShortName,
    collectionName,
    dataPath,
    port: input.port,
    rebuildCompletedAt: null,
    legacyDataPath,
    transitionToken,
    stateRevision: null,
  };
}

function indexStateFilename(
  vaultRoot: string,
  generation: string,
  modelShortName: string,
  evidenceId?: string,
): string {
  if (generation !== "legacy" && generation !== "v2") throw migrationError("INVALID_INDEX_GENERATION");
  validateModelShortName(modelShortName);
  if (!path.isAbsolute(vaultRoot)) throw migrationError("INVALID_VAULT_RUNTIME_ROOT");
  if (evidenceId !== undefined) validateTransitionToken(evidenceId);
  const filename = evidenceId
    ? path.join(path.resolve(vaultRoot), "index-states", generation, modelShortName, `${evidenceId}.json`)
    : path.join(path.resolve(vaultRoot), "index-states", generation, `${modelShortName}.json`);
  assertContained(vaultRoot, filename);
  return filename;
}

function isIndexStateEntry(value: unknown): value is IndexStateEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return Number.isFinite(item.mtime) && Number.isSafeInteger(item.chunkCount) && (item.chunkCount as number) >= 0
    && (item.path === undefined || typeof item.path === "string");
}

function normalizeIndexState(value: unknown): IndexState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw migrationError("INDEX_STATE_INVALID");
  const normalized: IndexState = {};
  for (const [rawDocId, rawEntry] of Object.entries(value as Record<string, unknown>)) {
    if (!isIndexStateEntry(rawEntry)) throw migrationError("INDEX_STATE_INVALID");
    const docId = normalizeRelativeDocumentPath(rawDocId);
    const itemPath = normalizeRelativeDocumentPath(rawEntry.path ?? rawDocId);
    if (!docId || !itemPath || normalized[docId]) throw migrationError("INDEX_STATE_INVALID");
    normalized[docId] = { ...rawEntry, path: itemPath };
  }
  return normalized;
}

export function createDeviceLocalIndexStateStore(
  vaultRoot: string,
  generation: "legacy" | "v2",
  modelShortName: string,
  evidenceId?: string,
): IndexStateStore {
  const filename = indexStateFilename(vaultRoot, generation, modelShortName, evidenceId);
  return {
    load: async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await fs.promises.readFile(filename, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw migrationError("INDEX_STATE_READ_FAILED", error);
      }
      return normalizeIndexState(parsed);
    },
    save: async (state) => {
      await atomicWriteJson(filename, normalizeIndexState(state));
    },
  };
}

function pendingState(
  generation: ChromaDataGeneration,
  startedAt: number,
): ChromaRuntimeState["pendingGeneration"] {
  return {
    generation: "v2",
    runtimeId: CHROMA_RUNTIME_ID,
    transitionToken: generation.transitionToken,
    startedAt,
    modelShortName: generation.modelShortName,
    collectionName: generation.collectionName,
    port: generation.port,
    rebuildCompletedAt: null,
  };
}

interface StoredScopeEvidence {
  schemaVersion: 1;
  evidenceId: string;
  transitionToken: string;
  scopeType: "recent" | "folder" | "vault";
  selectionDigest: string;
  modelShortName: string;
  collectionName: string;
  selectedDocuments: SelectedDocumentEvidence[];
  collectionDocuments: CollectionDocumentEvidence[];
  fileCount: number;
  chunkCount: number;
  completedAt: number;
}

const TOP_LEVEL_STATE_KEYS = [
  "schemaVersion", "revision", "runtimeVaultId", "activeGeneration", "previousGeneration",
  "pendingGeneration", "runtimeId", "port", "modelShortName", "collectionName",
  "rebuildCompletedAt", "scopeCompletion",
] as const;
const POINTER_KEYS = [
  "generation", "runtimeId", "port", "modelShortName", "collectionName",
  "rebuildCompletedAt", "scopeCompletion",
] as const;
const PENDING_KEYS = [
  "generation", "runtimeId", "transitionToken", "startedAt", "modelShortName",
  "collectionName", "port", "rebuildCompletedAt",
] as const;
const SCOPE_KEYS = [
  "schemaVersion", "evidenceId", "scopeType", "selectionDigest", "fileCount", "chunkCount", "completedAt",
] as const;
const STORED_EVIDENCE_KEYS = [
  "schemaVersion", "evidenceId", "transitionToken", "scopeType", "selectionDigest",
  "modelShortName", "collectionName", "selectedDocuments", "collectionDocuments",
  "fileCount", "chunkCount", "completedAt",
] as const;

function selectionDigest(documents: readonly SelectedDocumentEvidence[]): string {
  return createHash("sha256").update(JSON.stringify(documents), "utf8").digest("hex");
}

function validScopeCompletion(value: unknown): value is ChromaScopeCompletion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as unknown as Record<string, unknown>;
  return exactKeys(scope, SCOPE_KEYS)
    && scope.schemaVersion === 1
    && typeof scope.evidenceId === "string" && /^[0-9a-f]{32}$/.test(scope.evidenceId)
    && (scope.scopeType === "recent" || scope.scopeType === "folder" || scope.scopeType === "vault")
    && typeof scope.selectionDigest === "string" && /^[0-9a-f]{64}$/.test(scope.selectionDigest)
    && Number.isSafeInteger(scope.fileCount) && (scope.fileCount as number) >= 0
    && Number.isSafeInteger(scope.chunkCount) && (scope.chunkCount as number) >= 0
    && Number.isSafeInteger(scope.completedAt) && (scope.completedAt as number) > 0;
}

function validateSelectedDocument(value: unknown): value is SelectedDocumentEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return exactKeys(item, ["docId", "path", "mtime"])
    && validRelativeDocumentPath(item.docId) && validRelativeDocumentPath(item.path)
    && Number.isFinite(item.mtime) && (item.mtime as number) >= 0;
}

function validateCollectionDocument(value: unknown): value is CollectionDocumentEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return exactKeys(item, ["docId", "path", "mtime", "chunkCount"])
    && validRelativeDocumentPath(item.docId) && validRelativeDocumentPath(item.path)
    && Number.isFinite(item.mtime) && (item.mtime as number) >= 0
    && Number.isSafeInteger(item.chunkCount) && (item.chunkCount as number) > 0;
}

export class ChromaDataMigration {
  private static readonly stateLocks = new Map<string, Promise<void>>();
  private readonly runtimeStatePath: string;
  private readonly now: () => number;

  constructor(options: { runtimeStatePath: string; now?: () => number }) {
    if (!path.isAbsolute(options.runtimeStatePath)) throw migrationError("INVALID_RUNTIME_STATE_PATH");
    this.runtimeStatePath = path.resolve(options.runtimeStatePath);
    this.now = options.now ?? Date.now;
  }

  private async withStateLock<T>(operation: () => Promise<T>): Promise<T> {
    const key = this.runtimeStatePath;
    const previous = ChromaDataMigration.stateLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    ChromaDataMigration.stateLocks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (ChromaDataMigration.stateLocks.get(key) === current) ChromaDataMigration.stateLocks.delete(key);
    }
  }

  private validPrevious(value: unknown, runtimeVaultId: string): value is ChromaGenerationPointer {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const pointer = value as unknown as Record<string, unknown>;
    if (!exactKeys(pointer, POINTER_KEYS)) return false;
    try {
      validatePort(pointer.port as number);
      validateModelShortName(pointer.modelShortName as string);
    } catch { return false; }
    const generation = pointer.generation;
    const completedAt = pointer.rebuildCompletedAt;
    const scopeCompletion = pointer.scopeCompletion;
    return (generation === "legacy" || generation === "v2")
      && validRuntimeId(pointer.runtimeId) && validCollectionName(pointer.collectionName)
      && (generation !== "v2" || (pointer.runtimeId === CHROMA_RUNTIME_ID
        && validV2Collection(pointer.collectionName, runtimeVaultId, pointer.modelShortName as string)
        && Number.isSafeInteger(completedAt) && (completedAt as number) > 0
        && validScopeCompletion(scopeCompletion)))
      && (generation !== "legacy" || (completedAt === null && scopeCompletion === null));
  }

  private validPending(value: unknown, runtimeVaultId: string): value is NonNullable<ChromaRuntimeState["pendingGeneration"]> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const pending = value as unknown as Record<string, unknown>;
    if (!exactKeys(pending, PENDING_KEYS)) return false;
    try {
      validatePort(pending.port as number);
      validateModelShortName(pending.modelShortName as string);
      validateTransitionToken(pending.transitionToken as string);
    } catch { return false; }
    const prefix = collectionPrefix(runtimeVaultId, pending.modelShortName as string);
    return pending.generation === "v2" && pending.runtimeId === CHROMA_RUNTIME_ID
      && pending.rebuildCompletedAt === null
      && Number.isSafeInteger(pending.startedAt) && (pending.startedAt as number) > 0
      && (pending.collectionName === prefix
        || pending.collectionName === `${prefix}_${(pending.transitionToken as string).slice(0, 12)}`);
  }

  private migrateTask14State(value: unknown): ChromaRuntimeState | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const old = value as Record<string, unknown>;
    const oldKeys = [
      "schemaVersion", "runtimeVaultId", "activeGeneration", "previousGeneration",
      "pendingGeneration", "runtimeId", "port", "modelShortName", "collectionName",
      "rebuildCompletedAt",
    ] as const;
    if (!exactKeys(old, oldKeys)) return null;
    const expectedVaultId = path.basename(path.dirname(this.runtimeStatePath));
    try {
      validateRuntimeVaultId(old.runtimeVaultId as string);
      validatePort(old.port as number);
      validateModelShortName(old.modelShortName as string);
    } catch { return null; }
    if (old.schemaVersion !== 1 || old.runtimeVaultId !== expectedVaultId
      || (old.activeGeneration !== null && old.activeGeneration !== "legacy" && old.activeGeneration !== "v2")
      || !validRuntimeId(old.runtimeId) || !validCollectionName(old.collectionName)) return null;

    const now = this.now();
    if (!Number.isSafeInteger(now) || now <= 0) return null;
    const token = randomUUID().replace(/-/g, "");
    let pending: ChromaRuntimeState["pendingGeneration"] = null;
    const oldPending = old.pendingGeneration;
    if (oldPending !== null) {
      if (!oldPending || typeof oldPending !== "object" || Array.isArray(oldPending)) return null;
      const item = oldPending as Record<string, unknown>;
      if (!exactKeys(item, ["generation", "runtimeId", "modelShortName", "collectionName", "port", "rebuildCompletedAt"])) {
        return null;
      }
      try {
        validateModelShortName(item.modelShortName as string);
        validatePort(item.port as number);
      } catch { return null; }
      if (item.generation !== "v2" || item.runtimeId !== CHROMA_RUNTIME_ID
        || item.rebuildCompletedAt !== null || !validCollectionName(item.collectionName)
        || !validV2Collection(item.collectionName, expectedVaultId, item.modelShortName as string)) return null;
      pending = {
        generation: "v2", runtimeId: CHROMA_RUNTIME_ID, transitionToken: token, startedAt: now,
        modelShortName: item.modelShortName as string, collectionName: item.collectionName,
        port: item.port as number, rebuildCompletedAt: null,
      };
    }

    let activeGeneration = old.activeGeneration as ChromaRuntimeState["activeGeneration"];
    let rebuildCompletedAt: number | null = null;
    if (activeGeneration === "v2") {
      if (old.runtimeId !== CHROMA_RUNTIME_ID
        || !Number.isSafeInteger(old.rebuildCompletedAt) || (old.rebuildCompletedAt as number) <= 0
        || !validV2Collection(old.collectionName, expectedVaultId, old.modelShortName as string)) return null;
      activeGeneration = null;
      pending = {
        generation: "v2", runtimeId: CHROMA_RUNTIME_ID, transitionToken: token, startedAt: now,
        modelShortName: old.modelShortName as string, collectionName: old.collectionName,
        port: old.port as number, rebuildCompletedAt: null,
      };
    } else if (old.rebuildCompletedAt !== null) {
      return null;
    }

    let previousGeneration: ChromaGenerationPointer | null = null;
    if (old.previousGeneration !== null) {
      const pointer = old.previousGeneration;
      if (!pointer || typeof pointer !== "object" || Array.isArray(pointer)) return null;
      const item = pointer as Record<string, unknown>;
      if (!exactKeys(item, ["generation", "runtimeId", "port", "modelShortName", "collectionName", "rebuildCompletedAt"])) {
        return null;
      }
      try {
        validatePort(item.port as number);
        validateModelShortName(item.modelShortName as string);
      } catch { return null; }
      // Only a legacy pointer has enough evidence to remain directly restorable.
      if (item.generation === "legacy" && item.rebuildCompletedAt === null
        && validRuntimeId(item.runtimeId) && validCollectionName(item.collectionName)) {
        previousGeneration = {
          generation: "legacy", runtimeId: item.runtimeId, port: item.port as number,
          modelShortName: item.modelShortName as string, collectionName: item.collectionName,
          rebuildCompletedAt: null, scopeCompletion: null,
        };
      }
    }
    return {
      schemaVersion: 1,
      revision: 1,
      runtimeVaultId: expectedVaultId as `vault-v2-${string}`,
      activeGeneration,
      previousGeneration,
      pendingGeneration: pending,
      runtimeId: old.runtimeId as string,
      port: old.port as number,
      modelShortName: old.modelShortName as string,
      collectionName: old.collectionName as string,
      rebuildCompletedAt,
      scopeCompletion: null,
    };
  }

  private validateRuntimeState(value: unknown): ChromaRuntimeState {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw migrationError("RUNTIME_STATE_INVALID");
    const state = value as unknown as Record<string, unknown>;
    try {
      if (!exactKeys(state, TOP_LEVEL_STATE_KEYS)) throw migrationError("RUNTIME_STATE_INVALID");
      validateRuntimeVaultId(state.runtimeVaultId as string);
      validateRevision(state.revision as number);
      validatePort(state.port as number);
      validateModelShortName(state.modelShortName as string);
      const expectedVaultId = path.basename(path.dirname(this.runtimeStatePath));
      if (state.schemaVersion !== 1 || state.runtimeVaultId !== expectedVaultId
        || (state.activeGeneration !== null && state.activeGeneration !== "legacy" && state.activeGeneration !== "v2")
        || !validRuntimeId(state.runtimeId) || !validCollectionName(state.collectionName)
        || (state.rebuildCompletedAt !== null
          && (!Number.isSafeInteger(state.rebuildCompletedAt) || (state.rebuildCompletedAt as number) <= 0))
        || (state.previousGeneration !== null && !this.validPrevious(state.previousGeneration, expectedVaultId))
        || (state.pendingGeneration !== null && !this.validPending(state.pendingGeneration, expectedVaultId))) {
        throw migrationError("RUNTIME_STATE_INVALID");
      }
      if (state.activeGeneration === "v2") {
        if (state.runtimeId !== CHROMA_RUNTIME_ID
          || !validV2Collection(state.collectionName as string, expectedVaultId, state.modelShortName as string)
          || !Number.isSafeInteger(state.rebuildCompletedAt) || (state.rebuildCompletedAt as number) <= 0
          || !validScopeCompletion(state.scopeCompletion)) throw migrationError("RUNTIME_STATE_INVALID");
      } else if (state.scopeCompletion !== null || state.rebuildCompletedAt !== null) {
        throw migrationError("RUNTIME_STATE_INVALID");
      }
      return state as unknown as ChromaRuntimeState;
    } catch (error) {
      if ((error as Error).message === "RUNTIME_STATE_INVALID") throw error;
      throw migrationError("RUNTIME_STATE_INVALID", error);
    }
  }

  private async readUnsafe(): Promise<ChromaRuntimeState> {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.runtimeStatePath, "utf8")) as unknown;
      try {
        return this.validateRuntimeState(parsed);
      } catch (error) {
        const migrated = this.migrateTask14State(parsed);
        if (!migrated) throw error;
        await atomicWriteJson(this.runtimeStatePath, migrated);
        return this.validateRuntimeState(migrated);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw migrationError("RUNTIME_STATE_MISSING", error);
      throw error;
    }
  }

  private async readOptionalUnsafe(): Promise<ChromaRuntimeState | null> {
    try { return await this.readUnsafe(); } catch (error) {
      if ((error as Error).message === "RUNTIME_STATE_MISSING") return null;
      throw error;
    }
  }

  read(): Promise<ChromaRuntimeState> {
    return this.withStateLock(() => this.readUnsafe());
  }

  readOptional(): Promise<ChromaRuntimeState | null> {
    return this.withStateLock(() => this.readOptionalUnsafe());
  }

  begin(
    generation: ChromaDataGeneration,
    cleanupCollection?: (collectionName: string) => Promise<void>,
  ): Promise<ChromaDataGeneration> {
    return this.withStateLock(async () => {
      validateTransitionToken(generation.transitionToken);
      const previous = await this.readOptionalUnsafe();
      if (previous?.pendingGeneration?.transitionToken === generation.transitionToken) {
        return {
          ...generation,
          collectionName: previous.pendingGeneration.collectionName,
          port: previous.pendingGeneration.port,
          stateRevision: previous.revision,
        };
      }
      const startedAt = this.now();
      if (!Number.isSafeInteger(startedAt) || startedAt <= 0) throw migrationError("INVALID_REBUILD_START_TIME");
      const revision = (previous?.revision ?? 0) + 1;
      const superseded = previous?.pendingGeneration
        && previous.pendingGeneration.transitionToken !== generation.transitionToken
        ? { ...previous.pendingGeneration } : null;
      const state: ChromaRuntimeState = {
        schemaVersion: 1,
        revision,
        runtimeVaultId: generation.runtimeVaultId,
        activeGeneration: previous?.activeGeneration ?? null,
        previousGeneration: previous?.previousGeneration ?? null,
        pendingGeneration: pendingState(generation, startedAt),
        runtimeId: previous?.runtimeId ?? generation.runtimeId,
        port: previous?.port ?? generation.port,
        modelShortName: previous?.modelShortName ?? generation.modelShortName,
        collectionName: previous?.collectionName ?? generation.collectionName,
        rebuildCompletedAt: previous?.rebuildCompletedAt ?? null,
        scopeCompletion: previous?.scopeCompletion ?? null,
      };
      await atomicWriteJson(this.runtimeStatePath, state);
      if (superseded) {
        await this.cleanupUnreferencedGenerationUnsafe(
          superseded.transitionToken,
          superseded.modelShortName,
          superseded.collectionName,
          state,
          cleanupCollection,
        );
      }
      return { ...generation, stateRevision: revision };
    });
  }

  publishActiveLease(generation: ChromaDataGeneration): Promise<ChromaDataGeneration> {
    return this.withStateLock(async () => {
      const previous = await this.readOptionalUnsafe();
      if (previous?.pendingGeneration?.modelShortName === generation.modelShortName) {
        const revision = previous.revision + 1;
        const pending = { ...previous.pendingGeneration, port: generation.port };
        await atomicWriteJson(this.runtimeStatePath, { ...previous, revision, pendingGeneration: pending });
        return {
          ...generation,
          transitionToken: pending.transitionToken,
          collectionName: pending.collectionName,
          port: pending.port,
          stateRevision: revision,
        };
      }
      if (previous?.activeGeneration === "v2") {
        if (previous.runtimeVaultId !== generation.runtimeVaultId
          || previous.modelShortName !== generation.modelShortName || previous.rebuildCompletedAt === null) {
          throw migrationError("RUNTIME_ACTIVE_GENERATION_MISMATCH");
        }
        const revision = previous.revision + 1;
        await atomicWriteJson(this.runtimeStatePath, {
          ...previous,
          revision,
          runtimeId: generation.runtimeId,
          port: generation.port,
        });
        return {
          ...generation,
          collectionName: previous.collectionName,
          port: generation.port,
          stateRevision: revision,
        };
      }
      if (previous) return { ...generation, stateRevision: previous.revision };
      const discovered: ChromaRuntimeState = {
        schemaVersion: 1,
        revision: 1,
        runtimeVaultId: generation.runtimeVaultId,
        activeGeneration: null,
        previousGeneration: null,
        pendingGeneration: null,
        runtimeId: generation.runtimeId,
        port: generation.port,
        modelShortName: generation.modelShortName,
        collectionName: generation.collectionName,
        rebuildCompletedAt: null,
        scopeCompletion: null,
      };
      await atomicWriteJson(this.runtimeStatePath, discovered);
      return { ...generation, stateRevision: 1 };
    });
  }

  writeLegacyPointerForMigration(
    generation: "legacy",
    port: number,
    collectionName: string,
    modelShortName: string,
    runtimeVaultId = path.basename(path.dirname(this.runtimeStatePath)),
  ): Promise<void> {
    return this.withStateLock(async () => {
      validateRuntimeVaultId(runtimeVaultId);
      validatePort(port);
      validateModelShortName(modelShortName);
      if (!validCollectionName(collectionName)) throw migrationError("INVALID_COLLECTION_NAME");
      const previous = await this.readOptionalUnsafe();
      const legacyState: ChromaRuntimeState = {
        schemaVersion: 1,
        revision: (previous?.revision ?? 0) + 1,
        runtimeVaultId,
        activeGeneration: generation,
        previousGeneration: null,
        pendingGeneration: null,
        runtimeId: "legacy-chroma",
        port,
        modelShortName,
        collectionName,
        rebuildCompletedAt: null,
        scopeCompletion: null,
      };
      await atomicWriteJson(this.runtimeStatePath, legacyState);
    });
  }

  resumePendingGeneration(localDataRoot: string, legacyDataPath: string | null = null): Promise<ChromaDataGeneration | null> {
    return this.withStateLock(async () => {
      const state = await this.readOptionalUnsafe();
      const pending = state?.pendingGeneration;
      if (!state || !pending) return null;
      if (!path.isAbsolute(localDataRoot)) throw migrationError("INVALID_LOCAL_DATA_ROOT");
      return {
        schemaVersion: 1,
        generation: "v2",
        runtimeId: CHROMA_RUNTIME_ID,
        runtimeVaultId: state.runtimeVaultId,
        modelShortName: pending.modelShortName,
        collectionName: pending.collectionName,
        dataPath: path.join(path.resolve(localDataRoot), "vaults", state.runtimeVaultId, "chroma_data_v2"),
        port: pending.port,
        rebuildCompletedAt: null,
        legacyDataPath,
        transitionToken: pending.transitionToken,
        stateRevision: state.revision,
      };
    });
  }

  discardPendingGeneration(
    transitionToken: string,
    cleanupCollection?: (collectionName: string) => Promise<void>,
  ): Promise<boolean> {
    return this.withStateLock(async () => {
      validateTransitionToken(transitionToken);
      const state = await this.readOptionalUnsafe();
      const pending = state?.pendingGeneration;
      if (!state || !pending || pending.transitionToken !== transitionToken) return false;
      const next: ChromaRuntimeState = {
        ...state,
        revision: state.revision + 1,
        pendingGeneration: null,
      };
      await atomicWriteJson(this.runtimeStatePath, next);
      await this.cleanupUnreferencedGenerationUnsafe(
        pending.transitionToken,
        pending.modelShortName,
        pending.collectionName,
        next,
        cleanupCollection,
      );
      return true;
    });
  }

  private evidenceFilename(evidenceId: string): string {
    validateTransitionToken(evidenceId);
    const vaultRoot = path.dirname(this.runtimeStatePath);
    const filename = path.join(vaultRoot, "generation-evidence", `${evidenceId}.json`);
    assertContained(vaultRoot, filename);
    return filename;
  }

  private async cleanupUnreferencedGenerationUnsafe(
    transitionToken: string,
    modelShortName: string,
    collectionName: string,
    state: ChromaRuntimeState,
    cleanupCollection?: (collectionName: string) => Promise<void>,
  ): Promise<void> {
    validateTransitionToken(transitionToken);
    validateModelShortName(modelShortName);
    if (!validV2Collection(collectionName, state.runtimeVaultId, modelShortName)) return;
    const referencedTokens = new Set([
      state.pendingGeneration?.transitionToken,
      state.scopeCompletion?.evidenceId,
      state.previousGeneration?.scopeCompletion?.evidenceId,
    ].filter((value): value is string => Boolean(value)));
    const referencedCollections = new Set([
      state.activeGeneration ? state.collectionName : undefined,
      state.pendingGeneration?.collectionName,
      state.previousGeneration?.collectionName,
    ].filter((value): value is string => Boolean(value)));
    if (referencedTokens.has(transitionToken) || referencedCollections.has(collectionName)) return;
    if (!cleanupCollection) return;
    try {
      await cleanupCollection(collectionName);
    } catch {
      return;
    }
    await Promise.all([
      fs.promises.unlink(this.evidenceFilename(transitionToken)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }),
      fs.promises.unlink(indexStateFilename(
        path.dirname(this.runtimeStatePath), "v2", modelShortName, transitionToken,
      )).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }),
    ]);
  }

  private normalizeVerification(verification: RebuildVerificationInput): {
    scopeType: "recent" | "folder" | "vault";
    selectedDocuments: SelectedDocumentEvidence[];
    collectionDocuments: CollectionDocumentEvidence[];
    chunkCount: number;
  } {
    const selectedDocumentsInput = verification.selectedDocuments
      ? verification.selectedDocuments.map((item) => ({ ...item }))
      : Object.entries(verification.indexState).map(([docId, entry]) => ({
        docId,
        path: entry.path ?? docId,
        mtime: entry.mtime,
      }));
    const selectedDocuments = selectedDocumentsInput.map((item) => {
      const docId = normalizeRelativeDocumentPath(item.docId);
      const itemPath = normalizeRelativeDocumentPath(item.path);
      if (!docId || !itemPath) throw migrationError("CHROMA_REBUILD_DOCUMENT_EVIDENCE_MISMATCH");
      return { ...item, docId, path: itemPath };
    });
    const indexState = normalizeIndexState(verification.indexState);
    if (verification.expectedFileCount !== undefined
      && (!Number.isSafeInteger(verification.expectedFileCount) || verification.expectedFileCount < 0)) {
      throw migrationError("CHROMA_REBUILD_EXPECTED_COUNT_INVALID");
    }
    if (verification.expectedFileCount !== undefined
      && verification.expectedFileCount !== selectedDocuments.length) {
      throw migrationError("CHROMA_REBUILD_FILE_COUNT_MISMATCH");
    }
    if (!selectedDocuments.every(validateSelectedDocument)
      || new Set(selectedDocuments.map((item) => item.docId)).size !== selectedDocuments.length) {
      throw migrationError("CHROMA_REBUILD_DOCUMENT_EVIDENCE_MISMATCH");
    }
    const selectedById = new Map(selectedDocuments.map((item) => [item.docId, item]));
    if (Object.keys(indexState).length !== selectedDocuments.length) {
      throw migrationError("CHROMA_REBUILD_FILE_COUNT_MISMATCH");
    }
    for (const [docId, entry] of Object.entries(indexState)) {
      const selected = selectedById.get(docId);
      if (!selected || (entry.path ?? docId) !== selected.path || entry.mtime !== selected.mtime
        || !isIndexStateEntry(entry)) throw migrationError("CHROMA_REBUILD_DOCUMENT_EVIDENCE_MISMATCH");
    }
    const collectionDocumentsInput = verification.collectionDocuments
      ? verification.collectionDocuments.map((item) => ({ ...item }))
      : Object.entries(indexState)
        .filter(([, entry]) => entry.chunkCount > 0)
        .map(([docId, entry]) => ({
          docId, path: entry.path ?? docId, mtime: entry.mtime, chunkCount: entry.chunkCount,
        }));
    const collectionDocuments = collectionDocumentsInput.map((item) => {
      const docId = normalizeRelativeDocumentPath(item.docId);
      const itemPath = normalizeRelativeDocumentPath(item.path);
      if (!docId || !itemPath) throw migrationError("CHROMA_REBUILD_DOCUMENT_EVIDENCE_MISMATCH");
      return { ...item, docId, path: itemPath };
    });
    if (!collectionDocuments.every(validateCollectionDocument)
      || new Set(collectionDocuments.map((item) => item.docId)).size !== collectionDocuments.length) {
      throw migrationError("CHROMA_REBUILD_DOCUMENT_EVIDENCE_MISMATCH");
    }
    const collectionById = new Map(collectionDocuments.map((item) => [item.docId, item]));
    for (const [docId, selected] of selectedById) {
      const stateEntry = indexState[docId];
      const document = collectionById.get(docId);
      if (stateEntry.chunkCount === 0) {
        if (document) throw migrationError("CHROMA_REBUILD_DOCUMENT_EVIDENCE_MISMATCH");
      } else if (!document || document.path !== selected.path || document.mtime !== selected.mtime
        || document.chunkCount !== stateEntry.chunkCount) {
        throw migrationError("CHROMA_REBUILD_DOCUMENT_EVIDENCE_MISMATCH");
      }
    }
    if ([...collectionById.keys()].some((docId) => !selectedById.has(docId))) {
      throw migrationError("CHROMA_REBUILD_DOCUMENT_EVIDENCE_MISMATCH");
    }
    const expectedChunks = Object.values(indexState)
      .reduce((total, entry) => total + entry.chunkCount, 0);
    if (!Number.isSafeInteger(verification.chunkCount) || verification.chunkCount !== expectedChunks
      || collectionDocuments.reduce((total, entry) => total + entry.chunkCount, 0) !== expectedChunks) {
      throw migrationError("CHROMA_REBUILD_CHUNK_COUNT_MISMATCH");
    }
    return {
      scopeType: verification.scopeType ?? "vault",
      selectedDocuments,
      collectionDocuments,
      chunkCount: verification.chunkCount,
    };
  }

  async completeRebuild(
    generation: ChromaDataGeneration,
    verification: RebuildVerificationInput,
  ): Promise<ChromaDataGeneration> {
    if (generation.stateRevision === null) throw migrationError("CHROMA_REBUILD_TRANSITION_MISMATCH");
    const normalized = this.normalizeVerification(verification);
    const smokeResults = await verification.smokeQuery(CHROMA_REBUILD_SMOKE_QUERY);
    if (!Array.isArray(smokeResults) || (normalized.chunkCount > 0 && smokeResults.length === 0)) {
      throw migrationError("CHROMA_REBUILD_SMOKE_FAILED");
    }
    return this.withStateLock(async () => {
      const previous = await this.readUnsafe();
      const pending = previous.pendingGeneration;
      if (!pending || previous.revision !== generation.stateRevision
        || pending.transitionToken !== generation.transitionToken
        || pending.modelShortName !== generation.modelShortName
        || pending.collectionName !== generation.collectionName
        || pending.port !== generation.port) {
        throw migrationError("CHROMA_REBUILD_TRANSITION_MISMATCH");
      }
      const completedAt = this.now();
      if (!Number.isSafeInteger(completedAt) || completedAt <= 0) {
        throw migrationError("INVALID_REBUILD_COMPLETION_TIME");
      }
      const digest = selectionDigest(normalized.selectedDocuments);
      const scopeCompletion: ChromaScopeCompletion = {
        schemaVersion: 1,
        evidenceId: generation.transitionToken,
        scopeType: normalized.scopeType,
        selectionDigest: digest,
        fileCount: normalized.selectedDocuments.length,
        chunkCount: normalized.chunkCount,
        completedAt,
      };
      const storedEvidence: StoredScopeEvidence = {
        schemaVersion: 1,
        evidenceId: generation.transitionToken,
        transitionToken: generation.transitionToken,
        scopeType: normalized.scopeType,
        selectionDigest: digest,
        modelShortName: generation.modelShortName,
        collectionName: generation.collectionName,
        selectedDocuments: normalized.selectedDocuments,
        collectionDocuments: normalized.collectionDocuments,
        fileCount: normalized.selectedDocuments.length,
        chunkCount: normalized.chunkCount,
        completedAt,
      };
      const revision = previous.revision + 1;
      const runtimeState: ChromaRuntimeState = {
        schemaVersion: 1,
        revision,
        runtimeVaultId: generation.runtimeVaultId,
        activeGeneration: "v2",
        previousGeneration: toGenerationPointer(previous),
        pendingGeneration: null,
        runtimeId: generation.runtimeId,
        port: pending.port,
        modelShortName: generation.modelShortName,
        collectionName: generation.collectionName,
        rebuildCompletedAt: completedAt,
        scopeCompletion,
      };
      const evidenceFilename = this.evidenceFilename(generation.transitionToken);
      await atomicWriteJson(evidenceFilename, storedEvidence);
      try {
        await atomicWriteJson(this.runtimeStatePath, runtimeState);
      } catch (error) {
        await fs.promises.unlink(evidenceFilename).catch(() => undefined);
        throw error;
      }
      const retired = previous.previousGeneration;
      if (retired?.generation === "v2" && retired.scopeCompletion) {
        await this.cleanupUnreferencedGenerationUnsafe(
          retired.scopeCompletion.evidenceId,
          retired.modelShortName,
          retired.collectionName,
          runtimeState,
          verification.cleanupCollection,
        );
      }
      return { ...generation, port: pending.port, rebuildCompletedAt: completedAt, stateRevision: revision };
    });
  }

  async completeLegacyVectorMigration(
    generation: ChromaDataGeneration,
    copy: LegacyVectorMigrationEvidence,
    verification: RebuildVerificationInput,
  ): Promise<ChromaDataGeneration> {
    if (copy.targetTransitionToken !== generation.transitionToken
      || copy.targetCollectionName !== generation.collectionName) {
      throw migrationError("CHROMA_MIGRATION_TRANSITION_MISMATCH");
    }
    if (copy.sourceModelShortName !== generation.modelShortName
      || typeof copy.sourceModelId !== "string" || copy.sourceModelId.length > 255
      || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(copy.sourceModelId)
      || !validCollectionName(copy.sourceCollectionName)
      || !copy.sourceCollectionName.endsWith(`_${generation.modelShortName}`)) {
      throw migrationError("CHROMA_MIGRATION_MODEL_MISMATCH");
    }
    if (!/^[0-9a-f]{64}$/.test(copy.sourceIdentity)) {
      throw migrationError("CHROMA_MIGRATION_SOURCE_IDENTITY_INVALID");
    }
    // The copy stage proves exact source/destination count and identity digest. The onboarding
    // adoption step intentionally does not mutate copied vectors; new or changed notes remain
    // pending until the user explicitly continues indexing.
    if (!Number.isSafeInteger(copy.recordCount) || copy.recordCount < 0) {
      throw migrationError("CHROMA_MIGRATION_COUNT_MISMATCH");
    }
    if (!/^[0-9a-f]{64}$/.test(copy.recordDigest)) {
      throw migrationError("CHROMA_MIGRATION_DIGEST_INVALID");
    }
    if (!Number.isSafeInteger(copy.vectorDimension) || copy.vectorDimension < 1) {
      throw migrationError("CHROMA_MIGRATION_DIMENSION_INVALID");
    }
    const validTopIds = (ids: readonly string[]) => Array.isArray(ids)
      && ids.length <= 100 && ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 2048);
    const targetTopIdSet = new Set(copy.targetTopIds);
    if (!validTopIds(copy.sourceTopIds) || !validTopIds(copy.targetTopIds)
      || (copy.recordCount > 0 && copy.sourceTopIds.length === 0)
      || copy.sourceTopIds.length !== copy.targetTopIds.length
      // Old and new Chroma releases can rank the same approximate-HNSW neighbours differently.
      // Exact record count and identity digest are already verified, so one shared smoke hit is
      // sufficient here while a completely disjoint result still fails closed.
      || (copy.recordCount > 0 && !copy.sourceTopIds.some((id) => targetTopIdSet.has(id)))) {
      throw migrationError("CHROMA_MIGRATION_SMOKE_MISMATCH");
    }
    return this.completeRebuild(generation, verification);
  }

  async isCompletedFor(input: {
    modelShortName: string;
    indexState: IndexState;
    actualPort?: number | null;
  }): Promise<boolean> {
    try {
      const state = await this.read();
      if (state.activeGeneration !== "v2" || state.pendingGeneration !== null
        || state.modelShortName !== input.modelShortName || state.rebuildCompletedAt === null
        || !state.scopeCompletion || (input.actualPort != null && state.port !== input.actualPort)) return false;
      const raw = JSON.parse(await fs.promises.readFile(this.evidenceFilename(state.scopeCompletion.evidenceId), "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
      const evidence = raw as StoredScopeEvidence;
      if (!exactKeys(evidence as unknown as Record<string, unknown>, STORED_EVIDENCE_KEYS)
        || evidence.schemaVersion !== 1 || evidence.evidenceId !== state.scopeCompletion.evidenceId
        || evidence.transitionToken !== evidence.evidenceId || evidence.modelShortName !== state.modelShortName
        || evidence.collectionName !== state.collectionName || evidence.selectionDigest !== state.scopeCompletion.selectionDigest
        || evidence.fileCount !== state.scopeCompletion.fileCount || evidence.chunkCount !== state.scopeCompletion.chunkCount
        || evidence.completedAt !== state.scopeCompletion.completedAt
        || !Array.isArray(evidence.selectedDocuments) || !evidence.selectedDocuments.every(validateSelectedDocument)
        || !Array.isArray(evidence.collectionDocuments)
        || !evidence.collectionDocuments.every(validateCollectionDocument)
        || evidence.selectedDocuments.length !== evidence.fileCount
        || evidence.collectionDocuments.reduce((sum, item) => sum + item.chunkCount, 0) !== evidence.chunkCount
        || selectionDigest(evidence.selectedDocuments) !== evidence.selectionDigest) return false;
      return true;
    } catch {
      return false;
    }
  }

  rollbackToLegacy(actualPort?: number): Promise<void> {
    return this.rollback("legacy", actualPort);
  }

  rollbackToPreviousGeneration(actualPort?: number): Promise<void> {
    return this.rollback(null, actualPort);
  }

  private rollback(requiredGeneration: "legacy" | null, actualPort?: number): Promise<void> {
    return this.withStateLock(async () => {
      const state = await this.readUnsafe();
      const target = state.previousGeneration;
      if (!target || (requiredGeneration && target.generation !== requiredGeneration)) {
        throw migrationError("CHROMA_ROLLBACK_UNAVAILABLE");
      }
      if (actualPort !== undefined) validatePort(actualPort);
      const current = toGenerationPointer(state);
      await atomicWriteJson(this.runtimeStatePath, {
        ...state,
        revision: state.revision + 1,
        activeGeneration: target.generation,
        previousGeneration: current,
        pendingGeneration: null,
        runtimeId: target.runtimeId,
        port: actualPort ?? target.port,
        modelShortName: target.modelShortName,
        collectionName: target.collectionName,
        rebuildCompletedAt: target.rebuildCompletedAt,
        scopeCompletion: target.scopeCompletion,
      });
    });
  }
}

function isContainedOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

function safeDirectoryChain(root: string, candidate: string): boolean {
  if (!isContainedOrEqual(root, candidate)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  let cursor = path.resolve(root);
  try {
    for (const component of relative ? relative.split(path.sep) : []) {
      const parent = fs.lstatSync(cursor);
      if (!parent.isDirectory() || parent.isSymbolicLink()) return false;
      cursor = path.join(cursor, component);
    }
    const final = fs.lstatSync(cursor);
    if (!final.isDirectory() || final.isSymbolicLink()) return false;
    return isContainedOrEqual(fs.realpathSync(root), fs.realpathSync(candidate));
  } catch {
    return false;
  }
}

type LegacyRecoveryState = "prepared" | "isolated" | "trash-failed" | "restore-failed";

interface LegacyRecoveryMetadata {
  schemaVersion: 1;
  id: string;
  state: LegacyRecoveryState;
  sourceName: string;
  sourceDev: number;
  sourceIno: number;
  isolatedAt: number;
  updatedAt: number;
}

export interface LegacyCleanupRecovery {
  id: string;
  state: LegacyRecoveryState;
  updatedAt: number;
}

export interface LegacyCleanupManager {
  cleanup(confirmation: string): Promise<LegacyCleanupResult>;
  listRecoveries(): Promise<LegacyCleanupRecovery[]>;
  retryRecovery(id: string): Promise<{ removed: number; failed: number }>;
  restoreRecovery(id: string): Promise<{ restored: number; failed: number }>;
}

const LEGACY_RECOVERY_KEYS = [
  "schemaVersion", "id", "state", "sourceName", "sourceDev", "sourceIno", "isolatedAt", "updatedAt",
] as const;

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.isDirectory() && right.isDirectory()
    && !left.isSymbolicLink() && !right.isSymbolicLink();
}

function writeJsonSyncAtomic(filename: string, value: unknown): void {
  const temp = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, filename);
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}

function validRecoveryMetadata(value: unknown, expectedId: string): value is LegacyRecoveryMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return exactKeys(item, LEGACY_RECOVERY_KEYS) && item.schemaVersion === 1 && item.id === expectedId
    && /^[0-9a-f]{32}$/.test(expectedId)
    && (item.state === "prepared" || item.state === "isolated"
      || item.state === "trash-failed" || item.state === "restore-failed")
    && typeof item.sourceName === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(item.sourceName)
    && Number.isSafeInteger(item.sourceDev) && (item.sourceDev as number) >= 0
    && Number.isSafeInteger(item.sourceIno) && (item.sourceIno as number) >= 0
    && Number.isSafeInteger(item.isolatedAt) && (item.isolatedAt as number) > 0
    && Number.isSafeInteger(item.updatedAt) && (item.updatedAt as number) > 0;
}

export function createLegacyCleanupManager(options: {
  legacyDataPath: string | null;
  pluginDirectory: string;
  isV2Completed(): Promise<boolean>;
  trashItem(target: string): Promise<void>;
}): LegacyCleanupManager {
  const pluginDirectory = path.resolve(options.pluginDirectory);
  const allowedRoot = path.join(pluginDirectory, "chroma_data");
  const source = options.legacyDataPath ? path.resolve(options.legacyDataPath) : null;
  const quarantineRoot = path.join(allowedRoot, ".analogy-quarantine");

  const recoveryDirectory = (id: string): string => {
    if (!/^[0-9a-f]{32}$/.test(id)) throw migrationError("LEGACY_CLEANUP_RECOVERY_INVALID");
    const directory = path.join(quarantineRoot, `legacy-${id}`);
    if (!isContainedOrEqual(quarantineRoot, directory) || directory === quarantineRoot) {
      throw migrationError("LEGACY_CLEANUP_RECOVERY_INVALID");
    }
    return directory;
  };

  const readRecovery = (id: string): { directory: string; metadata: LegacyRecoveryMetadata } => {
    const directory = recoveryDirectory(id);
    if (!safeDirectoryChain(quarantineRoot, directory)) throw migrationError("LEGACY_CLEANUP_RECOVERY_INVALID");
    const metadataPath = path.join(directory, "recovery.json");
    const stat = fs.lstatSync(metadataPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) {
      throw migrationError("LEGACY_CLEANUP_RECOVERY_INVALID");
    }
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as unknown;
    if (!validRecoveryMetadata(metadata, id)) throw migrationError("LEGACY_CLEANUP_RECOVERY_INVALID");
    const isolated = fs.lstatSync(path.join(directory, "data"));
    if (!isolated.isDirectory() || isolated.isSymbolicLink()
      || isolated.dev !== metadata.sourceDev || isolated.ino !== metadata.sourceIno) {
      throw migrationError("LEGACY_CLEANUP_RECOVERY_IDENTITY_MISMATCH");
    }
    return { directory, metadata };
  };

  const listRecoveries = async (): Promise<LegacyCleanupRecovery[]> => {
    if (!fs.existsSync(quarantineRoot)) return [];
    if (!safeDirectoryChain(allowedRoot, quarantineRoot)) throw migrationError("LEGACY_CLEANUP_RECOVERY_INVALID");
    const results: LegacyCleanupRecovery[] = [];
    for (const entry of fs.readdirSync(quarantineRoot, { withFileTypes: true })) {
      const match = /^legacy-([0-9a-f]{32})$/.exec(entry.name);
      if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        const recovery = readRecovery(match[1]);
        results.push({ id: match[1], state: recovery.metadata.state, updatedAt: recovery.metadata.updatedAt });
      } catch { /* malformed entries are never acted on */ }
    }
    return results.sort((left, right) => left.id.localeCompare(right.id));
  };

  const cleanup = async (confirmation: string): Promise<LegacyCleanupResult> => {
    if (confirmation !== LEGACY_CLEANUP_CONFIRMATION) {
      throw migrationError("LEGACY_CLEANUP_CONFIRMATION_REQUIRED");
    }
    if (!source || !path.isAbsolute(options.pluginDirectory)
      || !isContainedOrEqual(allowedRoot, source) || source === allowedRoot
      || path.basename(source).startsWith(".")) throw migrationError("LEGACY_CLEANUP_UNAVAILABLE");
    if (!await options.isV2Completed()) throw migrationError("LEGACY_CLEANUP_V2_NOT_COMPLETE");
    if (!fs.existsSync(source)) return { removed: 0, failed: 0, skipped: 1 };
    if (!safeDirectoryChain(pluginDirectory, allowedRoot) || !safeDirectoryChain(allowedRoot, source)) {
      throw migrationError("LEGACY_CLEANUP_UNSAFE_PATH");
    }
    fs.mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(quarantineRoot, 0o700);
    if (!safeDirectoryChain(allowedRoot, quarantineRoot)) throw migrationError("LEGACY_CLEANUP_UNSAFE_PATH");
    const sourceIdentity = fs.lstatSync(source);
    const quarantineIdentity = fs.lstatSync(quarantineRoot);
    if (!sourceIdentity.isDirectory() || sourceIdentity.isSymbolicLink()
      || sourceIdentity.dev !== quarantineIdentity.dev) throw migrationError("LEGACY_CLEANUP_UNSAFE_PATH");

    const id = randomUUID().replace(/-/g, "");
    const directory = recoveryDirectory(id);
    const isolated = path.join(directory, "data");
    const metadataPath = path.join(directory, "recovery.json");
    fs.mkdirSync(directory, { mode: 0o700 });
    const now = Date.now();
    let metadata: LegacyRecoveryMetadata = {
      schemaVersion: 1, id, state: "prepared", sourceName: path.basename(source),
      sourceDev: sourceIdentity.dev, sourceIno: sourceIdentity.ino, isolatedAt: now, updatedAt: now,
    };
    writeJsonSyncAtomic(metadataPath, metadata);
    try {
      if (!safeDirectoryChain(pluginDirectory, allowedRoot)
        || !safeDirectoryChain(allowedRoot, source)
        || !safeDirectoryChain(allowedRoot, quarantineRoot)
        || !safeDirectoryChain(quarantineRoot, directory)) throw migrationError("LEGACY_CLEANUP_UNSAFE_PATH");
      const finalIdentity = fs.lstatSync(source);
      if (!sameIdentity(sourceIdentity, finalIdentity)) throw migrationError("LEGACY_CLEANUP_IDENTITY_CHANGED");
      fs.renameSync(source, isolated);
      const isolatedIdentity = fs.lstatSync(isolated);
      if (!sameIdentity(sourceIdentity, isolatedIdentity)) {
        try { fs.renameSync(isolated, source); } catch { /* prepared metadata remains recoverable */ }
        throw migrationError("LEGACY_CLEANUP_IDENTITY_CHANGED");
      }
      metadata = { ...metadata, state: "isolated", updatedAt: Date.now() };
      writeJsonSyncAtomic(metadataPath, metadata);
    } catch (error) {
      if (fs.existsSync(source)) {
        try { fs.unlinkSync(metadataPath); } catch { /* best effort */ }
        try { fs.rmdirSync(directory); } catch { /* best effort */ }
      }
      throw migrationError("LEGACY_CLEANUP_ISOLATION_FAILED", error);
    }

    try {
      const recovery = readRecovery(id);
      await options.trashItem(recovery.directory);
      if (fs.existsSync(recovery.directory)) throw migrationError("LEGACY_CLEANUP_TRASH_INCOMPLETE");
      return { removed: 1, failed: 0, skipped: 0 };
    } catch {
      metadata = { ...metadata, state: "trash-failed", updatedAt: Date.now() };
      try { writeJsonSyncAtomic(metadataPath, metadata); } catch { /* isolated metadata remains durable */ }
      return { removed: 1, failed: 1, skipped: 0 };
    }
  };

  const retryRecovery = async (id: string): Promise<{ removed: number; failed: number }> => {
    const recovery = readRecovery(id);
    try {
      await options.trashItem(recovery.directory);
      if (fs.existsSync(recovery.directory)) throw migrationError("LEGACY_CLEANUP_TRASH_INCOMPLETE");
      return { removed: 1, failed: 0 };
    } catch {
      const metadata = { ...recovery.metadata, state: "trash-failed" as const, updatedAt: Date.now() };
      try { writeJsonSyncAtomic(path.join(recovery.directory, "recovery.json"), metadata); } catch { /* retained */ }
      return { removed: 0, failed: 1 };
    }
  };

  const restoreRecovery = async (id: string): Promise<{ restored: number; failed: number }> => {
    const recovery = readRecovery(id);
    const restoreTarget = path.join(allowedRoot, recovery.metadata.sourceName);
    if (source && restoreTarget !== source) throw migrationError("LEGACY_CLEANUP_RECOVERY_INVALID");
    if (fs.existsSync(restoreTarget)) return { restored: 0, failed: 1 };
    try {
      fs.renameSync(path.join(recovery.directory, "data"), restoreTarget);
      const restored = fs.lstatSync(restoreTarget);
      if (restored.dev !== recovery.metadata.sourceDev || restored.ino !== recovery.metadata.sourceIno
        || !restored.isDirectory() || restored.isSymbolicLink()) {
        try { fs.renameSync(restoreTarget, path.join(recovery.directory, "data")); } catch { /* retained metadata records failure */ }
        throw migrationError("LEGACY_CLEANUP_RECOVERY_IDENTITY_MISMATCH");
      }
      try { fs.unlinkSync(path.join(recovery.directory, "recovery.json")); } catch { /* restored data is committed */ }
      try { fs.rmdirSync(recovery.directory); } catch { /* tombstone cleanup is best effort */ }
      return { restored: 1, failed: 0 };
    } catch {
      if (fs.existsSync(path.join(recovery.directory, "recovery.json"))) {
        const metadata = { ...recovery.metadata, state: "restore-failed" as const, updatedAt: Date.now() };
        try { writeJsonSyncAtomic(path.join(recovery.directory, "recovery.json"), metadata); } catch { /* retained */ }
      }
      return { restored: 0, failed: 1 };
    }
  };

  return { cleanup, listRecoveries, retryRecovery, restoreRecovery };
}

export function createLegacyCleanupCapability(options: {
  legacyDataPath: string | null;
  pluginDirectory: string;
  trustedDataRoot: string;
  quarantineRoot: string;
  isV2Completed(): Promise<boolean>;
  trashItem(target: string): Promise<void>;
}): (confirmation: string) => Promise<LegacyCleanupResult> {
  const manager = createLegacyCleanupManager(options);
  return (confirmation) => manager.cleanup(confirmation);
}
