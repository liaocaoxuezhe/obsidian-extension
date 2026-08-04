import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareUtf8Bytes, readRuntimeArchive } from "./runtime-archive.mjs";
import { validateMachOImage } from "./runtime-native-binary.mjs";
import { validateOrtNativeOverlayPayload } from "./runtime-native-overlay.mjs";
import { verifyNativeSmokeBundle } from "./runtime-smoke-attestation.mjs";

export const RUNTIME_VERSION = "node22-v1";
export const PACK_ROOT_NAME = `analogy-embedding-runtime-${RUNTIME_VERSION}`;
export const RUNTIME_VERSIONS = Object.freeze({
  node: "22.23.2",
  transformers: "4.2.0",
  onnxruntime: "1.26.0",
});
export const EXPECTED_PACKS = Object.freeze([
  Object.freeze({ platform: "darwin-arm64", fileName: "analogy-embedding-runtime-node22-v1-darwin-arm64.tar.gz", archive: "tar.gz", internalExecutableRelativePath: "node/bin/node" }),
  Object.freeze({ platform: "darwin-x64", fileName: "analogy-embedding-runtime-node22-v1-darwin-x64.tar.gz", archive: "tar.gz", internalExecutableRelativePath: "node/bin/node" }),
  Object.freeze({ platform: "win32-x64", fileName: "analogy-embedding-runtime-node22-v1-win32-x64.zip", archive: "zip", internalExecutableRelativePath: "node/bin/node.exe" }),
]);
export const LICENSE_CATALOG_SHA256 = "71793f921ffbb1f286175e7823a842f0a8d1c92941702a759dbcd8aa348e2eaa";
export const SMOKE_MODEL_CATALOG_SHA256 = "5766162e4e8fd00d395a01a2359baa533137be10d5612176c9cae1d9576be9b2";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_PACKAGE_ROOT = path.resolve(SCRIPT_DIRECTORY, "..", "runtime-package");
const LICENSE_CATALOG_PATH = path.join(RUNTIME_PACKAGE_ROOT, "license-catalog.json");
const SMOKE_MODEL_PATH = path.join(RUNTIME_PACKAGE_ROOT, "smoke-model.json");
const NODE_ASSETS_PATH = path.join(RUNTIME_PACKAGE_ROOT, "node-assets.json");
const PACKAGE_LOCK_PATH = path.join(RUNTIME_PACKAGE_ROOT, "package-lock.json");
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function sha256File(filename) {
  return sha256Bytes(fs.readFileSync(filename));
}

function readJsonBytes(value, label) {
  try {
    return JSON.parse(value.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireRegularFile(filename, label) {
  if (!fs.existsSync(filename)) throw new Error(`Missing ${label}: ${path.basename(filename)}`);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${path.basename(filename)}`);
  return stat;
}

function assertExactObject(value, expected, label) {
  if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error(`${label} mismatch`);
}

function assertManifestPath(value, label) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/")
    || path.posix.normalize(value) !== value || value.split("/").some((part) => part === ".." || part === "." || !part)) {
    throw new Error(`${label} must be a canonical portable relative path`);
  }
}

function parsePe(data, expectedKind, label) {
  if (data.length < 0x100 || data[0] !== 0x4d || data[1] !== 0x5a) throw new Error(`${label} must be a complete PE32+ image`);
  const peOffset = data.readUInt32LE(0x3c);
  if (peOffset < 0x40 || peOffset + 24 > data.length || data.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error(`${label} has an invalid PE header`);
  }
  if (data.readUInt16LE(peOffset + 4) !== 0x8664) throw new Error(`${label} PE machine is not x86_64`);
  const sectionCount = data.readUInt16LE(peOffset + 6);
  const optionalSize = data.readUInt16LE(peOffset + 20);
  const characteristics = data.readUInt16LE(peOffset + 22);
  const optionalOffset = peOffset + 24;
  if (sectionCount === 0 || sectionCount > 96 || optionalSize < 112 || optionalOffset + optionalSize > data.length
    || data.readUInt16LE(optionalOffset) !== 0x20b || (characteristics & 0x0002) === 0) {
    throw new Error(`${label} has an incomplete PE32+ executable header`);
  }
  const isDll = (characteristics & 0x2000) !== 0;
  if ((expectedKind === "exe" && isDll) || (expectedKind === "dll" && !isDll)) throw new Error(`${label} PE file kind mismatch`);
  const sectionOffset = optionalOffset + optionalSize;
  if (sectionOffset + sectionCount * 40 > data.length) throw new Error(`${label} PE section table is truncated`);
  let fileBackedBytes = 0;
  for (let index = 0; index < sectionCount; index += 1) {
    const cursor = sectionOffset + index * 40;
    const rawSize = data.readUInt32LE(cursor + 16);
    const rawOffset = data.readUInt32LE(cursor + 20);
    if (rawSize > 0 && (rawOffset < sectionOffset + sectionCount * 40 || rawOffset + rawSize > data.length)) {
      throw new Error(`${label} PE section exceeds file bounds`);
    }
    fileBackedBytes += rawSize;
  }
  if (fileBackedBytes === 0) throw new Error(`${label} has no real file-backed PE body`);
}

export function validateNativeBinary(data, platform, relativePath, kind) {
  if (platform.startsWith("darwin-")) {
    const arch = platform.slice("darwin-".length);
    validateMachOImage(data, arch, kind === "node" ? 2 : kind === "binding" ? [6, 8] : 6, relativePath);
  } else if (platform === "win32-x64") {
    parsePe(data, kind === "node" ? "exe" : "dll", relativePath);
  } else {
    throw new Error(`Unsupported native platform: ${platform}`);
  }
}

function verifiedCatalog() {
  const bytes = fs.readFileSync(LICENSE_CATALOG_PATH);
  if (sha256Bytes(bytes) !== LICENSE_CATALOG_SHA256) throw new Error("Repository license catalog hash mismatch");
  const catalog = readJsonBytes(bytes, "license catalog");
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.entries)) throw new Error("Repository license catalog schema mismatch");
  for (const entry of catalog.entries) {
    for (const file of entry.files || []) {
      assertManifestPath(file.path, "license catalog path");
      const filename = path.join(RUNTIME_PACKAGE_ROOT, ...file.path.split("/"));
      requireRegularFile(filename, "catalog license text");
      if (!SHA256_PATTERN.test(file.sha256 || "") || sha256File(filename) !== file.sha256) {
        throw new Error(`Catalog license hash mismatch: ${file.path}`);
      }
    }
  }
  const ort = catalog.entries.find((entry) => entry.component === "onnxruntime" && entry.version === "1.26.0");
  if (!ort || JSON.stringify(ort.files.map((file) => path.basename(file.path))) !== JSON.stringify([
    "onnxruntime-1.26.0-LICENSE.txt",
    "onnxruntime-1.26.0-ThirdPartyNotices.txt",
  ])) throw new Error("License catalog lacks the exact ONNX Runtime 1.26.0 license set");
  const libvips = catalog.entries.find((entry) => entry.component === "libvips" && entry.version === "8.17.3");
  if (!libvips || !libvips.files.some((file) => file.path.endsWith("-LICENSE.txt"))
    || !libvips.files.some((file) => file.path.endsWith("-SOURCE-OFFER.txt"))) {
    throw new Error("License catalog lacks the libvips LGPL text and source offer");
  }
  return { catalog, bytes };
}

function verifiedSmokeModel() {
  const bytes = fs.readFileSync(SMOKE_MODEL_PATH);
  if (sha256Bytes(bytes) !== SMOKE_MODEL_CATALOG_SHA256) throw new Error("Smoke model catalog hash mismatch");
  const model = readJsonBytes(bytes, "smoke model catalog");
  if (model.schemaVersion !== 1 || model.modelId !== "hf-internal-testing/tiny-random-BertModel"
    || model.revision !== "fc08ad9cc33be9aef4f55cc80e16ef5ae3d5981c" || model.dtype !== "fp32"
    || !Array.isArray(model.files) || model.files.length !== 4) throw new Error("Smoke model catalog schema mismatch");
  return { model, bytes };
}

function fileMapFromEntries(entries) {
  const root = entries.find((entry) => entry.path === PACK_ROOT_NAME);
  if (!root?.directory) throw new Error(`Runtime pack must have the fixed root ${PACK_ROOT_NAME}`);
  const map = new Map();
  for (const entry of entries) {
    if (entry.path !== PACK_ROOT_NAME && !entry.path.startsWith(`${PACK_ROOT_NAME}/`)) throw new Error(`Archive entry escapes fixed root: ${entry.path}`);
    if (entry.directory) continue;
    const relativePath = entry.path.slice(PACK_ROOT_NAME.length + 1);
    if (!relativePath) throw new Error("Runtime pack root cannot be a file");
    map.set(relativePath, entry);
  }
  return map;
}

function validateManifestFiles(manifest, files, expected) {
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error(`Internal manifest has no payload list for ${expected.fileName}`);
  const paths = [];
  const declared = new Map();
  for (const entry of manifest.files) {
    assertManifestPath(entry?.path, "manifest file path");
    if (declared.has(entry.path)) throw new Error(`Duplicate manifest payload: ${entry.path}`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !SHA256_PATTERN.test(entry.sha256 || "")) {
      throw new Error(`Invalid manifest payload metadata: ${entry.path}`);
    }
    declared.set(entry.path, entry);
    paths.push(entry.path);
  }
  if (JSON.stringify(paths) !== JSON.stringify([...paths].sort(compareUtf8Bytes))) {
    throw new Error("Manifest payload list must be sorted by UTF-8 bytes");
  }
  const actualPaths = [...files.keys()].filter((entry) => entry !== "manifest.json").sort(compareUtf8Bytes);
  if (JSON.stringify(paths) !== JSON.stringify(actualPaths)) throw new Error("Manifest payload list is not the unique complete archive payload set");
  for (const relativePath of actualPaths) {
    const payload = files.get(relativePath).data;
    const metadata = declared.get(relativePath);
    if (payload.length !== metadata.size || sha256Bytes(payload) !== metadata.sha256) throw new Error(`Archive payload hash mismatch: ${relativePath}`);
    if (/(?:^|\/)(?:\.cache|\.npm|_cacache|model-cache|models--[^/]+|checkpoints?)(?:\/|$)/i.test(relativePath)
      || /\.(?:map|onnx|onnx_data|safetensors)$/i.test(relativePath)) {
      throw new Error(`Forbidden cache, model, source-map, or weight payload: ${relativePath}`);
    }
  }
}

function packageJson(files, packagePath, expectedVersion) {
  const candidates = [...files.keys()].filter((name) => name === packagePath || name.endsWith(`/node_modules/${packagePath}`));
  if (candidates.length !== 1) throw new Error(`Expected exactly one ${packagePath} payload`);
  const metadata = readJsonBytes(files.get(candidates[0]).data, packagePath);
  if (metadata.version !== expectedVersion) throw new Error(`${packagePath} version must be ${expectedVersion}`);
  return candidates[0];
}

function validateRuntimePayload(manifest, files, expected) {
  packageJson(files, "node_modules/@huggingface/transformers/package.json", "4.2.0");
  packageJson(files, "node_modules/onnxruntime-node/package.json", "1.26.0");
  packageJson(files, "node_modules/sharp/package.json", "0.0.0-analogy-disabled");
  const sharpFiles = [...files.keys()].filter((name) => name.startsWith("node_modules/sharp/"));
  if (JSON.stringify(sharpFiles.sort(compareUtf8Bytes)) !== JSON.stringify([
    "node_modules/sharp/index.js",
    "node_modules/sharp/package.json",
  ])) throw new Error("Text-only sharp shim payload is not the fixed fail-closed implementation");
  if (!files.get("node_modules/sharp/index.js").data.toString("utf8").includes("Image processing is disabled")) {
    throw new Error("Text-only sharp shim does not fail closed");
  }
  const forbiddenPackages = [
    "node_modules/@img/", "node_modules/adm-zip/", "node_modules/onnxruntime-web/", "node_modules/global-agent/",
  ];
  for (const relativePath of files.keys()) {
    if (forbiddenPackages.some((prefix) => relativePath.startsWith(prefix))
      || /^node_modules\/onnxruntime-node\/(?:script|tools?)\//.test(relativePath)) {
      throw new Error(`Forbidden production runtime package payload: ${relativePath}`);
    }
  }
  if (!files.has("node_modules/@huggingface/transformers/dist/transformers.node.cjs")
    || !files.has("node_modules/onnxruntime-node/dist/backend.js")) {
    throw new Error("Required Transformers/ONNX Runtime Node worker backend was incorrectly pruned");
  }
  const transformerFiles = [...files.keys()].filter((name) => name.startsWith("node_modules/@huggingface/transformers/"));
  if (transformerFiles.some((name) => name.startsWith("node_modules/@huggingface/transformers/src/")
    || name.startsWith("node_modules/@huggingface/transformers/types/")
    || (name.startsWith("node_modules/@huggingface/transformers/dist/")
      && name !== "node_modules/@huggingface/transformers/dist/transformers.node.cjs"))) {
    throw new Error("Transformers web/WASM/types/source payload survived the text-only production prune");
  }
  const allowedRoots = [
    "node_modules/@huggingface/jinja/",
    "node_modules/@huggingface/tokenizers/",
    "node_modules/@huggingface/transformers/",
    "node_modules/onnxruntime-common/",
    "node_modules/onnxruntime-node/",
    "node_modules/sharp/",
  ];
  for (const name of files.keys()) {
    if (name.startsWith("node_modules/") && !allowedRoots.some((root) => name.startsWith(root))) {
      throw new Error(`Unexpected extra node_modules payload: ${name}`);
    }
  }
  const expectedPackageRoots = new Map([
    ["node_modules/@huggingface/jinja/package.json", ["@huggingface/jinja", "0.5.9"]],
    ["node_modules/@huggingface/tokenizers/package.json", ["@huggingface/tokenizers", "0.1.3"]],
    ["node_modules/@huggingface/transformers/package.json", ["@huggingface/transformers", "4.2.0"]],
    ["node_modules/onnxruntime-common/package.json", ["onnxruntime-common", "1.26.0"]],
    ["node_modules/onnxruntime-node/package.json", ["onnxruntime-node", "1.26.0"]],
    ["node_modules/sharp/package.json", ["sharp", "0.0.0-analogy-disabled"]],
  ]);
  for (const [packagePath, [name, version]] of expectedPackageRoots) {
    const entry = files.get(packagePath);
    const metadata = entry ? readJsonBytes(entry.data, packagePath) : null;
    if (metadata?.name !== name || metadata?.version !== version) {
      throw new Error(`Runtime pack package identity mismatch: ${packagePath}`);
    }
  }
  const nodePath = manifest.executableRelativePath;
  const node = files.get(nodePath);
  if (!node) throw new Error(`Missing packaged Node executable: ${nodePath}`);
  validateNativeBinary(node.data, expected.platform, nodePath, "node");
  const nativePrefix = `node_modules/onnxruntime-node/bin/napi-v6/${expected.platform.replace("-", "/")}/`;
  const nativeFiles = [...files.keys()].filter((name) => name.startsWith("node_modules/onnxruntime-node/bin/napi-v6/"));
  if (nativeFiles.length < 2 || nativeFiles.some((name) => !name.startsWith(nativePrefix))) {
    throw new Error(`Runtime must contain only the unique ONNX Runtime native payload for ${expected.platform}`);
  }
  const binding = nativeFiles.filter((name) => name.endsWith("/onnxruntime_binding.node"));
  const libraries = nativeFiles.filter((name) => expected.platform.startsWith("darwin-") ? name.endsWith(".dylib") : name.endsWith(".dll"));
  if (binding.length !== 1 || libraries.length === 0) throw new Error(`ONNX Runtime native payload is incomplete for ${expected.platform}`);
  validateNativeBinary(files.get(binding[0]).data, expected.platform, binding[0], "binding");
  for (const library of libraries) validateNativeBinary(files.get(library).data, expected.platform, library, "library");
}

function validateBuildInputs(manifest, expected) {
  const inputs = manifest.inputs;
  const nodeCatalog = JSON.parse(fs.readFileSync(NODE_ASSETS_PATH, "utf8"));
  const nodeAsset = nodeCatalog.assets.find((entry) => entry.platformKey === expected.platform);
  if (nodeCatalog.nodeVersion !== RUNTIME_VERSIONS.node || !nodeAsset
    || JSON.stringify(inputs?.node) !== JSON.stringify({ url: nodeAsset.url, size: nodeAsset.size, sha256: nodeAsset.sha256 })) {
    throw new Error(`Internal manifest does not bind the reviewed Node input for ${expected.platform}`);
  }
  if (inputs?.packageLockSha256 !== sha256File(PACKAGE_LOCK_PATH)) throw new Error("Internal manifest package lock hash mismatch");
  const builder = inputs?.builder;
  if (builder?.implementation !== "scripts/runtime-archive.mjs" || builder?.node !== `v${RUNTIME_VERSIONS.node}`
    || typeof builder?.zlib !== "string" || !/^\d+\.\d+(?:\.\d+)?/.test(builder.zlib)
    || builder?.archiveWriterSha256 !== sha256File(path.join(SCRIPT_DIRECTORY, "write-runtime-archive.mjs"))
    || builder?.archiveImplementationSha256 !== sha256File(path.join(SCRIPT_DIRECTORY, "runtime-archive.mjs"))) {
    throw new Error("Internal manifest does not bind the pinned Node archive builder and implementation");
  }
  const expectedOs = expected.platform.startsWith("darwin-") ? "darwin" : "win32";
  const expectedArch = expected.platform.endsWith("arm64") ? "arm64" : "x64";
  const expectedMachine = expectedArch === "x64" ? "x86_64" : "arm64";
  if (builder.runner?.os !== expectedOs || builder.runner?.processArch !== expectedArch
    || builder.runner?.osMachine !== expectedMachine || builder.runner?.translated !== false) {
    throw new Error(`Runtime build runner is not native ${expected.platform}`);
  }
}

function validateNotices(manifest, notices, catalog) {
  if (!notices.length || notices.includes(0)) throw new Error("THIRD_PARTY_NOTICES must be non-empty UTF-8 text without NUL bytes");
  const rendered = notices.toString("utf8");
  if (!rendered.includes("onnxruntime@1.26.0")) throw new Error("THIRD_PARTY_NOTICES omits ONNX Runtime 1.26.0");
  const ort = catalog.entries.find((entry) => entry.component === "onnxruntime" && entry.version === "1.26.0");
  for (const file of ort.files) {
    const text = fs.readFileSync(path.join(RUNTIME_PACKAGE_ROOT, ...file.path.split("/")), "utf8").trimEnd();
    if (!rendered.includes(text)) throw new Error(`THIRD_PARTY_NOTICES omits catalog text ${file.path}`);
  }
  if (manifest.inputs?.licenseCatalog?.sha256 !== LICENSE_CATALOG_SHA256
    || manifest.inputs?.licenseCatalog?.noticesSha256 !== sha256Bytes(notices)) {
    throw new Error("Internal manifest does not bind the fixed license catalog and notices bytes");
  }
}

function validateSmokeAttestation(attestation, expected, binding, manifest, trustPolicy) {
  if (attestation.schemaVersion !== 1 || attestation.platform !== expected.platform
    || attestation.pack?.fileName !== expected.fileName || attestation.pack?.size !== binding.archiveSize
    || attestation.pack?.sha256 !== binding.archiveSha256
    || attestation.pack?.internalManifestSha256 !== binding.manifestSha256
    || attestation.pack?.noticesSha256 !== binding.noticesSha256) {
    throw new Error(`Native smoke attestation is not bound to ${expected.fileName}`);
  }
  const runner = attestation.runner;
  const expectedOs = expected.platform.startsWith("darwin-") ? "darwin" : "win32";
  const expectedArch = expected.platform.endsWith("arm64") ? "arm64" : "x64";
  const expectedMachine = expectedArch === "x64" ? "x86_64" : "arm64";
  if (runner?.os !== expectedOs || runner?.osMachine !== expectedMachine || runner?.processArch !== expectedArch
    || runner?.translated !== false || runner?.emulated !== false || runner?.environment !== "github-hosted"
    || typeof runner?.image !== "string" || !runner.image || typeof runner?.workflowRunId !== "string" || !runner.workflowRunId) {
    throw new Error(`Native smoke attestation runner is not a non-emulated ${expected.platform} GitHub-hosted runner`);
  }
  if (!Array.isArray(attestation.binaries) || attestation.binaries.length < 3
    || attestation.binaries.some((entry) => typeof entry.path !== "string" || !SHA256_PATTERN.test(entry.sha256 || "") || !Number.isSafeInteger(entry.size) || entry.size <= 0)) {
    throw new Error("Native smoke attestation lacks executable/native binary hashes");
  }
  const expectedBinaries = manifest.files
    .filter((entry) => entry.path === manifest.executableRelativePath
      || (entry.path.startsWith("node_modules/onnxruntime-node/bin/napi-v6/") && /\.(?:node|dylib|dll)$/i.test(entry.path)))
    .map(({ path: binaryPath, size, sha256 }) => ({ path: binaryPath, size, sha256 }))
    .sort((left, right) => compareUtf8Bytes(left.path, right.path));
  const attestedBinaries = [...attestation.binaries].sort((left, right) => compareUtf8Bytes(left.path, right.path));
  if (JSON.stringify(attestedBinaries) !== JSON.stringify(expectedBinaries)) {
    throw new Error("Native smoke binary hashes are not the exact pack executable/native payload set");
  }
  if (attestation.modelCatalogSha256 !== SMOKE_MODEL_CATALOG_SHA256) throw new Error("Native smoke attestation uses an unreviewed model catalog");
  const { model } = verifiedSmokeModel();
  assertExactObject(attestation.model, model, "Native smoke model provenance");
  if (attestation.cache?.freshTemporary !== true || attestation.cache?.persistentCacheUsed !== false
    || attestation.cache?.preexistingEntries !== 0 || typeof attestation.cache?.pathSha256 !== "string"
    || !SHA256_PATTERN.test(attestation.cache.pathSha256)) {
    throw new Error("Native smoke must use a fresh temporary cache and no persistent/main cache");
  }
  if (attestation.result?.health !== "passed" || attestation.result?.inference !== "passed"
    || attestation.result?.vectors !== 1 || !Number.isSafeInteger(attestation.result?.dimensions)
    || attestation.result.dimensions <= 0 || attestation.result?.finite !== true || attestation.result?.normalized !== true) {
    throw new Error("Native smoke result is incomplete or failed");
  }
  if (attestation.provenance?.issuer !== trustPolicy.issuer
    || attestation.provenance?.repository !== trustPolicy.repository
    || attestation.provenance?.workflow !== trustPolicy.workflow
    || attestation.provenance?.workflowRef !== trustPolicy.workflowRef
    || attestation.provenance?.workflowIdentity !== trustPolicy.workflowIdentity
    || !/^[0-9a-f]{40}$/.test(attestation.provenance?.commit || "")
    || !/^[1-9][0-9]*$/.test(attestation.provenance?.runId || "")
    || !Number.isSafeInteger(attestation.provenance?.runAttempt) || attestation.provenance.runAttempt < 1) {
    throw new Error("Native smoke attestation lacks the exact cryptographically-bound GitHub provenance fields");
  }
}

function validateCompletionMarker(marker, expected, groupFiles) {
  if (marker.schemaVersion !== 1 || marker.platform !== expected.platform
    || typeof marker.generationId !== "string" || !/^[0-9a-f]{64}$/.test(marker.generationId)
    || !Array.isArray(marker.files)) throw new Error(`Invalid completion marker for ${expected.platform}`);
  const expectedFiles = [...groupFiles.entries()].map(([name, bytes]) => ({ name, size: bytes.length, sha256: sha256Bytes(bytes) }))
    .sort((left, right) => compareUtf8Bytes(left.name, right.name));
  if (JSON.stringify(marker.files) !== JSON.stringify(expectedFiles)) throw new Error(`Completion marker does not bind one complete artifact generation for ${expected.platform}`);
  const generation = sha256Bytes(Buffer.from(expectedFiles.map((entry) => `${entry.name}\0${entry.size}\0${entry.sha256}\n`).join(""), "utf8"));
  if (marker.generationId !== generation) throw new Error(`Completion marker generation ID mismatch for ${expected.platform}`);
}

export function artifactNames(expected) {
  return {
    manifest: `${expected.fileName}.manifest.json`,
    notices: `${expected.fileName}.THIRD_PARTY_NOTICES.txt`,
    attestation: `${expected.fileName}.smoke-attestation.json`,
    completion: `${expected.fileName}.complete.json`,
  };
}

export function validateRuntimeArtifactGroup(inputRoot, expected, { requireCompletion = true, releaseAsset, trustPolicy } = {}) {
  const names = artifactNames(expected);
  const archivePath = path.join(inputRoot, expected.fileName);
  const manifestPath = path.join(inputRoot, names.manifest);
  const noticesPath = path.join(inputRoot, names.notices);
  const attestationPath = path.join(inputRoot, names.attestation);
  const completionPath = path.join(inputRoot, names.completion);
  const archiveStat = requireRegularFile(archivePath, "runtime pack");
  for (const [filename, label] of [[manifestPath, "runtime internal manifest"], [noticesPath, "runtime THIRD_PARTY_NOTICES"]]) {
    requireRegularFile(filename, label);
  }
  const archiveBytes = fs.readFileSync(archivePath);
  const manifestBytes = fs.readFileSync(manifestPath);
  const noticesBytes = fs.readFileSync(noticesPath);
  const attestationBytes = fs.existsSync(attestationPath) ? fs.readFileSync(attestationPath) : Buffer.alloc(0);
  const binding = {
    archiveSize: archiveBytes.length,
    archiveSha256: sha256Bytes(archiveBytes),
    manifestSha256: sha256Bytes(manifestBytes),
    noticesSha256: sha256Bytes(noticesBytes),
  };
  if (releaseAsset && (releaseAsset.size !== archiveStat.size || releaseAsset.sha256 !== binding.archiveSha256
    || releaseAsset.internalManifestSha256 !== binding.manifestSha256 || releaseAsset.noticesSha256 !== binding.noticesSha256)) {
    throw new Error(`Runtime release manifest hash/size mismatch for ${expected.fileName}`);
  }
  const entries = readRuntimeArchive(archivePath, expected.archive);
  const files = fileMapFromEntries(entries);
  const embeddedManifest = files.get("manifest.json")?.data;
  const embeddedNotices = files.get("THIRD_PARTY_NOTICES.txt")?.data;
  if (!embeddedManifest?.equals(manifestBytes)) throw new Error(`Archive internal manifest bytes do not match sidecar for ${expected.fileName}`);
  if (!embeddedNotices?.equals(noticesBytes)) throw new Error(`Archive notices bytes do not match sidecar for ${expected.fileName}`);
  const manifest = readJsonBytes(manifestBytes, "runtime internal manifest");
  if (manifest.schemaVersion !== 1 || manifest.id !== `embedding-runtime-${RUNTIME_VERSION}-${expected.platform}`
    || manifest.kind !== "embedding-runtime" || manifest.platform !== expected.platform || manifest.version !== RUNTIME_VERSION) {
    throw new Error(`Internal manifest identity mismatch for ${expected.fileName}`);
  }
  assertExactObject(manifest.runtimeVersions, RUNTIME_VERSIONS, `Runtime versions for ${expected.fileName}`);
  if (manifest.executableRelativePath !== expected.internalExecutableRelativePath || manifest.moduleRootRelativePath !== "node_modules"
    || manifest.noticesRelativePath !== "THIRD_PARTY_NOTICES.txt") throw new Error(`Internal runtime paths mismatch for ${expected.fileName}`);
  validateManifestFiles(manifest, files, expected);
  validateBuildInputs(manifest, expected);
  const { catalog } = verifiedCatalog();
  validateNotices(manifest, noticesBytes, catalog);
  validateRuntimePayload(manifest, files, expected);
  const overlay = manifest.inputs?.onnxruntimeNativeOverlay;
  if (expected.platform === "darwin-x64") validateOrtNativeOverlayPayload(overlay, expected.platform, manifest.files);
  else if (overlay !== undefined) throw new Error(`Unexpected ONNX Runtime overlay provenance for ${expected.platform}`);
  requireRegularFile(attestationPath, "runtime native smoke attestation");
  const verifiedAttestationBytes = fs.readFileSync(attestationPath);
  if (!verifiedAttestationBytes.equals(attestationBytes)) throw new Error(`Runtime native smoke attestation changed during validation: ${expected.fileName}`);
  const verifiedProof = verifyNativeSmokeBundle(attestationBytes, {
    expectedFileName: expected.fileName,
    expectedSha256: binding.archiveSha256,
    trustPolicy,
  });
  const attestation = verifiedProof.predicate;
  validateSmokeAttestation(attestation, expected, binding, manifest, verifiedProof.trustPolicy);
  if (requireCompletion) {
    requireRegularFile(completionPath, "runtime completion marker");
    const marker = readJsonBytes(fs.readFileSync(completionPath), "runtime completion marker");
    validateCompletionMarker(marker, expected, new Map([
      [expected.fileName, archiveBytes], [names.manifest, manifestBytes], [names.notices, noticesBytes], [names.attestation, attestationBytes],
    ]));
  }
  return { expected, manifest, attestation, attestationBundle: verifiedProof.bundle, binding, names };
}

export function validateRuntimeMatrix(inputRoot, options = {}) {
  return EXPECTED_PACKS.map((expected) => validateRuntimeArtifactGroup(inputRoot, expected, options));
}
