const assert = require("assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const releaseVersion = "1.0.5";
const releaseDir = path.join(root, "release", releaseVersion);

function gitLsFiles() {
  return new Set(
    execFileSync("git", ["ls-files"], {
      cwd: root,
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .filter(Boolean),
  );
}

const trackedFiles = gitLsFiles();
const requiredTrackedSource = [
  "src/local-vector/document-summarizer.ts",
  "src/local-vector/ollama-client.ts",
  "src/local-vector/search-result-cache.ts",
  "src/local-vector/summary-models.ts",
];

for (const file of requiredTrackedSource) {
  assert.ok(trackedFiles.has(file), `${file} must be tracked so source builds from a clean clone`);
}

const requiredReleaseFiles = [
  "main.js",
  "manifest.json",
  "styles.css",
  "package.json",
  "package-lock.json",
  "scripts/install-local-runtime.mjs",
  "scripts/download-jina-model.py",
  "mcp-server/package.json",
  "mcp-server/package-lock.json",
  "mcp-server/tsconfig.json",
  "mcp-server/src/index.ts",
  "mcp-server/src/config.ts",
  "mcp-server/src/chroma-client.ts",
  "mcp-server/src/embedding.ts",
];

for (const file of requiredReleaseFiles) {
  assert.ok(fs.existsSync(path.join(releaseDir, file)), `release/${releaseVersion}/${file} is required for runtime setup`);
}

const forbiddenReleasePaths = [
  "docs",
  "test",
  "benchmark",
  "mcp-server/src/commercial",
  "mcp-server/Dockerfile.commercial",
  "mcp-server/docker-compose.commercial.yml",
];

for (const file of forbiddenReleasePaths) {
  assert.ok(!fs.existsSync(path.join(releaseDir, file)), `release/${releaseVersion}/${file} must not be included`);
}

console.log("Release integrity test passed");
