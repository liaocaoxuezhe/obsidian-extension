"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const verifier = path.join(
  process.cwd(),
  "scripts/verify-local-plugin-artifact.mjs",
);

test("local deployment gate rejects a development runtime fixture bundle", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-local-artifact-gate-"));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "main.js"), [
    'const source = "development-fixture";',
    'const url = "https://example.invalid/analogy/runtime.tar.gz";',
  ].join("\n"));
  fs.writeFileSync(path.join(root, "manifest.json"), '{"id":"analogy-rag-in-your-vault","version":"1.1.9"}\n');
  fs.writeFileSync(path.join(root, "styles.css"), "body{}\n");

  const result = spawnSync(process.execPath, [verifier, root], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /LOCAL_PLUGIN_DEVELOPMENT_RUNTIME_FORBIDDEN/);
});

test("local deployment gate accepts a published runtime bundle with exactly three files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-local-artifact-gate-"));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "main.js"), [
    'const source = "published";',
    'const url = "https://github.com/Nixum/analogy/releases/download/runtime-node22-v1/runtime.tar.gz";',
  ].join("\n"));
  const version = require(path.join(process.cwd(), "package.json")).version;
  fs.writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify({
    id: "analogy-rag-in-your-vault",
    version,
  })}\n`);
  fs.writeFileSync(path.join(root, "styles.css"), "body{}\n");

  const result = spawnSync(process.execPath, [verifier, root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("local deployment gate rejects an artifact from a stale plugin version", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-local-artifact-gate-"));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "main.js"), 'const source = "published";\n');
  fs.writeFileSync(path.join(root, "manifest.json"), '{"id":"analogy-rag-in-your-vault","version":"1.2.4"}\n');
  fs.writeFileSync(path.join(root, "styles.css"), "body{}\n");

  const result = spawnSync(process.execPath, [verifier, root], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /LOCAL_PLUGIN_MANIFEST_INVALID/);
});

test("published runtime renderer keeps the internal manifest binding required at startup", async () => {
  const binding = await import(pathToFileURL(path.join(
    process.cwd(),
    "scripts/runtime-manifest-binding.mjs",
  )).href);
  const internalManifestSha256 = "2".repeat(64);
  const source = binding.renderPublishedRuntimeTypeScript({
    schemaVersion: 1,
    runtimeVersion: "node22-v1",
    baseUrl: "https://github.com/Nixum/analogy/releases/download/runtime-node22-v1",
    assets: [{
      id: "embedding-runtime-node22-v1-darwin-arm64",
      kind: "embedding-runtime",
      platform: "darwin-arm64",
      version: "node22-v1",
      url: "https://github.com/Nixum/analogy/releases/download/runtime-node22-v1/runtime.tar.gz",
      fileName: "runtime.tar.gz",
      archive: "tar.gz",
      size: 123,
      sha256: "1".repeat(64),
      executableRelativePath: "analogy-embedding-runtime-node22-v1/node/bin/node",
      licenseName: "notices",
      licenseUrl: "https://github.com/Nixum/analogy/releases/download/runtime-node22-v1/notices.txt",
      source: "published",
      runtimeVersions: { node: "22.23.2", transformers: "4.2.0", onnxruntime: "1.26.0" },
      internalManifestSha256,
    }],
  });

  assert.match(source, new RegExp(internalManifestSha256));
});
