#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { installOrtNativeOverlay, verifyOrtNativeOverlay } from "./runtime-native-overlay.mjs";
import { compareUtf8Bytes as compareUtf8ByteOrder } from "./runtime-archive.mjs";
import { validateRuntimeLockfile } from "./runtime-lockfile-validator.mjs";
import { LICENSE_CATALOG_SHA256 } from "./runtime-package-validator.mjs";

const execFileAsync = promisify(execFile);
const REQUIRED_OPTIONS = ["platform", "arch", "node-version", "output"];
const OPTIONAL_OPTIONS = ["ort-native-overlay"];
const RUNTIME_VERSION = "node22-v1";
const PACK_ROOT_NAME = `analogy-embedding-runtime-${RUNTIME_VERSION}`;
const NORMALIZED_MTIME = new Date("2000-01-01T00:00:00.000Z");
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const RUNTIME_PACKAGE_ROOT = path.join(EXTENSION_ROOT, "runtime-package");
const NODE_ASSETS_PATH = path.join(RUNTIME_PACKAGE_ROOT, "node-assets.json");
const PACKAGE_JSON_PATH = path.join(RUNTIME_PACKAGE_ROOT, "package.json");
const PACKAGE_LOCK_PATH = path.join(RUNTIME_PACKAGE_ROOT, "package-lock.json");
const LICENSE_CATALOG_PATH = path.join(RUNTIME_PACKAGE_ROOT, "license-catalog.json");
const ARCHIVE_WRITER_PATH = path.join(SCRIPT_DIRECTORY, "write-runtime-archive.mjs");
const SAFE_RUNTIME_PACKAGES = new Set([
  "@huggingface/jinja",
  "@huggingface/tokenizers",
  "@huggingface/transformers",
  "onnxruntime-common",
  "onnxruntime-node",
]);
const EXPECTED_RUNTIME_DEPENDENCIES = Object.freeze({
  "@huggingface/transformers": "4.2.0",
  "onnxruntime-node": "1.26.0",
});

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid argument sequence near ${option || "<end>"}`);
    }
    const name = option.slice(2);
    if (![...REQUIRED_OPTIONS, ...OPTIONAL_OPTIONS].includes(name)) {
      throw new Error(`Unknown argument: ${option}`);
    }
    if (values.has(name)) {
      throw new Error(`Duplicate argument: ${option}`);
    }
    values.set(name, value);
  }
  const missing = REQUIRED_OPTIONS.filter((name) => !values.has(name));
  if (missing.length > 0) {
    throw new Error(`Missing required arguments: ${missing.map((name) => `--${name}`).join(", ")}`);
  }
  return Object.fromEntries(values);
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function detectNativeRunner() {
  const machine = os.machine().toLowerCase();
  let translated = false;
  if (process.platform === "darwin") {
    try {
      translated = execFileSync("/usr/sbin/sysctl", ["-in", "sysctl.proc_translated"], { encoding: "utf8" }).trim() === "1";
    } catch (error) {
      if (error?.status !== 1) throw new Error(`Unable to determine Rosetta translation state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const windowsUnderlying = (process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE || "").toLowerCase();
  const expectedMachine = process.arch === "arm64" ? "arm64" : "x86_64";
  const normalizedMachine = machine === "amd64" ? "x86_64" : machine;
  const windowsMismatch = process.platform === "win32" && process.arch === "x64" && windowsUnderlying && !/^(?:amd64|x86_64)$/.test(windowsUnderlying);
  if (translated || normalizedMachine !== expectedMachine || windowsMismatch) {
    throw new Error(`Refusing emulated/translated native build: process.arch=${process.arch}, os.machine=${machine}, translated=${translated}, windowsUnderlying=${windowsUnderlying || "n/a"}`);
  }
  return { os: process.platform, processArch: process.arch, osMachine: normalizedMachine, translated, windowsUnderlying: windowsUnderlying || null };
}

function sanitizedNpmEnvironment({ bundledToolDirectory, privateRoot, cacheRoot }) {
  const environment = {
    PATH: `${bundledToolDirectory}${path.delimiter}${process.platform === "win32" ? (process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32") : "") : "/usr/bin:/bin"}`,
    HOME: privateRoot,
    USERPROFILE: privateRoot,
    npm_config_cache: path.join(cacheRoot, "npm"),
    npm_config_userconfig: path.join(privateRoot, "empty-npmrc"),
    npm_config_globalconfig: path.join(privateRoot, "empty-global-npmrc"),
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_metrics_registry: "https://registry.npmjs.org/",
    npm_config_fetch_retries: "5",
    npm_config_fetch_retry_factor: "2",
    npm_config_fetch_retry_mintimeout: "1000",
    npm_config_fetch_retry_maxtimeout: "20000",
    npm_config_proxy: "",
    npm_config_https_proxy: "",
    npm_config_noproxy: "*",
    ONNXRUNTIME_NODE_INSTALL: "skip",
  };
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

async function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  const handle = await fs.promises.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writePrivateFile(filename, body, mode = 0o600) {
  const handle = await fs.promises.open(filename, "wx", mode);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishBuiltGroup(outputRoot, platformKey, stageRoot, filenames) {
  const lockRoot = path.join(outputRoot, ".locks");
  const lockPath = path.join(lockRoot, `${platformKey}.lock`);
  await fs.promises.mkdir(lockRoot, { recursive: true, mode: 0o700 });
  try {
    await fs.promises.mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`Another runtime publication owns ${platformKey}`);
    throw error;
  }
  try {
    const completion = path.join(outputRoot, `${filenames.archive}.complete.json`);
    await fs.promises.rm(completion, { force: true });
    for (const filename of [filenames.archive, filenames.manifest, filenames.notices]) {
      const source = path.join(stageRoot, filename);
      const sourceStat = await fs.promises.lstat(source);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`Private publication contains a non-regular file: ${filename}`);
      const destination = path.join(outputRoot, filename);
      await fs.promises.rm(destination, { force: true });
      await fs.promises.rename(source, destination);
    }
    await fsyncDirectory(outputRoot);
  } finally {
    await fs.promises.rm(lockPath, { recursive: true, force: true });
  }
}

async function sha256File(filename) {
  const hash = crypto.createHash("sha256");
  const input = fs.createReadStream(filename);
  for await (const chunk of input) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyPinnedFile(filename, metadata, label) {
  const stat = await fs.promises.stat(filename);
  if (stat.size !== metadata.size) {
    throw new Error(`${label} size mismatch: expected ${metadata.size}, got ${stat.size}`);
  }
  const actualSha256 = await sha256File(filename);
  if (actualSha256 !== metadata.sha256) {
    throw new Error(`${label} SHA-256 mismatch: expected ${metadata.sha256}, got ${actualSha256}`);
  }
}

async function downloadPinnedAsset(asset, destination) {
  if (fs.existsSync(destination)) {
    try {
      await verifyPinnedFile(destination, asset, "Cached Node archive");
      console.log(`[embedding-runtime] Reusing verified ${asset.fileName}`);
      return;
    } catch {
      await fs.promises.rm(destination, { force: true });
    }
  }

  const temporary = `${destination}.${process.pid}.part`;
  await fs.promises.rm(temporary, { force: true });
  console.log(`[embedding-runtime] Downloading ${asset.url}`);
  try {
    await new Promise((resolve, reject) => {
      const request = https.get(asset.url, {
        headers: { "User-Agent": "Analogy-Runtime-Builder/1" },
      }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Node download failed with HTTP ${response.statusCode}`));
          return;
        }
        const declaredLength = Number(response.headers["content-length"]);
        if (!Number.isSafeInteger(declaredLength) || declaredLength !== asset.size) {
          response.resume();
          reject(new Error(`Node download Content-Length mismatch: expected ${asset.size}, got ${response.headers["content-length"] || "missing"}`));
          return;
        }
        const output = fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 });
        pipeline(response, output).then(resolve, reject);
      });
      request.setTimeout(120_000, () => request.destroy(new Error("Node download timed out")));
      request.on("error", reject);
    });
    await verifyPinnedFile(temporary, asset, "Downloaded Node archive");
    await fs.promises.rename(temporary, destination);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true });
    throw error;
  }
}

async function runExecutable(executable, args, options = {}) {
  const rendered = [executable, ...args].map((part) => JSON.stringify(part)).join(" ");
  console.log(`[embedding-runtime] $ ${rendered}`);
  try {
    return await execFileAsync(executable, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeout ?? 300_000,
      windowsHide: true,
    });
  } catch (error) {
    const output = `${error?.stdout || ""}${error?.stderr || ""}`.trim();
    throw new Error(`${rendered} failed${output ? `: ${output}` : ""}`, { cause: error });
  }
}

async function extractNodeArchive(archivePath, asset, destination) {
  await fs.promises.mkdir(destination, { recursive: true });
  const tarExecutable = process.platform === "win32"
    ? path.join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "tar.exe")
    : "tar";
  const args = asset.archive === "tar.gz"
    ? ["-xzf", archivePath, "-C", destination]
    : ["-xf", archivePath, "-C", destination];
  try {
    await runExecutable(tarExecutable, args, { timeout: 180_000 });
  } catch (error) {
    if (process.platform !== "win32" || asset.archive !== "zip") throw error;
    // Windows runner antivirus/indexing can transiently make bsdtar fail while
    // reopening a verified cached ZIP. Retry once into a clean extraction root.
    await fs.promises.rm(destination, { recursive: true, force: true });
    await fs.promises.mkdir(destination, { recursive: true });
    await runExecutable(tarExecutable, args, { timeout: 180_000 });
  }
}

function collectInstalledPackages(nodeModulesRoot) {
  const packages = [];
  const scanNodeModules = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".bin") continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.name.startsWith("@")) {
        for (const scopedEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
          if (scopedEntry.isDirectory()) addPackage(path.join(entryPath, scopedEntry.name));
        }
      } else {
        addPackage(entryPath);
      }
    }
  };
  const addPackage = (directory) => {
    const packageJsonPath = path.join(directory, "package.json");
    if (!fs.existsSync(packageJsonPath)) return;
    const metadata = readJson(packageJsonPath);
    packages.push({ directory, metadata });
    scanNodeModules(path.join(directory, "node_modules"));
  };
  scanNodeModules(nodeModulesRoot);
  return packages.sort((left, right) => {
    const leftKey = `${left.metadata.name}@${left.metadata.version}`;
    const rightKey = `${right.metadata.name}@${right.metadata.version}`;
    return compareUtf8ByteOrder(leftKey, rightKey);
  });
}

async function pruneRuntimeTree(nodeModulesRoot, platform, arch) {
  const packages = collectInstalledPackages(nodeModulesRoot);
  const onnxPackages = packages.filter(({ metadata }) => metadata.name === "onnxruntime-node");
  if (onnxPackages.length !== 1 || onnxPackages[0].metadata.version !== "1.26.0") {
    throw new Error(`Expected exactly onnxruntime-node@1.26.0, found ${onnxPackages.map(({ metadata }) => metadata.version).join(", ") || "none"}`);
  }

  for (const { directory } of onnxPackages) {
    const nativeRoot = path.join(directory, "bin", "napi-v6");
    const expectedNativeRoot = path.join(nativeRoot, platform, arch);
    if (!fs.existsSync(expectedNativeRoot)) {
      throw new Error(`onnxruntime-node@1.26.0 has no native library for ${platform}-${arch}`);
    }
    const nativeFiles = fs.readdirSync(expectedNativeRoot);
    if (!nativeFiles.includes("onnxruntime_binding.node") || !nativeFiles.some((filename) => /\.(?:dylib|dll)$/.test(filename))) {
      throw new Error(`onnxruntime-node@1.26.0 native payload is incomplete for ${platform}-${arch}`);
    }
    for (const platformEntry of fs.readdirSync(nativeRoot, { withFileTypes: true })) {
      const platformPath = path.join(nativeRoot, platformEntry.name);
      if (!platformEntry.isDirectory() || platformEntry.name !== platform) {
        await fs.promises.rm(platformPath, { recursive: true, force: true });
        continue;
      }
      for (const archEntry of fs.readdirSync(platformPath, { withFileTypes: true })) {
        if (!archEntry.isDirectory() || archEntry.name !== arch) {
          await fs.promises.rm(path.join(platformPath, archEntry.name), { recursive: true, force: true });
        }
      }
    }
    await fs.promises.rm(path.join(directory, "script"), { recursive: true, force: true });
    await fs.promises.rm(path.join(directory, "lib"), { recursive: true, force: true });
  }

  // The text embedding worker needs only the reviewed Node backend graph. Remove
  // browser ORT, vulnerable image/native packages, install-only ZIP/proxy tools,
  // and all now-orphaned transitive packages by an explicit package allowlist.
  for (const { directory, metadata } of [...packages]
    .sort((left, right) => right.directory.split(path.sep).length - left.directory.split(path.sep).length)) {
    if (!SAFE_RUNTIME_PACKAGES.has(metadata.name)) {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }

  const sharpShimRoot = path.join(nodeModulesRoot, "sharp");
  await fs.promises.mkdir(sharpShimRoot, { recursive: true });
  await fs.promises.writeFile(path.join(sharpShimRoot, "package.json"), `${JSON.stringify({
    name: "sharp",
    version: "0.0.0-analogy-disabled",
    private: true,
    main: "index.js",
    license: "MIT",
    description: "Fail-closed image backend shim for the text-only Analogy embedding runtime",
  }, null, 2)}\n`, "utf8");
  await fs.promises.writeFile(path.join(sharpShimRoot, "index.js"), [
    '"use strict";',
    "function imageBackendDisabled() {",
    '  throw new Error("Image processing is disabled in the text-only Analogy embedding runtime");',
    "}",
    "module.exports = imageBackendDisabled;",
    "module.exports.default = imageBackendDisabled;",
    "",
  ].join("\n"), "utf8");

  const transformersRoot = path.join(nodeModulesRoot, "@huggingface", "transformers");
  await fs.promises.rm(path.join(transformersRoot, "src"), { recursive: true, force: true });
  await fs.promises.rm(path.join(transformersRoot, "types"), { recursive: true, force: true });
  const transformersDist = path.join(transformersRoot, "dist");
  for (const entry of await fs.promises.readdir(transformersDist, { withFileTypes: true })) {
    if (entry.name !== "transformers.node.cjs") {
      await fs.promises.rm(path.join(transformersDist, entry.name), { recursive: true, force: true });
    }
  }
  await fs.promises.rm(path.join(nodeModulesRoot, ".package-lock.json"), { force: true });

  const walk = async (directory) => {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const stat = await fs.promises.lstat(entryPath);
      if (stat.isSymbolicLink()) {
        await fs.promises.unlink(entryPath);
      } else if (stat.isDirectory()) {
        if ([".bin", ".cache", ".npm", "_cacache"].includes(entry.name)) {
          await fs.promises.rm(entryPath, { recursive: true, force: true });
        } else {
          await walk(entryPath);
        }
      } else if (entry.name.endsWith(".map") || entry.name.endsWith(".ts")
        || /\.(?:onnx(?:_data)?|safetensors)$/i.test(entry.name)) {
        await fs.promises.unlink(entryPath);
      }
    }
  };
  await walk(nodeModulesRoot);

  const finalPackages = collectInstalledPackages(nodeModulesRoot);
  for (const { metadata } of finalPackages) {
    if (metadata.name === "sharp" && metadata.version === "0.0.0-analogy-disabled") continue;
    if (!SAFE_RUNTIME_PACKAGES.has(metadata.name)) throw new Error(`Unexpected production runtime package after pruning: ${metadata.name}@${metadata.version}`);
  }
  for (const forbiddenName of ["adm-zip", "global-agent", "onnxruntime-web", "@img/sharp", "@img/sharp-libvips"]) {
    if (finalPackages.some(({ metadata }) => metadata.name === forbiddenName)) throw new Error(`Forbidden production dependency survived pruning: ${forbiddenName}`);
  }
}

function repositoryUrl(metadata) {
  if (typeof metadata.repository === "string") return metadata.repository;
  if (metadata.repository && typeof metadata.repository.url === "string") return metadata.repository.url;
  return metadata.homepage || "not declared";
}

function loadVerifiedLicenseCatalog() {
  const bytes = fs.readFileSync(LICENSE_CATALOG_PATH);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  if (hash !== LICENSE_CATALOG_SHA256) throw new Error(`License catalog hash mismatch: expected ${LICENSE_CATALOG_SHA256}, got ${hash}`);
  const catalog = JSON.parse(bytes.toString("utf8"));
  const texts = new Map();
  for (const component of catalog.entries || []) {
    for (const entry of component.files || []) {
      const filename = path.join(RUNTIME_PACKAGE_ROOT, ...entry.path.split("/"));
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Catalog license must be a regular file: ${entry.path}`);
      const body = fs.readFileSync(filename);
      const actual = crypto.createHash("sha256").update(body).digest("hex");
      if (actual !== entry.sha256) throw new Error(`Catalog license hash mismatch: ${entry.path}`);
      texts.set(entry.path, body.toString("utf8"));
    }
  }
  return { catalog, texts, sha256: hash };
}

function renderThirdPartyNotices({ nodeAsset, nodeLicense, packages, licenseCatalog }) {
  const sections = [
    "Analogy Embedding Runtime Pack — Third-Party Notices",
    "",
    "This file covers Node.js and every package distributed in the reviewed text-only runtime.",
    "Package entries without a shipped license file retain their registry-declared SPDX license identifier.",
    "",
    `===== Node.js ${nodeAsset.nodeVersion} =====`,
    `Source: https://nodejs.org/dist/v${nodeAsset.nodeVersion}/`,
    "License file: node/LICENSE",
    "",
    nodeLicense.trimEnd(),
  ];

  for (const { directory, metadata } of packages) {
    const licenseFiles = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^(licen[cs]e|notice|copying|copyright)(\.|$)/i.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareUtf8ByteOrder);
    const declaredLicense = typeof metadata.license === "string"
      ? metadata.license
      : JSON.stringify(metadata.license ?? "not declared");
    sections.push(
      "",
      `===== ${metadata.name}@${metadata.version} =====`,
      `Declared license: ${declaredLicense}`,
      `Source: ${repositoryUrl(metadata)}`,
    );
    if (licenseFiles.length === 0) {
      sections.push("License file: not included in the published npm tarball; see declared license above.");
    } else {
      for (const licenseFile of licenseFiles) {
        sections.push("", `----- ${licenseFile} -----`, fs.readFileSync(path.join(directory, licenseFile), "utf8").trimEnd());
      }
    }
  }
  const ort = licenseCatalog.catalog.entries.find((entry) => entry.component === "onnxruntime" && entry.version === "1.26.0");
  if (!ort || ort.files.length !== 2) throw new Error("Reviewed ONNX Runtime license catalog entry is incomplete");
  sections.push("", "===== onnxruntime@1.26.0 — upstream native notices =====");
  for (const entry of ort.files) {
    sections.push("", `----- ${path.basename(entry.path)} -----`, licenseCatalog.texts.get(entry.path).trimEnd());
  }
  return `${sections.join("\n")}\n`;
}

async function collectFileHashes(root, relativeDirectory = "") {
  const files = [];
  const directory = path.join(root, relativeDirectory);
  for (const entry of (await fs.promises.readdir(directory, { withFileTypes: true }))
    .sort((left, right) => compareUtf8ByteOrder(left.name, right.name))) {
    const relativePath = path.posix.join(relativeDirectory.split(path.sep).join("/"), entry.name);
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const stat = await fs.promises.lstat(absolutePath);
    if (stat.isSymbolicLink()) throw new Error(`Runtime pack cannot contain symbolic links: ${relativePath}`);
    if (stat.isDirectory()) {
      files.push(...await collectFileHashes(root, relativePath));
    } else if (stat.isFile() && relativePath !== "manifest.json") {
      files.push({ path: relativePath, size: stat.size, sha256: await sha256File(absolutePath) });
    }
  }
  return relativeDirectory ? files : files.sort((left, right) => compareUtf8ByteOrder(left.path, right.path));
}

async function normalizePackMetadata(root, executableRelativePath) {
  const visit = async (directory, relativeDirectory = "") => {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const stat = await fs.promises.lstat(entryPath);
      if (stat.isSymbolicLink()) throw new Error(`Runtime pack cannot contain symbolic links: ${relativePath}`);
      if (stat.isDirectory()) {
        await visit(entryPath, relativePath);
        await fs.promises.chmod(entryPath, 0o755);
      } else if (stat.isFile()) {
        await fs.promises.chmod(entryPath, relativePath === executableRelativePath ? 0o755 : 0o644);
      } else {
        throw new Error(`Runtime pack contains an unsupported filesystem entry: ${relativePath}`);
      }
      await fs.promises.utimes(entryPath, NORMALIZED_MTIME, NORMALIZED_MTIME);
    }
  };
  await visit(root);
  await fs.promises.chmod(root, 0o755);
  await fs.promises.utimes(root, NORMALIZED_MTIME, NORMALIZED_MTIME);
}

async function createArchive(packParent, packRoot, archivePath, archiveKind, pinnedNodeExecutable) {
  const result = await runExecutable(pinnedNodeExecutable, [
    ARCHIVE_WRITER_PATH,
    "--pack-parent", packParent,
    "--pack-root", packRoot,
    "--kind", archiveKind,
    "--output", archivePath,
  ], { cwd: EXTENSION_ROOT, env: {}, timeout: 300_000 });
  const metadata = JSON.parse(result.stdout.trim());
  if (metadata.node !== "v22.23.2" || typeof metadata.zlib !== "string" || !metadata.zlib
    || !Number.isSafeInteger(metadata.bytes) || metadata.bytes <= 0) {
    throw new Error("Pinned archive writer returned unexpected tool metadata");
  }
  return metadata;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const runner = detectNativeRunner();
  if (options.platform !== process.platform || options.arch !== process.arch) {
    throw new Error(
      `Refusing cross-platform build: requested ${options.platform}-${options.arch}, host is ${process.platform}-${process.arch}`,
    );
  }

  const nodeCatalog = readJson(NODE_ASSETS_PATH);
  if (options["node-version"] !== nodeCatalog.nodeVersion) {
    throw new Error(`Unsupported Node version ${options["node-version"]}; reviewed version is ${nodeCatalog.nodeVersion}`);
  }
  const platformKey = `${options.platform}-${options.arch}`;
  const nodeAsset = nodeCatalog.assets.find((asset) => asset.platformKey === platformKey);
  if (!nodeAsset) throw new Error(`Unsupported native runtime target: ${platformKey}`);
  let verifiedOrtNativeOverlay = null;
  if (options["ort-native-overlay"]) {
    verifiedOrtNativeOverlay = await verifyOrtNativeOverlay(options["ort-native-overlay"], platformKey);
  } else if (platformKey === "darwin-x64") {
    throw new Error(
      "onnxruntime-node@1.26.0 does not publish darwin-x64 native files; provide --ort-native-overlay from the pinned v1.26.0 source build",
    );
  }
  const officialPrefix = `https://nodejs.org/dist/v${nodeCatalog.nodeVersion}/`;
  if (!nodeAsset.url.startsWith(officialPrefix) || nodeAsset.url.includes("latest")) {
    throw new Error(`Node asset URL is not pinned to ${officialPrefix}`);
  }

  const runtimePackage = readJson(PACKAGE_JSON_PATH);
  const runtimeLock = readJson(PACKAGE_LOCK_PATH);
  validateRuntimeLockfile(runtimeLock, EXPECTED_RUNTIME_DEPENDENCIES);
  if (JSON.stringify(runtimePackage.dependencies) !== JSON.stringify(EXPECTED_RUNTIME_DEPENDENCIES)) {
    throw new Error("Runtime dependencies must remain exactly @huggingface/transformers@4.2.0 and onnxruntime-node@1.26.0");
  }

  const outputRoot = path.resolve(EXTENSION_ROOT, options.output);
  const cacheRoot = path.join(outputRoot, ".cache");
  const workRoot = path.join(outputRoot, `.build-${platformKey}-${process.pid}`);
  const packParent = path.join(workRoot, "pack");
  const packRoot = path.join(packParent, PACK_ROOT_NAME);
  const nodeExtractRoot = path.join(workRoot, "node-extract");
  const npmInstallRoot = path.join(workRoot, "npm-install");
  const archiveKind = options.platform === "win32" ? "zip" : "tar.gz";
  const archiveName = `analogy-embedding-runtime-${RUNTIME_VERSION}-${platformKey}.${archiveKind}`;
  const publicationStage = path.join(workRoot, "publication");
  const archivePath = path.join(publicationStage, archiveName);
  const nodeArchivePath = path.join(cacheRoot, nodeAsset.fileName);

  await fs.promises.mkdir(cacheRoot, { recursive: true });
  await fs.promises.rm(workRoot, { recursive: true, force: true });
  await fs.promises.mkdir(packRoot, { recursive: true });
  await fs.promises.mkdir(publicationStage, { recursive: true, mode: 0o700 });
  try {
    await downloadPinnedAsset(nodeAsset, nodeArchivePath);
    await extractNodeArchive(nodeArchivePath, nodeAsset, nodeExtractRoot);

    const extractedNodeRoot = path.join(nodeExtractRoot, nodeAsset.fileName.replace(/\.(?:tar\.gz|zip)$/, ""));
    const nodeExecutableSource = path.join(extractedNodeRoot, ...nodeAsset.executableRelativePath.split("/"));
    const nodeLicenseSource = path.join(extractedNodeRoot, "LICENSE");
    const bundledToolDirectory = options.platform === "win32" ? extractedNodeRoot : path.join(extractedNodeRoot, "bin");
    const bundledNpmCli = options.platform === "win32"
      ? path.join(extractedNodeRoot, "node_modules", "npm", "bin", "npm-cli.js")
      : path.join(extractedNodeRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    if (!fs.existsSync(nodeExecutableSource) || !fs.existsSync(nodeLicenseSource) || !fs.existsSync(bundledNpmCli)) {
      throw new Error(`Official Node archive ${nodeAsset.fileName} is missing its executable, npm CLI, or LICENSE`);
    }
    const nodeDirectory = path.join(packRoot, "node");
    const nodeBinDirectory = path.join(nodeDirectory, "bin");
    const packagedNodeName = options.platform === "win32" ? "node.exe" : "node";
    const packagedNodePath = path.join(nodeBinDirectory, packagedNodeName);
    await fs.promises.mkdir(nodeBinDirectory, { recursive: true });
    await fs.promises.copyFile(nodeExecutableSource, packagedNodePath);
    if (options.platform !== "win32") await fs.promises.chmod(packagedNodePath, 0o755);
    await fs.promises.copyFile(nodeLicenseSource, path.join(nodeDirectory, "LICENSE"));

    const nodeProbe = await runExecutable(packagedNodePath, ["-p", "process.version + ' ' + process.platform + '-' + process.arch"]);
    const expectedProbe = `v${nodeCatalog.nodeVersion} ${platformKey}`;
    if (nodeProbe.stdout.trim() !== expectedProbe) {
      throw new Error(`Packaged Node probe mismatch: expected ${expectedProbe}, got ${nodeProbe.stdout.trim()}`);
    }
    const archiveToolVersions = JSON.parse((await runExecutable(packagedNodePath, [
      "-p", "JSON.stringify({node:process.version,zlib:process.versions.zlib})",
    ])).stdout.trim());
    if (archiveToolVersions.node !== `v${nodeCatalog.nodeVersion}` || typeof archiveToolVersions.zlib !== "string") {
      throw new Error("Packaged Node did not report the reviewed archive tool versions");
    }

    await fs.promises.mkdir(npmInstallRoot, { recursive: true });
    await writePrivateFile(path.join(npmInstallRoot, "empty-npmrc"), Buffer.alloc(0));
    await writePrivateFile(path.join(npmInstallRoot, "empty-global-npmrc"), Buffer.alloc(0));
    await fs.promises.copyFile(PACKAGE_JSON_PATH, path.join(npmInstallRoot, "package.json"));
    await fs.promises.copyFile(PACKAGE_LOCK_PATH, path.join(npmInstallRoot, "package-lock.json"));
    await runExecutable(packagedNodePath, [
      bundledNpmCli,
      "ci",
      "--ignore-scripts=true",
      "--omit=optional",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org",
    ], {
      cwd: npmInstallRoot,
      env: sanitizedNpmEnvironment({ bundledToolDirectory, privateRoot: npmInstallRoot, cacheRoot: path.join(workRoot, "npm-private") }),
      timeout: 420_000,
    });

    const installedNodeModules = path.join(npmInstallRoot, "node_modules");
    if (verifiedOrtNativeOverlay) {
      const installedOrtPackage = readJson(path.join(installedNodeModules, "onnxruntime-node", "package.json"));
      if (installedOrtPackage.version !== "1.26.0") {
        throw new Error(`ORT native overlay requires onnxruntime-node@1.26.0, got ${installedOrtPackage.version}`);
      }
      await installOrtNativeOverlay(
        verifiedOrtNativeOverlay,
        path.join(installedNodeModules, "onnxruntime-node", "bin", "napi-v6", "darwin", "x64"),
      );
    }
    await pruneRuntimeTree(installedNodeModules, options.platform, options.arch);
    const transformersPackage = readJson(path.join(installedNodeModules, "@huggingface", "transformers", "package.json"));
    const onnxRuntimePackage = readJson(path.join(installedNodeModules, "onnxruntime-node", "package.json"));
    if (transformersPackage.version !== "4.2.0" || onnxRuntimePackage.version !== "1.26.0") {
      throw new Error(`Installed runtime version mismatch: transformers=${transformersPackage.version}, onnxruntime-node=${onnxRuntimePackage.version}`);
    }

    const installedPackages = collectInstalledPackages(installedNodeModules);
    const licenseCatalog = loadVerifiedLicenseCatalog();
    const notices = renderThirdPartyNotices({
      nodeAsset: { ...nodeAsset, nodeVersion: nodeCatalog.nodeVersion },
      nodeLicense: fs.readFileSync(nodeLicenseSource, "utf8"),
      packages: installedPackages,
      licenseCatalog,
    });
    await fs.promises.writeFile(path.join(packRoot, "THIRD_PARTY_NOTICES.txt"), notices, "utf8");
    await fs.promises.rename(installedNodeModules, path.join(packRoot, "node_modules"));

    const files = await collectFileHashes(packRoot);
    const internalManifest = {
      schemaVersion: 1,
      id: `embedding-runtime-${RUNTIME_VERSION}-${platformKey}`,
      kind: "embedding-runtime",
      platform: platformKey,
      version: RUNTIME_VERSION,
      runtimeVersions: {
        node: nodeCatalog.nodeVersion,
        transformers: "4.2.0",
        onnxruntime: "1.26.0",
      },
      executableRelativePath: `node/bin/${packagedNodeName}`,
      moduleRootRelativePath: "node_modules",
      noticesRelativePath: "THIRD_PARTY_NOTICES.txt",
      inputs: {
        node: {
          url: nodeAsset.url,
          size: nodeAsset.size,
          sha256: nodeAsset.sha256,
        },
        packageLockSha256: await sha256File(PACKAGE_LOCK_PATH),
        licenseCatalog: {
          sha256: licenseCatalog.sha256,
          noticesSha256: crypto.createHash("sha256").update(notices, "utf8").digest("hex"),
        },
        builder: {
          implementation: "scripts/runtime-archive.mjs",
          archiveWriterSha256: await sha256File(ARCHIVE_WRITER_PATH),
          archiveImplementationSha256: await sha256File(path.join(SCRIPT_DIRECTORY, "runtime-archive.mjs")),
          node: archiveToolVersions.node,
          zlib: archiveToolVersions.zlib,
          runner,
        },
        ...(verifiedOrtNativeOverlay ? { onnxruntimeNativeOverlay: verifiedOrtNativeOverlay.provenance } : {}),
      },
      packages: installedPackages.map(({ metadata }) => ({
        name: metadata.name,
        version: metadata.version,
        license: metadata.license ?? null,
      })),
      files,
    };
    await fs.promises.writeFile(path.join(packRoot, "manifest.json"), `${JSON.stringify(internalManifest, null, 2)}\n`, "utf8");

    await normalizePackMetadata(packRoot, internalManifest.executableRelativePath);
    const writtenToolVersions = await createArchive(packParent, packRoot, archivePath, archiveKind, packagedNodePath);
    if (writtenToolVersions.node !== archiveToolVersions.node || writtenToolVersions.zlib !== archiveToolVersions.zlib) {
      throw new Error("Archive writer tool versions changed during the build");
    }
    const manifestName = `${archiveName}.manifest.json`;
    const noticesName = `${archiveName}.THIRD_PARTY_NOTICES.txt`;
    await writePrivateFile(path.join(publicationStage, manifestName), await fs.promises.readFile(path.join(packRoot, "manifest.json")));
    await writePrivateFile(path.join(publicationStage, noticesName), await fs.promises.readFile(path.join(packRoot, "THIRD_PARTY_NOTICES.txt")));
    await fsyncDirectory(publicationStage);
    await publishBuiltGroup(outputRoot, platformKey, publicationStage, { archive: archiveName, manifest: manifestName, notices: noticesName });
    const publishedArchivePath = path.join(outputRoot, archiveName);
    const archiveStat = await fs.promises.stat(publishedArchivePath);
    const archiveSha256 = await sha256File(publishedArchivePath);
    console.log(`[embedding-runtime] Built ${archiveName} (${archiveStat.size} bytes, sha256 ${archiveSha256}); native smoke attestation and completion marker are still required`);
  } finally {
    await fs.promises.rm(workRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[embedding-runtime] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
