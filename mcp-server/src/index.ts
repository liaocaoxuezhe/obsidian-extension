#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildSafeVaultDescription, loadConfig, McpConfig } from "./config";
import { SqliteVectorReader } from "./sqlite-vector-reader";
import { EmbeddingService } from "./embedding";

let config: McpConfig;
let vectorReader: SqliteVectorReader;
let embeddingService: EmbeddingService;
let collectionReady = false;
let initialized = false;
let initInProgress = false;

function log(msg: string) {
  process.stderr.write(`[analogy-mcp] ${msg}\n`);
}

async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  if (initInProgress) {
    throw new Error("MCP server is still initializing. Please try again in a few seconds.");
  }

  initInProgress = true;
  try {
    config = loadConfig();
    // Read-only access to the plugin's SQLite store; Obsidian does not need to be running.
    vectorReader = new SqliteVectorReader(config.databasePath);

    collectionReady = vectorReader.hasCollection(config.collectionName);
    if (!collectionReady) {
      throw new Error(
        `Vector collection "${config.collectionName}" not found in the local vector database. ` +
          "This means either: (1) this Obsidian vault has not been indexed yet — " +
          "open Obsidian and wait for the Analogy plugin to finish indexing, or " +
          `(2) the embedding model "${config.modelKey}" does not match what the plugin is using.`
      );
    }

    log(`Vector database opened. Collection: ${config.collectionName}`);

    embeddingService = new EmbeddingService({
      pluginDir: config.pluginDir,
      remoteHost: config.remoteHost,
      modelConfig: config.modelConfig,
    });

    log("Loading embedding model (this may take a moment)...");
    await embeddingService.initialize();
    log("Embedding model ready.");

    initialized = true;
  } finally {
    initInProgress = false;
  }
}

function isPathAllowed(filePath: string): boolean {
  if (config.allowedPaths.length === 0) return true;
  const normalized = filePath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return config.allowedPaths.some(
    (allowed) =>
      normalized === allowed || normalized.startsWith(`${allowed}/`)
  );
}

function buildVaultDescription(): string {
  return buildSafeVaultDescription(config);
}

const server = new McpServer({
  name: "analogy-obsidian-vault",
  version: "1.0.0",
});

server.tool(
  "vault_semantic_search",
  "Search the user's Obsidian vault using cosine similarity on embedding vectors. " +
    "Documents in the vault are chunked (~900 chars each) and embedded using a local model. " +
    "Queries are embedded with the same model and matched against all indexed chunks by cosine distance. " +
    "Returns the most semantically similar chunks with their source file path, title, similarity score, and content. " +
    "BEFORE using this tool, call vault_index_status to verify the index is ready and to learn the vault's scope " +
    "(which folders/paths are accessible). The search only covers documents already indexed by the Obsidian plugin — " +
    "if the vault is not indexed or Obsidian is not running, the tool will return an error with actionable instructions.",
  {
    query: z.string().describe(
      "The text to search for. The search uses cosine similarity between the query's embedding vector and all indexed document chunk embeddings. " +
        "Write a natural-language description of the concept or topic you're looking for — not keywords. " +
        "The query will be embedded using the same model that indexed the vault, so semantic meaning matters more than exact wording."
    ),
    top_k: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(5)
      .describe(
        "Number of most similar chunks to return (1–50, default 5). Each chunk is a section of a vault document (~900 chars max)."
      ),
  },
  // @ts-expect-error — zod + MCP SDK deep type instantiation (TS2589)
  async ({ query, top_k }: { query: string; top_k: number }) => {
    await ensureInitialized();

    if (!query.trim()) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "EMPTY_QUERY",
              message: "The query string is empty. Provide a non-empty natural language query to search for semantically similar content.",
            }),
          },
        ],
        isError: true,
      };
    }

    if (!collectionReady) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "COLLECTION_NOT_FOUND",
              message: `The vector collection "${config.collectionName}" is not available. The Obsidian vault may not be indexed yet.`,
              suggestion: "Open Obsidian and check the Analogy plugin status. The plugin needs to finish indexing documents before search is available.",
            }),
          },
        ],
        isError: true,
      };
    }

    try {
      const queryEmbedding = await embeddingService.embedQuery(query);
      const results = vectorReader.search(config.collectionName, queryEmbedding, top_k + 10);

      const filtered = config.allowedPaths.length > 0
        ? results.filter((r) => {
            const p = r.metadata?.path as string | undefined;
            return p ? isPathAllowed(p) : false;
          })
        : results;

      const topResults = filtered.slice(0, top_k);

      if (topResults.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                query,
                results: [],
                message: "No matching content found. The vault may be empty, not yet indexed, or the query has no semantically similar content in the indexed documents.",
                vault: buildVaultDescription(),
              }, null, 2),
            },
          ],
        };
      }

      // Vectors are unit-normalized, so squared L2 distance = 2 * cosine distance.
      const formatted = topResults.map((r, i) => ({
        rank: i + 1,
        title: r.metadata?.title || "Untitled",
        path: r.metadata?.path || null,
        cosine_distance: +(r.distance / 2).toFixed(6),
        similarity: +(1 - r.distance / 2).toFixed(4),
        content: r.content,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                query,
                model: config.modelConfig.shortName,
                total_results: formatted.length,
                results: formatted,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "SEARCH_FAILED",
              message: `Search operation failed: ${(err as Error).message}`,
              detail: "This could be due to: (1) the local vector database being unreadable, or (2) the embedding model failing to process the query.",
              suggestion: "Open Obsidian once and check that the Analogy plugin status shows 'ready'.",
            }),
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "vault_index_status",
  "Check the current state of the Obsidian vault's vector index. " +
    "Returns: index readiness, total indexed chunks, embedding model name, " +
    "and access control configuration (which vault paths this MCP server is allowed to search). " +
    "Call this FIRST before performing any search to understand what data is available and what scope restrictions apply.",
  {},
  async () => {
    await ensureInitialized();

    try {
      if (!vectorReader.hasCollection(config.collectionName)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "not_indexed",
                runtime_generation: config.runtimeGeneration,
                collection_name: config.collectionName,
                message: "The vault has not been indexed yet. Open Obsidian and let the Analogy plugin complete indexing.",
              }, null, 2),
            },
          ],
        };
      }

      const count = vectorReader.count(config.collectionName);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "ready",
                vault: buildVaultDescription(),
                collection_name: config.collectionName,
                runtime_generation: config.runtimeGeneration,
                total_chunks: count,
                embedding_model: config.modelConfig.shortName,
                vector_database: "sqlite",
                access_control:
                  config.allowedPaths.length > 0
                    ? {
                        mode: "restricted",
                        allowed_paths: config.allowedPaths,
                      }
                    : { mode: "full_vault" },
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "STATUS_CHECK_FAILED",
              message: `Failed to check index status: ${(err as Error).message}`,
              suggestion: "Open Obsidian once so the Analogy plugin can create or migrate the local vector database.",
            }),
          },
        ],
        isError: true,
      };
    }
  }
);

async function main() {
  log("Starting Analogy Obsidian MCP server...");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server connected via stdio. Tools will initialize on first call.");
}

main().catch((err) => {
  log(`Fatal error: ${(err as Error).message}`);
  process.exit(1);
});
