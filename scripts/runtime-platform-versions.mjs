#!/usr/bin/env node

/**
 * Single reviewed source for which managed runtime version each platform ships.
 * Every runtime script and workflow reads runtime-package/platform-versions.json
 * through this module, so a platform (for example win32-x64) can move to a new
 * runtime version while the others keep their published version untouched.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const PLATFORM_VERSIONS_PATH = path.resolve(SCRIPT_DIRECTORY, "..", "runtime-package", "platform-versions.json");

/** Hosted release scope; darwin-x64 is deferred until it has a verified native build. */
export const SUPPORTED_RUNTIME_PLATFORMS = Object.freeze(["darwin-arm64", "win32-x64"]);
const RUNTIME_VERSION_PATTERN = /^node22-v[1-9][0-9]{0,3}$/;
const WINDOWS_VISUAL_CPP = new Set(["absent", "bundled"]);
const WINDOWS_DIRECT_ML = new Set(["kept", "stripped"]);

/** DirectML / DirectX shader files that onnxruntime.dll delay-loads; CPU-only inference never needs them. */
export const DIRECT_ML_FILES = Object.freeze(["DirectML.dll", "dxcompiler.dll", "dxil.dll"]);

function fail(message) {
  throw new Error(`Runtime platform version table: ${message}`);
}

function validReleaseRoot(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
    && !/(?:^|\/)latest(?:\/|$)/i.test(url.pathname) && !value.endsWith("/");
}

function normalizeWindowsProfile(platform, profile) {
  if (!platform.startsWith("win32-")) {
    if (profile !== undefined) fail(`${platform} cannot declare a Windows payload profile`);
    return null;
  }
  if (!profile || typeof profile !== "object" || Array.isArray(profile)
    || JSON.stringify(Object.keys(profile).sort()) !== JSON.stringify(["directMl", "visualCppRuntime"])
    || !WINDOWS_VISUAL_CPP.has(profile.visualCppRuntime) || !WINDOWS_DIRECT_ML.has(profile.directMl)) {
    fail(`${platform} must declare windows.visualCppRuntime (absent|bundled) and windows.directMl (kept|stripped)`);
  }
  return Object.freeze({ visualCppRuntime: profile.visualCppRuntime, directMl: profile.directMl });
}

export function parsePlatformVersionTable(value) {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["platforms", "releaseRoot", "schemaVersion"])) {
    fail("unexpected top-level fields");
  }
  if (!validReleaseRoot(value.releaseRoot)) fail("releaseRoot must be an immutable HTTPS release download root");
  const platforms = value.platforms;
  if (!platforms || typeof platforms !== "object" || Array.isArray(platforms)) fail("platforms must be an object");
  if (JSON.stringify(Object.keys(platforms)) !== JSON.stringify(SUPPORTED_RUNTIME_PLATFORMS)) {
    fail(`platforms must list exactly ${SUPPORTED_RUNTIME_PLATFORMS.join(", ")} in that order`);
  }
  const entries = {};
  for (const platform of SUPPORTED_RUNTIME_PLATFORMS) {
    const entry = platforms[platform];
    if (!entry || typeof entry !== "object" || !RUNTIME_VERSION_PATTERN.test(entry.version || "")) {
      fail(`${platform}.version must look like node22-vN`);
    }
    const extra = Object.keys(entry).filter((key) => key !== "version" && key !== "windows");
    if (extra.length) fail(`${platform} has unexpected fields: ${extra.join(", ")}`);
    entries[platform] = Object.freeze({
      platform,
      version: entry.version,
      windows: normalizeWindowsProfile(platform, entry.windows),
    });
  }
  return Object.freeze({ releaseRoot: value.releaseRoot, platforms: Object.freeze(entries) });
}

let cachedTable = null;

export function loadPlatformVersionTable(filename = PLATFORM_VERSIONS_PATH) {
  if (filename === PLATFORM_VERSIONS_PATH && cachedTable) return cachedTable;
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    fail(`cannot read ${path.basename(filename)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const table = parsePlatformVersionTable(value);
  if (filename === PLATFORM_VERSIONS_PATH) cachedTable = table;
  return table;
}

export function runtimeVersionFor(platform, table = loadPlatformVersionTable()) {
  const entry = table.platforms[platform];
  if (!entry) fail(`no runtime version for ${platform}`);
  return entry.version;
}

export function platformVersionMap(table = loadPlatformVersionTable()) {
  return Object.fromEntries(SUPPORTED_RUNTIME_PLATFORMS.map((platform) => [platform, table.platforms[platform].version]));
}

export function packRootName(version) {
  if (!RUNTIME_VERSION_PATTERN.test(version || "")) fail(`invalid runtime version ${version}`);
  return `analogy-embedding-runtime-${version}`;
}

export function archiveKindFor(platform) {
  return platform.startsWith("win32-") ? "zip" : "tar.gz";
}

export function packFileName(version, platform) {
  return `${packRootName(version)}-${platform}.${archiveKindFor(platform)}`;
}

export function runtimeAssetId(version, platform) {
  return `embedding-runtime-${version}-${platform}`;
}

export function runtimeReleaseTag(version) {
  packRootName(version);
  return `runtime-${version}`;
}

export function runtimeReleaseBaseUrl(releaseRoot, version) {
  return `${releaseRoot}/${runtimeReleaseTag(version)}`;
}

/**
 * Parses a comma separated platform list (workflow input) into table order and
 * returns the single release tag those platforms publish under.
 */
export function selectRuntimePlatforms(requested) {
  const names = String(requested || "").split(",").map((name) => name.trim()).filter(Boolean);
  if (!names.length) fail("at least one platform must be selected");
  const unknown = names.filter((name) => !SUPPORTED_RUNTIME_PLATFORMS.includes(name));
  if (unknown.length) fail(`unsupported platforms: ${unknown.join(", ")}`);
  if (new Set(names).size !== names.length) fail("duplicate platforms");
  return SUPPORTED_RUNTIME_PLATFORMS.filter((platform) => names.includes(platform));
}

export function planRuntimeRelease(requested, table = loadPlatformVersionTable()) {
  const platforms = selectRuntimePlatforms(requested);
  const versions = [...new Set(platforms.map((platform) => table.platforms[platform].version))];
  if (versions.length !== 1) {
    fail(`one runtime release publishes one version; selected platforms span ${versions.join(", ")}`);
  }
  const carried = SUPPORTED_RUNTIME_PLATFORMS.filter((platform) => !platforms.includes(platform));
  return {
    tag: runtimeReleaseTag(versions[0]),
    version: versions[0],
    platforms,
    carried: carried.map((platform) => ({
      platform,
      version: table.platforms[platform].version,
      tag: runtimeReleaseTag(table.platforms[platform].version),
      fileName: packFileName(table.platforms[platform].version, platform),
    })),
  };
}

function printUsage() {
  return [
    "Usage:",
    "  node scripts/runtime-platform-versions.mjs plan --platforms <list> [--tag <runtime tag>]",
    "  node scripts/runtime-platform-versions.mjs downloads",
    "  node scripts/runtime-platform-versions.mjs archive --platform <platform>",
    "  node scripts/runtime-platform-versions.mjs matrix --platforms <list>",
  ].join("\n");
}

const MATRIX_RUNNERS = Object.freeze({
  "darwin-arm64": { os: "macos-14", platform: "darwin", arch: "arm64", key: "darwin-arm64" },
  "win32-x64": { os: "windows-2025", platform: "win32", arch: "x64", key: "win32-x64" },
});

function main(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith("--") || rest[index + 1] === undefined) throw new Error(printUsage());
    options[rest[index].slice(2)] = rest[index + 1];
  }
  const table = loadPlatformVersionTable();
  if (command === "plan") {
    // A publish plan (with --tag) must target exactly one runtime version.
    const plan = options.tag === undefined
      ? { platforms: selectRuntimePlatforms(options.platforms) }
      : planRuntimeRelease(options.platforms, table);
    if (options.tag !== undefined && options.tag !== plan.tag) {
      fail(`runtime tag ${options.tag} does not match ${plan.tag} for ${plan.platforms.join(", ")}`);
    }
    process.stdout.write(`${JSON.stringify(plan)}\n`);
  } else if (command === "matrix") {
    const platforms = selectRuntimePlatforms(options.platforms);
    process.stdout.write(JSON.stringify({ include: platforms.map((platform) => MATRIX_RUNNERS[platform]) }));
  } else if (command === "downloads") {
    // One line per platform: "<tag> <file name prefix>", consumed by gh release download.
    for (const platform of SUPPORTED_RUNTIME_PLATFORMS) {
      const version = table.platforms[platform].version;
      process.stdout.write(`${runtimeReleaseTag(version)} ${packFileName(version, platform)}\n`);
    }
  } else if (command === "archive") {
    const version = runtimeVersionFor(options.platform, table);
    process.stdout.write(packFileName(version, options.platform));
  } else {
    throw new Error(printUsage());
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[runtime-platform-versions] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
