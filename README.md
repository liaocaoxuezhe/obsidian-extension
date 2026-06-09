# Analogy - RAG in your vault

Analogy adds local semantic search to Obsidian and exposes your indexed vault to MCP clients for retrieval-augmented generation.

The plugin is desktop-only because it uses Node.js APIs, starts a local ChromaDB process, and loads local embedding models.

## Features

- Index Markdown notes into local vector chunks.
- Search the current vault semantically from the Analogy side pane.
- Exclude folders or files from the local index.
- Run ChromaDB locally on `127.0.0.1`.
- Use the companion MCP server to let tools such as Claude Code or Cursor search approved vault content.

## Install

### Community plugin release

Download the release assets from GitHub and copy them into:

```text
<Vault>/.obsidian/plugins/analogy-rag-in-your-vault/
```

Required Obsidian plugin assets:

- `main.js`
- `manifest.json`
- `styles.css`

Enable the plugin in Obsidian Settings -> Community plugins.

### Local RAG runtime

Obsidian loads the three plugin assets above. Local RAG and MCP also need the runtime files included in the matching `release/<version>` package: `package.json`, `package-lock.json`, `scripts/`, and `mcp-server/`.

Run the setup command inside the installed plugin folder:

```bash
npm run setup:local
```

The setup script checks for Python 3.9 or newer, installs the plugin runtime dependencies, installs ChromaDB, downloads the default local embedding model, and builds the companion MCP server.

More details are in [docs/local-runtime.md](docs/local-runtime.md).

## Usage

1. Open Obsidian and enable Analogy.
2. Click the Analogy ribbon icon to open the side pane.
3. Open Settings -> Analogy - RAG in your vault.
4. Verify that ChromaDB and the embedding model show as ready.
5. Click Continue index or Rebuild index.
6. Search your vault from the Analogy pane, or connect an MCP client using [docs/mcp-server.md](docs/mcp-server.md).

## MCP server

Analogy includes a companion MCP server that lets MCP clients such as Claude Code, Cursor, and other AI agents search your indexed Obsidian vault. It exposes local semantic retrieval over stdio, so agents can ground answers in your notes without receiving direct filesystem access.

The MCP server is useful when you want an agent to:

- Search vault content by meaning instead of exact keywords.
- Retrieve note chunks with file path, title, similarity score, and source text.
- Check whether the local vector index is ready before searching.
- Limit agent access to selected vault folders with a path allowlist.

### How it works

```text
MCP client
  -> Analogy MCP server (Node.js stdio process)
  -> local ChromaDB started by the Obsidian plugin
  -> indexed note chunks and local embedding model
```

The server does not build the index by itself. Keep Obsidian running, enable Analogy, and wait until the plugin finishes indexing before calling the MCP tools. The MCP server uses the same embedding model as the plugin, so `ANALOGY_MODEL` must match the model selected in Obsidian.

### Build the MCP server

```bash
cd mcp-server
npm install
npm run build
```

The MCP entry point is `mcp-server/dist/index.js`.

### Configure an MCP client

Use a stdio MCP configuration like this, replacing the paths with your local repository and vault paths:

```json
{
  "mcpServers": {
    "analogy-vault": {
      "command": "node",
      "args": [
        "/path/to/analogy-rag-in-your-vault/mcp-server/dist/index.js"
      ],
      "env": {
        "ANALOGY_VAULT_PATH": "/path/to/your-obsidian-vault",
        "ANALOGY_CHROMA_PORT": "8000",
        "ANALOGY_MODEL": "jina-nano"
      }
    }
  }
}
```

Required and common environment variables:

- `ANALOGY_VAULT_PATH` - required absolute path to the Obsidian vault.
- `ANALOGY_CHROMA_PORT` - ChromaDB port started by the plugin, default `8000`.
- `ANALOGY_MODEL` - embedding model, default `jina-nano`; must match the plugin setting.
- `ANALOGY_PLUGIN_DIR` - optional plugin directory if it is not under `<Vault>/.obsidian/plugins/analogy-rag-in-your-vault`.
- `ANALOGY_ALLOWED_PATHS` - optional comma-separated vault-relative paths the agent may search, such as `notes/public,projects/docs`.

### Available MCP tools

- `vault_index_status` - checks whether the vault index is ready, returns the collection name, indexed chunk count, embedding model, ChromaDB port, and access-control scope. Agents should call this before searching.
- `vault_semantic_search` - searches indexed note chunks by semantic similarity. It accepts `query` and optional `top_k` (1-50, default 5), then returns ranked chunks with metadata and content.

For complete client-specific examples, access control details, and troubleshooting, see [docs/mcp-server.md](docs/mcp-server.md).

## Privacy and data flow

Analogy is designed for local-first vault search. Markdown content is read from the current Obsidian vault so the plugin can split notes into chunks, create embeddings, and write a local vector index. Note contents are not sent to the license server.

- **Vault reads:** Markdown files are read through the Obsidian Vault API for indexing and search snippets.
- **Vault enumeration:** The plugin enumerates Markdown files to show indexing status, enforce the free page limit, and decide which files need indexing.
- **Direct filesystem access:** The plugin writes local index state, model cache files, and ChromaDB data under the plugin/runtime folders. This is used for local persistence and offline operation.
- **Shell execution:** The plugin starts a local ChromaDB process with `chroma`, `python3`, or `python` so vector search can run on `127.0.0.1`.
- **Local storage:** The UI stores license cache, device identifier, and small UI selections in browser `localStorage`.
- **Network access:** Embedding model files may be downloaded from the configured model host, which defaults to `https://hf-mirror.com/`. Optional license validation may connect to the configured license server. MCP clients can access search snippets only when you explicitly configure and run the MCP server.

See [docs/privacy.md](docs/privacy.md) for the fuller review-oriented privacy and security notes.

## Security review notes

The plugin intentionally uses desktop-only capabilities that automated review tools may flag:

- `fs` is used to persist local index state, model caches, and ChromaDB runtime data.
- `child_process.spawn` is used to launch a local ChromaDB service bound to `127.0.0.1`.
- `vault.getMarkdownFiles()` and `vault.getFiles()` are used to maintain index status and watch for changed Markdown notes.
- `localStorage` is used for license and UI state. Plugin data APIs may replace some of this in a future cleanup.

These capabilities are part of the local RAG runtime. They should be reviewed together with the source files in `src/local-vector/`, `src/license/`, and `mcp-server/src/`.

## Development

Install dependencies:

```bash
npm install
```

Start watch mode:

```bash
npm run dev
```

Build production assets:

```bash
npm run build
```

Prepare release assets:

```bash
npm run release:prepare
```

The release tag must exactly match `manifest.json` `version`.

## Repository layout

- `main.ts` - Obsidian plugin entry point.
- `src/` - Obsidian plugin source.
- `mcp-server/` - Companion MCP server source.
- `scripts/` - Setup and release helpers.
- `docs/` - User, runtime, privacy, and release documentation.
- `test/` - Node-based tests and local diagnostics.
- `release/1.0.0/` - Release assets uploaded to the GitHub Release.

## Release integrity

The current release keeps the source code and release assets in this repository. GitHub artifact attestations for release assets are recommended and can be added with a GitHub Actions release workflow in a follow-up.

## License

Apache-2.0
