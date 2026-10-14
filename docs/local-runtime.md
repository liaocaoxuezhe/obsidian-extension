# Local runtime

Analogy runs search entirely on your computer. Obsidian installs only `main.js`, `manifest.json` and `styles.css`; everything else is set up by the plugin's guided onboarding. No Python, `npm install` or command line is required.

## What onboarding installs

| Component | Source | Verified by |
|---|---|---|
| Managed embedding runtime (Node 22.23.2, Transformers.js 4.2.0, ONNX Runtime 1.26.0) | GitHub release `runtime-<version>` of this repository | Archive size and SHA-256 pinned in the plugin, internal manifest hash, per-file hashes after extraction, a native load check |
| Embedding model files | Hugging Face (default mirror `https://hf-mirror.com/`) | Size and SHA-256 of every file, pinned per model revision |
| Vector store | SQLite inside the managed runtime (`node:sqlite`) | Created locally; nothing is downloaded |

Supported platforms: macOS on Apple Silicon and Windows x64. Intel Macs are not supported yet.

### Per-platform runtime versions

Each platform ships its own runtime version (for example macOS `node22-v1`, Windows `node22-v2`). A new Windows runtime therefore never makes macOS users download anything. When your installed runtime is superseded, Analogy shows an **Upgrade the inference engine** step with the download size; your index, models and settings are kept, and the old runtime is moved aside after the upgrade succeeds.

The Windows `node22-v2` runtime bundles the Microsoft Visual C++ runtime next to ONNX Runtime, so a clean Windows installation no longer needs the separate VC++ Redistributable. It also omits the DirectML GPU files, which CPU inference never loads (about 38 MB of uncompressed files).

## Where data lives

All device data is stored outside the vault and is never synced:

- macOS: `~/Library/Application Support/Analogy/`
- Windows: `%LOCALAPPDATA%\Analogy\`

| Folder | Content |
|---|---|
| `runtime/` | Managed runtimes and download staging |
| `models/transformers-cache/<model>/` | Verified model files |
| `vaults/<vault id>/vector-store/vectors.sqlite` | The vector index and keyword index of one vault |
| `mcp/` | The MCP server materialized from the plugin and the last-query status |

## Downloads, proxies and offline installs

- Downloads resume after interruptions and fall back to Obsidian's network stack, which follows the system proxy and PAC settings.
- No network at all: open **Settings → Analogy → Local runtime → Offline install**. Use **Import runtime archive…** with the runtime archive for your platform from the matching GitHub release, and **Import model folder…** with a folder containing the model files. Both are verified against the pinned hashes before they are used.

## Hybrid search and speed

Text queries combine semantic search with a keyword index (SQLite FTS5, trigram), so exact names, people and code identifiers are found even when the embedding model misses them. Existing indexes build the keyword index in the background after upgrading; until it finishes, search is purely semantic. Turn it off or change the keyword weight under **Settings → Analogy → Hybrid search**.

Large indexes (20,000+ chunks) are scanned on several worker threads. 100,000 × 768-dimension vectors take about 14 ms on an Apple M4, with results identical to a single-threaded scan.

## Choosing a model

The model picker shows each model's download size and estimated memory. Devices with less than 8 GB of memory do not list the 200M+ parameter models, and switching to a large model asks for confirmation. On first install Analogy samples your notes: Chinese-first vaults default to the multilingual Granite model, others to BGE-small.

## Troubleshooting

Every setup failure shows an error code; see [install-troubleshooting.md](./install-troubleshooting.md). For MCP clients, see [mcp-server.md](./mcp-server.md).
