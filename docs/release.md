# Release checklist

Analogy uses the Obsidian community plugin release flow. The GitHub release tag must exactly match the `manifest.json` `version`.

This repository is the only source for plugin development and releases. Do not copy source or generated assets from the retired mixed repository.

Preparing assets and publishing them are separate operations. `npm run release:prepare` only creates and verifies a local candidate. It does not authorize a tag, a Runtime publication, a GitHub Release, a staged rollout, or an Obsidian community submission. Obtain explicit user approval for the specific release immediately before any of those external changes.

## Prepare assets

```bash
npm ci
npm run check
npm run release:prepare
```

The command builds `main.js`, verifies that `manifest.json`, `package.json`, and `versions.json` agree, then copies the release assets into `release/<version>/`.

Upload these files as binary assets on the GitHub release:

- `main.js`
- `manifest.json`
- `styles.css`

## External runtime dependencies

The Obsidian release assets do not include `node_modules`, model files, ChromaDB, or the MCP server dependencies. The plugin must therefore be installed from the GitHub repository directory when local RAG is enabled, or the user must copy the runtime files from the matching `release/<version>` package and run the setup command in the installed plugin folder:

```bash
npm run setup:local
```

This is intentional: the plugin detects missing runtime pieces and surfaces setup instructions instead of assuming `node_modules` exists.

## Submit to Obsidian

Add this entry to `obsidianmd/obsidian-releases` `community-plugins.json`:

```json
{
  "id": "analogy-rag-in-your-vault",
  "name": "Analogy - RAG in your vault",
  "author": "liaocaoxuezhe",
  "description": "Search your vault semantically with local vector embeddings and expose RAG search to MCP clients.",
  "repo": "liaocaoxuezhe/obsidian-extension"
}
```

Create release tags only from this repository after all CI gates pass and the user has completed acceptance and explicitly authorized that release. Pushing a matching tag automatically invokes `.github/workflows/release.yml` and can create a public GitHub Release, so tag creation/push is a publishing action, not a harmless preparation step.

For the repository-split candidate, prepare version `1.2.5` and stop before creating the tag. After user acceptance and a new explicit publication authorization, create the bare `1.2.5` tag from the accepted clean commit and let the GitHub workflow build the release assets. The tag, `package.json`, `package-lock.json`, `manifest.json`, and `versions.json` entry must remain identical. Do not use a staged or gray rollout.

The managed Runtime currently publishes only `darwin-arm64` and `win32-x64`. Intel Mac (`darwin-x64`) publication is deferred by explicit user decision; do not add an unverified Intel archive to the runtime manifest or full-runtime ZIP.
