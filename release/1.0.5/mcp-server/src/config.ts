import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { EMBEDDING_MODELS, EmbeddingModelConfig } from "./embedding";

export interface McpConfig {
  chromaPort: number;
  vaultPath: string;
  vaultId: string;
  pluginDir: string;
  modelKey: string;
  modelConfig: EmbeddingModelConfig;
  collectionName: string;
  remoteHost: string;
  allowedPaths: string[];
}

function resolveVaultId(vaultPath: string): string {
  return crypto.createHash("md5").update(vaultPath).digest("hex").slice(0, 12);
}

export function loadConfig(): McpConfig {
  const vaultPath = process.env.ANALOGY_VAULT_PATH;
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
    process.env.ANALOGY_PLUGIN_DIR ||
    path.join(vaultPath, ".obsidian/plugins/analogy-rag-in-your-vault");
  if (!fs.existsSync(pluginDir)) {
    throw new Error(
      `Plugin directory does not exist: ${pluginDir}. ` +
        "The Analogy Obsidian plugin must be installed. " +
        "If installed in a non-standard location, set ANALOGY_PLUGIN_DIR."
    );
  }

  const chromaPort = parseInt(process.env.ANALOGY_CHROMA_PORT || "8000", 10);
  if (isNaN(chromaPort) || chromaPort < 1 || chromaPort > 65535) {
    throw new Error(
      `Invalid ANALOGY_CHROMA_PORT: "${process.env.ANALOGY_CHROMA_PORT}". Must be 1-65535.`
    );
  }

  const modelKey = process.env.ANALOGY_MODEL || "jina-nano";
  const modelConfig = EMBEDDING_MODELS[modelKey];
  if (!modelConfig) {
    throw new Error(
      `Unknown embedding model: "${modelKey}". ` +
        `Available models: ${Object.keys(EMBEDDING_MODELS).join(", ")}`
    );
  }

  const vaultId = resolveVaultId(vaultPath);
  const collectionName = `analogy_${vaultId}_${modelConfig.shortName}`;

  const remoteHost =
    process.env.ANALOGY_MODEL_HOST || "https://hf-mirror.com/";

  const allowedPaths = process.env.ANALOGY_ALLOWED_PATHS
    ? process.env.ANALOGY_ALLOWED_PATHS.split(",")
        .map((p) => p.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
        .filter(Boolean)
    : [];

  return {
    chromaPort,
    vaultPath,
    vaultId,
    pluginDir,
    modelKey,
    modelConfig,
    collectionName,
    remoteHost,
    allowedPaths,
  };
}
