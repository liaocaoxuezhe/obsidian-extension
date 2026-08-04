import * as fs from "fs";
import * as path from "path";
import { EMBEDDING_MODELS, EmbeddingModelConfig } from "./embedding";
import { deriveRuntimeVaultId, RuntimeVaultPlatform } from "./runtime-vault-identity";

export interface McpConfig {
  chromaPort: number;
  vaultPath: string;
  vaultId: string;
  runtimeVaultId: string;
  runtimeGeneration: "legacy" | "v2";
  pluginDir: string;
  modelKey: string;
  modelConfig: EmbeddingModelConfig;
  collectionName: string;
  remoteHost: string;
  allowedPaths: string[];
}

interface RuntimeStatePointer {
  schemaVersion: 1;
  revision: number;
  runtimeVaultId: string;
  activeGeneration: "legacy" | "v2";
  previousGeneration: GenerationPointer | null;
  pendingGeneration: (GenerationPointer & { generation: "v2"; rebuildCompletedAt: null }) | null;
  runtimeId: string;
  port: number;
  modelShortName: string;
  collectionName: string;
  rebuildCompletedAt: number | null;
  scopeCompletion: ScopeCompletion | null;
}

interface GenerationPointer {
  generation: "legacy" | "v2";
  runtimeId: string;
  port: number;
  modelShortName: string;
  collectionName: string;
  rebuildCompletedAt: number | null;
  scopeCompletion: ScopeCompletion | null;
}

interface ScopeCompletion {
  schemaVersion: 1;
  evidenceId: string;
  scopeType: "recent" | "folder" | "vault";
  selectionDigest: string;
  fileCount: number;
  chunkCount: number;
  completedAt: number;
}

const STATE_KEYS = [
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

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function validScopeCompletion(value: unknown): value is ScopeCompletion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return exactKeys(scope, SCOPE_KEYS) && scope.schemaVersion === 1
    && typeof scope.evidenceId === "string" && /^[0-9a-f]{32}$/.test(scope.evidenceId)
    && (scope.scopeType === "recent" || scope.scopeType === "folder" || scope.scopeType === "vault")
    && typeof scope.selectionDigest === "string" && /^[0-9a-f]{64}$/.test(scope.selectionDigest)
    && Number.isSafeInteger(scope.fileCount) && (scope.fileCount as number) >= 0
    && Number.isSafeInteger(scope.chunkCount) && (scope.chunkCount as number) >= 0
    && Number.isSafeInteger(scope.completedAt) && (scope.completedAt as number) > 0;
}

function validV2Collection(value: unknown, runtimeVaultId: string, modelShortName: string): boolean {
  if (typeof value !== "string") return false;
  const prefix = `analogy_${runtimeVaultId}_${modelShortName}`;
  return value === prefix || new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_[0-9a-f]{12}$`).test(value);
}

function validGenerationPointer(value: unknown, runtimeVaultId: string, pending = false): value is GenerationPointer {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  if (!exactKeys(raw, pending ? PENDING_KEYS : POINTER_KEYS)) return false;
  const pointer = value as Partial<GenerationPointer> & { transitionToken?: unknown; startedAt?: unknown };
  return (pointer.generation === "legacy" || pointer.generation === "v2")
    && (!pending || pointer.generation === "v2")
    && typeof pointer.runtimeId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(pointer.runtimeId)
    && Number.isSafeInteger(pointer.port) && pointer.port! >= 1 && pointer.port! <= 65_535
    && typeof pointer.modelShortName === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pointer.modelShortName)
    && typeof pointer.collectionName === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/.test(pointer.collectionName)
    && (pointer.generation !== "v2"
      || validV2Collection(pointer.collectionName, runtimeVaultId, pointer.modelShortName!))
    && (pointer.rebuildCompletedAt === null
      || (Number.isSafeInteger(pointer.rebuildCompletedAt) && pointer.rebuildCompletedAt! > 0))
    && (!pending || (pointer.rebuildCompletedAt === null
      && typeof pointer.transitionToken === "string" && /^[0-9a-f]{32}$/.test(pointer.transitionToken)
      && Number.isSafeInteger(pointer.startedAt) && (pointer.startedAt as number) > 0))
    && (pending || (pointer.generation === "v2"
      ? Number.isSafeInteger(pointer.rebuildCompletedAt) && pointer.rebuildCompletedAt! > 0
        && validScopeCompletion(pointer.scopeCompletion)
      : pointer.rebuildCompletedAt === null && pointer.scopeCompletion === null));
}

function resolveLocalDataRoot(
  environment: NodeJS.ProcessEnv,
  platform: "darwin" | "win32",
  homeDirectory: string,
): string {
  if (environment.ANALOGY_LOCAL_DATA_ROOT) {
    if (!path.isAbsolute(environment.ANALOGY_LOCAL_DATA_ROOT)) {
      throw new Error("ANALOGY_LOCAL_DATA_ROOT must be an absolute path.");
    }
    return path.resolve(environment.ANALOGY_LOCAL_DATA_ROOT);
  }
  if (platform === "darwin") return path.join(homeDirectory, "Library", "Application Support", "Analogy");
  return path.join(environment.LOCALAPPDATA || path.join(homeDirectory, "AppData", "Local"), "Analogy");
}

function readRuntimeState(filename: string, expectedRuntimeVaultId: string): RuntimeStatePointer {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
    throw new Error("Analogy runtime-state.json is not a trusted regular file.");
  }
  const state = JSON.parse(fs.readFileSync(filename, "utf8")) as Partial<RuntimeStatePointer>;
  if (!exactKeys(state as Record<string, unknown>, STATE_KEYS)
    || state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision! < 1
    || state.runtimeVaultId !== expectedRuntimeVaultId
    || (state.activeGeneration !== "legacy" && state.activeGeneration !== "v2")
    || typeof state.runtimeId !== "string" || !state.runtimeId
    || !Number.isSafeInteger(state.port) || state.port! < 1 || state.port! > 65_535
    || typeof state.modelShortName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(state.modelShortName)
    || typeof state.collectionName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/.test(state.collectionName)
    || (state.activeGeneration === "v2"
      && (state.runtimeId !== "chroma-cli-1.4.4"
        || !validV2Collection(state.collectionName, expectedRuntimeVaultId, state.modelShortName!)
        || !Number.isSafeInteger(state.rebuildCompletedAt) || state.rebuildCompletedAt! <= 0
        || !validScopeCompletion(state.scopeCompletion)))
    || (state.activeGeneration === "legacy"
      && (state.rebuildCompletedAt !== null || state.scopeCompletion !== null))
    || (state.rebuildCompletedAt !== null
      && (!Number.isSafeInteger(state.rebuildCompletedAt) || state.rebuildCompletedAt! <= 0))
    || (state.previousGeneration !== null
      && !validGenerationPointer(state.previousGeneration, expectedRuntimeVaultId))
    || (state.pendingGeneration !== null
      && !validGenerationPointer(state.pendingGeneration, expectedRuntimeVaultId, true))) {
    throw new Error("Analogy runtime-state.json is invalid or belongs to another Vault.");
  }
  return state as RuntimeStatePointer;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  options: { platform?: "darwin" | "win32"; homeDirectory?: string } = {},
): McpConfig {
  const vaultPath = environment.ANALOGY_VAULT_PATH;
  if (!vaultPath) {
    throw new Error(
      "ANALOGY_VAULT_PATH environment variable is required. " +
        "Set it to the absolute path of your Obsidian vault (e.g. /Users/you/my-vault)."
    );
  }
  if (!fs.existsSync(vaultPath)) {
    throw new Error(
      `Vault path does not exist: ${vaultPath}. ` +
        "Check your ANALOGY_VAULT_PATH environment variable."
    );
  }

  const pluginDir =
    environment.ANALOGY_PLUGIN_DIR ||
    path.join(vaultPath, ".obsidian/plugins/analogy-rag-in-your-vault");
  if (!fs.existsSync(pluginDir)) {
    throw new Error(
      `Plugin directory does not exist: ${pluginDir}. ` +
        "The Analogy Obsidian plugin must be installed. " +
        "If installed in a non-standard location, set ANALOGY_PLUGIN_DIR."
    );
  }

  const platform = options.platform ?? (process.platform === "win32" ? "win32" : "darwin");
  const runtimeVaultId = deriveRuntimeVaultId(
    vaultPath,
    (platform === "win32" ? "win32-x64" : "darwin-arm64") as RuntimeVaultPlatform,
  );
  const localDataRoot = resolveLocalDataRoot(environment, platform, options.homeDirectory ?? require("os").homedir());
  const runtimeState = readRuntimeState(
    path.join(localDataRoot, "vaults", runtimeVaultId, "runtime-state.json"),
    runtimeVaultId,
  );

  const rawPort = environment.ANALOGY_CHROMA_PORT ?? String(runtimeState.port);
  const chromaPort = /^[1-9][0-9]{0,4}$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  if (!Number.isSafeInteger(chromaPort) || chromaPort < 1 || chromaPort > 65535) {
    throw new Error(
      `Invalid ANALOGY_CHROMA_PORT: "${environment.ANALOGY_CHROMA_PORT}". Must be 1-65535.`
    );
  }

  const configuredModel = environment.ANALOGY_MODEL;
  const requestedModelKey = configuredModel
    ? (EMBEDDING_MODELS[configuredModel] ? configuredModel : Object.keys(EMBEDDING_MODELS).find(
      (key) => EMBEDDING_MODELS[key].shortName === configuredModel,
    ))
    : Object.keys(EMBEDDING_MODELS).find(
      (key) => EMBEDDING_MODELS[key].shortName === runtimeState.modelShortName,
    );
  const modelKey = requestedModelKey || configuredModel || runtimeState.modelShortName;
  const modelConfig = EMBEDDING_MODELS[modelKey];
  if (!modelConfig) {
    throw new Error(
      `Unknown embedding model: "${modelKey}". ` +
        `Available models: ${Object.keys(EMBEDDING_MODELS).join(", ")}`
    );
  }

  let selectedGeneration: GenerationPointer = {
    generation: runtimeState.activeGeneration,
    runtimeId: runtimeState.runtimeId,
    port: runtimeState.port,
    modelShortName: runtimeState.modelShortName,
    collectionName: runtimeState.collectionName,
    rebuildCompletedAt: runtimeState.rebuildCompletedAt,
    scopeCompletion: runtimeState.scopeCompletion,
  };
  if (configuredModel && modelConfig.shortName !== runtimeState.modelShortName) {
    const previous = runtimeState.previousGeneration;
    if (runtimeState.activeGeneration !== "v2" || previous?.generation !== "v2"
      || previous.modelShortName !== modelConfig.shortName || previous.rebuildCompletedAt === null
      || !previous.scopeCompletion) {
      throw new Error(`ANALOGY_MODEL "${configuredModel}" has no completed generation evidence.`);
    }
    selectedGeneration = previous;
  }

  const vaultId = runtimeVaultId;
  const collectionName = selectedGeneration.collectionName;

  const remoteHost =
    environment.ANALOGY_MODEL_HOST || "https://hf-mirror.com/";

  const allowedPaths = environment.ANALOGY_ALLOWED_PATHS
    ? environment.ANALOGY_ALLOWED_PATHS.split(",")
        .map((p) => p.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
        .filter(Boolean)
    : [];

  return {
    chromaPort,
    vaultPath,
    vaultId,
    runtimeVaultId,
    runtimeGeneration: runtimeState.activeGeneration,
    pluginDir,
    modelKey,
    modelConfig,
    collectionName,
    remoteHost,
    allowedPaths,
  };
}

export function buildSafeVaultDescription(config: McpConfig): string {
  const pathScope = config.allowedPaths.length > 0
    ? `Accessible path filters: ${config.allowedPaths.length}`
    : "Scope: entire vault (no path restrictions)";
  return `Obsidian vault id: ${config.runtimeVaultId}. Embedding model: ${config.modelConfig.shortName}. ${pathScope}`;
}
