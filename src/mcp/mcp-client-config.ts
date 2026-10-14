import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * One-click MCP configuration for desktop AI clients. Every write is previewed as a diff,
 * needs explicit confirmation in the UI, keeps a timestamped backup of the original file
 * and replaces the file atomically. Only the Analogy server entry is added or replaced.
 */

export type McpClientId = "claude-desktop" | "claude-code" | "cursor" | "opencode" | "codex";
export type McpClientStatus = "missing" | "configured" | "outdated" | "unreadable";

export interface McpLaunchSpec {
  serverName: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpClientPlan {
  client: McpClientId;
  label: string;
  configPath: string;
  status: McpClientStatus;
  /** Full new file content, or null when the file cannot be updated safely. */
  nextContent: string | null;
  diff: string;
  error?: string;
}

interface ClientDefinition {
  id: McpClientId;
  label: string;
  configPath(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string;
  format: "json" | "jsonc" | "toml";
  /** Applies the launch spec to the parsed document (JSON clients only). */
  apply?(document: Record<string, unknown>, spec: McpLaunchSpec): Record<string, unknown>;
  read?(document: Record<string, unknown>, serverName: string): unknown;
  entry?(spec: McpLaunchSpec): unknown;
}

function stdioEntry(spec: McpLaunchSpec, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...extra, command: spec.command, args: spec.args, env: spec.env };
}

function withServer(document: Record<string, unknown>, key: string, name: string, entry: unknown): Record<string, unknown> {
  const section = document[key];
  const servers = section && typeof section === "object" && !Array.isArray(section) ? section as Record<string, unknown> : {};
  return { ...document, [key]: { ...servers, [name]: entry } };
}

function serverIn(document: Record<string, unknown>, key: string, name: string): unknown {
  const section = document[key];
  return section && typeof section === "object" && !Array.isArray(section) ? (section as Record<string, unknown>)[name] : undefined;
}

export const MCP_CLIENTS: readonly ClientDefinition[] = [
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    format: "json",
    configPath: (platform, home, env) => platform === "win32"
      ? path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
      : path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    entry: (spec) => stdioEntry(spec),
    apply: (document, spec) => withServer(document, "mcpServers", spec.serverName, stdioEntry(spec)),
    read: (document, name) => serverIn(document, "mcpServers", name),
  },
  {
    id: "claude-code",
    label: "Claude Code",
    format: "json",
    configPath: (_platform, home) => path.join(home, ".claude.json"),
    entry: (spec) => stdioEntry(spec, { type: "stdio" }),
    apply: (document, spec) => withServer(document, "mcpServers", spec.serverName, stdioEntry(spec, { type: "stdio" })),
    read: (document, name) => serverIn(document, "mcpServers", name),
  },
  {
    id: "cursor",
    label: "Cursor",
    format: "json",
    configPath: (_platform, home) => path.join(home, ".cursor", "mcp.json"),
    entry: (spec) => stdioEntry(spec),
    apply: (document, spec) => withServer(document, "mcpServers", spec.serverName, stdioEntry(spec)),
    read: (document, name) => serverIn(document, "mcpServers", name),
  },
  {
    id: "opencode",
    label: "opencode",
    format: "jsonc",
    configPath: (_platform, home) => path.join(home, ".config", "opencode", "opencode.jsonc"),
    entry: (spec) => ({ type: "local", command: [spec.command, ...spec.args], enabled: true, environment: spec.env }),
    apply: (document, spec) => withServer(document, "mcp", spec.serverName,
      { type: "local", command: [spec.command, ...spec.args], enabled: true, environment: spec.env }),
    read: (document, name) => serverIn(document, "mcp", name),
  },
  {
    id: "codex",
    label: "Codex",
    format: "toml",
    configPath: (_platform, home) => path.join(home, ".codex", "config.toml"),
  },
];

/** Strips // and /* *\/ comments and trailing commas outside strings (JSONC → JSON). */
export function stripJsonComments(source: string): string {
  let output = "";
  let inString = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (inString) {
      output += character;
      if (character === "\\") { output += next ?? ""; index += 1; }
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") { inString = true; output += character; continue; }
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    output += character;
  }
  return output.replace(/,(\s*[}\]])/g, "$1");
}

function detectIndent(source: string): string | number {
  const match = /\n([ \t]+)"/.exec(source);
  return match ? (match[1].includes("\t") ? "\t" : match[1].length) : 2;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

/** The Codex block for the Analogy server (a main table plus its env sub-table). */
export function codexBlock(spec: McpLaunchSpec): string {
  const name = tomlKey(spec.serverName);
  return [
    `[mcp_servers.${name}]`,
    `command = ${tomlString(spec.command)}`,
    `args = [${spec.args.map(tomlString).join(", ")}]`,
    "",
    `[mcp_servers.${name}.env]`,
    ...Object.entries(spec.env).map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`),
    "",
  ].join("\n");
}

/** Removes existing tables for this server from a TOML file and returns [rest, removedBlock]. */
export function splitCodexServer(source: string, serverName: string): { rest: string; existing: string } {
  const name = tomlKey(serverName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const owned = new RegExp(`^\\[mcp_servers\\.${name}(?:\\.[^\\]]+)?\\]\\s*$`);
  const lines = source.split(/\r?\n/);
  const rest: string[] = [];
  const existing: string[] = [];
  let inOwned = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) inOwned = owned.test(line.trim());
    (inOwned ? existing : rest).push(line);
  }
  return { rest: rest.join("\n").replace(/\n{3,}/g, "\n\n"), existing: existing.join("\n").trim() };
}

/** Compact unified-style diff: common prefix/suffix trimmed, changed block shown with -/+ lines. */
export function lineDiff(before: string, after: string): string {
  const left = before.split(/\r?\n/);
  const right = after.split(/\r?\n/);
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let endLeft = left.length - 1;
  let endRight = right.length - 1;
  while (endLeft >= start && endRight >= start && left[endLeft] === right[endRight]) { endLeft -= 1; endRight -= 1; }
  if (start > endLeft && start > endRight) return "";
  const context = 2;
  const lines = [`@@ line ${start + 1} @@`];
  for (let index = Math.max(0, start - context); index < start; index += 1) lines.push(`  ${left[index]}`);
  for (let index = start; index <= endLeft; index += 1) lines.push(`- ${left[index]}`);
  for (let index = start; index <= endRight; index += 1) lines.push(`+ ${right[index]}`);
  for (let index = endRight + 1; index < Math.min(right.length, endRight + 1 + context); index += 1) lines.push(`  ${right[index]}`);
  return lines.join("\n");
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function planMcpClientConfig(
  client: ClientDefinition,
  spec: McpLaunchSpec,
  options: { platform?: NodeJS.Platform; home?: string; env?: NodeJS.ProcessEnv; readFile?: (file: string) => string | null } = {},
): McpClientPlan {
  const platform = options.platform ?? process.platform;
  const configPath = client.configPath(platform, options.home ?? os.homedir(), options.env ?? process.env);
  const readFile = options.readFile ?? ((file: string) => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } });
  const original = readFile(configPath);
  const base = { client: client.id, label: client.label, configPath };
  if (client.format === "toml") {
    const source = original ?? "";
    const { rest, existing } = splitCodexServer(source, spec.serverName);
    const block = codexBlock(spec);
    const status: McpClientStatus = !existing ? "missing" : existing === block.trim() ? "configured" : "outdated";
    const nextContent = `${rest.trimEnd()}${rest.trim() ? "\n\n" : ""}${block}`;
    return { ...base, status, nextContent, diff: lineDiff(source, nextContent) };
  }
  let document: Record<string, unknown> = {};
  if (original !== null && original.trim()) {
    try {
      const parsed = JSON.parse(client.format === "jsonc" ? stripJsonComments(original) : original) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      document = parsed as Record<string, unknown>;
    } catch (error) {
      return { ...base, status: "unreadable", nextContent: null, diff: "", error: `Cannot parse ${path.basename(configPath)}: ${(error as Error).message}` };
    }
  }
  const current = client.read!(document, spec.serverName);
  const status: McpClientStatus = current === undefined ? "missing" : sameValue(current, client.entry!(spec)) ? "configured" : "outdated";
  const nextContent = `${JSON.stringify(client.apply!(document, spec), null, detectIndent(original ?? ""))}\n`;
  return { ...base, status, nextContent, diff: lineDiff(original ?? "", nextContent) };
}

export function planAllMcpClients(spec: McpLaunchSpec): McpClientPlan[] {
  return MCP_CLIENTS.map((client) => planMcpClientConfig(client, spec));
}

/** Writes a confirmed plan: backup of the original (if any), then atomic replace. Returns the backup path. */
export function applyMcpClientPlan(plan: McpClientPlan, now: number = Date.now()): string | null {
  if (plan.nextContent === null) throw new Error("MCP_CLIENT_CONFIG_UNREADABLE");
  fs.mkdirSync(path.dirname(plan.configPath), { recursive: true });
  let backup: string | null = null;
  if (fs.existsSync(plan.configPath)) {
    const stat = fs.lstatSync(plan.configPath);
    if (!stat.isFile()) throw new Error("MCP_CLIENT_CONFIG_NOT_A_FILE");
    backup = `${plan.configPath}.analogy-backup-${now}`;
    fs.copyFileSync(plan.configPath, backup);
  }
  const temporary = `${plan.configPath}.${process.pid}.${now}.tmp`;
  try {
    fs.writeFileSync(temporary, plan.nextContent, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, plan.configPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return backup;
}
