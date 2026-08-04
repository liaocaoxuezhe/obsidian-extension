import { createHash } from "crypto";
import * as path from "path";

export type RuntimeVaultPlatform = "darwin" | "darwin-arm64" | "darwin-x64" | "win32" | "win32-x64";

export function deriveRuntimeVaultId(vaultPath: string, platform: RuntimeVaultPlatform): string {
  if (!vaultPath || typeof vaultPath !== "string") {
    throw new Error("INVALID_VAULT_PATH: an absolute Vault path is required");
  }
  const windows = platform === "win32" || platform === "win32-x64";
  const pathModule = windows ? path.win32 : path.posix;
  if (!pathModule.isAbsolute(vaultPath)) {
    throw new Error("INVALID_VAULT_PATH: an absolute Vault path is required");
  }
  let canonicalPath = pathModule.resolve(vaultPath).normalize("NFC");
  if (windows) canonicalPath = canonicalPath.toLowerCase();
  return `vault-v2-${createHash("sha256").update(canonicalPath, "utf8").digest("hex").slice(0, 16)}`;
}
