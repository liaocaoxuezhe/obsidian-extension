# Analogy - RAG in your vault

Analogy adds local semantic search to Obsidian and exposes your indexed vault to MCP clients for retrieval-augmented generation.

The plugin is desktop-only because it uses Node.js APIs, starts a local ChromaDB process, and loads local embedding models.

## Features

- Index Markdown notes into local vector chunks.
- Search the current vault semantically from the Analogy side pane.
- Explore related indexed chunks in a local Semantic Walk canvas.
- Exclude folders or files from the local index.
- Run ChromaDB locally on `127.0.0.1`.
- Use the companion MCP server to let tools such as Claude Code or Cursor search approved vault content.

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

### Local RAG runtime

Obsidian only installs the three plugin assets above. Open Analogy settings and use the Local RAG runtime installer to install the embedding runtime in the plugin folder. Analogy also creates a small runtime `package.json`, installs the embedding runtime, and starts ChromaDB automatically when possible.

On first launch, the guided onboarding flow detects the local environment, downloads the pinned ChromaDB and embedding runtimes, verifies their checksums and signed release metadata, installs them atomically, and builds a small first index. Managed runtime downloads currently support macOS on Apple Silicon and Windows on x64. Intel Mac runtime publication is temporarily deferred until its pinned ONNX Runtime native payload can be built and verified outside the pull-request critical path. The Ollama summary model is optional and can be skipped without blocking local semantic search.

Existing compatible Chroma indexes are migrated into the managed runtime without re-embedding. If migration or setup is interrupted, onboarding resumes from its saved recovery state; setup, repair, diagnostics, and rebuild controls remain available in Analogy settings.


If automatic installation fails, run the setup command inside the installed plugin folder:

```bash
npm run setup:local
```

If you need the companion MCP server files too, download the full runtime zip from the GitHub release.

## Usage

1. Open Obsidian and enable Analogy.
2. Click the Analogy ribbon icon to open the side pane.
3. Open Settings -> Analogy - RAG in your vault.
4. Verify that ChromaDB and the embedding model show as ready.
5. Click Continue index or Rebuild index.
6. Search your vault from the Analogy pane, or connect an MCP client to the bundled MCP server.

### Semantic Walk

Semantic Walk is a local, chunk-level exploration canvas in the main Obsidian workspace. Open it from the ribbon, the command palette, the current document, a sidebar search result, or a random indexed chunk.

Expanding a node queries the existing local index on demand. Multiple chunks from the same Markdown document can remain on the canvas while you follow another branch. Use **New batch** to reset the graph and choose a new random root. Relationship labels are relative to the current candidate batch rather than an absolute similarity percentage.

Indexes created by older Analogy versions may lack stable chunk identity, heading, or position metadata. Existing search remains compatible, but run **Rebuild index** to enable every Semantic Walk entry and obtain accurate chunk positioning.

## Privacy and data flow

- Your vector index is stored locally in the plugin folder.
- Semantic Walk reuses the local chunk index and embedding worker; it does not create a remote graph service or upload note content.
- ChromaDB listens on `127.0.0.1` by default.
- Markdown content is read from the current vault for indexing.
- Embedding model files may be downloaded from the configured model host, which defaults to `https://hf-mirror.com/`.
- License validation uses `https://analogy.zexing.club/api/v1/obsidian/license/validate`; deactivation uses `/api/v1/obsidian/license/deactivate`. These requests send the license key, plugin version, a local device identifier, and a vault identifier, but never note contents, paths, queries, or embeddings.
- Purchase and account-management actions open `https://analogy.zexing.club/analogy` and `https://analogy.zexing.club/analogy/account` in the browser. The plugin does not receive Stripe credentials or payment-card data.
- The plugin caches license state locally and normally refreshes it about every 7 days. If the service is temporarily unavailable, the last active state remains usable only through the server-provided `grace_until`; after that, the plugin falls back to the free limits without blocking local note access.
- MCP clients can access search snippets only when you explicitly configure and run the MCP server.
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
- `mcp-server/` - Companion MCP server source.
- `scripts/` - Setup helpers such as model download.
- `.obsidian/` - Local development vault, ignored by the standalone plugin repo.

## License

Apache-2.0
