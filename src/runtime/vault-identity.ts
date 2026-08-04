import { createHash } from "crypto";
import * as path from "path";
import { SupportedPlatformKey } from "./runtime-types";

function normalizeVaultPath(vaultPath: string, platform: SupportedPlatformKey): string {
  if (!vaultPath || typeof vaultPath !== "string") {
    throw new Error("INVALID_VAULT_PATH: an absolute Vault path is required");
  }

  const pathModule = platform === "win32-x64" ? path.win32 : path.posix;
  if (!pathModule.isAbsolute(vaultPath)) {
    throw new Error("INVALID_VAULT_PATH: an absolute Vault path is required");
  }

  const normalized = pathModule.resolve(vaultPath).normalize("NFC");
  return platform === "win32-x64" ? normalized.toLowerCase() : normalized;
}

export function deriveRuntimeVaultId(vaultPath: string, platform: SupportedPlatformKey): string {
  const canonicalPath = normalizeVaultPath(vaultPath, platform);
  const digest = createHash("sha256").update(canonicalPath, "utf8").digest("hex");
  return `vault-v2-${digest.slice(0, 16)}`;
}
