#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_PACKS,
  RUNTIME_VERSIONS,
  artifactNames,
  sha256File,
  validateRuntimeMatrix,
} from "./runtime-package-validator.mjs";
import { renderPublishedRuntimeTypeScript, runtimeAssetBaseUrl } from "./runtime-manifest-binding.mjs";
import { loadPlatformVersionTable } from "./runtime-platform-versions.mjs";

const REQUIRED_OPTIONS = ["input", "output"];
const OPTIONAL_OPTIONS = ["release-root"];

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`Invalid argument sequence near ${option || "<end>"}`);
    const name = option.slice(2);
    if (!REQUIRED_OPTIONS.includes(name) && !OPTIONAL_OPTIONS.includes(name)) throw new Error(`Unknown argument: ${option}`);
    if (values.has(name)) throw new Error(`Duplicate argument: ${option}`);
    values.set(name, value);
  }
  const missing = REQUIRED_OPTIONS.filter((name) => !values.has(name));
  if (missing.length) throw new Error(`Missing required arguments: ${missing.map((name) => `--${name}`).join(", ")}`);
  return Object.fromEntries(values);
}

function validateReleaseRoot(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || /(?:^|\/)latest(?:\/|$)/i.test(url.pathname) || /\/runtime-[^/]+\/?$/.test(url.pathname)) {
    throw new Error("--release-root must be the immutable HTTPS releases/download root without credentials, query, hash, latest, or a tag");
  }
  return value.replace(/\/+$/, "");
}

function requireRealDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory: ${directory}`);
}

async function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  const directoryHandle = await fs.promises.open(directory, "r");
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
}

async function writeAtomic(filename, body) {
  await fs.promises.mkdir(path.dirname(filename), { recursive: true });
  requireRealDirectory(path.dirname(filename), "Atomic output parent");
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${Date.now()}.tmp`);
  let handle;
  try {
    handle = await fs.promises.open(temporary, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, filename);
    await fsyncDirectory(path.dirname(filename));
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.rm(temporary, { force: true });
  }
}

export async function generateRuntimeManifest({ inputRoot: requestedInputRoot, outputPath: requestedOutputPath, releaseRoot: requestedReleaseRoot, trustPolicy } = {}) {
  const inputRoot = path.resolve(requestedInputRoot);
  const outputPath = path.resolve(requestedOutputPath);
  const releaseRoot = validateReleaseRoot(requestedReleaseRoot ?? loadPlatformVersionTable().releaseRoot);
  requireRealDirectory(inputRoot, "Runtime input");
  const missingPacks = EXPECTED_PACKS.filter(({ fileName }) => !fs.existsSync(path.join(inputRoot, fileName))).map(({ fileName }) => fileName);
  if (missingPacks.length) throw new Error(`Missing runtime packs: ${missingPacks.join(", ")}`);

  // This call parses every archive and validates archive bytes against all sidecars,
  // native headers, licenses, smoke provenance, and the last-written completion marker.
  const validated = validateRuntimeMatrix(inputRoot, { trustPolicy });
  const assets = validated.map(({ expected, binding, names }) => {
    const noticesSize = fs.statSync(path.join(inputRoot, names.notices)).size;
    const baseUrl = runtimeAssetBaseUrl(releaseRoot, expected.version);
    return {
      id: expected.id,
      kind: "embedding-runtime",
      platform: expected.platform,
      version: expected.version,
      url: `${baseUrl}/${expected.fileName}`,
      fileName: expected.fileName,
      archive: expected.archive,
      size: binding.archiveSize,
      sha256: binding.archiveSha256,
      executableRelativePath: `${expected.packRootName}/${expected.internalExecutableRelativePath}`,
      licenseName: "See bundled THIRD_PARTY_NOTICES.txt",
      licenseUrl: `${baseUrl}/${names.notices}`,
      source: "published",
      runtimeVersions: RUNTIME_VERSIONS,
      internalManifestFile: names.manifest,
      internalManifestSha256: binding.manifestSha256,
      noticesFile: names.notices,
      noticesSize,
      noticesSha256: binding.noticesSha256,
      smokeAttestationFile: names.attestation,
      smokeAttestationSha256: sha256File(path.join(inputRoot, names.attestation)),
      completionMarkerFile: names.completion,
      completionMarkerSha256: sha256File(path.join(inputRoot, names.completion)),
    };
  });

  const platformVersions = Object.fromEntries(assets.map((asset) => [asset.platform, asset.version]));
  const releaseManifest = { schemaVersion: 2, releaseRoot, platformVersions, assets };
  await writeAtomic(path.join(inputRoot, "embedding-runtime-manifest.json"), `${JSON.stringify(releaseManifest, null, 2)}\n`);
  await writeAtomic(outputPath, renderPublishedRuntimeTypeScript(releaseManifest));
  console.log(`[runtime-manifest] Generated ${path.relative(process.cwd(), outputPath) || path.basename(outputPath)}`);
  return releaseManifest;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await generateRuntimeManifest({
    inputRoot: options.input,
    outputPath: options.output,
    releaseRoot: options["release-root"],
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[runtime-manifest] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
