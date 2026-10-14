import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * The MCP server is bundled into main.js (community installs receive only three files) and
 * written to a stable per-user path so MCP client configurations survive plugin updates.
 */
export const MCP_SERVER_FILE_NAME = "analogy-mcp-server.cjs";
export const MCP_LAST_QUERY_FILE_NAME = "last-query.json";

export interface MaterializedMcpServer {
  entry: string;
  sha256: string;
  written: boolean;
}

export interface McpLastQuery {
  at: number;
  tool: string;
  results?: number;
  durationMs?: number;
  hybrid?: boolean;
}

export function mcpDirectory(localDataRoot: string): string {
  return path.join(localDataRoot, "mcp");
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertRealDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("MCP_DIRECTORY_UNSAFE");
}

/** Writes the bundled server when missing or different, then verifies the bytes on disk. */
export function materializeMcpServer(localDataRoot: string, source: string): MaterializedMcpServer {
  if (!source.trim()) throw new Error("MCP_SERVER_BUNDLE_MISSING");
  const directory = mcpDirectory(localDataRoot);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertRealDirectory(directory);
  const entry = path.join(directory, MCP_SERVER_FILE_NAME);
  const expected = sha256(source);
  let current: string | null = null;
  try {
    const stat = fs.lstatSync(entry);
    if (stat.isFile() && !stat.isSymbolicLink()) current = sha256(fs.readFileSync(entry));
  } catch {
    current = null;
  }
  if (current === expected) return { entry, sha256: expected, written: false };
  const temporary = `${entry}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, entry);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  if (sha256(fs.readFileSync(entry)) !== expected) throw new Error("MCP_SERVER_HASH_MISMATCH");
  return { entry, sha256: expected, written: true };
}

export function readMcpLastQuery(localDataRoot: string, runtimeVaultId: string): McpLastQuery | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(mcpDirectory(localDataRoot), MCP_LAST_QUERY_FILE_NAME), "utf8"));
    if (value?.schemaVersion !== 1 || value.vaultId !== runtimeVaultId || !Number.isFinite(value.at) || typeof value.tool !== "string") {
      return null;
    }
    return {
      at: value.at,
      tool: value.tool.slice(0, 64),
      ...(Number.isFinite(value.results) ? { results: value.results } : {}),
      ...(Number.isFinite(value.durationMs) ? { durationMs: value.durationMs } : {}),
      ...(typeof value.hybrid === "boolean" ? { hybrid: value.hybrid } : {}),
    };
  } catch {
    return null;
  }
}
