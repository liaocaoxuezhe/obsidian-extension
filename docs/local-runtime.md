# Local runtime setup

Analogy keeps your vault index on your machine, but the Obsidian community-review build does not install, start, or stop external processes. Local RAG requires two user-managed runtime pieces:

- Node dependencies for Transformers.js and ONNX runtime.
- ChromaDB already running on `127.0.0.1`.

If you installed only `main.js`, `manifest.json`, and `styles.css`, first copy the runtime files from the matching `release/<version>` package into the installed plugin folder:

- `package.json`
- `package-lock.json`
- `scripts/`
- `mcp-server/`

Then run this command inside the installed plugin folder:

```bash
npm run setup:local
```

The setup script checks for Python 3.9 or newer, installs the Node runtime dependencies, installs ChromaDB, downloads the default local embedding model, and builds the companion MCP server.

If you manage ChromaDB manually, start it with:

```bash
chroma run --path <vault-or-plugin-data-dir>/chroma_data --host 127.0.0.1 --port 8000
```

The plugin only connects to that local service. It does not scan arbitrary local model paths; embedding models are loaded through Transformers.js using its cache and the model host configured in settings.

If your plugin folder is not the default `.obsidian/plugins/analogy-rag-in-your-vault`, set `ANALOGY_PLUGIN_DIR` for MCP clients.

For MCP usage, see [mcp-server.md](./mcp-server.md).
