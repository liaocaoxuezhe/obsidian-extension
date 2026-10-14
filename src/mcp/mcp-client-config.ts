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
  /** Top-level key holding the server map (JSON clients only). */
  section?: string;
  entry?(spec: McpLaunchSpec): unknown;
}

function stdioEntry(spec: McpLaunchSpec, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...extra, command: spec.command, args: spec.args, env: spec.env };
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
    section: "mcpServers",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    format: "json",
    configPath: (_platform, home) => path.join(home, ".claude.json"),
    entry: (spec) => stdioEntry(spec, { type: "stdio" }),
    section: "mcpServers",
  },
  {
    id: "cursor",
    label: "Cursor",
    format: "json",
    configPath: (_platform, home) => path.join(home, ".cursor", "mcp.json"),
    entry: (spec) => stdioEntry(spec),
    section: "mcpServers",
  },
  {
    id: "opencode",
    label: "opencode",
    format: "jsonc",
    configPath: (_platform, home) => path.join(home, ".config", "opencode", "opencode.jsonc"),
    entry: (spec) => ({ type: "local", command: [spec.command, ...spec.args], enabled: true, environment: spec.env }),
    section: "mcp",
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

interface JsonMember {
  key: string;
  /** Offset of the key's opening quote. */
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

interface JsonObjectSpan {
  open: number;
  close: number;
  members: JsonMember[];
}

/** Skips whitespace and (for JSONC) comments; returns the next significant offset. */
function skipTrivia(source: string, index: number): number {
  for (;;) {
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (source.startsWith("//", index)) {
      while (index < source.length && source[index] !== "\n") index += 1;
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
    } else {
      return index;
    }
  }
}

function skipString(source: string, index: number): number {
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\\") cursor += 1;
    else if (source[cursor] === "\"") return cursor + 1;
  }
  throw new Error("unterminated string");
}

/** Returns the end offset of the JSON value starting at `index`. */
function skipValue(source: string, index: number): number {
  const character = source[index];
  if (character === "\"") return skipString(source, index);
  if (character === "{" || character === "[") {
    const close = character === "{" ? "}" : "]";
    let cursor = skipTrivia(source, index + 1);
    while (source[cursor] !== close) {
      if (cursor >= source.length) throw new Error("unterminated container");
      if (character === "{") {
        cursor = skipTrivia(source, skipString(source, cursor));
        cursor = skipTrivia(source, cursor + 1);
      }
      cursor = skipTrivia(source, skipValue(source, cursor));
      if (source[cursor] === ",") cursor = skipTrivia(source, cursor + 1);
    }
    return cursor + 1;
  }
  const match = /^(?:true|false|null|-?\d[\d.eE+-]*)/.exec(source.slice(index));
  if (!match) throw new Error(`unexpected token at ${index}`);
  return index + match[0].length;
}

/** Lists the members of the object starting at `open` with their exact text spans. */
function objectSpan(source: string, open: number): JsonObjectSpan {
  if (source[open] !== "{") throw new Error("expected an object");
  const members: JsonMember[] = [];
  let cursor = skipTrivia(source, open + 1);
  while (source[cursor] !== "}") {
    const keyStart = cursor;
    const keyEnd = skipString(source, cursor);
    const key = JSON.parse(source.slice(keyStart, keyEnd)) as string;
    cursor = skipTrivia(source, keyEnd);
    if (source[cursor] !== ":") throw new Error("expected ':'");
    const valueStart = skipTrivia(source, cursor + 1);
    const valueEnd = skipValue(source, valueStart);
    members.push({ key, keyStart, valueStart, valueEnd });
    cursor = skipTrivia(source, valueEnd);
    if (source[cursor] === ",") cursor = skipTrivia(source, cursor + 1);
  }
  return { open, close: cursor, members };
}

function lineIndent(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(source.slice(lineStart))?.[0] ?? "";
}

function serializeAt(value: unknown, indentUnit: string | number, baseIndent: string): string {
  return JSON.stringify(value, null, indentUnit).split("\n").join(`\n${baseIndent}`);
}

/**
 * Sets `document[section][name] = value` by editing only that member's text, so the rest of the
 * file (formatting, key order, comments) stays byte-for-byte unchanged.
 */
export function setJsonMember(source: string, section: string, name: string, value: unknown): string {
  const unit = detectIndent(source);
  const unitText = typeof unit === "number" ? " ".repeat(unit) : unit;
  if (!source.trim()) return `${JSON.stringify({ [section]: { [name]: value } }, null, unit)}\n`;
  const root = objectSpan(source, skipTrivia(source, 0));
  const insertMember = (object: JsonObjectSpan, key: string, memberValue: unknown): string => {
    const last = object.members[object.members.length - 1];
    const closeIndent = lineIndent(source, object.close);
    const memberIndent = last ? lineIndent(source, last.keyStart) : `${closeIndent}${unitText}`;
    const text = `${JSON.stringify(key)}: ${serializeAt(memberValue, unit, memberIndent)}`;
    if (last) return `${source.slice(0, last.valueEnd)},\n${memberIndent}${text}${source.slice(last.valueEnd)}`;
    return `${source.slice(0, object.open + 1)}\n${memberIndent}${text}\n${closeIndent}${source.slice(object.close)}`;
  };
  const sectionMember = root.members.find((member) => member.key === section);
  if (!sectionMember) return insertMember(root, section, { [name]: value });
  if (source[sectionMember.valueStart] !== "{") throw new Error(`"${section}" is not an object`);
  const servers = objectSpan(source, sectionMember.valueStart);
  const existing = servers.members.find((member) => member.key === name);
  if (!existing) return insertMember(servers, name, value);
  return `${source.slice(0, existing.valueStart)}${serializeAt(value, unit, lineIndent(source, existing.keyStart))}${source.slice(existing.valueEnd)}`;
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
  const current = serverIn(document, client.section!, spec.serverName);
  const status: McpClientStatus = current === undefined ? "missing" : sameValue(current, client.entry!(spec)) ? "configured" : "outdated";
  let nextContent: string;
  try {
    nextContent = setJsonMember(original ?? "", client.section!, spec.serverName, client.entry!(spec));
  } catch (error) {
    return { ...base, status: "unreadable", nextContent: null, diff: "", error: `Cannot edit ${path.basename(configPath)}: ${(error as Error).message}` };
  }
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
