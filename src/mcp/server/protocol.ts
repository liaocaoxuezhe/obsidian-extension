/**
 * Minimal Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0).
 * Implements only what a tools-only server needs — initialize, ping, tools/list and
 * tools/call — so the bundle embedded in main.js stays small and dependency-free.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface McpServerInfo {
  name: string;
  version: string;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: Record<string, unknown>;
}

type Writer = (line: string) => void;

export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : SUPPORTED_PROTOCOL_VERSIONS[0];
}

export class StdioMcpServer {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(private readonly info: McpServerInfo, private readonly write: Writer = (line) => process.stdout.write(line)) {}

  addTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /** Handles one JSON-RPC message; returns the response object or null for notifications. */
  async handle(message: JsonRpcRequest): Promise<Record<string, unknown> | null> {
    const id = message?.id;
    const isNotification = id === undefined || id === null;
    const reply = (result: unknown) => (isNotification ? null : { jsonrpc: "2.0", id, result });
    const fail = (code: number, text: string) => (isNotification ? null : { jsonrpc: "2.0", id, error: { code, message: text } });
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return fail(-32600, "Invalid Request");
    switch (message.method) {
      case "initialize":
        return reply({
          protocolVersion: negotiateProtocolVersion(message.params?.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.info,
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: [...this.tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      case "tools/call": {
        const name = message.params?.name;
        const tool = typeof name === "string" ? this.tools.get(name) : undefined;
        if (!tool) return fail(-32602, `Unknown tool: ${String(name)}`);
        const args = message.params?.arguments;
        try {
          return reply(await tool.handler(args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {}));
        } catch (error) {
          return reply({
            content: [{ type: "text", text: JSON.stringify({ error: "TOOL_FAILED", message: (error as Error)?.message ?? String(error) }) }],
            isError: true,
          });
        }
      }
      default:
        if (message.method.startsWith("notifications/")) return null;
        return fail(-32601, `Method not found: ${message.method}`);
    }
  }

  /** Reads stdin line by line; requests are answered in arrival order. */
  listen(input: NodeJS.ReadableStream = process.stdin): void {
    let buffer = "";
    let queue: Promise<void> = Promise.resolve();
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        queue = queue.then(async () => {
          let message: JsonRpcRequest;
          try {
            message = JSON.parse(line) as JsonRpcRequest;
          } catch {
            this.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
            return;
          }
          const response = await this.handle(message);
          if (response) this.write(`${JSON.stringify(response)}\n`);
        });
      }
    });
    input.on("end", () => { void queue.finally(() => process.exit(0)); });
  }
}
