"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const repositoryRoot = path.resolve(__dirname, "..");
const moduleUrl = pathToFileURL(path.join(
  repositoryRoot,
  "scripts",
  "runtime-manifest-binding.mjs",
)).href;

const runtimeVersions = Object.freeze({ node: "22.23.2", transformers: "4.2.0", onnxruntime: "1.26.0" });
const asset = Object.freeze({
  id: "embedding-runtime-node22-v1-darwin-x64",
  kind: "embedding-runtime",
  platform: "darwin-x64",
  version: "node22-v1",
  url: "https://github.com/Nixum/analogy/releases/download/runtime-node22-v1/analogy-embedding-runtime-node22-v1-darwin-x64.tar.gz",
  fileName: "analogy-embedding-runtime-node22-v1-darwin-x64.tar.gz",
  archive: "tar.gz",
  size: 123456,
  sha256: "a".repeat(64),
  executableRelativePath: "analogy-embedding-runtime-node22-v1/node/bin/node",
  licenseName: "See bundled THIRD_PARTY_NOTICES.txt",
  licenseUrl: "https://github.com/Nixum/analogy/releases/download/runtime-node22-v1/analogy-embedding-runtime-node22-v1-darwin-x64.tar.gz.THIRD_PARTY_NOTICES.txt",
  source: "published",
  runtimeVersions,
});

async function loadModule() {
  try {
    return await import(moduleUrl);
  } catch {
    return {};
  }
}

test("generated TypeScript is field-for-field bound to the canonical staging manifest", async () => {
  const {
    assertGeneratedRuntimeBinding,
    computePublicRuntimeManifestSha256,
    extractGeneratedRuntimeManifestSha256,
    renderPublishedRuntimeTypeScript,
  } = await loadModule();
  assert.equal(typeof assertGeneratedRuntimeBinding, "function", "binding validator must be exported");
  assert.equal(typeof computePublicRuntimeManifestSha256, "function", "public runtime manifest digest must be exported");
  assert.equal(typeof extractGeneratedRuntimeManifestSha256, "function", "build must use the shared generated digest parser");
  assert.equal(typeof renderPublishedRuntimeTypeScript, "function", "generator renderer must be shared with release verification");
  const releaseManifest = { schemaVersion: 1, runtimeVersion: "node22-v1", baseUrl: "https://github.com/Nixum/analogy/releases/download/runtime-node22-v1", assets: [asset] };
  const source = renderPublishedRuntimeTypeScript(releaseManifest);
  const expectedDigest = "28bc6f7d8529317cf40a3657f91223afd0a8bf423e075680ac55b25fd6ecdda5";
  assert.equal(computePublicRuntimeManifestSha256(releaseManifest), expectedDigest);
  assert.match(source, new RegExp(`export const EMBEDDING_RUNTIME_PUBLIC_MANIFEST_SHA256 = "${expectedDigest}" as const;`));
  assert.match(source, new RegExp(`export const EMBEDDING_RUNTIME_BUILD_BINDING = "ANALOGY_EMBEDDING_RUNTIME_MANIFEST_SHA256:${expectedDigest}" as const;`));
  assert.equal(extractGeneratedRuntimeManifestSha256(source), expectedDigest);
  assert.throws(
    () => extractGeneratedRuntimeManifestSha256(source.replace(asset.url, "https://attacker.invalid/runtime.tar.gz")),
    /canonical generated runtime manifest|digest mismatch/,
    "the build must not trust a copied digest constant when generated asset fields changed",
  );
  assert.throws(
    () => extractGeneratedRuntimeManifestSha256(`${source}\nglobalThis.__runtimeGateBypass = true;\n`),
    /canonical generated runtime manifest/,
    "the build must reject executable code appended to the generated source",
  );
  const checkedInSource = fs.readFileSync(path.join(
    repositoryRoot,
    "src",
    "runtime",
    "generated-embedding-runtime-manifest.ts",
  ), "utf8");
  assert.match(checkedInSource, /EMBEDDING_RUNTIME_MANIFEST_SOURCE = "published"/);
  const checkedInDigest = checkedInSource.match(
    /EMBEDDING_RUNTIME_PUBLIC_MANIFEST_SHA256 = "([a-f0-9]{64})"/,
  )?.[1];
  assert.ok(checkedInDigest, "公开仓库必须提交可校验的 published runtime digest");
  assert.equal(
    extractGeneratedRuntimeManifestSha256(checkedInSource),
    checkedInDigest,
  );
  assert.doesNotThrow(() => assertGeneratedRuntimeBinding(source, releaseManifest));

  for (const [label, forgedSource] of [
    ["evil append", `${source}\nglobalThis.__runtimeGateBypass = true;\n`],
    ["evil prefix", `globalThis.__runtimeGateBypass = true;\n${source}`],
    ["duplicate assignment", `${source}\nexport const EMBEDDING_RUNTIME_PUBLIC_MANIFEST_SHA256 = "${expectedDigest}";\n`],
  ]) {
    assert.throws(
      () => assertGeneratedRuntimeBinding(forgedSource, releaseManifest),
      /exact canonical renderer output/,
      label,
    );
  }

  const mutations = [
    ["id", "embedding-runtime-node22-v1-forged"],
    ["platform", "darwin-arm64"],
    ["url", `${asset.url}?mutable=1`],
    ["fileName", "other.tar.gz"],
    ["size", asset.size + 1],
    ["sha256", "b".repeat(64)],
    ["runtimeVersions", { ...runtimeVersions, onnxruntime: "1.25.0" }],
  ];
  for (const [field, value] of mutations) {
    const forgedSource = renderPublishedRuntimeTypeScript({ ...releaseManifest, assets: [{ ...asset, [field]: value }] });
    assert.throws(
      () => assertGeneratedRuntimeBinding(forgedSource, releaseManifest),
      /exact canonical renderer output/,
      field,
    );
  }
});
