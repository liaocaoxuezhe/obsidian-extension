/**
 * Analogy MCP server bundled into main.js (P3.2). The plugin materializes this file to a
 * stable per-user path and MCP clients run it with the managed runtime's Node:
 *   <managed node> <localDataRoot>/mcp/analogy-mcp-server.cjs
 * It opens the plugin's SQLite store read-only (Obsidian may be closed), embeds queries
 * offline with the managed runtime, and fuses keyword hits when the keyword index is ready.
 */
import * as fs from "fs";
import * as path from "path";
import { buildSafeVaultDescription, loadConfig, type McpConfig } from "../../../mcp-server/src/config";
import { SqliteVectorReader, type SqliteSearchResult } from "../../../mcp-server/src/sqlite-vector-reader";
import { buildKeywordQuery, reciprocalRankFusion } from "../../local-vector/keyword-search";
import { OfflineQueryEmbedder } from "./offline-embedding";
import { StdioMcpServer, type ToolResult } from "./protocol";

declare const __ANALOGY_MCP_SERVER_VERSION__: string | undefined;
const SERVER_VERSION = typeof __ANALOGY_MCP_SERVER_VERSION__ === "string" ? __ANALOGY_MCP_SERVER_VERSION__ : "dev";

interface ServerState { config: McpConfig; reader: SqliteVectorReader; embedder: OfflineQueryEmbedder }

let state: ServerState | null = null;
let initializing: Promise<ServerState> | null = null;

function log(message: string): void {
  process.stderr.write(`[analogy-mcp] ${message}\n`);
}

function text(value: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

async function ensureInitialized(): Promise<ServerState> {
  if (state) return state;
  initializing ??= (async () => {
    const config = loadConfig();
    const reader = new SqliteVectorReader(config.databasePath);
    if (!reader.hasCollection(config.collectionName)) {
      reader.close();
      throw new Error(`The vault has not been indexed with "${config.modelConfig.shortName}" yet. Open Obsidian and let Analogy finish indexing.`);
    }
    const moduleRoot = process.env.ANALOGY_RUNTIME_MODULE_ROOT ?? "";
    const modelCache = path.join(config.localDataRoot, "models", "transformers-cache", config.modelConfig.shortName);
    const embedder = new OfflineQueryEmbedder(config.modelConfig, moduleRoot, modelCache);
    log(`Loading ${config.modelConfig.shortName} offline...`);
    await embedder.initialize();
    const ready: ServerState = { config, reader, embedder };
    state = ready;
    return ready;
  })().finally(() => { initializing = null; });
  return initializing;
}

function isPathAllowed(config: McpConfig, filePath: string): boolean {
  if (config.allowedPaths.length === 0) return true;
  const normalized = filePath.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return config.allowedPaths.some((allowed) => normalized === allowed || normalized.startsWith(`${allowed}/`));
}

/** Records the last query (time, tool, result count — never the query text) for the plugin's settings page. */
function recordLastQuery(config: McpConfig, entry: Record<string, unknown>): void {
  try {
    const directory = path.join(config.localDataRoot, "mcp");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, "last-query.json");
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, at: Date.now(), vaultId: config.runtimeVaultId, ...entry })}\n`, { mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch {
    // Status reporting must never break a search.
  }
}

export function fuseHybridResults(
  vector: SqliteSearchResult[],
  keyword: { fts: string[]; like: string[] },
  loadMissing: (ids: string[]) => SqliteSearchResult[],
  limit: number,
): Array<SqliteSearchResult & { matched_by: string[] }> {
  if (keyword.fts.length === 0 && keyword.like.length === 0) {
    return vector.slice(0, limit).map((result) => ({ ...result, matched_by: ["vector"] }));
  }
  const fused = reciprocalRankFusion([
    { ids: vector.map((result) => result.chunkId), weight: 1 },
    { ids: keyword.fts, weight: 1 },
    { ids: keyword.like, weight: 1 },
  ]).slice(0, limit);
  const byId = new Map(vector.map((result) => [result.chunkId, result]));
  const missing = fused.map(({ id }) => id).filter((id) => !byId.has(id));
  for (const result of loadMissing(missing)) byId.set(result.chunkId, result);
  const keywordIds = new Set([...keyword.fts, ...keyword.like]);
  return fused.flatMap(({ id }) => {
    const result = byId.get(id);
    if (!result) return [];
    const matched = [...(vector.some((entry) => entry.chunkId === id) ? ["vector"] : []), ...(keywordIds.has(id) ? ["keyword"] : [])];
    return [{ ...result, matched_by: matched }];
  });
}

export function createAnalogyMcpServer(): StdioMcpServer {
  const server = new StdioMcpServer({ name: "analogy-obsidian-vault", version: SERVER_VERSION });
  server.addTool({
    name: "vault_semantic_search",
    description: "Search the user's Obsidian vault. Combines semantic similarity (local embedding model) with keyword matching "
      + "for exact names, people and code identifiers. Returns the most relevant note chunks with path, title, similarity "
      + "and content. Call vault_index_status first to learn the scope. Works while Obsidian is closed.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for: a natural-language description, a name, or an identifier." },
        top_k: { type: "integer", minimum: 1, maximum: 50, default: 5, description: "Number of chunks to return (1-50)." },
      },
      required: ["query"],
    },
    async handler(args) {
      const query = typeof args.query === "string" ? args.query : "";
      const topK = Math.min(50, Math.max(1, Number.isInteger(args.top_k) ? args.top_k as number : 5));
      if (!query.trim()) return text({ error: "EMPTY_QUERY", message: "Provide a non-empty query." }, true);
      const started = Date.now();
      const { config, reader, embedder } = await ensureInitialized();
      const embedding = await embedder.embedQuery(query);
      const candidates = topK + 10;
      const vector = reader.search(config.collectionName, embedding, Math.max(candidates, 50));
      const keywordQuery = buildKeywordQuery(query);
      const keyword = reader.keywordCandidates(config.collectionName, keywordQuery.match, keywordQuery.shortTerms, 50);
      const results = fuseHybridResults(vector, keyword, (ids) => reader.chunksByIds(config.collectionName, ids, embedding), Math.max(candidates, 50))
        .filter((result) => {
          const notePath = result.metadata?.path;
          return typeof notePath === "string" ? isPathAllowed(config, notePath) : config.allowedPaths.length === 0;
        })
        .slice(0, topK);
      recordLastQuery(config, { tool: "vault_semantic_search", results: results.length, durationMs: Date.now() - started,
        hybrid: keyword.fts.length + keyword.like.length > 0 });
      // Vectors are unit-normalized, so squared L2 distance = 2 * cosine distance.
      return text({
        query,
        model: config.modelConfig.shortName,
        total_results: results.length,
        results: results.map((result, index) => ({
          rank: index + 1,
          title: result.metadata?.title || "Untitled",
          path: result.metadata?.path || null,
          similarity: +(1 - result.distance / 2).toFixed(4),
          matched_by: result.matched_by,
          content: result.content,
        })),
        ...(results.length === 0 ? { message: "No matching content found.", vault: buildSafeVaultDescription(config) } : {}),
      });
    },
  });
  server.addTool({
    name: "vault_index_status",
    description: "Check the vault index: readiness, chunk count, embedding model, keyword index state and which paths are searchable. Call this first.",
    inputSchema: { type: "object", properties: {} },
    async handler() {
      const config = loadConfig();
      const reader = new SqliteVectorReader(config.databasePath);
      try {
        if (!reader.hasCollection(config.collectionName)) {
          return text({ status: "not_indexed", embedding_model: config.modelConfig.shortName,
            message: "Open Obsidian and let the Analogy plugin finish indexing." });
        }
        recordLastQuery(config, { tool: "vault_index_status" });
        return text({
          status: "ready",
          vault: buildSafeVaultDescription(config),
          total_chunks: reader.count(config.collectionName),
          embedding_model: config.modelConfig.shortName,
          keyword_index: reader.keywordIndexReady() ? "ready" : "unavailable",
          server_version: SERVER_VERSION,
          access_control: config.allowedPaths.length > 0
            ? { mode: "restricted", allowed_paths: config.allowedPaths }
            : { mode: "full_vault" },
        });
      } finally {
        reader.close();
      }
    },
  });
  return server;
}

if (require.main === module) {
  createAnalogyMcpServer().listen();
  log("Analogy MCP server ready on stdio.");
}
