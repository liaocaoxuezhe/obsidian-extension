# Privacy and Security Notes

This document explains the desktop permissions that Analogy uses and how data flows through the local RAG runtime.

## Local vault access

Analogy reads Markdown files from the current Obsidian vault to build a local semantic index. It uses the Obsidian Vault API to enumerate Markdown files, read file contents, track indexing status, and update stale index entries when notes change.

Vault enumeration is needed so the plugin can show indexing progress, skip excluded paths, enforce indexing limits, and avoid re-indexing unchanged files.

## Local filesystem access

Analogy uses Node.js filesystem APIs to persist local runtime state. This includes:

- index state JSON files;
- ChromaDB runtime data;
- model cache files;
- local logs and temporary runtime files.

These files are stored under the plugin or runtime folders on the desktop machine. This access is not used to upload vault content.

## Local process execution

Analogy starts ChromaDB as a local process using `child_process.spawn`. The process is bound to `127.0.0.1` and is used as the local vector database for semantic search. The plugin tries common commands such as `chroma`, `python3 -m chromadb.cli.cli`, and `python -m chromadb.cli.cli`.

This process execution is required because ChromaDB is a separate local service rather than a pure Obsidian API.

## Browser local storage

Analogy uses browser `localStorage` for small pieces of UI and license state, including a cached license status and a local device identifier. This helps avoid repeated license checks and keeps UI selections stable between sessions.

## Network access

Analogy may use the network for these purposes:

- downloading embedding model files from the configured model host;
- license validation and deactivation at `https://analogy.zexing.club/api/v1/obsidian/license/*`;
- external purchase and account pages at `https://analogy.zexing.club/analogy` and `/analogy/account`.

License validation sends license and activation metadata, such as license key, plugin version, local device identifier, and vault identifier. It does not send note contents.
Payment pages open in the browser; the plugin does not receive Stripe credentials or payment-card data. When the license service is unavailable, cached active state is honored only through its server-provided grace period, then local free limits apply.

## MCP access

The companion MCP server can expose search results to local AI tools only when the user explicitly configures and runs it. Use `ANALOGY_ALLOWED_PATHS` to restrict which vault paths the MCP server can return.

## Data locality summary

Markdown note contents are used to create a local vector index. They are not uploaded for license validation. Search snippets can be returned to MCP clients only through explicit local MCP configuration.
