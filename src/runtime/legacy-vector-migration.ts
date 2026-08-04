import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import type { ChromaVectorRecord } from "../local-vector/vector-store";
import type { LegacyBatchResponse, LegacySourceSession } from "./legacy-chroma-runtime-bridge";

export type LegacyVectorMigrationState =
  | "preparing"
  | "copying"
  | "reconciling"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export interface LegacyVectorMigrationSnapshot {
  schemaVersion: 1;
  migrationId: string;
  state: LegacyVectorMigrationState;
  sourceIdentity: string;
  sourceCollectionName: string;
  sourceModelId: string;
  sourceModelShortName: string;
  targetTransitionToken: string;
  targetCollectionName: string;
  vectorDimension: number;
  totalRecords: number;
  copiedRecords: number;
  batchSize: number;
  recordDigest: string;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
  errorCode: string | null;
  action: "retry" | "rebuild" | "none";
}

export interface LegacyVectorMigrationEvidence {
  sourceIdentity: string;
  sourceCollectionName: string;
  sourceModelId: string;
  sourceModelShortName: string;
  targetTransitionToken: string;
  targetCollectionName: string;
  recordCount: number;
  recordDigest: string;
  vectorDimension: number;
  sourceTopIds: string[];
  targetTopIds: string[];
}

export interface LegacyVectorMigrationInspection {
  reusable: true;
  recordCount: number;
  sourceBytes: number;
  vectorDimension: number;
  sourceCollectionName: string;
  modelShortName: string;
}

export interface MigratedDocumentMetadataEvidence {
  docId: string;
  path: string;
  mtime: number;
  chunkCount: number;
  metadataComplete: boolean;
}

export function deriveMigratedDocumentEvidence(response: {
  ids?: unknown;
  metadatas?: unknown;
}): MigratedDocumentMetadataEvidence[] {
  const ids = normalizeList<unknown>(response.ids, true);
  const metadatas = normalizeList<unknown>(response.metadatas, true);
  if (!ids || !metadatas || ids.length !== metadatas.length) {
    throw migrationError("CHROMA_MIGRATION_DOCUMENT_EVIDENCE_INVALID");
  }
  const documents = new Map<string, {
    path: string;
    mtime: number;
    expected: number;
    seen: Set<number>;
    complete: boolean;
  }>();
  for (let index = 0; index < ids.length; index += 1) {
    if (typeof ids[index] !== "string" || !(ids[index] as string)) {
      throw migrationError("CHROMA_MIGRATION_DOCUMENT_EVIDENCE_INVALID");
    }
    const metadata = metadatas[index];
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) continue;
    const item = metadata as Record<string, unknown>;
    const docId = typeof item.doc_id === "string" ? item.doc_id.replace(/\\/g, "/").normalize("NFC") : "";
    if (!docId) continue;
    const itemPath = typeof item.path === "string" && item.path
      ? item.path.replace(/\\/g, "/").normalize("NFC") : docId;
    const mtime = typeof item.mtime === "number" && Number.isFinite(item.mtime) && item.mtime >= 0
      ? item.mtime : 0;
    const chunkIndex = Number.isSafeInteger(item.chunk_index) && (item.chunk_index as number) >= 0
      ? item.chunk_index as number : -1;
    const chunkCount = Number.isSafeInteger(item.chunk_count) && (item.chunk_count as number) >= 1
      ? item.chunk_count as number : 0;
    const semanticMetadata = typeof item.title === "string" && typeof item.section_label === "string";
    const existing = documents.get(docId);
    if (!existing) {
      documents.set(docId, {
        path: itemPath,
        mtime,
        expected: chunkCount,
        seen: new Set(chunkIndex >= 0 ? [chunkIndex] : []),
        complete: Boolean(itemPath && mtime >= 0 && chunkCount > 0 && chunkIndex >= 0 && semanticMetadata),
      });
      continue;
    }
    existing.complete = existing.complete && existing.path === itemPath && existing.mtime === mtime
      && existing.expected === chunkCount && chunkIndex >= 0 && semanticMetadata && !existing.seen.has(chunkIndex);
    if (chunkIndex >= 0) existing.seen.add(chunkIndex);
  }
  return [...documents.entries()].map(([docId, item]) => ({
    docId,
    path: item.path,
    mtime: item.mtime,
    chunkCount: item.seen.size,
    metadataComplete: item.complete && item.expected === item.seen.size
      && [...item.seen].every((value) => value >= 0 && value < item.expected),
  }));
}

interface MigrationDestination {
  upsertRecords(records: readonly ChromaVectorRecord[]): Promise<void>;
  getRecordIdentityPage(offset: number, limit: number): Promise<{ ids: string[] }>;
  count(): Promise<number>;
  queryIds(embedding: readonly number[], topK: number): Promise<string[]>;
}

interface MigrationModel {
  id: string;
  shortName: string;
}

interface TargetMigrationModel extends MigrationModel {
  smokeEmbedding(): Promise<number[]>;
}

export interface LegacyVectorMigrationOptions {
  checkpointPath: string;
  source: LegacySourceSession;
  destination: MigrationDestination;
  sourceModel: MigrationModel;
  expectedCollectionNames: readonly string[];
  targetModel: TargetMigrationModel;
  transition: { transitionToken: string; collectionName: string };
  batchSize?: number;
  now?: () => number;
}

function migrationError(code: string, cause?: unknown): Error {
  return Object.assign(new Error(code), { code, ...(cause === undefined ? {} : { cause }) });
}

function validIdentifier(value: unknown, max = 255): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value);
}

function validHex(value: unknown, length: number): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
}

function safeErrorCode(error: unknown): string {
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(code) ? code : "LEGACY_VECTOR_COPY_FAILED";
}

function cloneSnapshot(snapshot: LegacyVectorMigrationSnapshot): LegacyVectorMigrationSnapshot {
  return { ...snapshot };
}

async function atomicWriteJson(filename: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.promises.rename(temporary, filename);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw migrationError("LEGACY_MIGRATION_CHECKPOINT_WRITE_FAILED", error);
  }
}

function checkpointShape(value: unknown): LegacyVectorMigrationSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowedKeys = [
    "action", "batchSize", "completedAt", "copiedRecords", "errorCode", "migrationId",
    "recordDigest", "schemaVersion", "sourceCollectionName", "sourceIdentity", "sourceModelId",
    "sourceModelShortName", "startedAt", "state", "targetCollectionName", "targetTransitionToken",
    "totalRecords", "updatedAt", "vectorDimension",
  ];
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.length !== allowedKeys.length
    || actualKeys.some((key, index) => key !== allowedKeys[index])) return null;
  const item = value as Partial<LegacyVectorMigrationSnapshot>;
  const states: LegacyVectorMigrationState[] = [
    "preparing", "copying", "reconciling", "verifying", "completed", "failed", "cancelled",
  ];
  if (item.schemaVersion !== 1 || !validHex(item.migrationId, 32)
    || !states.includes(item.state as LegacyVectorMigrationState)
    || !validHex(item.sourceIdentity, 64)
    || !validIdentifier(item.sourceCollectionName)
    || !validIdentifier(item.sourceModelId)
    || !validIdentifier(item.sourceModelShortName)
    || !validHex(item.targetTransitionToken, 32)
    || !validIdentifier(item.targetCollectionName)
    || !Number.isSafeInteger(item.vectorDimension) || (item.vectorDimension as number) < 1
    || !Number.isSafeInteger(item.totalRecords) || (item.totalRecords as number) < 0
    || !Number.isSafeInteger(item.copiedRecords) || (item.copiedRecords as number) < 0
    || (item.copiedRecords as number) > (item.totalRecords as number)
    || !Number.isSafeInteger(item.batchSize) || (item.batchSize as number) < 1 || (item.batchSize as number) > 1024
    || !validHex(item.recordDigest, 64)
    || !Number.isFinite(item.startedAt) || !Number.isFinite(item.updatedAt)
    || (item.completedAt !== null && !Number.isFinite(item.completedAt))
    || (item.errorCode !== null && (typeof item.errorCode !== "string"
      || !/^[A-Z][A-Z0-9_]{2,80}$/.test(item.errorCode)))
    || !["retry", "rebuild", "none"].includes(item.action as string)) return null;
  return item as LegacyVectorMigrationSnapshot;
}

function normalizeList<T>(value: unknown, nested: boolean): T[] | null {
  if (!Array.isArray(value)) return null;
  const selected = nested && Array.isArray(value[0]) ? value[0] : value;
  return Array.isArray(selected) ? selected as T[] : null;
}

function validMetadata(value: unknown): value is Record<string, string | number | boolean> | null {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, item]) => key.length > 0 && key.length <= 256
    && (typeof item === "string" || typeof item === "boolean"
      || (typeof item === "number" && Number.isFinite(item))));
}

function normalizeBatch(response: LegacyBatchResponse, expectedDimension: number): ChromaVectorRecord[] {
  const ids = normalizeList<string>(response.ids, true);
  const documents = normalizeList<string | null>(response.documents, true);
  const metadatas = normalizeList<unknown>(response.metadatas, true);
  let embeddings: unknown = response.embeddings;
  if (Array.isArray(embeddings) && Array.isArray(embeddings[0]) && Array.isArray(embeddings[0][0])) {
    embeddings = embeddings[0];
  }
  if (!ids || !documents || !metadatas || !Array.isArray(embeddings)
    || ids.length !== documents.length || ids.length !== metadatas.length || ids.length !== embeddings.length) {
    throw migrationError("LEGACY_VECTOR_RECORD_INVALID");
  }
  return ids.map((id, index) => {
    const document = documents[index];
    const metadata = metadatas[index];
    const embedding = embeddings[index] as unknown;
    if (Array.isArray(embedding) && embedding.length !== expectedDimension) {
      throw migrationError("LEGACY_VECTOR_DIMENSION_MISMATCH");
    }
    if (typeof id !== "string" || !id || id.length > 2048
      || (document !== null && typeof document !== "string")
      || !validMetadata(metadata) || !Array.isArray(embedding)
      || embedding.length !== expectedDimension
      || embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw migrationError("LEGACY_VECTOR_RECORD_INVALID");
    }
    return { id, document, metadata, embedding: [...embedding] as number[] };
  });
}

function addIdsToDigest(current: string, ids: readonly string[]): string {
  const accumulator = Buffer.from(current, "hex");
  for (const id of ids) {
    const digest = createHash("sha256").update(id, "utf8").digest();
    for (let index = 0; index < accumulator.length; index += 1) accumulator[index] ^= digest[index];
  }
  return accumulator.toString("hex");
}

function topIds(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const ids = (value as { ids?: unknown }).ids;
  const normalized = normalizeList<string>(ids, true);
  return normalized?.filter((id) => typeof id === "string") ?? [];
}

export class LegacyVectorMigration {
  private readonly options: LegacyVectorMigrationOptions;
  private readonly listeners = new Set<(snapshot: Readonly<LegacyVectorMigrationSnapshot>) => void>();
  private readonly now: () => number;
  private snapshot: LegacyVectorMigrationSnapshot | null = null;
  private flight: Promise<LegacyVectorMigrationEvidence> | null = null;
  private controller: AbortController | null = null;

  constructor(options: LegacyVectorMigrationOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  getSnapshot(): Readonly<LegacyVectorMigrationSnapshot> | null {
    return this.snapshot ? Object.freeze(cloneSnapshot(this.snapshot)) : null;
  }

  subscribe(listener: (snapshot: Readonly<LegacyVectorMigrationSnapshot>) => void): () => void {
    this.listeners.add(listener);
    if (this.snapshot) listener(this.getSnapshot() as Readonly<LegacyVectorMigrationSnapshot>);
    return () => this.listeners.delete(listener);
  }

  async inspect(signal: AbortSignal): Promise<LegacyVectorMigrationInspection> {
    if (signal.aborted) throw migrationError("LEGACY_MIGRATION_CANCELLED");
    this.assertCompatibleModels();
    const smokeEmbedding = await this.options.targetModel.smokeEmbedding();
    if (signal.aborted) throw migrationError("LEGACY_MIGRATION_CANCELLED");
    if (!Array.isArray(smokeEmbedding) || smokeEmbedding.length < 1
      || smokeEmbedding.some((value) => !Number.isFinite(value))) {
      throw migrationError("LEGACY_TARGET_MODEL_INVALID");
    }
    const recordCount = await this.options.source.count();
    if (!Number.isSafeInteger(recordCount) || recordCount < 0) {
      throw migrationError("LEGACY_RECORD_COUNT_INVALID");
    }
    if (recordCount > 0) {
      normalizeBatch(await this.options.source.readBatch(0, 1), smokeEmbedding.length);
    }
    return {
      reusable: true,
      recordCount,
      sourceBytes: this.options.source.snapshot.sourceIdentity.totalBytes,
      vectorDimension: smokeEmbedding.length,
      sourceCollectionName: this.options.source.collectionName,
      modelShortName: this.options.sourceModel.shortName,
    };
  }

  start(signal: AbortSignal): Promise<LegacyVectorMigrationEvidence> {
    return this.begin(signal, false);
  }

  resume(signal: AbortSignal): Promise<LegacyVectorMigrationEvidence> {
    return this.begin(signal, true);
  }

  async cancel(): Promise<void> {
    this.controller?.abort();
    await this.flight?.then(() => undefined, () => undefined);
  }

  async discard(): Promise<void> {
    if (this.flight) throw migrationError("LEGACY_MIGRATION_BUSY");
    await fs.promises.rm(this.options.checkpointPath, { force: true });
    this.snapshot = null;
  }

  private begin(signal: AbortSignal, resume: boolean): Promise<LegacyVectorMigrationEvidence> {
    if (this.flight) return this.flight;
    const controller = new AbortController();
    this.controller = controller;
    const abort = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abort, { once: true });
    const operation = this.run(controller.signal, resume);
    this.flight = operation;
    void operation.finally(() => {
      signal.removeEventListener("abort", abort);
      if (this.flight === operation) this.flight = null;
      if (this.controller === controller) this.controller = null;
    }).catch(() => undefined);
    return operation;
  }

  private async run(signal: AbortSignal, resume: boolean): Promise<LegacyVectorMigrationEvidence> {
    try {
      this.assertCompatibleModels();
      const smokeEmbedding = await this.options.targetModel.smokeEmbedding();
      if (!Array.isArray(smokeEmbedding) || smokeEmbedding.length < 1
        || smokeEmbedding.some((value) => !Number.isFinite(value))) {
        throw migrationError("LEGACY_TARGET_MODEL_INVALID");
      }
      const totalRecords = await this.options.source.count();
      if (!Number.isSafeInteger(totalRecords) || totalRecords < 0) {
        throw migrationError("LEGACY_RECORD_COUNT_INVALID");
      }
      const existing = resume ? await this.readCheckpoint() : null;
      if (resume && !existing) throw migrationError("LEGACY_MIGRATION_CHECKPOINT_INVALID");
      const batchSize = this.options.batchSize ?? 256;
      if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1024) {
        throw migrationError("LEGACY_BATCH_RANGE_INVALID");
      }
      this.snapshot = existing ?? {
        schemaVersion: 1,
        migrationId: randomUUID().replace(/-/g, ""),
        state: "preparing",
        sourceIdentity: this.options.source.snapshot.sourceIdentity.digest,
        sourceCollectionName: this.options.source.collectionName,
        sourceModelId: this.options.sourceModel.id,
        sourceModelShortName: this.options.sourceModel.shortName,
        targetTransitionToken: this.options.transition.transitionToken,
        targetCollectionName: this.options.transition.collectionName,
        vectorDimension: smokeEmbedding.length,
        totalRecords,
        copiedRecords: 0,
        batchSize,
        recordDigest: "0".repeat(64),
        startedAt: this.now(),
        updatedAt: this.now(),
        completedAt: null,
        errorCode: null,
        action: "retry",
      };
      this.assertCheckpointMatches(this.snapshot, totalRecords, smokeEmbedding.length, batchSize);
      await this.publish({ state: "copying", errorCode: null, action: "retry" });
      while (this.snapshot.copiedRecords < totalRecords) {
        this.assertNotAborted(signal);
        const offset = this.snapshot.copiedRecords;
        const limit = Math.min(batchSize, totalRecords - offset);
        const records = normalizeBatch(await this.options.source.readBatch(offset, limit), smokeEmbedding.length);
        if (records.length !== limit) throw migrationError("LEGACY_SOURCE_CHANGED");
        await this.options.destination.upsertRecords(records);
        await this.publish({
          copiedRecords: offset + records.length,
          recordDigest: addIdsToDigest(this.snapshot.recordDigest, records.map(({ id }) => id)),
        });
      }
      this.assertNotAborted(signal);
      await this.publish({ state: "verifying" });
      if (await this.options.source.count() !== totalRecords
        || await this.options.destination.count() !== totalRecords) {
        throw migrationError("LEGACY_MIGRATION_COUNT_MISMATCH");
      }
      let destinationDigest = "0".repeat(64);
      let destinationOffset = 0;
      while (destinationOffset < totalRecords) {
        const page = await this.options.destination.getRecordIdentityPage(
          destinationOffset,
          Math.min(batchSize, totalRecords - destinationOffset),
        );
        if (page.ids.length < 1) throw migrationError("LEGACY_MIGRATION_DIGEST_MISMATCH");
        destinationDigest = addIdsToDigest(destinationDigest, page.ids);
        destinationOffset += page.ids.length;
      }
      if (destinationOffset !== totalRecords || destinationDigest !== this.snapshot.recordDigest) {
        throw migrationError("LEGACY_MIGRATION_DIGEST_MISMATCH");
      }
      const sourceTopIds = topIds(await this.options.source.query(smokeEmbedding, Math.min(3, Math.max(1, totalRecords))));
      const targetTopIds = await this.options.destination.queryIds(smokeEmbedding, Math.min(3, Math.max(1, totalRecords)));
      const expectedSmokeResults = Math.min(3, totalRecords);
      const targetTopIdSet = new Set(targetTopIds);
      if (sourceTopIds.length !== expectedSmokeResults || targetTopIds.length !== expectedSmokeResults
        || (expectedSmokeResults > 0 && !sourceTopIds.some((id) => targetTopIdSet.has(id)))) {
        throw migrationError("LEGACY_MIGRATION_SMOKE_MISMATCH");
      }
      await this.publish({ state: "completed", completedAt: this.now(), action: "none", errorCode: null });
      return {
        sourceIdentity: this.snapshot.sourceIdentity,
        sourceCollectionName: this.snapshot.sourceCollectionName,
        sourceModelId: this.snapshot.sourceModelId,
        sourceModelShortName: this.snapshot.sourceModelShortName,
        targetTransitionToken: this.snapshot.targetTransitionToken,
        targetCollectionName: this.snapshot.targetCollectionName,
        recordCount: totalRecords,
        recordDigest: this.snapshot.recordDigest,
        vectorDimension: this.snapshot.vectorDimension,
        sourceTopIds,
        targetTopIds,
      };
    } catch (error) {
      const code = signal.aborted ? "LEGACY_MIGRATION_CANCELLED" : safeErrorCode(error);
      if (this.snapshot) {
        await this.publish({
          state: signal.aborted ? "cancelled" : "failed",
          errorCode: code,
          action: signal.aborted ? "retry" : code === "LEGACY_MODEL_MISMATCH" ? "rebuild" : "retry",
        }).catch(() => undefined);
      }
      if ([
        "LEGACY_MODEL_MISMATCH",
        "LEGACY_COLLECTION_UNTRUSTED",
        "LEGACY_VECTOR_DIMENSION_MISMATCH",
        "LEGACY_MIGRATION_CHECKPOINT_MISMATCH",
        "LEGACY_MIGRATION_CHECKPOINT_INVALID",
      ].includes(code)) throw migrationError(code);
      throw migrationError(code === "LEGACY_MIGRATION_CANCELLED" ? code : "LEGACY_VECTOR_COPY_FAILED", error);
    }
  }

  private assertCompatibleModels(): void {
    if (!Array.isArray(this.options.expectedCollectionNames)
      || this.options.expectedCollectionNames.length < 1
      || this.options.expectedCollectionNames.length > 4
      || this.options.expectedCollectionNames.some((name) => !validIdentifier(name))
      || !this.options.expectedCollectionNames.includes(this.options.source.collectionName)) {
      throw migrationError("LEGACY_COLLECTION_UNTRUSTED");
    }
    if (this.options.sourceModel.id !== this.options.targetModel.id
      || this.options.sourceModel.shortName !== this.options.targetModel.shortName
      || !validIdentifier(this.options.sourceModel.id)
      || !validIdentifier(this.options.sourceModel.shortName)) {
      throw migrationError("LEGACY_MODEL_MISMATCH");
    }
  }

  private assertCheckpointMatches(
    checkpoint: LegacyVectorMigrationSnapshot,
    totalRecords: number,
    vectorDimension: number,
    batchSize: number,
  ): void {
    if (checkpoint.sourceIdentity !== this.options.source.snapshot.sourceIdentity.digest
      || checkpoint.sourceCollectionName !== this.options.source.collectionName
      || checkpoint.sourceModelId !== this.options.sourceModel.id
      || checkpoint.sourceModelShortName !== this.options.sourceModel.shortName
      || checkpoint.targetTransitionToken !== this.options.transition.transitionToken
      || checkpoint.targetCollectionName !== this.options.transition.collectionName
      || checkpoint.vectorDimension !== vectorDimension
      || checkpoint.totalRecords !== totalRecords
      || checkpoint.batchSize !== batchSize) {
      throw migrationError("LEGACY_MIGRATION_CHECKPOINT_MISMATCH");
    }
  }

  private async readCheckpoint(): Promise<LegacyVectorMigrationSnapshot | null> {
    let body: string;
    try { body = await fs.promises.readFile(this.options.checkpointPath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw migrationError("LEGACY_MIGRATION_CHECKPOINT_INVALID", error);
    }
    try {
      const checkpoint = checkpointShape(JSON.parse(body));
      if (!checkpoint) throw migrationError("LEGACY_MIGRATION_CHECKPOINT_INVALID");
      return checkpoint;
    } catch (error) {
      if ((error as Error).message === "LEGACY_MIGRATION_CHECKPOINT_INVALID") throw error;
      throw migrationError("LEGACY_MIGRATION_CHECKPOINT_INVALID", error);
    }
  }

  private assertNotAborted(signal: AbortSignal): void {
    if (signal.aborted) throw migrationError("LEGACY_MIGRATION_CANCELLED");
  }

  private async publish(patch: Partial<LegacyVectorMigrationSnapshot>): Promise<void> {
    if (!this.snapshot) throw migrationError("LEGACY_MIGRATION_STATE_INVALID");
    this.snapshot = { ...this.snapshot, ...patch, updatedAt: this.now() };
    await atomicWriteJson(this.options.checkpointPath, this.snapshot);
    const immutable = Object.freeze(cloneSnapshot(this.snapshot));
    for (const listener of [...this.listeners]) listener(immutable);
  }
}
