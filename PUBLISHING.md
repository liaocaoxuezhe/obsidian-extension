# Publishing to Obsidian Community Plugins

This repository is prepared for the Obsidian Community Plugins submission flow.

## Initial GitHub setup

Create a public GitHub repository, for example:

```text
https://github.com/liaocaoxuezhe/analogy-obsidian-plugin
```

Then push this folder as the repository root.

## Release 1.0.0

The initial release assets are already prepared in:

```text
release/1.0.0/
```

Create a GitHub release with tag `1.0.0`. The tag must match `manifest.json` `version` exactly.

Upload these release assets:

- `release/1.0.0/main.js`
- `release/1.0.0/manifest.json`
- `release/1.0.0/styles.css`

## Submit to Obsidian

Submit the public repository URL through:

```text
https://community.obsidian.md
```

Sign in with your Obsidian account, link GitHub, then create a new plugin submission.
