#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderPublishedRuntimeTypeScript } from "./runtime-manifest-binding.mjs";

const RUNTIME_VERSION = "node22-v1";
const RUNTIME_VERSIONS = Object.freeze({
  node: "22.23.2",
  transformers: "4.2.0",
  onnxruntime: "1.26.0",
});
const DEFAULT_RUNTIME_RELEASE_ROOT = "https://github.com/liaocaoxuezhe/obsidian-extension/releases/download/runtime-node22-v1";
const PLATFORM_PACKS = Object.freeze({
  "darwin-arm64": Object.freeze({
    fileName: "analogy-embedding-runtime-node22-v1-darwin-arm64.tar.gz",
    archive: "tar.gz",
  }),
  "darwin-x64": Object.freeze({
    fileName: "analogy-embedding-runtime-node22-v1-darwin-x64.tar.gz",
    archive: "tar.gz",
  }),
  "win32-x64": Object.freeze({
    fileName: "analogy-embedding-runtime-node22-v1-win32-x64.zip",
    archive: "zip",
  }),
});

function fail(code) {
  throw new Error(code);
}

function readJson(filename, code) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch {
    fail(code);
  }
  return value;
}

function requireRealDirectory(filename, code) {
  let stat;
  try {
    stat = fs.lstatSync(filename);
  } catch {
    fail(code);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code);
}

function requireRegularFile(filename, code) {
  let stat;
  try {
    stat = fs.lstatSync(filename);
  } catch {
    fail(code);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(code);
  return stat;
}

function requireContained(root, candidate, code) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(code);
}

function sha256File(filename) {
  const hash = crypto.createHash("sha256");
  const handle = fs.openSync(filename, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
}

function validSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validRelativePath(value) {
  return typeof value === "string" && value.length > 0 && !path.posix.isAbsolute(value)
    && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function platformFromHost() {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "win32" && process.arch === "x64") return "win32-x64";
  fail(`LOCAL_DEVELOPMENT_PLATFORM_UNSUPPORTED:${process.platform}-${process.arch}`);
}

export function createLocalDevelopmentRuntimeManifest({
  localDataRoot,
  platform = platformFromHost(),
  baseUrl = DEFAULT_RUNTIME_RELEASE_ROOT,
}) {
  const pack = PLATFORM_PACKS[platform];
  if (!pack) fail(`LOCAL_DEVELOPMENT_PLATFORM_UNSUPPORTED:${platform}`);
  const resolvedDataRoot = path.resolve(localDataRoot);
  const runtimeRoot = path.join(resolvedDataRoot, "runtime");
  const pointerPath = path.join(runtimeRoot, "current", "embedding-runtime.json");
  requireRealDirectory(resolvedDataRoot, "LOCAL_DEVELOPMENT_DATA_ROOT_INVALID");
  requireRealDirectory(runtimeRoot, "LOCAL_DEVELOPMENT_RUNTIME_ROOT_INVALID");
  requireRegularFile(pointerPath, "LOCAL_DEVELOPMENT_RUNTIME_POINTER_MISSING");
  const pointer = readJson(pointerPath, "LOCAL_DEVELOPMENT_RUNTIME_POINTER_INVALID");
  const expectedRuntimeId = `embedding-runtime-${RUNTIME_VERSION}-${platform}`;
  const expectedInstalledPath = path.join(runtimeRoot, "embedding", expectedRuntimeId);
  if (pointer?.schemaVersion !== 1 || pointer.kind !== "embedding-runtime"
    || pointer.runtimeId !== expectedRuntimeId || !validSha256(pointer.assetSha256)
    || path.resolve(pointer.installedPath || "") !== path.resolve(expectedInstalledPath)) {
    fail("LOCAL_DEVELOPMENT_RUNTIME_POINTER_MISMATCH");
  }
  requireContained(runtimeRoot, expectedInstalledPath, "LOCAL_DEVELOPMENT_RUNTIME_PATH_UNSAFE");
  requireRealDirectory(expectedInstalledPath, "LOCAL_DEVELOPMENT_RUNTIME_INSTALL_MISSING");

  const packRoot = path.join(expectedInstalledPath, `analogy-embedding-runtime-${RUNTIME_VERSION}`);
  const internalManifestPath = path.join(packRoot, "manifest.json");
  requireRealDirectory(packRoot, "LOCAL_DEVELOPMENT_RUNTIME_PACK_MISSING");
  requireRegularFile(internalManifestPath, "LOCAL_DEVELOPMENT_RUNTIME_MANIFEST_MISSING");
  const internalManifest = readJson(internalManifestPath, "LOCAL_DEVELOPMENT_RUNTIME_MANIFEST_INVALID");
  if (internalManifest?.schemaVersion !== 1 || internalManifest.id !== expectedRuntimeId
    || internalManifest.kind !== "embedding-runtime" || internalManifest.platform !== platform
    || internalManifest.version !== RUNTIME_VERSION
    || JSON.stringify(internalManifest.runtimeVersions) !== JSON.stringify(RUNTIME_VERSIONS)
    || !validRelativePath(internalManifest.executableRelativePath)) {
    fail("LOCAL_DEVELOPMENT_RUNTIME_MANIFEST_MISMATCH");
  }

  const archivePath = path.join(runtimeRoot, "downloads", `${expectedRuntimeId}.part`);
  const metadataPath = `${archivePath}.meta.json`;
  const archiveStat = requireRegularFile(archivePath, "LOCAL_DEVELOPMENT_RUNTIME_ARCHIVE_MISSING");
  requireRegularFile(metadataPath, "LOCAL_DEVELOPMENT_RUNTIME_METADATA_MISSING");
  const metadata = readJson(metadataPath, "LOCAL_DEVELOPMENT_RUNTIME_METADATA_INVALID");
  if (metadata?.schemaVersion !== 1 || metadata.assetId !== expectedRuntimeId
    || metadata.sha256 !== pointer.assetSha256 || metadata.expectedSize !== archiveStat.size
    || sha256File(archivePath) !== pointer.assetSha256) {
    fail("LOCAL_DEVELOPMENT_RUNTIME_ARCHIVE_MISMATCH");
  }

  const normalizedBaseUrl = String(baseUrl).replace(/\/+$/, "");
  const asset = {
    id: expectedRuntimeId,
    kind: "embedding-runtime",
    platform,
    version: RUNTIME_VERSION,
    url: `${normalizedBaseUrl}/${pack.fileName}`,
    fileName: pack.fileName,
    archive: pack.archive,
    size: archiveStat.size,
    sha256: pointer.assetSha256,
    executableRelativePath: `${path.posix.basename(packRoot)}/${internalManifest.executableRelativePath}`,
    licenseName: "See bundled THIRD_PARTY_NOTICES.txt",
    licenseUrl: `${normalizedBaseUrl}/${pack.fileName}.THIRD_PARTY_NOTICES.txt`,
    source: "published",
    runtimeVersions: RUNTIME_VERSIONS,
    internalManifestSha256: sha256File(internalManifestPath),
  };
  const releaseManifest = {
    schemaVersion: 1,
    runtimeVersion: RUNTIME_VERSION,
    baseUrl: normalizedBaseUrl,
    assets: [asset],
  };
  return {
    asset,
    source: renderPublishedRuntimeTypeScript(releaseManifest),
  };
}

function writeAtomic(filename, body) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function deployLocalPluginFiles(sourceRoot, targetRoot) {
  const source = path.resolve(sourceRoot);
  const target = path.resolve(targetRoot);
  requireRealDirectory(source, "LOCAL_DEVELOPMENT_PLUGIN_SOURCE_INVALID");
  requireRealDirectory(target, "LOCAL_DEVELOPMENT_PLUGIN_TARGET_INVALID");
  for (const name of ["main.js", "manifest.json", "styles.css"]) {
    const sourcePath = path.join(source, name);
    requireRegularFile(sourcePath, `LOCAL_DEVELOPMENT_PLUGIN_FILE_MISSING:${name}`);
    writeAtomic(path.join(target, name), fs.readFileSync(sourcePath));
  }
  const mcpSource = path.join(source, "mcp-server");
  requireRealDirectory(mcpSource, "LOCAL_DEVELOPMENT_MCP_SOURCE_INVALID");
  requireRegularFile(path.join(mcpSource, "package.json"), "LOCAL_DEVELOPMENT_MCP_PACKAGE_MISSING");
  requireRegularFile(path.join(mcpSource, "dist", "index.js"), "LOCAL_DEVELOPMENT_MCP_BUILD_MISSING");
  const mcpTarget = path.join(target, "mcp-server");
  let targetStat = null;
  try {
    targetStat = fs.lstatSync(mcpTarget);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (targetStat) {
    const stat = targetStat;
    if (!stat.isSymbolicLink()) fail("LOCAL_DEVELOPMENT_MCP_TARGET_CONFLICT");
    fs.unlinkSync(mcpTarget);
  }
  fs.symlinkSync(mcpSource, mcpTarget, process.platform === "win32" ? "junction" : "dir");
}

function parseOptions(values) {
  if (values.length % 2 !== 0) fail("LOCAL_DEVELOPMENT_ARGUMENTS_INVALID");
  const options = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || options.has(name.slice(2))) {
      fail("LOCAL_DEVELOPMENT_ARGUMENTS_INVALID");
    }
    options.set(name.slice(2), value);
  }
  return options;
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (!value) fail(`LOCAL_DEVELOPMENT_ARGUMENT_MISSING:${name}`);
  return value;
}

function main() {
  const [command, ...values] = process.argv.slice(2);
  const options = parseOptions(values);
  if (command === "prepare") {
    const result = createLocalDevelopmentRuntimeManifest({
      localDataRoot: requiredOption(options, "local-data-root"),
      platform: options.get("platform") || platformFromHost(),
      baseUrl: options.get("base-url") || DEFAULT_RUNTIME_RELEASE_ROOT,
    });
    const output = path.resolve(requiredOption(options, "output"));
    writeAtomic(output, result.source);
    console.log(`[local-development] prepared runtime binding for ${result.asset.id}`);
    return;
  }
  if (command === "deploy") {
    deployLocalPluginFiles(requiredOption(options, "source"), requiredOption(options, "target"));
    console.log(`[local-development] deployed main.js, manifest.json, styles.css, and the local MCP development link`);
    return;
  }
  fail("LOCAL_DEVELOPMENT_COMMAND_INVALID");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[local-development] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
