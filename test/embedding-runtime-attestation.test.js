"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const repositoryRoot = path.resolve(__dirname, "..");
const extensionRoot = repositoryRoot;
const moduleUrl = pathToFileURL(path.join(extensionRoot, "scripts", "runtime-smoke-attestation.mjs")).href;
const fixturePath = path.join(repositoryRoot, "test", "fixtures", "github-cli-v2.50.0-windows-arm64.sigstore.json");
const productionRuntimeFixturePath = path.join(
  repositoryRoot,
  "test",
  "fixtures",
  "analogy-embedding-runtime-node22-v1-darwin-arm64.tar.gz.smoke-attestation.json",
);

function fixture() {
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}

function flipBase64(value) {
  const bytes = Buffer.from(value, "base64");
  bytes[bytes.length - 1] ^= 1;
  return bytes.toString("base64");
}

function sha256Bytes(...values) {
  const hash = crypto.createHash("sha256");
  for (const value of values) hash.update(value);
  return hash.digest();
}

function policyForCliFixture() {
  return {
    ...JSON.parse(fs.readFileSync(path.join(extensionRoot, "runtime-package", "native-smoke-trust.json"), "utf8")),
    repository: "cli/cli",
    workflow: ".github/workflows/deployment.yml",
    workflowRef: "cli/cli/.github/workflows/deployment.yml@refs/heads/trunk",
    workflowIdentity: "https://github.com/cli/cli/.github/workflows/deployment.yml@refs/heads/trunk",
  };
}

function replaceWithSyntheticTransparencyEntry(bundle, policy, integratedTime) {
  const keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyRawBytes = keys.publicKey.export({ type: "spki", format: "der" });
  const logIdBytes = sha256Bytes(publicKeyRawBytes);
  const logId = logIdBytes.toString("base64");
  const logID = logIdBytes.toString("hex");
  const canonicalizedBody = bundle.verificationMaterial.tlogEntries[0].canonicalizedBody;
  const bodyBytes = Buffer.from(canonicalizedBody, "base64");
  const rootHash = sha256Bytes(Buffer.from([0]), bodyBytes);
  const checkpointOrigin = "test.rekor.invalid - 1";
  const checkpointNote = `${checkpointOrigin}\n1\n${rootHash.toString("base64")}\n`;
  const checkpointSignature = crypto.sign("sha256", Buffer.from(checkpointNote), keys.privateKey);
  const checkpointEnvelope = `${checkpointNote}\n— test.rekor.invalid ${Buffer.concat([
    logIdBytes.subarray(0, 4),
    checkpointSignature,
  ]).toString("base64")}\n`;
  const setPayload = JSON.stringify({
    body: canonicalizedBody,
    integratedTime,
    logID,
    logIndex: 0,
  });
  bundle.verificationMaterial.tlogEntries = [{
    logIndex: "0",
    logId: { keyId: logId },
    kindVersion: { kind: "dsse", version: "0.0.1" },
    integratedTime: String(integratedTime),
    inclusionPromise: {
      signedEntryTimestamp: crypto.sign("sha256", Buffer.from(setPayload), keys.privateKey).toString("base64"),
    },
    inclusionProof: {
      logIndex: "0",
      rootHash: rootHash.toString("base64"),
      treeSize: "1",
      hashes: [],
      checkpoint: { envelope: checkpointEnvelope },
    },
    canonicalizedBody,
  }];
  policy.trustedRoot = {
    mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
    snapshotVersion: "test-rekor-v1",
    tlogs: [{
      baseUrl: "https://test.rekor.invalid",
      hashAlgorithm: "SHA2_256",
      publicKey: {
        rawBytes: publicKeyRawBytes.toString("base64"),
        keyDetails: "PKIX_ECDSA_P256_SHA_256",
        validFor: { start: "2020-01-01T00:00:00Z", end: "2030-01-01T00:00:00Z" },
      },
      logId: { keyId: logId },
      checkpointOrigin,
    }],
  };
}

test("production policy pins the planned Obsidian runtime matrix workflow identity", async () => {
  const { readProductionNativeSmokeTrustPolicy } = await import(moduleUrl);
  const policy = readProductionNativeSmokeTrustPolicy();
  assert.deepEqual({
    repository: policy.repository,
    workflow: policy.workflow,
    workflowRef: policy.workflowRef,
    workflowIdentity: policy.workflowIdentity,
  }, {
    repository: "liaocaoxuezhe/obsidian-extension",
    workflow: ".github/workflows/obsidian-runtime-matrix.yml",
    workflowRef: "liaocaoxuezhe/obsidian-extension/.github/workflows/obsidian-runtime-matrix.yml@refs/heads/main",
    workflowIdentity: "https://github.com/liaocaoxuezhe/obsidian-extension/.github/workflows/obsidian-runtime-matrix.yml@refs/heads/main",
  });
});

test("real GitHub Sigstore fixture verifies Fulcio chain, DSSE signature, and OIDC certificate claims", async () => {
  const { verifySigstoreDsseEnvelope } = await import(moduleUrl);
  assert.equal(typeof verifySigstoreDsseEnvelope, "function", "raw Sigstore verifier must be exported");
  const policy = policyForCliFixture();
  const bytes = fs.readFileSync(fixturePath);
  const verified = verifySigstoreDsseEnvelope(bytes, policy);
  assert.deepEqual(verified.githubClaims, {
    issuer: "https://token.actions.githubusercontent.com",
    commit: "faef2ddd81b0736748413a7c646cd0bfc26c00a0",
    repository: "cli/cli",
    runnerEnvironment: "github-hosted",
    workflowIdentity: "https://github.com/cli/cli/.github/workflows/deployment.yml@refs/heads/trunk",
    runId: "9289075752",
    runAttempt: 1,
  });
  assert.equal(
    verified.statement.subject.find((entry) => entry.name === "gh_2.50.0_windows_arm64.zip").digest.sha256,
    "8aad120b416386b4269ef62c8fdebcad31a70847297817a149daf927edc85548",
  );
  assert.deepEqual(verified.transparencyLog, {
    bundleMediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    entryKind: "dsse@0.0.1",
    logId: "wNI9atQGlz+VWfO6LRygH4QUfY/8W4RFwiT5i5WRgB0=",
    integratedTime: 1716998992,
    inclusionProofLogIndex: 93750549,
    inclusionProofTreeSize: 93750551,
  });

  const tampered = JSON.parse(bytes);
  const signature = tampered.dsseEnvelope.signatures[0].sig;
  tampered.dsseEnvelope.signatures[0].sig = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  assert.throws(
    () => verifySigstoreDsseEnvelope(Buffer.from(JSON.stringify(tampered)), policy),
    /DSSE signature verification failed/,
  );
});

test("current Cosign bundle verifies when Rekor omits an empty DSSE keyid", async () => {
  const { verifySigstoreDsseEnvelope, readProductionNativeSmokeTrustPolicy } = await import(moduleUrl);
  const bytes = fs.readFileSync(productionRuntimeFixturePath);
  const verified = verifySigstoreDsseEnvelope(bytes, readProductionNativeSmokeTrustPolicy());
  assert.equal(verified.githubClaims.repository, "liaocaoxuezhe/obsidian-extension");
  assert.equal(verified.transparencyLog.entryKind, "dsse@0.0.1");
});

test("production Sigstore verification rejects missing or substituted Rekor evidence", async () => {
  const { verifySigstoreDsseEnvelope } = await import(moduleUrl);
  const policy = policyForCliFixture();
  const mutations = [
    ["missing tlog", (bundle) => { delete bundle.verificationMaterial.tlogEntries; }, /transparency log/i],
    ["wrong log ID", (bundle) => { bundle.verificationMaterial.tlogEntries[0].logId.keyId = Buffer.alloc(32, 7).toString("base64"); }, /log ID/i],
    ["bad SET", (bundle) => { const entry = bundle.verificationMaterial.tlogEntries[0]; entry.inclusionPromise.signedEntryTimestamp = flipBase64(entry.inclusionPromise.signedEntryTimestamp); }, /signed entry timestamp|SET/i],
    ["substituted body", (bundle) => { const entry = bundle.verificationMaterial.tlogEntries[0]; const body = JSON.parse(Buffer.from(entry.canonicalizedBody, "base64")); body.spec.payloadHash.value = "0".repeat(64); entry.canonicalizedBody = Buffer.from(JSON.stringify(body)).toString("base64"); }, /canonicalized body|SET/i],
    ["bad inclusion proof", (bundle) => { const proof = bundle.verificationMaterial.tlogEntries[0].inclusionProof; proof.hashes[0] = flipBase64(proof.hashes[0]); }, /inclusion proof/i],
    ["bad checkpoint", (bundle) => { const checkpoint = bundle.verificationMaterial.tlogEntries[0].inclusionProof.checkpoint; checkpoint.envelope = checkpoint.envelope.replace("93750551", "93750552"); }, /checkpoint/i],
  ];
  for (const [label, mutate, expectedError] of mutations) {
    const bundle = fixture();
    mutate(bundle);
    assert.throws(
      () => verifySigstoreDsseEnvelope(Buffer.from(JSON.stringify(bundle)), policy),
      expectedError,
      label,
    );
  }
});

test("trusted Rekor time must fall inside the Fulcio leaf validity interval", async () => {
  const { verifySigstoreDsseEnvelope } = await import(moduleUrl);
  const bundle = fixture();
  const policy = policyForCliFixture();
  const leaf = new crypto.X509Certificate(Buffer.from(bundle.verificationMaterial.certificate.rawBytes, "base64"));
  const afterLeafExpiry = Math.floor(Date.parse(leaf.validTo) / 1000) + 1;
  replaceWithSyntheticTransparencyEntry(bundle, policy, afterLeafExpiry);
  assert.throws(
    () => verifySigstoreDsseEnvelope(Buffer.from(JSON.stringify(bundle)), policy),
    /integrated time.*Fulcio certificate validity/i,
  );
});
