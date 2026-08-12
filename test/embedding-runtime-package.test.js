"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const zlib = require("node:zlib");
const ts = require("typescript");
const esbuild = require("esbuild");

const repositoryRoot = path.resolve(__dirname, "..");
const extensionRoot = repositoryRoot;
const runtimePackageRoot = path.join(extensionRoot, "runtime-package");
const runtimeOutputRoot = path.join(extensionRoot, "dist", "runtime");
const supportedHost = ["darwin-arm64", "darwin-x64", "win32-x64"].includes(`${process.platform}-${process.arch}`);
const hostPlatformKey = `${process.platform}-${process.arch}`;
const hostArchiveName = `analogy-embedding-runtime-node22-v1-${hostPlatformKey}${process.platform === "win32" ? ".zip" : ".tar.gz"}`;
const hostArchivePath = path.join(runtimeOutputRoot, hostArchiveName);
const loadedTypeScriptModules = new Map();
let extractedPackRoot = "";

function loadTypeScriptFile(filename) {
  if (loadedTypeScriptModules.has(filename)) return loadedTypeScriptModules.get(filename);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  const loadedModule = { exports: {} };
  loadedTypeScriptModules.set(filename, loadedModule.exports);
  const localRequire = (specifier) => {
    if (!specifier.startsWith(".")) return require(specifier);
    const resolved = path.resolve(path.dirname(filename), specifier);
    return fs.existsSync(`${resolved}.ts`) ? loadTypeScriptFile(`${resolved}.ts`) : require(resolved);
  };
  Function("exports", "require", "module", "__filename", "__dirname", output)(
    loadedModule.exports,
    localRequire,
    loadedModule,
    filename,
    path.dirname(filename),
  );
  loadedTypeScriptModules.set(filename, loadedModule.exports);
  return loadedModule.exports;
}

function sha256File(filename) {
  return crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function copyHostRuntimeGroup(destinationRoot) {
  fs.mkdirSync(destinationRoot, { recursive: true });
  for (const suffix of ["", ".manifest.json", ".THIRD_PARTY_NOTICES.txt"]) {
    fs.copyFileSync(`${hostArchivePath}${suffix}`, path.join(destinationRoot, `${hostArchiveName}${suffix}`));
  }
}

function nativeSmokePredicate(groupRoot, expected) {
  const archivePath = path.join(groupRoot, expected.fileName);
  const manifestPath = `${archivePath}.manifest.json`;
  const noticesPath = `${archivePath}.THIRD_PARTY_NOTICES.txt`;
  const manifest = readJson(manifestPath);
  const expectedOs = expected.platform.startsWith("darwin-") ? "darwin" : "win32";
  const expectedArch = expected.platform.endsWith("arm64") ? "arm64" : "x64";
  return {
    schemaVersion: 1,
    platform: expected.platform,
    pack: {
      fileName: expected.fileName,
      size: fs.statSync(archivePath).size,
      sha256: sha256File(archivePath),
      internalManifestSha256: sha256File(manifestPath),
      noticesSha256: sha256File(noticesPath),
    },
    runner: {
      os: expectedOs,
      osMachine: expectedArch === "x64" ? "x86_64" : "arm64",
      processArch: expectedArch,
      translated: false,
      emulated: false,
      environment: "github-hosted",
      image: `${expectedOs}-native-test-image`,
      workflowRunId: "123456789",
    },
    binaries: manifest.files
      .filter((entry) => entry.path === manifest.executableRelativePath
        || (entry.path.startsWith("node_modules/onnxruntime-node/bin/napi-v6/") && /\.(?:node|dylib|dll)$/i.test(entry.path)))
      .map(({ path: binaryPath, size, sha256 }) => ({ path: binaryPath, size, sha256 })),
    modelCatalogSha256: "5766162e4e8fd00d395a01a2359baa533137be10d5612176c9cae1d9576be9b2",
    model: readJson(path.join(runtimePackageRoot, "smoke-model.json")),
    cache: {
      freshTemporary: true,
      persistentCacheUsed: false,
      preexistingEntries: 0,
      pathSha256: "4".repeat(64),
    },
    result: {
      health: "passed",
      inference: "passed",
      vectors: 1,
      dimensions: 32,
      finite: true,
      normalized: true,
    },
    provenance: {
      issuer: "https://token.actions.githubusercontent.com",
      repository: "liaocaoxuezhe/obsidian-extension",
      workflow: ".github/workflows/obsidian-runtime-matrix.yml",
      workflowRef: "liaocaoxuezhe/obsidian-extension/.github/workflows/obsidian-runtime-matrix.yml@refs/heads/main",
      workflowIdentity: "https://github.com/liaocaoxuezhe/obsidian-extension/.github/workflows/obsidian-runtime-matrix.yml@refs/heads/main",
      commit: "a".repeat(40),
      runId: "123456789",
      runAttempt: 1,
    },
  };
}

function dssePae(payloadType, payload) {
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${payload.length} `, "utf8"),
    payload,
  ]);
}

function signedSmokeBundle(predicate, privateKey, publicKey, expected) {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: expected.fileName, digest: { sha256: predicate.pack.sha256 } }],
    predicateType: "https://github.com/liaocaoxuezhe/obsidian-extension/attestations/native-runtime-smoke/v1",
    predicate,
  };
  const payloadType = "application/vnd.in-toto+json";
  const payload = Buffer.from(JSON.stringify(statement), "utf8");
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const keyId = crypto.createHash("sha256").update(publicKeyDer).digest("hex");
  return {
    keyId,
    bundle: {
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      verificationMaterial: { publicKey: { hint: keyId } },
      dsseEnvelope: {
        payloadType,
        payload: payload.toString("base64"),
        signatures: [{ keyid: keyId, sig: crypto.sign(null, dssePae(payloadType, payload), privateKey).toString("base64") }],
      },
    },
    trustPolicy: {
      kind: "public-key",
      keyId,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
      issuer: predicate.provenance.issuer,
      repository: predicate.provenance.repository,
      workflow: predicate.provenance.workflow,
      workflowRef: predicate.provenance.workflowRef,
      workflowIdentity: predicate.provenance.workflowIdentity,
    },
  };
}

function writeThinX64MachO(filename, marker, cpuSubtype = 3) {
  const payload = Buffer.alloc(256);
  payload.writeUInt32LE(0xfeedfacf, 0);
  payload.writeUInt32LE(0x01000007, 4);
  payload.writeUInt32LE(cpuSubtype >>> 0, 8);
  payload.writeUInt32LE(filename.endsWith(".node") ? 8 : 6, 12);
  payload.writeUInt32LE(1, 16);
  payload.writeUInt32LE(72, 20);
  payload.writeUInt32LE(0x19, 32);
  payload.writeUInt32LE(72, 36);
  payload.write("__TEXT", 40, "ascii");
  payload.writeBigUInt64LE(BigInt(payload.length), 56);
  payload.writeBigUInt64LE(0n, 72);
  payload.writeBigUInt64LE(BigInt(payload.length), 80);
  payload.writeUInt32LE(5, 88);
  payload.writeUInt32LE(5, 92);
  payload.write(marker, 104, "utf8");
  fs.writeFileSync(filename, payload);
}

function walkFiles(root, relativeDirectory = "") {
  const files = [];
  const directory = path.join(root, ...relativeDirectory.split("/").filter(Boolean));
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const stat = fs.lstatSync(absolutePath);
    assert.equal(stat.isSymbolicLink(), false, `pack must not contain a symbolic link: ${relativePath}`);
    if (stat.isDirectory()) files.push(...walkFiles(root, relativePath));
    if (stat.isFile()) files.push({ path: relativePath, size: stat.size, sha256: sha256File(absolutePath) });
  }
  return files;
}

function findCachePayload(root, suffix) {
  const normalizedSuffix = suffix.split("/").join(path.sep);
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = visit(filename);
        if (found) return found;
      } else if ((entry.isFile() || entry.isSymbolicLink()) && filename.endsWith(normalizedSuffix)) {
        return entry.isSymbolicLink() ? fs.realpathSync(filename) : filename;
      }
    }
    return "";
  };
  return visit(root);
}

function collectPackagePaths(nodeModulesRoot, relativeDirectory = "node_modules") {
  const packages = [];
  const scan = (directory, relative) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".bin") continue;
      const entryPath = path.join(directory, entry.name);
      const entryRelative = path.posix.join(relative, entry.name);
      if (entry.name.startsWith("@")) {
        scanScope(entryPath, entryRelative);
      } else {
        addPackage(entryPath, entryRelative);
      }
    }
  };
  const scanScope = (directory, relative) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) addPackage(path.join(directory, entry.name), path.posix.join(relative, entry.name));
    }
  };
  const addPackage = (directory, relative) => {
    const packageJsonPath = path.join(directory, "package.json");
    if (!fs.existsSync(packageJsonPath)) return;
    packages.push({ path: relative, directory, metadata: readJson(packageJsonPath) });
    const nested = path.join(directory, "node_modules");
    if (fs.existsSync(nested)) scan(nested, path.posix.join(relative, "node_modules"));
  };
  scan(nodeModulesRoot, relativeDirectory);
  return packages;
}

async function extractBuiltPack() {
  if (extractedPackRoot) return extractedPackRoot;
  const extractionRoot = path.join(runtimeOutputRoot, ".cache", `test-extracted-${hostPlatformKey}`);
  fs.rmSync(extractionRoot, { recursive: true, force: true });
  const extractor = loadTypeScriptFile(path.join(extensionRoot, "src", "runtime", "archive-extractor.ts"));
  await extractor.extractRuntimeArchive({
    archivePath: hostArchivePath,
    archive: process.platform === "win32" ? "zip" : "tar.gz",
    stagingRoot: extractionRoot,
  });
  extractedPackRoot = path.join(extractionRoot, "analogy-embedding-runtime-node22-v1");
  return extractedPackRoot;
}

test.after(() => {
  if (extractedPackRoot) fs.rmSync(path.dirname(extractedPackRoot), { recursive: true, force: true });
});

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function runNativeBuilder(environmentOverrides = {}) {
  const builderArguments = [
    path.join(extensionRoot, "scripts", "build-embedding-runtime.mjs"),
    "--platform", process.platform,
    "--arch", process.arch,
    "--node-version", "22.23.2",
    "--output", runtimeOutputRoot,
  ];
  const overlay = environmentOverrides.ANALOGY_ORT_NATIVE_OVERLAY
    ?? process.env.ANALOGY_ORT_NATIVE_OVERLAY;
  if (hostPlatformKey === "darwin-x64" && overlay) {
    builderArguments.push("--ort-native-overlay", overlay);
  }
  return spawnSync(process.execPath, builderArguments, {
    cwd: extensionRoot,
    encoding: "utf8",
    env: { ...process.env, ...environmentOverrides },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 590_000,
  });
}

function parseUstarMetadata(archivePath) {
  const compressed = fs.readFileSync(archivePath);
  assert.equal(compressed.readUInt32LE(4), 0, "gzip header mtime must be zero");
  const tar = zlib.gunzipSync(compressed);
  const entries = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/, "");
    const octal = (start, length) => Number.parseInt(text(start, length).trim() || "0", 8);
    const name = [text(345, 155), text(0, 100)].filter(Boolean).join("/").replace(/\/$/, "");
    const size = octal(124, 12);
    entries.push({
      name,
      mode: octal(100, 8),
      uid: octal(108, 8),
      gid: octal(116, 8),
      size,
      mtime: octal(136, 12),
      type: text(156, 1) || "0",
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function parseZipMetadata(archivePath) {
  const archive = fs.readFileSync(archivePath);
  let endOffset = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  assert.ok(endOffset >= 0, "zip end-of-central-directory must exist");
  const entryCount = archive.readUInt16LE(endOffset + 10);
  let cursor = archive.readUInt32LE(endOffset + 16);
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    const versionMadeBy = archive.readUInt16LE(cursor + 4);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const rawName = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    entries.push({
      name: rawName.replace(/\/$/, ""),
      creator: versionMadeBy >>> 8,
      dosTime: archive.readUInt16LE(cursor + 12),
      dosDate: archive.readUInt16LE(cursor + 14),
      mode: (externalAttributes >>> 16) & 0o777,
      directory: rawName.endsWith("/"),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test("runtime inputs pin the reviewed Node 22.23.2 assets and every npm tarball integrity", () => {
  const nodeAssetsPath = path.join(runtimePackageRoot, "node-assets.json");
  assert.ok(fs.existsSync(nodeAssetsPath), "node-assets.json must define the reviewed official downloads");

  const runtimePackage = readJson(path.join(runtimePackageRoot, "package.json"));
  const lock = readJson(path.join(runtimePackageRoot, "package-lock.json"));
  const nodeAssets = readJson(nodeAssetsPath);
  const expectedAssets = [
    {
      platform: "darwin",
      arch: "arm64",
      platformKey: "darwin-arm64",
      fileName: "node-v22.23.2-darwin-arm64.tar.gz",
      archive: "tar.gz",
      url: "https://nodejs.org/dist/v22.23.2/node-v22.23.2-darwin-arm64.tar.gz",
      size: 50068815,
      sha256: "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
      executableRelativePath: "bin/node",
    },
    {
      platform: "darwin",
      arch: "x64",
      platformKey: "darwin-x64",
      fileName: "node-v22.23.2-darwin-x64.tar.gz",
      archive: "tar.gz",
      url: "https://nodejs.org/dist/v22.23.2/node-v22.23.2-darwin-x64.tar.gz",
      size: 51246936,
      sha256: "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026",
      executableRelativePath: "bin/node",
    },
    {
      platform: "win32",
      arch: "x64",
      platformKey: "win32-x64",
      fileName: "node-v22.23.2-win-x64.zip",
      archive: "zip",
      url: "https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip",
      size: 35683585,
      sha256: "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97",
      executableRelativePath: "node.exe",
    },
  ];

  assert.deepEqual(runtimePackage.dependencies, {
    "@huggingface/transformers": "4.2.0",
    "onnxruntime-node": "1.26.0",
  });
  assert.deepEqual(lock.packages[""].dependencies, runtimePackage.dependencies);
  assert.equal(nodeAssets.nodeVersion, "22.23.2");
  assert.equal(nodeAssets.shasumsUrl, "https://nodejs.org/dist/v22.23.2/SHASUMS256.txt");
  assert.deepEqual(nodeAssets.assets, expectedAssets);
  assert.equal(new Set(nodeAssets.assets.map((asset) => asset.url)).size, 3);
  assert.equal(new Set(nodeAssets.assets.map((asset) => asset.platformKey)).size, 3);

  const npmTarballs = Object.entries(lock.packages).filter(([packagePath]) => packagePath !== "");
  assert.ok(npmTarballs.length > 0, "lockfile must contain immutable npm tarballs");
  for (const [packagePath, metadata] of npmTarballs) {
    assert.match(
      metadata.resolved || "",
      /^https:\/\/registry\.npmjs\.org\/(?:@[^/]+\/)?[^/]+\/-\/[^/?#]+\.tgz$/,
      `${packagePath} must resolve only to an official registry HTTPS tarball`,
    );
    assert.match(metadata.integrity || "", /^sha512-[A-Za-z0-9+/]+={0,2}$/, `${packagePath} must pin tarball integrity`);
  }
  const onnxRuntimeVersions = Object.entries(lock.packages)
    .filter(([packagePath]) => packagePath.endsWith("node_modules/onnxruntime-node"))
    .map(([, metadata]) => metadata.version);
  assert.deepEqual([...new Set(onnxRuntimeVersions)], ["1.26.0"], "worker resolution must not fall back to a nested ORT version");
});

test("runtime builder rejects an implicit platform or output", () => {
  const script = path.join(extensionRoot, "scripts", "build-embedding-runtime.mjs");
  const result = spawnSync(process.execPath, [script], {
    cwd: extensionRoot,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /Missing required arguments: --platform, --arch, --node-version, --output/);
});

test("runtime builder refuses to label native modules as another platform", () => {
  const script = path.join(extensionRoot, "scripts", "build-embedding-runtime.mjs");
  const foreignTarget = process.platform === "darwin" && process.arch === "arm64"
    ? { platform: "darwin", arch: "x64" }
    : { platform: "darwin", arch: "arm64" };
  const result = spawnSync(process.execPath, [
    script,
    "--platform", foreignTarget.platform,
    "--arch", foreignTarget.arch,
    "--node-version", "22.23.2",
    "--output", "dist/runtime",
  ], {
    cwd: extensionRoot,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}${result.stderr}`,
    new RegExp(`Refusing cross-platform build: requested ${foreignTarget.platform}-${foreignTarget.arch}, host is ${process.platform}-${process.arch}`),
  );
});

test("darwin-x64 ORT source overlay is pinned, hashed, and architecture checked", async () => {
  const overlayRoot = path.join(repositoryRoot, "test", ".runtime", "ort-darwin-x64-overlay");
  const metadataPath = path.join(overlayRoot, "analogy-ort-native-overlay.json");
  const requiredFiles = [
    "libonnxruntime.1.26.0.dylib",
    "libonnxruntime.1.dylib",
    "onnxruntime_binding.node",
  ];
  fs.rmSync(overlayRoot, { recursive: true, force: true });
  fs.mkdirSync(overlayRoot, { recursive: true });
  for (const [index, filename] of requiredFiles.entries()) {
    writeThinX64MachO(path.join(overlayRoot, filename), `fixture-${index}`);
  }
  const metadata = {
    schemaVersion: 1,
    platform: "darwin-x64",
    onnxruntimeVersion: "1.26.0",
    source: {
      repository: "https://github.com/microsoft/onnxruntime",
      tag: "v1.26.0",
      commit: "8c546c37b43caaca1fa25db430dab94b901cf277",
    },
    licenseInput: {
      licenseUrl: "https://raw.githubusercontent.com/microsoft/onnxruntime/v1.26.0/LICENSE",
      licenseSha256: "2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c",
      thirdPartyNoticesUrl: "https://raw.githubusercontent.com/microsoft/onnxruntime/v1.26.0/ThirdPartyNotices.txt",
      thirdPartyNoticesSha256: "0e07b95f3a8d6230037707c5c4a2b554d12c4cb67369669ac255635528ffcee2",
    },
    files: requiredFiles.map((filename) => ({
      path: filename,
      size: fs.statSync(path.join(overlayRoot, filename)).size,
      sha256: sha256File(path.join(overlayRoot, filename)),
    })),
  };
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  const moduleUrl = pathToFileURL(path.join(extensionRoot, "scripts", "runtime-native-overlay.mjs")).href;
  const { verifyOrtNativeOverlay } = await import(moduleUrl);
  const verified = await verifyOrtNativeOverlay(overlayRoot, "darwin-x64");
  assert.deepEqual(verified.provenance, metadata);
  assert.deepEqual(verified.files.map(({ relativePath }) => relativePath), requiredFiles);

  writeThinX64MachO(path.join(overlayRoot, "onnxruntime_binding.node"), "tampered");
  await assert.rejects(
    verifyOrtNativeOverlay(overlayRoot, "darwin-x64"),
    /ORT native overlay SHA-256 mismatch for onnxruntime_binding\.node/,
  );

  writeThinX64MachO(path.join(overlayRoot, "onnxruntime_binding.node"), "fixture-2");
  metadata.files = requiredFiles.map((filename) => ({
    path: filename,
    size: fs.statSync(path.join(overlayRoot, filename)).size,
    sha256: sha256File(path.join(overlayRoot, filename)),
  }));
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  const arm64Binding = Buffer.alloc(32);
  arm64Binding.writeUInt32LE(0xfeedfacf, 0);
  arm64Binding.writeUInt32LE(0x0100000c, 4);
  fs.writeFileSync(path.join(overlayRoot, "onnxruntime_binding.node"), arm64Binding);
  metadata.files = requiredFiles.map((filename) => ({
    path: filename,
    size: fs.statSync(path.join(overlayRoot, filename)).size,
    sha256: sha256File(path.join(overlayRoot, filename)),
  }));
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await assert.rejects(
    verifyOrtNativeOverlay(overlayRoot, "darwin-x64"),
    /ORT native overlay is not a thin x86_64 Mach-O file: onnxruntime_binding\.node/,
  );
});

test("Mach-O validation requires the real x86_64 ALL subtype and parses capability bits", async (t) => {
  const fixtureRoot = path.join(repositoryRoot, "test", ".runtime", "macho-subtype");
  const subtype3Path = path.join(fixtureRoot, "subtype3.node");
  const subtype0Path = path.join(fixtureRoot, "subtype0.node");
  const capabilityPath = path.join(fixtureRoot, "subtype3-lib64.node");
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(fixtureRoot, { recursive: true });
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  writeThinX64MachO(subtype3Path, "subtype-3", 3);
  writeThinX64MachO(subtype0Path, "subtype-0", 0);
  writeThinX64MachO(capabilityPath, "subtype-cap", 0x80000003);

  const officialHeaderHex = fs.readFileSync(
    path.join(repositoryRoot, "test", "fixtures", "node-v22.23.2-darwin-x64-mach-o-header.hex"),
    "utf8",
  ).replace(/\s/g, "");
  const officialHeader = Buffer.from(officialHeaderHex, "hex");
  assert.equal(officialHeader.readUInt32LE(0), 0xfeedfacf);
  assert.equal(officialHeader.readUInt32LE(4), 0x01000007);
  assert.equal(officialHeader.readUInt32LE(8), 3, "official Node 22.23.2 darwin-x64 uses CPU_SUBTYPE_X86_64_ALL");

  const validator = await import(pathToFileURL(path.join(extensionRoot, "scripts", "runtime-package-validator.mjs")).href);
  assert.doesNotThrow(() => validator.validateNativeBinary(fs.readFileSync(subtype3Path), "darwin-x64", "binding.node", "binding"));
  assert.doesNotThrow(() => validator.validateNativeBinary(fs.readFileSync(capabilityPath), "darwin-x64", "binding.node", "binding"));
  assert.throws(
    () => validator.validateNativeBinary(fs.readFileSync(subtype0Path), "darwin-x64", "binding.node", "binding"),
    /CPU subtype/,
  );
});

test("runtime builder only permits the source overlay for darwin-x64", { skip: hostPlatformKey === "darwin-x64" }, () => {
  const script = path.join(extensionRoot, "scripts", "build-embedding-runtime.mjs");
  const result = spawnSync(process.execPath, [
    script,
    "--platform", process.platform,
    "--arch", process.arch,
    "--node-version", "22.23.2",
    "--output", runtimeOutputRoot,
    "--ort-native-overlay", path.join(repositoryRoot, "test", ".runtime", "ort-darwin-x64-overlay"),
  ], { cwd: extensionRoot, encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /ORT native overlay is only supported for darwin-x64/);
});

test("runtime builder creates the fixed native platform archive", { skip: !supportedHost, timeout: 600_000 }, () => {
  fs.mkdirSync(runtimeOutputRoot, { recursive: true });
  fs.rmSync(hostArchivePath, { force: true });
  const result = runNativeBuilder();

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.ok(fs.statSync(hostArchivePath).size > 0, "native runtime archive must not be empty");
  assert.match(result.stdout, new RegExp(`Built ${hostArchiveName.replaceAll(".", "\\.")}`));

  const archiveList = spawnSync("tar", ["-tf", hostArchivePath], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  assert.equal(archiveList.status, 0, archiveList.stderr);
  const entries = archiveList.stdout.split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/\/$/, ""));
  const root = "analogy-embedding-runtime-node22-v1";
  const nativeRoot = `${root}/node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}`;
  assert.ok(entries.includes(`${root}/manifest.json`));
  assert.ok(entries.includes(`${root}/THIRD_PARTY_NOTICES.txt`));
  assert.ok(entries.includes(`${root}/node/bin/${process.platform === "win32" ? "node.exe" : "node"}`));
  assert.ok(entries.includes(`${root}/node_modules/@huggingface/transformers/package.json`));
  assert.ok(entries.includes(`${root}/node_modules/onnxruntime-node/package.json`));
  assert.ok(entries.some((entry) => entry.startsWith(`${nativeRoot}/`) && entry.endsWith("onnxruntime_binding.node")));
  assert.ok(entries.some((entry) => entry.startsWith(`${nativeRoot}/`) && /\.(?:dylib|dll)$/.test(entry)));
});

test("runtime builder uses npm bundled with pinned Node instead of ambient npm", { skip: !supportedHost, timeout: 600_000 }, () => {
  const result = runNativeBuilder({
    PATH: process.platform === "win32" ? path.dirname(process.execPath) : "/usr/bin:/bin",
    npm_execpath: "",
    npm_config_registry: "https://example.invalid/",
    npm_config_userconfig: path.join(repositoryRoot, "test", ".runtime", "must-not-be-read.npmrc"),
    npm_config_https_proxy: "https://inherited-proxy.invalid/",
    HTTPS_PROXY: "https://inherited-proxy.invalid/",
    NODE_AUTH_TOKEN: "analogy-secret-must-not-leak",
    NPM_TOKEN: "analogy-secret-must-not-leak",
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /node-v22\.23\.2-[^/]+\/(?:lib\/node_modules|node_modules)\/npm\/bin\/npm-cli\.js/);
  assert.doesNotMatch(fs.readFileSync(`${hostArchivePath}.manifest.json`, "utf8"), /example\.invalid|inherited-proxy|analogy-secret/);
});

test("Windows cached Node ZIP extraction retries once into a clean directory", () => {
  const source = fs.readFileSync(path.join(extensionRoot, "scripts", "build-embedding-runtime.mjs"), "utf8");
  assert.match(source, /process\.platform !== "win32" \|\| asset\.archive !== "zip"/);
  assert.match(source, /rm\(destination, \{ recursive: true, force: true \}\)/);
});

test("native runtime archive is byte-reproducible with normalized metadata", { skip: !supportedHost, timeout: 1_200_000 }, (t) => {
  const firstBuild = runNativeBuilder();
  assert.equal(firstBuild.status, 0, `${firstBuild.stdout}${firstBuild.stderr}`);
  const firstSha256 = sha256File(hostArchivePath);
  const entries = process.platform === "win32" ? parseZipMetadata(hostArchivePath) : parseUstarMetadata(hostArchivePath);
  const names = entries.map((entry) => entry.name);
  const byteSortedNames = [...names].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  assert.deepEqual(names, byteSortedNames, "archive entries must use deterministic byte ordering");
  assert.ok(entries.length > 0);
  if (process.platform === "win32") {
    for (const entry of entries) {
      assert.equal(entry.dosTime, 0, `${entry.name} DOS time must be normalized`);
      assert.equal(entry.dosDate, 0x2821, `${entry.name} DOS date must be 2000-01-01`);
      if (entry.creator === 3) {
        const expectedMode = entry.directory || entry.name.endsWith("/node/bin/node.exe") ? 0o755 : 0o644;
        assert.equal(entry.mode, expectedMode, `${entry.name} mode must be normalized`);
      }
    }
  } else {
    for (const entry of entries) {
      assert.equal(entry.uid, 0, `${entry.name} uid must be normalized`);
      assert.equal(entry.gid, 0, `${entry.name} gid must be normalized`);
      assert.equal(entry.mtime, 946684800, `${entry.name} mtime must be normalized`);
      const expectedMode = entry.type === "5" || entry.name.endsWith("/node/bin/node") ? 0o755 : 0o644;
      assert.equal(entry.mode & 0o777, expectedMode, `${entry.name} mode must be normalized`);
    }
  }

  const secondBuild = runNativeBuilder();
  assert.equal(secondBuild.status, 0, `${secondBuild.stdout}${secondBuild.stderr}`);
  const secondSha256 = sha256File(hostArchivePath);
  assert.equal(secondSha256, firstSha256, `consecutive builds differ: ${firstSha256} != ${secondSha256}`);
  t.diagnostic(`consecutive build SHA-256: ${firstSha256} / ${secondSha256}`);
});

test("native pack is installer-compatible, fully hashed, production-only, and completely noticed", { skip: !supportedHost, timeout: 300_000 }, async () => {
  assert.ok(fs.existsSync(hostArchivePath), "build the native pack before inspecting it");
  const packRoot = await extractBuiltPack();
  const manifest = readJson(path.join(packRoot, "manifest.json"));
  const lock = readJson(path.join(runtimePackageRoot, "package-lock.json"));
  const notices = fs.readFileSync(path.join(packRoot, "THIRD_PARTY_NOTICES.txt"), "utf8");
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const nodeExecutable = path.join(packRoot, "node", "bin", nodeName);

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.platform, hostPlatformKey);
  assert.equal(manifest.version, "node22-v1");
  assert.deepEqual(manifest.runtimeVersions, {
    node: "22.23.2",
    transformers: "4.2.0",
    onnxruntime: "1.26.0",
  });
  assert.equal(manifest.executableRelativePath, `node/bin/${nodeName}`);
  assert.equal(manifest.moduleRootRelativePath, "node_modules");
  assert.equal(manifest.noticesRelativePath, "THIRD_PARTY_NOTICES.txt");

  const nodeProbe = spawnSync(nodeExecutable, ["-p", "process.version + ' ' + process.platform + '-' + process.arch"], { encoding: "utf8" });
  assert.equal(nodeProbe.status, 0, nodeProbe.stderr);
  assert.equal(nodeProbe.stdout.trim(), `v22.23.2 ${hostPlatformKey}`);

  const actualFiles = walkFiles(packRoot)
    .filter((entry) => entry.path !== "manifest.json")
    .sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")));
  assert.deepEqual(manifest.files, actualFiles, "internal manifest must hash every payload file exactly once");
  assert.equal(new Set(manifest.files.map((entry) => entry.path)).size, manifest.files.length);
  for (const entry of manifest.files) {
    assert.doesNotMatch(entry.path, /(?:^|\/)(?:\.cache|\.npm|_cacache)(?:\/|$)/);
    assert.doesNotMatch(entry.path, /\.map$/);
    assert.doesNotMatch(entry.path, /\.(?:onnx(?:_data)?|safetensors)$/i);
    assert.doesNotMatch(entry.path, /^node_modules\/@huggingface\/transformers\/(?:src|types)\//);
    if (entry.path.startsWith("node_modules/@huggingface/transformers/dist/")) {
      assert.equal(entry.path, "node_modules/@huggingface/transformers/dist/transformers.node.cjs", "only the Node worker distribution may remain");
    }
  }

  const transformers = readJson(path.join(packRoot, "node_modules", "@huggingface", "transformers", "package.json"));
  const onnxRuntime = readJson(path.join(packRoot, "node_modules", "onnxruntime-node", "package.json"));
  assert.equal(transformers.version, "4.2.0");
  assert.equal(onnxRuntime.version, "1.26.0");
  const packages = collectPackagePaths(path.join(packRoot, "node_modules"));
  for (const installedPackage of packages) {
    if (installedPackage.metadata.name === "sharp") {
      assert.equal(installedPackage.metadata.version, "0.0.0-analogy-disabled");
      assert.match(fs.readFileSync(path.join(installedPackage.directory, "index.js"), "utf8"), /Image processing is disabled/);
    } else {
      assert.ok(lock.packages[installedPackage.path], `${installedPackage.path} must originate in the reviewed lockfile`);
      assert.equal(lock.packages[installedPackage.path].version, installedPackage.metadata.version, `${installedPackage.path} version must match the reviewed lockfile`);
      assert.notEqual(lock.packages[installedPackage.path].dev, true, `${installedPackage.path} must not be a development dependency`);
    }
    assert.ok(
      notices.includes(`===== ${installedPackage.metadata.name}@${installedPackage.metadata.version} =====`),
      `${installedPackage.metadata.name}@${installedPackage.metadata.version} must appear in notices`,
    );
    for (const licenseFile of fs.readdirSync(installedPackage.directory)
      .filter((filename) => /^(licen[cs]e|notice|copying|copyright)(\.|$)/i.test(filename))) {
      const licensePath = path.join(installedPackage.directory, licenseFile);
      if (fs.statSync(licensePath).isFile()) {
        assert.ok(notices.includes(fs.readFileSync(licensePath, "utf8").trimEnd()), `${installedPackage.metadata.name} ${licenseFile} text must be included`);
      }
    }
  }
  for (const forbidden of ["adm-zip", "global-agent", "onnxruntime-web"]) {
    assert.equal(packages.some(({ metadata }) => metadata.name === forbidden), false, `${forbidden} must not be distributed`);
  }
  assert.equal(packages.some(({ metadata }) => metadata.name.startsWith("@img/")), false, "sharp/libvips native packages must not be distributed");
  const licenseCatalog = readJson(path.join(runtimePackageRoot, "license-catalog.json"));
  for (const entry of licenseCatalog.entries.find((entry) => entry.component === "onnxruntime").files) {
    assert.ok(notices.includes(fs.readFileSync(path.join(runtimePackageRoot, entry.path), "utf8").trimEnd()), `${entry.path} must be in notices`);
  }
  assert.ok(notices.includes(fs.readFileSync(path.join(packRoot, "node", "LICENSE"), "utf8").trimEnd()));
});

test("packaged Node and native modules pass real worker health and tiny vector inference", { skip: !supportedHost, timeout: 300_000 }, async (t) => {
  assert.ok(fs.existsSync(hostArchivePath), "build the native pack before running smoke");
  const packRoot = await extractBuiltPack();
  const manifest = readJson(path.join(packRoot, "manifest.json"));
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `analogy-worker-smoke-${hostPlatformKey}-`));
  t.after(() => fs.rmSync(smokeRoot, { recursive: true, force: true }));
  const modelCache = path.join(smokeRoot, "model-cache");
  const workerBundle = path.join(smokeRoot, "embedding-worker-smoke.cjs");
  assert.equal(fs.existsSync(modelCache), false, "smoke model cache must be fresh for every run");
  await esbuild.build({
    entryPoints: [path.join(extensionRoot, "src", "local-vector", "embedding-worker.ts")],
    bundle: true,
    external: ["@huggingface/transformers", "onnxruntime-node"],
    format: "cjs",
    platform: "node",
    target: "node22",
    sourcemap: false,
    outfile: workerBundle,
    logLevel: "silent",
  });

  const executable = path.join(packRoot, ...manifest.executableRelativePath.split("/"));
  const moduleRoot = path.join(packRoot, ...manifest.moduleRootRelativePath.split("/"));
  const child = spawn(executable, [workerBundle], {
    cwd: packRoot,
    env: {
      ANALOGY_RUNTIME_MODULE_ROOT: moduleRoot,
      ELECTRON_RUN_AS_NODE: "1",
      HOME: smokeRoot,
      USERPROFILE: smokeRoot,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
      ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdoutBuffer = "";
  let stderrTail = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof response.ok !== "boolean") continue;
      const waiter = pending.get(response.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        pending.delete(response.id);
        waiter.resolve(response);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-16 * 1024);
  });
  t.after(() => {
    if (!child.killed) child.kill();
  });

  const request = (message, timeoutMs = 180_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(message.id);
      reject(new Error(`Worker request ${message.type} timed out. stderr: ${stderrTail}`));
    }, timeoutMs);
    pending.set(message.id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });

  const health = await request({ id: "smoke-health", type: "health" }, 15_000);
  assert.equal(health.ok, true, JSON.stringify(health));
  assert.ok(health.memoryUsage.rss > 0);

  const initialized = await request({
    id: "smoke-initialize",
    type: "initialize",
    modelId: "hf-internal-testing/tiny-random-BertModel",
    modelRevision: "fc08ad9cc33be9aef4f55cc80e16ef5ae3d5981c",
    dtype: "fp32",
    pooling: "mean",
    cacheDir: modelCache,
  });
  assert.equal(initialized.ok, true, `${JSON.stringify(initialized)} stderr: ${stderrTail}`);

  const smokeModel = readJson(path.join(runtimePackageRoot, "smoke-model.json"));
  assert.equal(smokeModel.revision, "fc08ad9cc33be9aef4f55cc80e16ef5ae3d5981c");
  assert.ok(fs.readdirSync(modelCache, { recursive: true }).some((name) => String(name).includes(smokeModel.revision)), "cache must be bound to the exact model revision");
  for (const expectedFile of smokeModel.files) {
    const cachedFile = findCachePayload(modelCache, expectedFile.path);
    assert.ok(cachedFile, `smoke cache must contain ${expectedFile.path}`);
    assert.equal(fs.statSync(cachedFile).size, expectedFile.size, `${expectedFile.path} size must match the catalog`);
    assert.equal(sha256File(cachedFile), expectedFile.sha256, `${expectedFile.path} hash must match the catalog`);
  }

  const inferred = await request({ id: "smoke-embed", type: "embed", texts: ["Analogy runtime smoke"] });
  assert.equal(inferred.ok, true, `${JSON.stringify(inferred)} stderr: ${stderrTail}`);
  assert.equal(inferred.embeddings.length, 1);
  assert.ok(inferred.embeddings[0].length > 0);
  assert.ok(inferred.embeddings[0].every(Number.isFinite));
  const norm = Math.sqrt(inferred.embeddings[0].reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 0.001, `normalized vector norm must be 1, got ${norm}`);

  const disposed = await request({ id: "smoke-dispose", type: "dispose" }, 15_000);
  assert.equal(disposed.ok, true, JSON.stringify(disposed));
  child.stdin.end();
});

test("embedding worker only forwards a model revision when the optional protocol field is supplied", async (t) => {
  const fixtureRoot = path.join(repositoryRoot, "test", ".runtime", "worker-revision-protocol");
  const fakeModuleRoot = path.join(fixtureRoot, "node_modules", "@huggingface", "transformers");
  const fakeOnnxRoot = path.join(fixtureRoot, "node_modules", "onnxruntime-node");
  const workerBundle = path.join(fixtureRoot, "embedding-worker.cjs");
  const probePath = path.join(fixtureRoot, "pipeline-options.jsonl");
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(fakeModuleRoot, { recursive: true });
  fs.mkdirSync(fakeOnnxRoot, { recursive: true });
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fakeModuleRoot, "index.js"), [
    '"use strict";',
    'const fs = require("node:fs");',
    "exports.env = {};",
    "exports.pipeline = async (_task, _model, options) => {",
    '  fs.appendFileSync(process.env.ANALOGY_PIPELINE_PROBE, `${JSON.stringify(options)}\\n`);',
    "  const extractor = async (texts) => ({ data: new Float32Array(texts.length * 2).fill(0.5), dims: [texts.length, 2] });",
    "  extractor.dispose = async () => {};",
    "  return extractor;",
    "};",
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(fakeOnnxRoot, "package.json"), '{"name":"onnxruntime-node","main":"index.js"}\n', "utf8");
  fs.writeFileSync(path.join(fakeOnnxRoot, "index.js"), "module.exports = {};\n", "utf8");
  await esbuild.build({
    entryPoints: [path.join(extensionRoot, "src", "local-vector", "embedding-worker.ts")],
    bundle: true,
    external: ["@huggingface/transformers"],
    format: "cjs",
    platform: "node",
    target: "node22",
    outfile: workerBundle,
    logLevel: "silent",
  });

  const initialize = (modelRevision) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerBundle], {
      env: {
        ANALOGY_RUNTIME_MODULE_ROOT: path.join(fixtureRoot, "node_modules"),
        ANALOGY_PIPELINE_PROBE: probePath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`worker protocol timeout: ${stderr}`)); }, 10_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      while (stdout.includes("\n")) {
        const lineEnd = stdout.indexOf("\n");
        const response = JSON.parse(stdout.slice(0, lineEnd));
        stdout = stdout.slice(lineEnd + 1);
        if (typeof response.ok !== "boolean") continue;
        clearTimeout(timer);
        child.stdin.end();
        if (!response.ok) reject(new Error(JSON.stringify(response)));
        else resolve();
        return;
      }
    });
    child.stdin.write(`${JSON.stringify({
      id: modelRevision ? "with-revision" : "without-revision",
      type: "initialize",
      modelId: "fixture/model",
      dtype: "fp32",
      cacheDir: path.join(fixtureRoot, "cache"),
      ...(modelRevision ? { modelRevision } : {}),
    })}\n`);
  });

  await initialize(undefined);
  await initialize("fc08ad9cc33be9aef4f55cc80e16ef5ae3d5981c");
  const [withoutRevision, withRevision] = fs.readFileSync(probePath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(Object.hasOwn(withoutRevision, "revision"), false, "legacy/default worker behavior must remain unchanged");
  assert.equal(withRevision.revision, "fc08ad9cc33be9aef4f55cc80e16ef5ae3d5981c");
});

test("runtime manifest generation fails closed until every supported native pack exists", () => {
  const fixtureRoot = path.join(runtimeOutputRoot, ".cache", "manifest-missing-platforms");
  const generatedPath = path.join(fixtureRoot, "generated-embedding-runtime-manifest.ts");
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const script = path.join(extensionRoot, "scripts", "generate-runtime-manifest.mjs");
  const result = spawnSync(process.execPath, [
    script,
    "--input", fixtureRoot,
    "--output", generatedPath,
    "--base-url", "https://github.com/liaocaoxuezhe/obsidian-extension/releases/download/runtime-node22-v1",
  ], {
    cwd: extensionRoot,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Missing runtime packs: analogy-embedding-runtime-node22-v1-darwin-arm64\.tar\.gz, analogy-embedding-runtime-node22-v1-win32-x64\.zip/,
  );
  assert.equal(fs.existsSync(generatedPath), false, "a partial matrix must never replace the development fixture");
});

test("Node runtime archive writer is byte-stable and parser rejects traversal for tar.gz and zip", async (t) => {
  const fixtureRoot = path.join(repositoryRoot, "test", ".runtime", "archive-format");
  const packParent = path.join(fixtureRoot, "pack");
  const packRoot = path.join(packParent, "analogy-embedding-runtime-node22-v1");
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(packRoot, "node", "bin"), { recursive: true });
  fs.writeFileSync(path.join(packRoot, "node", "bin", "node"), "node-body", "utf8");
  fs.writeFileSync(path.join(packRoot, "manifest.json"), "{}\n", "utf8");

  const archiveModule = await import(pathToFileURL(path.join(extensionRoot, "scripts", "runtime-archive.mjs")).href);
  for (const kind of ["tar.gz", "zip"]) {
    const first = await archiveModule.createDeterministicRuntimeArchive(packParent, packRoot, kind);
    const second = await archiveModule.createDeterministicRuntimeArchive(packParent, packRoot, kind);
    assert.ok(first.equals(second), `${kind} output must be byte-identical`);
    const archivePath = path.join(fixtureRoot, `fixture.${kind}`);
    fs.writeFileSync(archivePath, first);
    const entries = archiveModule.readRuntimeArchive(archivePath, kind);
    assert.deepEqual(entries.map((entry) => entry.path), [...entries.map((entry) => entry.path)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));

    if (kind === "zip") {
      for (const [offset, value, label] of [
        [4, 10, "version"],
        [10, 1, "time"],
        [12, 0x2822, "date"],
      ]) {
        const mismatchedLocal = Buffer.from(first);
        mismatchedLocal.writeUInt16LE(value, offset);
        fs.writeFileSync(archivePath, mismatchedLocal);
        assert.throws(
          () => archiveModule.readRuntimeArchive(archivePath, kind),
          /local zip header differs from central directory/,
          `local ${label} must match the central directory`,
        );
      }

      let eocd = first.length - 22;
      const centralOffset = first.readUInt32LE(eocd + 16);
      const centralCount = first.readUInt16LE(eocd + 10);
      const records = [];
      let centralCursor = centralOffset;
      for (let index = 0; index < centralCount; index += 1) {
        const nameLength = first.readUInt16LE(centralCursor + 28);
        records.push({ centralCursor, localOffset: first.readUInt32LE(centralCursor + 42) });
        centralCursor += 46 + nameLength;
      }
      const gapOffset = records[1].localOffset;
      const withGap = Buffer.concat([first.subarray(0, gapOffset), Buffer.from([0xa5]), first.subarray(gapOffset)]);
      eocd += 1;
      withGap.writeUInt32LE(centralOffset + 1, eocd + 16);
      for (const record of records) {
        if (record.localOffset >= gapOffset) {
          withGap.writeUInt32LE(record.localOffset + 1, record.centralCursor + 1 + 42);
        }
      }
      fs.writeFileSync(archivePath, withGap);
      assert.throws(
        () => archiveModule.readRuntimeArchive(archivePath, kind),
        /continuous, gap-free local file region/,
        "hidden bytes between local records must be rejected",
      );
    }

    const malicious = Buffer.from(first);
    if (kind === "tar.gz") {
      const tar = zlib.gunzipSync(malicious);
      tar.fill(0, 0, 100);
      tar.write("../escape", 0, "utf8");
      tar.fill(0x20, 148, 156);
      let checksum = 0;
      for (let index = 0; index < 512; index += 1) checksum += tar[index];
      tar.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
      tar[154] = 0;
      tar[155] = 0x20;
      fs.writeFileSync(archivePath, zlib.gzipSync(tar, { level: 9, mtime: 0 }));
    } else {
      const rootBytes = Buffer.from("analogy-embedding-runtime-node22-v1/", "utf8");
      let cursor = 0;
      while ((cursor = malicious.indexOf(rootBytes, cursor)) >= 0) {
        malicious[cursor] = 0x2f;
        cursor += rootBytes.length;
      }
      fs.writeFileSync(archivePath, malicious);
    }
    assert.throws(() => archiveModule.readRuntimeArchive(archivePath, kind), /unsafe or non-canonical entry path/);
  }
});

test("runtime manifest generation rejects text files dressed up as a complete native matrix", () => {
  const fixtureRoot = path.join(runtimeOutputRoot, ".cache", "manifest-complete-matrix");
  const generatedPath = path.join(fixtureRoot, "generated-embedding-runtime-manifest.ts");
  const baseUrl = "https://github.com/liaocaoxuezhe/obsidian-extension/releases/download/runtime-node22-v1";
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const fixtures = [
    { platform: "darwin-arm64", filename: "analogy-embedding-runtime-node22-v1-darwin-arm64.tar.gz", archive: "tar.gz", size: 18, sha256: "8e07e71a2fec20c5eaf51ca86a4050512330b11de58bc06a81c9a7dd049dc83f", noticeSize: 21, noticeSha256: "3548052a22d6741fa71851b65401a8213063f93f2155a958e36b91be89311808", internalExecutable: "node/bin/node" },
    { platform: "darwin-x64", filename: "analogy-embedding-runtime-node22-v1-darwin-x64.tar.gz", archive: "tar.gz", size: 16, sha256: "e53edf079313220605575af451778651edec3041ba848eb31152e72e871ee6cf", noticeSize: 19, noticeSha256: "982a3f36e6aea1e67e3be99af512bcf5083ef2422d1fcc31534989789f98185a", internalExecutable: "node/bin/node" },
    { platform: "win32-x64", filename: "analogy-embedding-runtime-node22-v1-win32-x64.zip", archive: "zip", size: 15, sha256: "25fece180d3e3f4536c125bde273be594aed48a0300300f62897fe8c6287b7aa", noticeSize: 18, noticeSha256: "c6721838128ebf7ec1b8bf4bbcd9798d9cabb59124bb9458770f3dd4571f1aa3", internalExecutable: "node/bin/node.exe" },
  ];
  const ortOverlayFiles = [
    "libonnxruntime.1.26.0.dylib",
    "libonnxruntime.1.dylib",
    "onnxruntime_binding.node",
  ].map((filename, index) => ({
    path: filename,
    size: 100 + index,
    sha256: crypto.createHash("sha256").update(`ort-overlay:${filename}`).digest("hex"),
  }));

  for (const fixture of fixtures) {
    fs.writeFileSync(path.join(fixtureRoot, fixture.filename), `pack:${fixture.platform}\n`, "utf8");
    const noticesFile = `${fixture.filename}.THIRD_PARTY_NOTICES.txt`;
    fs.writeFileSync(path.join(fixtureRoot, noticesFile), `notices:${fixture.platform}\n`, "utf8");
    fs.writeFileSync(path.join(fixtureRoot, `${fixture.filename}.manifest.json`), `${JSON.stringify({
      schemaVersion: 1,
      id: `embedding-runtime-node22-v1-${fixture.platform}`,
      kind: "embedding-runtime",
      platform: fixture.platform,
      version: "node22-v1",
      runtimeVersions: { node: "22.23.2", transformers: "4.2.0", onnxruntime: "1.26.0" },
      executableRelativePath: fixture.internalExecutable,
      moduleRootRelativePath: "node_modules",
      noticesRelativePath: "THIRD_PARTY_NOTICES.txt",
      ...(fixture.platform === "darwin-x64" ? {
        inputs: {
          onnxruntimeNativeOverlay: {
            schemaVersion: 1,
            platform: "darwin-x64",
            onnxruntimeVersion: "1.26.0",
            source: {
              repository: "https://github.com/microsoft/onnxruntime",
              tag: "v1.26.0",
              commit: "8c546c37b43caaca1fa25db430dab94b901cf277",
            },
            files: ortOverlayFiles,
          },
        },
      } : {}),
      files: [
        { path: "THIRD_PARTY_NOTICES.txt", size: fixture.noticeSize, sha256: fixture.noticeSha256 },
        ...(fixture.platform === "darwin-x64" ? ortOverlayFiles.map((entry) => ({
          ...entry,
          path: `node_modules/onnxruntime-node/bin/napi-v6/darwin/x64/${entry.path}`,
        })) : []),
      ],
    }, null, 2)}\n`, "utf8");
  }

  const script = path.join(extensionRoot, "scripts", "generate-runtime-manifest.mjs");
  const result = spawnSync(process.execPath, [
    script,
    "--input", fixtureRoot,
    "--output", generatedPath,
    "--base-url", baseUrl,
  ], { cwd: extensionRoot, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /Invalid runtime archive/);
  assert.equal(fs.existsSync(generatedPath), false, "fake packs must never publish a generated manifest");
});

test("native artifact validator rejects an attestation that is not bound to the real pack", { skip: !supportedHost }, async (t) => {
  const fixtureRoot = path.join(repositoryRoot, "test", ".runtime", "unbound-attestation");
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(fixtureRoot, { recursive: true });
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  for (const suffix of ["", ".manifest.json", ".THIRD_PARTY_NOTICES.txt"]) {
    fs.copyFileSync(`${hostArchivePath}${suffix}`, path.join(fixtureRoot, `${hostArchiveName}${suffix}`));
  }
  const validator = await import(pathToFileURL(path.join(extensionRoot, "scripts", "runtime-package-validator.mjs")).href);
  const expected = validator.EXPECTED_PACKS.find((entry) => entry.platform === hostPlatformKey);
  const predicate = nativeSmokePredicate(fixtureRoot, expected);
  predicate.pack.size = 1;
  predicate.pack.sha256 = "0".repeat(64);
  const keys = crypto.generateKeyPairSync("ed25519");
  const signed = signedSmokeBundle(predicate, keys.privateKey, keys.publicKey, expected);
  fs.writeFileSync(path.join(fixtureRoot, `${hostArchiveName}.smoke-attestation.json`), `${JSON.stringify(signed.bundle)}\n`, "utf8");
  assert.throws(
    () => validator.validateRuntimeArtifactGroup(fixtureRoot, expected, { requireCompletion: false, trustPolicy: signed.trustPolicy }),
    /Signed native smoke statement is not bound/,
  );
});

test("a fully correct but unsigned native smoke JSON can never validate or finalize", { skip: !supportedHost }, async (t) => {
  const fixtureRoot = path.join(repositoryRoot, "test", ".runtime", "unsigned-smoke-attestation");
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  copyHostRuntimeGroup(fixtureRoot);
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const validator = await import(pathToFileURL(path.join(extensionRoot, "scripts", "runtime-package-validator.mjs")).href);
  const expected = validator.EXPECTED_PACKS.find((entry) => entry.platform === hostPlatformKey);
  const attestationPath = path.join(fixtureRoot, `${hostArchiveName}.unsigned.json`);
  fs.writeFileSync(attestationPath, `${JSON.stringify(nativeSmokePredicate(fixtureRoot, expected), null, 2)}\n`, "utf8");
  fs.copyFileSync(attestationPath, path.join(fixtureRoot, `${hostArchiveName}.smoke-attestation.json`));

  assert.throws(
    () => validator.validateRuntimeArtifactGroup(fixtureRoot, expected, { requireCompletion: false }),
    /cryptographically signed Sigstore DSSE bundle/,
  );
  const finalized = spawnSync(process.execPath, [
    path.join(extensionRoot, "scripts", "finalize-runtime-artifact.mjs"),
    "--platform", hostPlatformKey,
    "--input", fixtureRoot,
    "--attestation", attestationPath,
  ], { cwd: extensionRoot, encoding: "utf8" });
  assert.notEqual(finalized.status, 0, "finalize must reject a self-declared smoke JSON even when every field is correct");
  assert.match(`${finalized.stdout}${finalized.stderr}`, /cryptographically signed Sigstore DSSE bundle/);
});

test("a valid DSSE signature is checked before its signed smoke predicate is trusted", { skip: !supportedHost }, async (t) => {
  const fixtureRoot = path.join(repositoryRoot, "test", ".runtime", "signed-smoke-attestation");
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  copyHostRuntimeGroup(fixtureRoot);
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const validator = await import(pathToFileURL(path.join(extensionRoot, "scripts", "runtime-package-validator.mjs")).href);
  const expected = validator.EXPECTED_PACKS.find((entry) => entry.platform === hostPlatformKey);
  const keys = crypto.generateKeyPairSync("ed25519");
  const signed = signedSmokeBundle(nativeSmokePredicate(fixtureRoot, expected), keys.privateKey, keys.publicKey, expected);
  const attestationPath = path.join(fixtureRoot, `${hostArchiveName}.smoke-attestation.json`);
  fs.writeFileSync(attestationPath, `${JSON.stringify(signed.bundle)}\n`, "utf8");

  assert.doesNotThrow(() => validator.validateRuntimeArtifactGroup(fixtureRoot, expected, {
    requireCompletion: false,
    trustPolicy: signed.trustPolicy,
  }));
  const productionCli = spawnSync(process.execPath, [
    path.join(extensionRoot, "scripts", "finalize-runtime-artifact.mjs"),
    "--platform", hostPlatformKey,
    "--input", fixtureRoot,
    "--attestation", attestationPath,
  ], { cwd: extensionRoot, encoding: "utf8" });
  assert.notEqual(productionCli.status, 0, "production CLI must never accept an injected test trust root");
  assert.match(`${productionCli.stdout}${productionCli.stderr}`, /Production smoke bundle must contain a Fulcio signing certificate/);
  signed.bundle.dsseEnvelope.signatures[0].sig = Buffer.alloc(64, 7).toString("base64");
  fs.writeFileSync(attestationPath, `${JSON.stringify(signed.bundle)}\n`, "utf8");
  assert.throws(
    () => validator.validateRuntimeArtifactGroup(fixtureRoot, expected, {
      requireCompletion: false,
      trustPolicy: signed.trustPolicy,
    }),
    /DSSE signature verification failed/,
  );
});

test("native artifact validator rejects a sidecar substituted after archive construction", { skip: !supportedHost }, async (t) => {
  const fixtureRoot = path.join(repositoryRoot, "test", ".runtime", "substituted-sidecar");
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(fixtureRoot, { recursive: true });
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  for (const suffix of ["", ".manifest.json", ".THIRD_PARTY_NOTICES.txt"]) {
    fs.copyFileSync(`${hostArchivePath}${suffix}`, path.join(fixtureRoot, `${hostArchiveName}${suffix}`));
  }
  fs.appendFileSync(path.join(fixtureRoot, `${hostArchiveName}.manifest.json`), " ");
  const validator = await import(pathToFileURL(path.join(extensionRoot, "scripts", "runtime-package-validator.mjs")).href);
  const expected = validator.EXPECTED_PACKS.find((entry) => entry.platform === hostPlatformKey);
  assert.throws(
    () => validator.validateRuntimeArtifactGroup(fixtureRoot, expected, { requireCompletion: false }),
    /Archive internal manifest bytes do not match sidecar/,
  );
});

test("release-only gate rejects a legacy matrix without native smoke and completion fields", () => {
  const fixtureRoot = path.join(repositoryRoot, "test", ".runtime", "legacy-release-matrix");
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, "embedding-runtime-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    runtimeVersion: "node22-v1",
    baseUrl: "https://github.com/liaocaoxuezhe/obsidian-extension/releases/download/runtime-node22-v1",
    assets: ["darwin-arm64", "darwin-x64", "win32-x64"].map((platform) => ({ platform })),
  })}\n`, "utf8");
  const result = spawnSync(process.execPath, [
    path.join(extensionRoot, "scripts", "prepare-release.mjs"),
    "--runtime-only",
    "--runtime-staging", fixtureRoot,
  ], { cwd: extensionRoot, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /canonical generated JSON representation|Unexpected runtime archive identity|Smoke attestation filename/);
});

test("default release refuses the checked-in development runtime fixture before preparing files", () => {
  const fixtureRoot = path.join(repositoryRoot, "test", ".runtime", "release-default-fixture");
  const generatedDirectory = path.join(fixtureRoot, "src", "runtime");
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(generatedDirectory, { recursive: true });
  fs.writeFileSync(path.join(generatedDirectory, "generated-embedding-runtime-manifest.ts"), [
    'export const EMBEDDING_RUNTIME_MANIFEST_SOURCE = "development-fixture" as const;',
    'export const GENERATED_EMBEDDING_RUNTIME_ASSETS = [{ url: "https://example.invalid/runtime" }];',
    "",
  ].join("\n"), "utf8");

  const result = spawnSync(process.execPath, [path.join(extensionRoot, "scripts", "prepare-release.mjs")], {
    cwd: fixtureRoot,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /RELEASE_RUNTIME_FIXTURE_FORBIDDEN/);
  assert.equal(fs.existsSync(path.join(fixtureRoot, "release")), false, "fixture rejection must happen before release mutation");
});
