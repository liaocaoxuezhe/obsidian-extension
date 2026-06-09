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

Required release assets:

- `main.js`
- `manifest.json`
- `styles.css`

Enable the plugin in Obsidian Settings -> Community plugins.

### Local RAG runtime

Obsidian only installs the three plugin assets above. On first local RAG startup, Analogy creates a small runtime `package.json`, installs the embedding runtime, and starts ChromaDB automatically.

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

## Privacy and data flow

- Your vector index is stored locally in the plugin folder.
- ChromaDB listens on `127.0.0.1` by default.
- Markdown content is read from the current vault for indexing.
- Embedding model files may be downloaded from the configured model host, which defaults to `https://hf-mirror.com/`.
- Optional license validation may connect to your configured license server. License validation sends the license key, plugin version, a local device identifier, and a vault identifier. The plugin caches the license key locally so it can silently refresh the license about every 7 days. It does not upload note contents for license validation.
- MCP clients can access search snippets only when you explicitly configure and run the MCP server.
- Use `ANALOGY_ALLOWED_PATHS` to restrict which vault paths the MCP server can return.

## Development

```bash
npm install
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

- `src/` - Obsidian plugin source.
- `mcp-server/` - Companion MCP server source.
- `scripts/` - Setup helpers such as model download.
- `.obsidian/` - Local development vault, ignored by the standalone plugin repo.

## License

Apache-2.0
