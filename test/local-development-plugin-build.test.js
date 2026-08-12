import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(projectRoot, "scripts", "local-development-build.mjs");

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function runScript(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
  });
}

test("prepare creates a local development manifest that reuses the installed runtime", (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-local-build-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const localDataRoot = path.join(temporaryRoot, "Analogy");
  const runtimeId = "embedding-runtime-node22-v1-darwin-arm64";
  const runtimeRoot = path.join(localDataRoot, "runtime");
  const installedPath = path.join(runtimeRoot, "embedding", runtimeId);
  const packRoot = path.join(installedPath, "analogy-embedding-runtime-node22-v1");
  const archiveBytes = Buffer.from("verified-local-runtime-archive", "utf8");
  const archiveSha256 = sha256(archiveBytes);
  const internalManifest = {
    schemaVersion: 1,
    id: runtimeId,
    kind: "embedding-runtime",
    platform: "darwin-arm64",
    version: "node22-v1",
    runtimeVersions: {
      node: "22.23.2",
      transformers: "4.2.0",
      onnxruntime: "1.26.0",
    },
    executableRelativePath: "node/bin/node",
    moduleRootRelativePath: "node_modules",
    noticesRelativePath: "THIRD_PARTY_NOTICES.txt",
  };

  fs.mkdirSync(path.join(runtimeRoot, "current"), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "downloads"), { recursive: true });
  fs.mkdirSync(packRoot, { recursive: true });
  fs.writeFileSync(path.join(packRoot, "manifest.json"), `${JSON.stringify(internalManifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(runtimeRoot, "downloads", `${runtimeId}.part`), archiveBytes);
  fs.writeFileSync(path.join(runtimeRoot, "downloads", `${runtimeId}.part.meta.json`), `${JSON.stringify({
    schemaVersion: 1,
    assetId: runtimeId,
    sha256: archiveSha256,
    expectedSize: archiveBytes.length,
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(runtimeRoot, "current", "embedding-runtime.json"), `${JSON.stringify({
    schemaVersion: 1,
    kind: "embedding-runtime",
    runtimeId,
    installedPath,
    assetSha256: archiveSha256,
    installedAt: 1,
    previousRuntimeId: null,
  }, null, 2)}\n`, "utf8");

  const outputPath = path.join(temporaryRoot, "generated-embedding-runtime-manifest.ts");
  const result = runScript([
    "prepare",
    "--local-data-root", localDataRoot,
    "--platform", "darwin-arm64",
    "--output", outputPath,
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = fs.readFileSync(outputPath, "utf8");
  assert.match(output, /EMBEDDING_RUNTIME_MANIFEST_SOURCE = "published"/);
  assert.match(output, new RegExp(runtimeId));
  assert.match(output, new RegExp(archiveSha256));
  assert.doesNotMatch(output, /development-fixture|example\.invalid/);
});

test("deploy copies the complete three-file local plugin artifact", (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-local-deploy-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const sourceRoot = path.join(temporaryRoot, "source");
  const targetRoot = path.join(temporaryRoot, "target");
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(targetRoot);
  fs.writeFileSync(path.join(sourceRoot, "main.js"), "local-main", "utf8");
  fs.writeFileSync(path.join(sourceRoot, "manifest.json"), "{\"id\":\"analogy-rag-in-your-vault\"}\n", "utf8");
  fs.writeFileSync(path.join(sourceRoot, "styles.css"), ".local-style{}\n", "utf8");
  fs.mkdirSync(path.join(sourceRoot, "mcp-server", "dist"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "mcp-server", "package.json"), "{}\n", "utf8");
  fs.writeFileSync(path.join(sourceRoot, "mcp-server", "dist", "index.js"), "mcp-entry\n", "utf8");

  const result = runScript([
    "deploy",
    "--source", sourceRoot,
    "--target", targetRoot,
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(path.join(targetRoot, "main.js"), "utf8"), "local-main");
  assert.equal(fs.readFileSync(path.join(targetRoot, "manifest.json"), "utf8"), "{\"id\":\"analogy-rag-in-your-vault\"}\n");
  assert.equal(fs.readFileSync(path.join(targetRoot, "styles.css"), "utf8"), ".local-style{}\n");
  assert.equal(fs.realpathSync(path.join(targetRoot, "mcp-server")), fs.realpathSync(path.join(sourceRoot, "mcp-server")));
  assert.equal(fs.readFileSync(path.join(targetRoot, "mcp-server", "dist", "index.js"), "utf8"), "mcp-entry\n");
});

test("deploy replaces a stale MCP development link", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-local-deploy-stale-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const targetRoot = path.join(root, "target");
  fs.mkdirSync(path.join(sourceRoot, "mcp-server", "dist"), { recursive: true });
  fs.mkdirSync(targetRoot, { recursive: true });
  for (const name of ["main.js", "manifest.json", "styles.css"]) {
    fs.writeFileSync(path.join(sourceRoot, name), `${name}\n`, "utf8");
  }
  fs.writeFileSync(path.join(sourceRoot, "mcp-server", "package.json"), "{}\n", "utf8");
  fs.writeFileSync(path.join(sourceRoot, "mcp-server", "dist", "index.js"), "mcp-entry\n", "utf8");
  fs.symlinkSync(path.join(root, "missing-mcp-server"), path.join(targetRoot, "mcp-server"), "dir");

  const result = runScript(["deploy", "--source", sourceRoot, "--target", targetRoot]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.realpathSync(path.join(targetRoot, "mcp-server")), fs.realpathSync(path.join(sourceRoot, "mcp-server")));
});

test("build:local bundles the installed runtime binding and deploys all plugin files", (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-local-build-integration-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const localDataRoot = path.join(temporaryRoot, "Analogy");
  const targetRoot = path.join(temporaryRoot, "plugin");
  const runtimeId = "embedding-runtime-node22-v1-darwin-arm64";
  const runtimeRoot = path.join(localDataRoot, "runtime");
  const installedPath = path.join(runtimeRoot, "embedding", runtimeId);
  const packRoot = path.join(installedPath, "analogy-embedding-runtime-node22-v1");
  const archiveBytes = Buffer.from("local-build-integration-runtime", "utf8");
  const archiveSha256 = sha256(archiveBytes);
  fs.mkdirSync(path.join(runtimeRoot, "current"), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "downloads"), { recursive: true });
  fs.mkdirSync(packRoot, { recursive: true });
  fs.mkdirSync(targetRoot);
  fs.writeFileSync(path.join(packRoot, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: runtimeId,
    kind: "embedding-runtime",
    platform: "darwin-arm64",
    version: "node22-v1",
    runtimeVersions: { node: "22.23.2", transformers: "4.2.0", onnxruntime: "1.26.0" },
    executableRelativePath: "node/bin/node",
    moduleRootRelativePath: "node_modules",
    noticesRelativePath: "THIRD_PARTY_NOTICES.txt",
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(runtimeRoot, "downloads", `${runtimeId}.part`), archiveBytes);
  fs.writeFileSync(path.join(runtimeRoot, "downloads", `${runtimeId}.part.meta.json`), `${JSON.stringify({
    schemaVersion: 1,
    assetId: runtimeId,
    sha256: archiveSha256,
    expectedSize: archiveBytes.length,
  })}\n`, "utf8");
  fs.writeFileSync(path.join(runtimeRoot, "current", "embedding-runtime.json"), `${JSON.stringify({
    schemaVersion: 1,
    kind: "embedding-runtime",
    runtimeId,
    installedPath,
    assetSha256: archiveSha256,
    installedAt: 1,
    previousRuntimeId: null,
  })}\n`, "utf8");

  const result = spawnSync("npm", ["run", "build:local"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ANALOGY_LOCAL_DATA_ROOT: localDataRoot,
      ANALOGY_LOCAL_PLUGIN_DIR: targetRoot,
      ANALOGY_LOCAL_RUNTIME_PLATFORM: "darwin-arm64",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const name of ["main.js", "manifest.json", "styles.css"]) {
    assert.deepEqual(
      fs.readFileSync(path.join(targetRoot, name)),
      fs.readFileSync(path.join(projectRoot, name)),
      `${name} was not deployed from the local build`,
    );
  }
  const bundle = fs.readFileSync(path.join(targetRoot, "main.js"), "utf8");
  assert.match(bundle, new RegExp(runtimeId));
  assert.match(bundle, new RegExp(archiveSha256));
  assert.doesNotMatch(bundle, /development-fixture|example\.invalid/);
});
