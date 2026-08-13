"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const repositoryRoot = path.resolve(__dirname, "..");
const extensionRoot = repositoryRoot;
const scriptsRoot = path.join(extensionRoot, "scripts");
const runtimePackageRoot = path.join(extensionRoot, "runtime-package");
const fixtureRoot = path.join(repositoryRoot, "test", ".runtime", "signed-release-chain");
const packRootName = "analogy-embedding-runtime-node22-v1";
const baseUrl = "https://github.com/liaocaoxuezhe/obsidian-extension/releases/download/runtime-node22-v1";

test("runtime manifest directory durability follows platform support", () => {
  const source = fs.readFileSync(path.join(scriptsRoot, "generate-runtime-manifest.mjs"), "utf8");
  assert.match(source, /async function fsyncDirectory/);
  assert.match(source, /if \(process\.platform === "win32"\) return/);
  assert.match(source, /await fsyncDirectory\(path\.dirname\(filename\)\)/);
});

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sha256File(filename) {
  return sha256Bytes(fs.readFileSync(filename));
}

function writeFile(root, relativePath, body) {
  const filename = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, body);
}

function thinMachO(arch, fileType) {
  const image = Buffer.alloc(256);
  image.writeUInt32LE(0xfeedfacf, 0);
  image.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  image.writeUInt32LE(arch === "arm64" ? 0 : 3, 8);
  image.writeUInt32LE(fileType, 12);
  image.writeUInt32LE(1, 16);
  image.writeUInt32LE(72, 20);
  image.writeUInt32LE(0x19, 32);
  image.writeUInt32LE(72, 36);
  image.write("__TEXT", 40, "ascii");
  image.writeBigUInt64LE(0n, 72);
  image.writeBigUInt64LE(BigInt(image.length), 80);
  image.writeUInt32LE(5, 88);
  image.writeUInt32LE(5, 92);
  return image;
}

function pe32Plus(dll) {
  const image = Buffer.alloc(0x280);
  image.write("MZ", 0, "ascii");
  image.writeUInt32LE(0x80, 0x3c);
  image.writeUInt32LE(0x00004550, 0x80);
  image.writeUInt16LE(0x8664, 0x84);
  image.writeUInt16LE(1, 0x86);
  image.writeUInt16LE(112, 0x94);
  image.writeUInt16LE(0x0002 | (dll ? 0x2000 : 0), 0x96);
  image.writeUInt16LE(0x20b, 0x98);
  const section = 0x98 + 112;
  image.write(".text", section, "ascii");
  image.writeUInt32LE(0x80, section + 16);
  image.writeUInt32LE(0x200, section + 20);
  image.fill(0x90, 0x200);
  return image;
}

function collectFiles(root, relative = "") {
  const files = [];
  const directory = path.join(root, ...relative.split("/").filter(Boolean));
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const child = path.posix.join(relative, entry.name);
    const absolute = path.join(root, ...child.split("/"));
    if (entry.isDirectory()) files.push(...collectFiles(root, child));
    if (entry.isFile() && child !== "manifest.json") {
      const bytes = fs.readFileSync(absolute);
      files.push({ path: child, size: bytes.length, sha256: sha256Bytes(bytes) });
    }
  }
  return files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
}

function dssePae(payloadType, payload) {
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${payload.length} `, "utf8"),
    payload,
  ]);
}

function smokePredicate(stagingRoot, expected, manifest, trustPolicy) {
  const archivePath = path.join(stagingRoot, expected.fileName);
  const manifestPath = `${archivePath}.manifest.json`;
  const noticesPath = `${archivePath}.THIRD_PARTY_NOTICES.txt`;
  const arch = expected.platform.endsWith("arm64") ? "arm64" : "x64";
  const runId = expected.platform === "darwin-arm64" ? "701" : expected.platform === "darwin-x64" ? "702" : "703";
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
      os: expected.platform.startsWith("darwin-") ? "darwin" : "win32",
      osMachine: arch === "x64" ? "x86_64" : "arm64",
      processArch: arch,
      translated: false,
      emulated: false,
      environment: "github-hosted",
      image: `canonical-${expected.platform}`,
      workflowRunId: runId,
    },
    binaries: manifest.files
      .filter((entry) => entry.path === manifest.executableRelativePath
        || (entry.path.startsWith("node_modules/onnxruntime-node/bin/napi-v6/") && /\.(?:node|dylib|dll)$/i.test(entry.path)))
      .map(({ path: binaryPath, size, sha256 }) => ({ path: binaryPath, size, sha256 })),
    modelCatalogSha256: "5766162e4e8fd00d395a01a2359baa533137be10d5612176c9cae1d9576be9b2",
    model: JSON.parse(fs.readFileSync(path.join(runtimePackageRoot, "smoke-model.json"), "utf8")),
    cache: { freshTemporary: true, persistentCacheUsed: false, preexistingEntries: 0, pathSha256: "c".repeat(64) },
    result: { health: "passed", inference: "passed", vectors: 1, dimensions: 8, finite: true, normalized: true },
    provenance: {
      issuer: trustPolicy.issuer,
      repository: trustPolicy.repository,
      workflow: trustPolicy.workflow,
      workflowRef: trustPolicy.workflowRef,
      workflowIdentity: trustPolicy.workflowIdentity,
      commit: "d".repeat(40),
      runId,
      runAttempt: 1,
    },
  };
}

function signedBundle(predicate, expected, privateKey, trustPolicy) {
  const payloadType = "application/vnd.in-toto+json";
  const payload = Buffer.from(JSON.stringify({
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: expected.fileName, digest: { sha256: predicate.pack.sha256 } }],
    predicateType: "https://github.com/liaocaoxuezhe/obsidian-extension/attestations/native-runtime-smoke/v1",
    predicate,
  }), "utf8");
  return Buffer.from(`${JSON.stringify({
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: { publicKey: { hint: trustPolicy.keyId } },
    dsseEnvelope: {
      payloadType,
      payload: payload.toString("base64"),
      signatures: [{ keyid: trustPolicy.keyId, sig: crypto.sign(null, dssePae(payloadType, payload), privateKey).toString("base64") }],
    },
  })}\n`, "utf8");
}

async function buildCanonicalGroup(stagingRoot, expected, validator, archiveModule, overlayModule) {
  const workParent = path.join(fixtureRoot, "packs", expected.platform);
  const packRoot = path.join(workParent, packRootName);
  fs.mkdirSync(packRoot, { recursive: true });
  const notices = Buffer.from([
    "===== onnxruntime@1.26.0 =====",
    fs.readFileSync(path.join(runtimePackageRoot, "licenses", "onnxruntime-1.26.0-LICENSE.txt"), "utf8").trimEnd(),
    fs.readFileSync(path.join(runtimePackageRoot, "licenses", "onnxruntime-1.26.0-ThirdPartyNotices.txt"), "utf8").trimEnd(),
    "",
  ].join("\n"), "utf8");
  writeFile(packRoot, "THIRD_PARTY_NOTICES.txt", notices);
  for (const [packagePath, name, version] of [
    ["node_modules/@huggingface/jinja/package.json", "@huggingface/jinja", "0.5.9"],
    ["node_modules/@huggingface/tokenizers/package.json", "@huggingface/tokenizers", "0.1.3"],
    ["node_modules/@huggingface/transformers/package.json", "@huggingface/transformers", "4.2.0"],
    ["node_modules/onnxruntime-common/package.json", "onnxruntime-common", "1.26.0"],
    ["node_modules/onnxruntime-node/package.json", "onnxruntime-node", "1.26.0"],
    ["node_modules/sharp/package.json", "sharp", "0.0.0-analogy-disabled"],
  ]) writeFile(packRoot, packagePath, `${JSON.stringify({ name, version })}\n`);
  writeFile(packRoot, "node_modules/sharp/index.js", 'throw new Error("Image processing is disabled in the text-only embedding runtime");\n');
  writeFile(packRoot, "node_modules/@huggingface/transformers/dist/transformers.node.cjs", '"use strict";\n');
  writeFile(packRoot, "node_modules/onnxruntime-node/dist/backend.js", '"use strict";\n');

  const arch = expected.platform.endsWith("arm64") ? "arm64" : "x64";
  const nativeRoot = `node_modules/onnxruntime-node/bin/napi-v6/${expected.platform.replace("-", "/")}`;
  if (expected.platform.startsWith("darwin-")) {
    writeFile(packRoot, "node/bin/node", thinMachO(arch, 2));
    const nativeNames = expected.platform === "darwin-x64"
      ? overlayModule.ORT_NATIVE_FILES
      : ["libonnxruntime.1.26.0.dylib", "onnxruntime_binding.node"];
    for (const name of nativeNames) writeFile(packRoot, `${nativeRoot}/${name}`, thinMachO(arch, name.endsWith(".node") ? 8 : 6));
  } else {
    writeFile(packRoot, "node/bin/node.exe", pe32Plus(false));
    writeFile(packRoot, `${nativeRoot}/onnxruntime_binding.node`, pe32Plus(true));
    writeFile(packRoot, `${nativeRoot}/onnxruntime.dll`, pe32Plus(true));
  }

  const nodeCatalog = JSON.parse(fs.readFileSync(path.join(runtimePackageRoot, "node-assets.json"), "utf8"));
  const nodeAsset = nodeCatalog.assets.find((entry) => entry.platformKey === expected.platform);
  const runner = {
    os: expected.platform.startsWith("darwin-") ? "darwin" : "win32",
    processArch: arch,
    osMachine: arch === "x64" ? "x86_64" : "arm64",
    translated: false,
    windowsUnderlying: null,
  };
  let files = collectFiles(packRoot);
  const overlayFiles = expected.platform === "darwin-x64"
    ? overlayModule.ORT_NATIVE_FILES.map((name) => files.find((entry) => entry.path === `${nativeRoot}/${name}`))
      .map((entry) => ({ path: path.posix.basename(entry.path), size: entry.size, sha256: entry.sha256 }))
    : null;
  const manifest = {
    schemaVersion: 1,
    id: `embedding-runtime-node22-v1-${expected.platform}`,
    kind: "embedding-runtime",
    platform: expected.platform,
    version: "node22-v1",
    runtimeVersions: validator.RUNTIME_VERSIONS,
    executableRelativePath: expected.internalExecutableRelativePath,
    moduleRootRelativePath: "node_modules",
    noticesRelativePath: "THIRD_PARTY_NOTICES.txt",
    inputs: {
      node: { url: nodeAsset.url, size: nodeAsset.size, sha256: nodeAsset.sha256 },
      packageLockSha256: sha256File(path.join(runtimePackageRoot, "package-lock.json")),
      licenseCatalog: { sha256: validator.LICENSE_CATALOG_SHA256, noticesSha256: sha256Bytes(notices) },
      builder: {
        implementation: "scripts/runtime-archive.mjs",
        archiveWriterSha256: sha256File(path.join(scriptsRoot, "write-runtime-archive.mjs")),
        archiveImplementationSha256: sha256File(path.join(scriptsRoot, "runtime-archive.mjs")),
        node: "v22.23.2",
        zlib: process.versions.zlib,
        runner,
      },
      ...(overlayFiles ? {
        onnxruntimeNativeOverlay: {
          schemaVersion: 1,
          platform: "darwin-x64",
          onnxruntimeVersion: "1.26.0",
          source: overlayModule.ORT_SOURCE,
          licenseInput: overlayModule.ORT_LICENSE_INPUT,
          files: overlayFiles,
        },
      } : {}),
    },
    files,
  };
  writeFile(packRoot, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  const archive = await archiveModule.createDeterministicRuntimeArchive(workParent, packRoot, expected.archive);
  const archivePath = path.join(stagingRoot, expected.fileName);
  fs.writeFileSync(archivePath, archive);
  fs.copyFileSync(path.join(packRoot, "manifest.json"), `${archivePath}.manifest.json`);
  fs.copyFileSync(path.join(packRoot, "THIRD_PARTY_NOTICES.txt"), `${archivePath}.THIRD_PARTY_NOTICES.txt`);
  return manifest;
}

test("signed canonical supported-platform chain finalizes, generates, and passes runtime-only release verification", async (t) => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const stagingRoot = path.join(fixtureRoot, "staging");
  const attestationsRoot = path.join(fixtureRoot, "attestations");
  fs.mkdirSync(stagingRoot, { recursive: true });
  fs.mkdirSync(attestationsRoot, { recursive: true });

  const validator = await import(pathToFileURL(path.join(scriptsRoot, "runtime-package-validator.mjs")).href);
  const archiveModule = await import(pathToFileURL(path.join(scriptsRoot, "runtime-archive.mjs")).href);
  const overlayModule = await import(pathToFileURL(path.join(scriptsRoot, "runtime-native-overlay.mjs")).href);
  const finalizer = await import(pathToFileURL(path.join(scriptsRoot, "finalize-runtime-artifact.mjs")).href);
  assert.equal(typeof finalizer.finalizeRuntimeArtifact, "function", "finalizer must expose a controlled module API");
  const generator = await import(pathToFileURL(path.join(scriptsRoot, "generate-runtime-manifest.mjs")).href);
  assert.equal(typeof generator.generateRuntimeManifest, "function", "generator must expose a controlled module API");
  const release = await import(pathToFileURL(path.join(scriptsRoot, "prepare-release.mjs")).href);
  assert.equal(typeof release.verifyRuntimeRelease, "function", "prepare-release must expose runtime-only verification");

  const keys = crypto.generateKeyPairSync("ed25519");
  const publicDer = keys.publicKey.export({ type: "spki", format: "der" });
  const trustPolicy = {
    kind: "public-key",
    keyId: sha256Bytes(publicDer),
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }),
    issuer: "https://token.actions.githubusercontent.com",
    repository: "liaocaoxuezhe/obsidian-extension",
    workflow: ".github/workflows/obsidian-runtime-matrix.yml",
    workflowRef: "liaocaoxuezhe/obsidian-extension/.github/workflows/obsidian-runtime-matrix.yml@refs/heads/main",
    workflowIdentity: "https://github.com/liaocaoxuezhe/obsidian-extension/.github/workflows/obsidian-runtime-matrix.yml@refs/heads/main",
  };

  for (const expected of validator.EXPECTED_PACKS) {
    const manifest = await buildCanonicalGroup(stagingRoot, expected, validator, archiveModule, overlayModule);
    const predicate = smokePredicate(stagingRoot, expected, manifest, trustPolicy);
    const unsignedPath = path.join(attestationsRoot, `${expected.platform}.unsigned.json`);
    fs.writeFileSync(unsignedPath, `${JSON.stringify(predicate)}\n`, "utf8");
    if (expected.platform === "darwin-arm64") {
      await assert.rejects(
        finalizer.finalizeRuntimeArtifact({ platform: expected.platform, inputRoot: stagingRoot, attestationSource: unsignedPath, trustPolicy }),
        /cryptographically signed Sigstore DSSE bundle/,
      );
    }
    const bundlePath = path.join(attestationsRoot, `${expected.platform}.sigstore.json`);
    fs.writeFileSync(bundlePath, signedBundle(predicate, expected, keys.privateKey, trustPolicy));
    await finalizer.finalizeRuntimeArtifact({ platform: expected.platform, inputRoot: stagingRoot, attestationSource: bundlePath, trustPolicy });
    assert.ok(fs.existsSync(path.join(stagingRoot, `${expected.fileName}.complete.json`)));
  }

  const generatedPath = path.join(fixtureRoot, "generated-embedding-runtime-manifest.ts");
  await generator.generateRuntimeManifest({ inputRoot: stagingRoot, outputPath: generatedPath, baseUrl, trustPolicy });
  const releaseManifest = release.verifyRuntimeRelease(stagingRoot, { generatedManifestPath: generatedPath, trustPolicy });
  assert.deepEqual(
    releaseManifest.assets.map((entry) => entry.platform),
    validator.EXPECTED_PACKS.map((entry) => entry.platform),
  );

  const manifestBinding = await import(pathToFileURL(path.join(scriptsRoot, "runtime-manifest-binding.mjs")).href);
  const publicManifestSha256 = manifestBinding.computePublicRuntimeManifestSha256(releaseManifest);
  const bindingMarker = `ANALOGY_EMBEDDING_RUNTIME_MANIFEST_SHA256:${publicManifestSha256}`;
  const mainJsPath = path.join(fixtureRoot, "main.js");
  const buildInfoPath = path.join(fixtureRoot, "build-info.json");
  const writeBuiltFixture = (mainSource, manifestSha256 = publicManifestSha256) => {
    fs.writeFileSync(mainJsPath, mainSource, "utf8");
    fs.writeFileSync(buildInfoPath, `${JSON.stringify({
      embeddingRuntimePublicManifestSha256: manifestSha256,
      mainJsSha256: sha256File(mainJsPath),
    }, null, 2)}\n`, "utf8");
  };
  writeBuiltFixture(`const EMBEDDING_RUNTIME_BUILD_BINDING = "${bindingMarker}";\n`);
  assert.doesNotThrow(() => release.verifyRuntimeRelease(stagingRoot, {
    generatedManifestPath: generatedPath,
    mainJsPath,
    buildInfoPath,
    trustPolicy,
  }));

  writeBuiltFixture(releaseManifest.assets.map((entry) => entry.sha256).join("\n"));
  assert.throws(
    () => release.verifyRuntimeRelease(stagingRoot, { generatedManifestPath: generatedPath, mainJsPath, buildInfoPath, trustPolicy }),
    /exactly one runtime manifest binding constant/,
    "an old bundle containing all three archive hashes is not build-bound",
  );
  writeBuiltFixture(`legacy bundle\n${publicManifestSha256}\n`);
  assert.throws(
    () => release.verifyRuntimeRelease(stagingRoot, { generatedManifestPath: generatedPath, mainJsPath, buildInfoPath, trustPolicy }),
    /exactly one runtime manifest binding constant/,
    "a digest appended as an arbitrary trailing string is not a compiled binding constant",
  );
  writeBuiltFixture(`const A = "${bindingMarker}"; const B = "${bindingMarker}";\n`);
  assert.throws(
    () => release.verifyRuntimeRelease(stagingRoot, { generatedManifestPath: generatedPath, mainJsPath, buildInfoPath, trustPolicy }),
    /exactly one runtime manifest binding constant/,
    "the binding marker must occur exactly once",
  );
  writeBuiltFixture(`const EMBEDDING_RUNTIME_BUILD_BINDING = "${bindingMarker}";\n`, "f".repeat(64));
  assert.throws(
    () => release.verifyRuntimeRelease(stagingRoot, { generatedManifestPath: generatedPath, mainJsPath, buildInfoPath, trustPolicy }),
    /build-info runtime manifest digest mismatch/,
  );

  const canonicalGeneratedSource = fs.readFileSync(generatedPath, "utf8");
  fs.writeFileSync(generatedPath, `${canonicalGeneratedSource.replace(baseUrl, "https://attacker.invalid/runtime")}\n${releaseManifest.assets.map((entry) => entry.sha256).join("\n")}\n`, "utf8");
  writeBuiltFixture(`const EMBEDDING_RUNTIME_BUILD_BINDING = "${bindingMarker}";\n`);
  assert.throws(
    () => release.verifyRuntimeRelease(stagingRoot, { generatedManifestPath: generatedPath, mainJsPath, buildInfoPath, trustPolicy }),
    /exact canonical renderer output/,
    "a wrong generated URL cannot be hidden by appending the three archive hashes",
  );
  fs.writeFileSync(generatedPath, canonicalGeneratedSource, "utf8");

  const firstDigest = releaseManifest.assets[0].sha256;
  fs.writeFileSync(generatedPath, fs.readFileSync(generatedPath, "utf8").replace(firstDigest, "e".repeat(64)), "utf8");
  assert.throws(
    () => release.verifyRuntimeRelease(stagingRoot, { generatedManifestPath: generatedPath, trustPolicy }),
    /exact canonical renderer output/,
  );
});
