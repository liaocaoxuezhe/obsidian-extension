#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildSafeVaultDescription, loadConfig, McpConfig } from "./config";
import { ChromaClient, CollectionInfo } from "./chroma-client";
import { EmbeddingService } from "./embedding";

let config: McpConfig;
let chromaClient: ChromaClient;
let embeddingService: EmbeddingService;
let collectionInfo: CollectionInfo | null = null;
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
    chromaClient = new ChromaClient(config.chromaPort);

    const healthy = await chromaClient.healthCheck();
    if (!healthy) {
      throw new Error(
        `ChromaDB is not reachable at 127.0.0.1:${config.chromaPort}. ` +
          "Please ensure the Analogy Obsidian plugin is running and has started ChromaDB. " +
          "You can check this in Obsidian > Analogy plugin settings."
      );
    }

    collectionInfo = await chromaClient.getCollectionByName(config.collectionName);
    if (!collectionInfo) {
      throw new Error(
        `Vector collection "${config.collectionName}" not found in ChromaDB. ` +
          "This means either: (1) this Obsidian vault has not been indexed yet — " +
          "open Obsidian and wait for the Analogy plugin to finish indexing, or " +
          `(2) the embedding model "${config.modelKey}" does not match what the plugin is using.`
      );
    }

    log(`ChromaDB connected. Collection: ${config.collectionName}`);

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

    if (!collectionInfo) {
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
      const results = await chromaClient.searchCollection(
        collectionInfo.id,
        queryEmbedding,
        top_k + 10
      );

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

      const formatted = topResults.map((r, i) => ({
        rank: i + 1,
        title: r.metadata?.title || "Untitled",
        path: r.metadata?.path || null,
        cosine_distance: r.score,
        similarity: +(1 - r.score).toFixed(4),
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
              detail: "This could be due to: (1) ChromaDB being temporarily unavailable, (2) the embedding model failing to process the query, or (3) a network/timeout issue with the local ChromaDB server.",
              suggestion: "Check that Obsidian is running and the Analogy plugin status shows 'ready'.",
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
      const collections = await chromaClient.listCollections();
      const targetCollection = collections.find(
        (c) => c.name === config.collectionName
      );

      if (!targetCollection) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "not_indexed",
                runtime_generation: config.runtimeGeneration,
                chroma_port: config.chromaPort,
                collection_name: config.collectionName,
                message: "The vault has not been indexed yet. Open Obsidian and let the Analogy plugin complete indexing.",
              }, null, 2),
            },
          ],
        };
      }

      const count = await chromaClient.countCollection(targetCollection.id);

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
                chroma_port: config.chromaPort,
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
              suggestion: "Ensure Obsidian is running and ChromaDB is started by the Analogy plugin.",
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
