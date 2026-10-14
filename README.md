# Analogy - RAG in your vault

Analogy adds local semantic search to Obsidian and exposes your indexed vault to MCP clients for retrieval-augmented generation.

The plugin is desktop-only because it runs a managed local runtime (Node.js, ONNX Runtime) for embeddings and a local SQLite vector store.

## Features

- Index Markdown notes into local vector chunks.
- Search the current vault semantically from the Analogy side pane.
- Explore related indexed chunks in a local Semantic Walk canvas.
- Exclude folders or files from the local index.
- Hybrid search: semantic similarity fused with keyword matching for exact names, people and code identifiers.
- Built-in MCP server with one-click setup for Claude Desktop, Claude Code, Cursor, opencode and Codex.

## Install

### Community plugin release

Download the release assets from GitHub and copy them into:

```text
<Vault>/.obsidian/plugins/analogy-rag-in-your-vault/
```

Required release assets:

- `main.js`
- `manifest.json`
- `styles.css`

Enable the plugin in Obsidian Settings -> Community plugins.

### Local runtime

Obsidian installs only the three files above; Analogy's guided onboarding sets up the rest. It downloads the managed embedding runtime for your platform from this repository's `runtime-<version>` release and one embedding model, verifies every file against hashes pinned in the plugin, and builds a first index. No Python, `npm install` or command line is needed. Supported: macOS on Apple Silicon and Windows x64.

- Each platform has its own runtime version, so a Windows runtime update never re-downloads anything on macOS. When a runtime is superseded, Analogy offers an **Upgrade the inference engine** step that keeps your index and models.
- Downloads resume after interruptions and follow the system proxy. Without network, use **Settings → Local runtime → Offline install** to import the runtime archive and model folder; both are verified before use.
- The model picker shows download size and estimated memory; first installs choose a multilingual model for Chinese-first vaults.

Details: [docs/local-runtime.md](docs/local-runtime.md). Error codes: [docs/install-troubleshooting.md](docs/install-troubleshooting.md).

## Usage

1. Open Obsidian and enable Analogy.
2. Click the Analogy ribbon icon to open the side pane.
3. Open Settings -> Analogy - RAG in your vault.
4. Verify that the local runtime and the embedding model show as ready.
5. Click Continue index or Rebuild index.
6. Search your vault from the Analogy pane, or connect an AI client under **Settings → MCP** ([docs/mcp-server.md](docs/mcp-server.md)).

### Semantic Walk

Semantic Walk is a local, chunk-level exploration canvas in the main Obsidian workspace. Open it from the ribbon, the command palette, the current document, a sidebar search result, or a random indexed chunk.

Expanding a node queries the existing local index on demand. Multiple chunks from the same Markdown document can remain on the canvas while you follow another branch. Use **New batch** to reset the graph and choose a new random root. Relationship labels are relative to the current candidate batch rather than an absolute similarity percentage.

Indexes created by older Analogy versions may lack stable chunk identity, heading, or position metadata. Existing search remains compatible, but run **Rebuild index** to enable every Semantic Walk entry and obtain accurate chunk positioning.

## Privacy and data flow

- Your vector index is stored in a device-local data folder outside the vault (`~/Library/Application Support/Analogy` or `%LOCALAPPDATA%\Analogy`) and is never synced.
- Semantic Walk reuses the local chunk index and embedding worker; it does not create a remote graph service or upload note content.
- The vector store is a local SQLite file; no network service is opened.
- Markdown content is read from the current vault for indexing.
- Embedding model files may be downloaded from the configured model host, which defaults to `https://hf-mirror.com/`.
- License validation uses `https://analogy.zexing.club/api/v1/obsidian/license/validate`; deactivation uses `/api/v1/obsidian/license/deactivate`. These requests send the license key, plugin version, a local device identifier, and a vault identifier, but never note contents, paths, queries, or embeddings.
- Purchase and account-management actions open `https://analogy.zexing.club/analogy` and `https://analogy.zexing.club/analogy/account` in the browser. The plugin does not receive Stripe credentials or payment-card data.
- The plugin caches license state locally and normally refreshes it about every 7 days. If the service is temporarily unavailable, the last active state remains usable only through the server-provided `grace_until`; after that, the plugin falls back to the free limits without blocking local note access.
- MCP clients can access search snippets only when you explicitly configure them. Writing a client configuration shows the exact change first and keeps a backup. The MCP server records only the time, tool and result count of the last query, never the query text.
- Use `ANALOGY_ALLOWED_PATHS` to restrict which vault paths the MCP server can return.
- Semantic Walk diagnostics contain only a hashed chunk identifier and allowlisted runtime metadata; they exclude chunk text, paths, queries, embeddings, and license keys.

## Development

```bash
npm install
npm run dev
```

Build for CI without deploying to Obsidian or creating release assets:

```bash
npm run build:ci
```

Build and atomically deploy the three-file plugin to the configured local Obsidian vault:

```bash
npm run build:local
```

Prepare release assets:

```bash
npm run release:prepare
```

The release tag must exactly match `manifest.json` `version`.

## Repository layout

- `src/` - Obsidian plugin source.
- `src/mcp/server/` - MCP server bundled into `main.js`; reuses the read-only store reader and config in `mcp-server/src/`.
- `runtime-package/` - Reviewed managed-runtime inputs, including the per-platform version table.
- `scripts/` - Runtime build, verification and release scripts.
- `benchmark/` - Hybrid retrieval and vector scan benchmarks.
- `.obsidian/` - Local development vault, ignored by the standalone plugin repo.

## License

Apache-2.0
