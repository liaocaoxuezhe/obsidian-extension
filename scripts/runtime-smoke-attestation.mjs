import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

export const SIGSTORE_BUNDLE_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle.v0.3+json";
export const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const NATIVE_SMOKE_PREDICATE_TYPE = "https://github.com/liaocaoxuezhe/obsidian-extension/attestations/native-runtime-smoke/v1";
export const SIGSTORE_TRUSTED_ROOT_MEDIA_TYPE = "application/vnd.dev.sigstore.trustedroot+json;version=0.1";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PRODUCTION_TRUST_PATH = path.resolve(SCRIPT_DIRECTORY, "..", "runtime-package", "native-smoke-trust.json");
const PRODUCTION_TRUSTED_ROOT_SNAPSHOT = "sigstore-public-good-tuf-2026-08-05-v1";
const PRODUCTION_REKOR_LOG_ID = "wNI9atQGlz+VWfO6LRygH4QUfY/8W4RFwiT5i5WRgB0=";
const SHA256_HEX = /^[0-9a-f]{64}$/;

function githubCertificateExtensionOidDer(extension) {
  if (!Number.isInteger(extension) || extension < 0 || extension > 127) {
    throw new Error("Unsupported GitHub certificate extension OID");
  }
  return Buffer.from([0x06, 0x0a, 0x2b, 0x06, 0x01, 0x04, 0x01, 0x83, 0xbf, 0x30, 0x01, extension]);
}

const GITHUB_CERTIFICATE_EXTENSION_OIDS = Object.freeze({
  issuer: githubCertificateExtensionOidDer(1),
  commit: githubCertificateExtensionOidDer(3),
  repository: githubCertificateExtensionOidDer(5),
  runnerEnvironment: githubCertificateExtensionOidDer(11),
  workflowIdentity: githubCertificateExtensionOidDer(18),
  invocationUri: githubCertificateExtensionOidDer(21),
});

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function strictBase64(value, label) {
  if (typeof value !== "string" || !value || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} must be canonical padded base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error(`${label} is not canonical base64`);
  return decoded;
}

function sha256Bytes(...values) {
  const hash = crypto.createHash("sha256");
  for (const value of values) hash.update(value);
  return hash.digest();
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("Canonical JSON contains an unsupported value");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function requireExactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expectedKeys].sort())) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function safeDecimal(value, label, { minimum = 0 } = {}) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be a canonical decimal string`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum) throw new Error(`${label} is outside the supported integer range`);
  return result;
}

function dssePae(payloadType, payload) {
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType, "utf8")} ${payloadType} ${payload.length} `, "utf8"),
    payload,
  ]);
}

function readDerLength(buffer, offset) {
  if (offset >= buffer.length) throw new Error("truncated DER length");
  const first = buffer[offset];
  if ((first & 0x80) === 0) return { length: first, bytes: 1 };
  const count = first & 0x7f;
  if (count === 0 || count > 4 || offset + 1 + count > buffer.length) throw new Error("invalid DER length");
  let length = 0;
  for (let index = 0; index < count; index += 1) length = (length * 256) + buffer[offset + 1 + index];
  if (length < 128) throw new Error("non-canonical DER length");
  return { length, bytes: 1 + count };
}

function certificateExtensionText(certificate, oidDer, label) {
  const matches = [];
  let cursor = 0;
  while ((cursor = certificate.raw.indexOf(oidDer, cursor)) >= 0) {
    matches.push(cursor);
    cursor += oidDer.length;
  }
  if (matches.length !== 1) throw new Error(`${label} certificate extension must occur exactly once`);
  cursor = matches[0] + oidDer.length;
  if (certificate.raw[cursor] === 0x01) {
    const criticalLength = readDerLength(certificate.raw, cursor + 1);
    cursor += 1 + criticalLength.bytes + criticalLength.length;
  }
  if (certificate.raw[cursor] !== 0x04) throw new Error(`${label} certificate extension is malformed`);
  const valueLength = readDerLength(certificate.raw, cursor + 1);
  const valueStart = cursor + 1 + valueLength.bytes;
  const valueEnd = valueStart + valueLength.length;
  if (valueEnd > certificate.raw.length) throw new Error(`${label} certificate extension is truncated`);
  let value = certificate.raw.subarray(valueStart, valueEnd);
  if ([0x0c, 0x16].includes(value[0])) {
    const innerLength = readDerLength(value, 1);
    const start = 1 + innerLength.bytes;
    if (start + innerLength.length !== value.length) throw new Error(`${label} certificate extension has trailing bytes`);
    value = value.subarray(start);
  }
  return value.toString("utf8");
}

function productionTrustPolicy() {
  const policy = parseJsonBytes(fs.readFileSync(PRODUCTION_TRUST_PATH), "native smoke production trust policy");
  const productionLog = policy.trustedRoot?.tlogs?.[0];
  if (policy.schemaVersion !== 2 || policy.kind !== "sigstore-x509"
    || policy.bundleMediaType !== SIGSTORE_BUNDLE_MEDIA_TYPE
    || policy.issuer !== "https://token.actions.githubusercontent.com"
    || policy.repository !== "liaocaoxuezhe/obsidian-extension"
    || policy.workflow !== ".github/workflows/obsidian-runtime-matrix.yml"
    || policy.workflowRef !== "liaocaoxuezhe/obsidian-extension/.github/workflows/obsidian-runtime-matrix.yml@refs/heads/main"
    || policy.workflowIdentity !== "https://github.com/liaocaoxuezhe/obsidian-extension/.github/workflows/obsidian-runtime-matrix.yml@refs/heads/main"
    || policy.trustedRoot?.mediaType !== SIGSTORE_TRUSTED_ROOT_MEDIA_TYPE
    || policy.trustedRoot?.snapshotVersion !== PRODUCTION_TRUSTED_ROOT_SNAPSHOT
    || !Array.isArray(policy.trustedRoot?.tlogs) || policy.trustedRoot.tlogs.length !== 1
    || productionLog?.baseUrl !== "https://rekor.sigstore.dev"
    || productionLog?.logId?.keyId !== PRODUCTION_REKOR_LOG_ID
    || productionLog?.hashAlgorithm !== "SHA2_256"
    || productionLog?.publicKey?.keyDetails !== "PKIX_ECDSA_P256_SHA_256"
    || productionLog?.checkpointOrigin !== "rekor.sigstore.dev - 1193050959916656506"
    || productionLog?.checkpointSignerName !== "rekor.sigstore.dev"
    || !Array.isArray(policy.certificateAuthorities) || policy.certificateAuthorities.length === 0) {
    throw new Error("Repository native smoke production trust policy is not the fixed GitHub workflow policy");
  }
  return policy;
}

function trustedRekorLog(policy, logId) {
  const root = policy.trustedRoot;
  if (root?.mediaType !== SIGSTORE_TRUSTED_ROOT_MEDIA_TYPE || typeof root.snapshotVersion !== "string"
    || !root.snapshotVersion || !Array.isArray(root.tlogs)) {
    throw new Error("Sigstore transparency log trusted root is missing or unsupported");
  }
  const matches = root.tlogs.filter((candidate) => candidate?.logId?.keyId === logId);
  if (matches.length !== 1) throw new Error("Sigstore transparency log ID is not present exactly once in the fixed trusted root");
  const log = matches[0];
  if (log.hashAlgorithm !== "SHA2_256" || log.publicKey?.keyDetails !== "PKIX_ECDSA_P256_SHA_256"
    || typeof log.checkpointOrigin !== "string" || !log.checkpointOrigin) {
    throw new Error("Sigstore transparency log trust metadata is unsupported");
  }
  const publicKeyRawBytes = strictBase64(log.publicKey.rawBytes, "Rekor public key");
  const actualLogId = sha256Bytes(publicKeyRawBytes);
  if (!actualLogId.equals(strictBase64(logId, "Rekor log ID")) || actualLogId.length !== 32) {
    throw new Error("Sigstore transparency log ID does not match its fixed public key");
  }
  const publicKey = crypto.createPublicKey({ key: publicKeyRawBytes, format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ec" || publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("Rekor trusted log key must be ECDSA P-256");
  }
  return { log, publicKey, publicKeyRawBytes, logIdBytes: actualLogId };
}

function assertTrustedTime(integratedTime, leaf, trustedLog) {
  const integratedMilliseconds = integratedTime * 1000;
  const leafStart = Date.parse(leaf.validFrom);
  const leafEnd = Date.parse(leaf.validTo);
  if (!Number.isFinite(leafStart) || !Number.isFinite(leafEnd)
    || integratedMilliseconds < leafStart || integratedMilliseconds > leafEnd) {
    throw new Error("Rekor integrated time is outside the Fulcio certificate validity interval");
  }
  const logStart = Date.parse(trustedLog.log.publicKey?.validFor?.start);
  const logEndValue = trustedLog.log.publicKey?.validFor?.end;
  const logEnd = logEndValue === undefined ? Number.POSITIVE_INFINITY : Date.parse(logEndValue);
  if (!Number.isFinite(logStart) || (!Number.isFinite(logEnd) && logEnd !== Number.POSITIVE_INFINITY)
    || integratedMilliseconds < logStart || integratedMilliseconds > logEnd) {
    throw new Error("Rekor integrated time is outside the trusted log key validity interval");
  }
}

function verifyRekorDsseBody(bodyBytes, envelope, leaf) {
  let bodyText;
  try {
    bodyText = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
  } catch {
    throw new Error("Rekor canonicalized body is not valid UTF-8");
  }
  const body = parseJsonBytes(Buffer.from(bodyText, "utf8"), "Rekor canonicalized body");
  if (bodyText !== canonicalJson(body)) throw new Error("Rekor canonicalized body is not RFC 8785 canonical JSON");
  requireExactKeys(body, ["apiVersion", "kind", "spec"], "Rekor canonicalized body");
  requireExactKeys(body.spec, ["envelopeHash", "payloadHash", "signatures"], "Rekor DSSE body spec");
  requireExactKeys(body.spec.envelopeHash, ["algorithm", "value"], "Rekor DSSE envelope hash");
  requireExactKeys(body.spec.payloadHash, ["algorithm", "value"], "Rekor DSSE payload hash");
  if (body.apiVersion !== "0.0.1" || body.kind !== "dsse"
    || body.spec.envelopeHash.algorithm !== "sha256" || !SHA256_HEX.test(body.spec.envelopeHash.value || "")
    || body.spec.payloadHash.algorithm !== "sha256" || !SHA256_HEX.test(body.spec.payloadHash.value || "")
    || !Array.isArray(body.spec.signatures) || body.spec.signatures.length !== 1) {
    throw new Error("Rekor canonicalized body is not a supported dsse@0.0.1 entry");
  }
  const loggedSignature = body.spec.signatures[0];
  requireExactKeys(loggedSignature, ["signature", "verifier"], "Rekor DSSE signature binding");
  const loggedVerifier = strictBase64(loggedSignature.verifier, "Rekor DSSE certificate verifier").toString("utf8");
  if (loggedSignature.signature !== envelope.signatures[0].sig || loggedVerifier !== leaf.toString()) {
    throw new Error("Rekor canonicalized body is not bound to the current DSSE signature and Fulcio certificate");
  }
  const payload = strictBase64(envelope.payload, "DSSE payload");
  if (body.spec.payloadHash.value !== sha256Bytes(payload).toString("hex")) {
    throw new Error("Rekor canonicalized body is not bound to the current DSSE payload");
  }
  const rekorEnvelope = {
    payload: envelope.payload,
    payloadType: envelope.payloadType,
    signatures: envelope.signatures.map((signature) => (
      signature.keyid ? { keyid: signature.keyid, sig: signature.sig } : { sig: signature.sig }
    )),
  };
  if (body.spec.envelopeHash.value !== sha256Bytes(Buffer.from(JSON.stringify(rekorEnvelope), "utf8")).toString("hex")) {
    throw new Error("Rekor canonicalized body is not bound to the current serialized DSSE envelope");
  }
  return body;
}

function verifyCheckpoint(checkpoint, proof, trustedLog) {
  requireExactKeys(checkpoint, ["envelope"], "Rekor checkpoint");
  if (typeof checkpoint.envelope !== "string" || !checkpoint.envelope.endsWith("\n")) {
    throw new Error("Rekor checkpoint envelope is malformed");
  }
  const separator = checkpoint.envelope.lastIndexOf("\n\n");
  if (separator < 0) throw new Error("Rekor checkpoint has no signed-note separator");
  const note = checkpoint.envelope.slice(0, separator + 1);
  const signatureBlock = checkpoint.envelope.slice(separator + 2, -1);
  if (signatureBlock.includes("\n")) throw new Error("Rekor checkpoint must contain exactly one signature");
  const signatureMatch = signatureBlock.match(/^— ([^\s]+) ([A-Za-z0-9+/]+={0,2})$/);
  const signerName = trustedLog.log.checkpointSignerName || new URL(trustedLog.log.baseUrl).hostname;
  if (!signatureMatch || signatureMatch[1] !== signerName) throw new Error("Rekor checkpoint signer identity is not trusted");
  const signedNote = strictBase64(signatureMatch[2], "Rekor checkpoint signature");
  if (signedNote.length < 5 || !signedNote.subarray(0, 4).equals(trustedLog.logIdBytes.subarray(0, 4))
    || !crypto.verify("sha256", Buffer.from(note, "utf8"), trustedLog.publicKey, signedNote.subarray(4))) {
    throw new Error("Rekor checkpoint signature verification failed");
  }
  const lines = note.split("\n");
  if (lines.length !== 4 || lines[0] !== trustedLog.log.checkpointOrigin || lines[3] !== "") {
    throw new Error("Rekor checkpoint origin or format is not the fixed trusted log checkpoint");
  }
  const checkpointSize = safeDecimal(lines[1], "Rekor checkpoint tree size", { minimum: 1 });
  const checkpointRoot = strictBase64(lines[2], "Rekor checkpoint root hash");
  if (checkpointRoot.length !== 32 || checkpointSize !== proof.treeSize || !checkpointRoot.equals(proof.rootHash)) {
    throw new Error("Rekor checkpoint does not bind the inclusion proof tree size and root hash");
  }
}

function verifyInclusionProof(bodyBytes, inclusionProof, trustedLog) {
  requireExactKeys(inclusionProof, ["logIndex", "rootHash", "treeSize", "hashes", "checkpoint"], "Rekor inclusion proof");
  const logIndex = safeDecimal(inclusionProof.logIndex, "Rekor inclusion proof log index");
  const treeSize = safeDecimal(inclusionProof.treeSize, "Rekor inclusion proof tree size", { minimum: 1 });
  const rootHash = strictBase64(inclusionProof.rootHash, "Rekor inclusion proof root hash");
  if (logIndex >= treeSize || rootHash.length !== 32 || !Array.isArray(inclusionProof.hashes) || inclusionProof.hashes.length > 64) {
    throw new Error("Rekor inclusion proof has invalid index, size, root, or hash count");
  }
  const siblings = inclusionProof.hashes.map((hash, index) => {
    const value = strictBase64(hash, `Rekor inclusion proof hash ${index}`);
    if (value.length !== 32) throw new Error(`Rekor inclusion proof hash ${index} must be SHA-256`);
    return value;
  });
  let current = sha256Bytes(Buffer.from([0]), bodyBytes);
  let nodeIndex = BigInt(logIndex);
  let lastNode = BigInt(treeSize - 1);
  for (const sibling of siblings) {
    if ((nodeIndex & 1n) === 1n || nodeIndex === lastNode) {
      current = sha256Bytes(Buffer.from([1]), sibling, current);
      while ((nodeIndex & 1n) === 0n && nodeIndex !== 0n) {
        nodeIndex >>= 1n;
        lastNode >>= 1n;
      }
    } else {
      current = sha256Bytes(Buffer.from([1]), current, sibling);
    }
    nodeIndex >>= 1n;
    lastNode >>= 1n;
  }
  if (lastNode !== 0n || !current.equals(rootHash)) throw new Error("Rekor inclusion proof does not reconstruct the signed checkpoint root");
  const proof = { logIndex, treeSize, rootHash };
  verifyCheckpoint(inclusionProof.checkpoint, proof, trustedLog);
  return proof;
}

function verifyTransparencyLogEntry(bundle, envelope, leaf, policy) {
  const entries = bundle.verificationMaterial?.tlogEntries;
  if (!Array.isArray(entries) || entries.length !== 1) {
    throw new Error("Production Sigstore bundle must contain exactly one transparency log entry");
  }
  const entry = entries[0];
  requireExactKeys(entry, ["logIndex", "logId", "kindVersion", "integratedTime", "inclusionPromise", "inclusionProof", "canonicalizedBody"], "Sigstore transparency log entry");
  requireExactKeys(entry.logId, ["keyId"], "Rekor log ID");
  requireExactKeys(entry.kindVersion, ["kind", "version"], "Rekor entry kind/version");
  requireExactKeys(entry.inclusionPromise, ["signedEntryTimestamp"], "Rekor inclusion promise");
  if (entry.kindVersion.kind !== "dsse" || entry.kindVersion.version !== "0.0.1") {
    throw new Error("Production Sigstore bundle requires a Rekor dsse@0.0.1 entry");
  }
  const logIdBytes = strictBase64(entry.logId.keyId, "Rekor log ID");
  if (logIdBytes.length !== 32) throw new Error("Rekor log ID must be SHA-256");
  const trustedLog = trustedRekorLog(policy, entry.logId.keyId);
  const bodyBytes = strictBase64(entry.canonicalizedBody, "Rekor canonicalized body");
  verifyRekorDsseBody(bodyBytes, envelope, leaf);
  const logIndex = safeDecimal(entry.logIndex, "Rekor SET log index");
  const integratedTime = safeDecimal(entry.integratedTime, "Rekor integrated time", { minimum: 1 });
  const setPayload = canonicalJson({
    body: entry.canonicalizedBody,
    integratedTime,
    logID: logIdBytes.toString("hex"),
    logIndex,
  });
  const signedEntryTimestamp = strictBase64(entry.inclusionPromise.signedEntryTimestamp, "Rekor signed entry timestamp");
  if (!crypto.verify("sha256", Buffer.from(setPayload, "utf8"), trustedLog.publicKey, signedEntryTimestamp)) {
    throw new Error("Rekor signed entry timestamp (SET) verification failed");
  }
  assertTrustedTime(integratedTime, leaf, trustedLog);
  const proof = verifyInclusionProof(bodyBytes, entry.inclusionProof, trustedLog);
  return {
    bundleMediaType: bundle.mediaType,
    entryKind: "dsse@0.0.1",
    logId: entry.logId.keyId,
    integratedTime,
    inclusionProofLogIndex: proof.logIndex,
    inclusionProofTreeSize: proof.treeSize,
  };
}

function githubCertificateClaims(leaf, policy) {
  const claims = {
    issuer: certificateExtensionText(leaf, GITHUB_CERTIFICATE_EXTENSION_OIDS.issuer, "GitHub OIDC issuer"),
    commit: certificateExtensionText(leaf, GITHUB_CERTIFICATE_EXTENSION_OIDS.commit, "GitHub commit"),
    repository: certificateExtensionText(leaf, GITHUB_CERTIFICATE_EXTENSION_OIDS.repository, "GitHub repository"),
    runnerEnvironment: certificateExtensionText(leaf, GITHUB_CERTIFICATE_EXTENSION_OIDS.runnerEnvironment, "GitHub runner environment"),
    workflowIdentity: certificateExtensionText(leaf, GITHUB_CERTIFICATE_EXTENSION_OIDS.workflowIdentity, "GitHub workflow identity"),
  };
  const invocationUri = certificateExtensionText(
    leaf,
    GITHUB_CERTIFICATE_EXTENSION_OIDS.invocationUri,
    "GitHub workflow invocation URI",
  );
  const invocationPrefix = `https://github.com/${claims.repository}/actions/runs/`;
  const invocation = invocationUri.startsWith(invocationPrefix)
    ? invocationUri.slice(invocationPrefix.length).match(/^([1-9][0-9]*)\/attempts\/([1-9][0-9]*)$/)
    : null;
  if (!invocation || !Number.isSafeInteger(Number(invocation[2]))) {
    throw new Error("Fulcio certificate has an invalid GitHub workflow invocation URI");
  }
  claims.runId = invocation[1];
  claims.runAttempt = Number(invocation[2]);
  if (claims.issuer !== policy.issuer || claims.repository !== policy.repository
    || claims.workflowIdentity !== policy.workflowIdentity
    || claims.workflowIdentity !== `https://github.com/${policy.workflowRef}`
    || claims.runnerEnvironment !== "github-hosted"
    || !/^[0-9a-f]{40}$/.test(claims.commit)) {
    throw new Error("Fulcio certificate claims do not match the pinned GitHub release workflow policy");
  }
  return claims;
}

function x509LeafFromBundle(bundle, policy) {
  const material = bundle.verificationMaterial;
  if (!material || material.publicKey !== undefined) throw new Error("Production smoke bundle must contain a Fulcio signing certificate");
  let encodedLeaf = material.certificate?.rawBytes;
  const chain = material.x509CertificateChain?.certificates;
  if (Array.isArray(chain)) {
    if (chain.length !== 1 || encodedLeaf !== undefined) throw new Error("Smoke bundle must contain exactly one Fulcio leaf certificate");
    encodedLeaf = chain[0]?.rawBytes;
  }
  const leaf = new crypto.X509Certificate(strictBase64(encodedLeaf, "Fulcio leaf certificate"));
  if (leaf.publicKey.asymmetricKeyType !== "ec" || leaf.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("Fulcio leaf certificate must use ECDSA P-256");
  }
  const trusted = policy.certificateAuthorities.some((authority) => {
    try {
      const intermediate = new crypto.X509Certificate(strictBase64(authority.intermediateRawBytes, "Fulcio intermediate"));
      const root = new crypto.X509Certificate(strictBase64(authority.rootRawBytes, "Fulcio root"));
      return leaf.checkIssued(intermediate) && leaf.verify(intermediate.publicKey)
        && intermediate.checkIssued(root) && intermediate.verify(root.publicKey)
        && root.checkIssued(root) && root.verify(root.publicKey);
    } catch {
      return false;
    }
  });
  if (!trusted) throw new Error("Fulcio certificate chain is not rooted in the pinned production trust root");
  if (leaf.subjectAltName !== `URI:${policy.workflowIdentity}`) {
    throw new Error("Fulcio certificate workflow identity does not match the pinned release workflow");
  }
  return { leaf, githubClaims: githubCertificateClaims(leaf, policy) };
}

function publicKeyFromBundle(bundle, policy) {
  if (policy.kind !== "public-key") throw new Error("Untrusted public-key smoke bundle");
  const material = bundle.verificationMaterial;
  if (!material || material.certificate !== undefined || material.x509CertificateChain !== undefined
    || material.publicKey?.hint !== policy.keyId) {
    throw new Error("Smoke bundle public key hint does not match the supplied verification policy");
  }
  const publicKey = crypto.createPublicKey(policy.publicKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Test/public-key DSSE policy must use Ed25519");
  const actualKeyId = crypto.createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
  if (actualKeyId !== policy.keyId) throw new Error("Smoke bundle public key ID mismatch");
  return publicKey;
}

function verifyPolicyClaims(predicate, policy, githubClaims) {
  const provenance = predicate?.provenance;
  if (provenance?.issuer !== policy.issuer || provenance?.repository !== policy.repository
    || provenance?.workflow !== policy.workflow || provenance?.workflowRef !== policy.workflowRef
    || provenance?.workflowIdentity !== policy.workflowIdentity
    || !/^[0-9a-f]{40}$/.test(provenance?.commit || "")
    || typeof provenance?.runId !== "string" || !/^[1-9][0-9]*$/.test(provenance.runId)
    || !Number.isSafeInteger(provenance?.runAttempt) || provenance.runAttempt < 1
    || predicate?.runner?.workflowRunId !== provenance.runId) {
    throw new Error("Signed native smoke provenance does not match the pinned issuer, repository, workflow, commit, and run identity");
  }
  if (policy.kind === "sigstore-x509" && (!githubClaims
    || provenance.issuer !== githubClaims.issuer
    || provenance.repository !== githubClaims.repository
    || provenance.workflowIdentity !== githubClaims.workflowIdentity
    || provenance.commit !== githubClaims.commit
    || provenance.runId !== githubClaims.runId
    || provenance.runAttempt !== githubClaims.runAttempt
    || predicate?.runner?.environment !== githubClaims.runnerEnvironment)) {
    throw new Error("Signed native smoke provenance is not bound to the Fulcio GitHub OIDC certificate claims");
  }
}

export function verifySigstoreDsseEnvelope(bundleBytes, trustPolicy) {
  if (!Buffer.isBuffer(bundleBytes) || bundleBytes.length === 0) {
    throw new Error("Native smoke proof must be a cryptographically signed Sigstore DSSE bundle");
  }
  const bundle = parseJsonBytes(bundleBytes, "native smoke Sigstore bundle");
  const policy = trustPolicy || productionTrustPolicy();
  if (!policy || !["sigstore-x509", "public-key"].includes(policy.kind)
    || bundle.mediaType !== SIGSTORE_BUNDLE_MEDIA_TYPE
    || bundle.mediaType !== (policy.bundleMediaType || SIGSTORE_BUNDLE_MEDIA_TYPE)) {
    throw new Error("Native smoke proof must be a cryptographically signed Sigstore DSSE bundle");
  }
  const envelope = bundle.dsseEnvelope;
  if (!envelope || envelope.payloadType !== IN_TOTO_PAYLOAD_TYPE
    || !Array.isArray(envelope.signatures) || envelope.signatures.length !== 1) {
    throw new Error("Native smoke proof must contain exactly one in-toto DSSE signature");
  }
  const payload = strictBase64(envelope.payload, "DSSE payload");
  const signature = strictBase64(envelope.signatures[0]?.sig, "DSSE signature");
  const x509Verification = policy.kind === "sigstore-x509" ? x509LeafFromBundle(bundle, policy) : null;
  const publicKey = x509Verification?.leaf || publicKeyFromBundle(bundle, policy);
  if (policy.kind === "public-key" && envelope.signatures[0]?.keyid !== policy.keyId) {
    throw new Error("DSSE signature key ID does not match the trusted public key");
  }
  const algorithm = publicKey instanceof crypto.X509Certificate ? "sha256" : null;
  const verificationKey = publicKey instanceof crypto.X509Certificate ? publicKey.publicKey : publicKey;
  if (!crypto.verify(algorithm, dssePae(envelope.payloadType, payload), verificationKey, signature)) {
    throw new Error("Native smoke DSSE signature verification failed");
  }
  const transparencyLog = x509Verification
    ? verifyTransparencyLogEntry(bundle, envelope, x509Verification.leaf, policy)
    : null;
  const statement = parseJsonBytes(payload, "signed native smoke statement");
  if (statement?._type !== IN_TOTO_STATEMENT_TYPE) {
    throw new Error("Sigstore DSSE payload must be an in-toto Statement v1");
  }
  return {
    bundle,
    statement,
    trustPolicy: policy,
    githubClaims: x509Verification?.githubClaims || null,
    transparencyLog,
  };
}

export function verifyNativeSmokeBundle(bundleBytes, { expectedFileName, expectedSha256, trustPolicy } = {}) {
  const verified = verifySigstoreDsseEnvelope(bundleBytes, trustPolicy);
  const { bundle, statement, trustPolicy: policy, githubClaims, transparencyLog } = verified;
  if (statement?._type !== IN_TOTO_STATEMENT_TYPE || statement?.predicateType !== NATIVE_SMOKE_PREDICATE_TYPE
    || !Array.isArray(statement?.subject) || statement.subject.length !== 1
    || statement.subject[0]?.name !== expectedFileName || statement.subject[0]?.digest?.sha256 !== expectedSha256
    || Object.keys(statement.subject[0]?.digest || {}).length !== 1) {
    throw new Error("Signed native smoke statement is not bound to the exact runtime archive subject");
  }
  verifyPolicyClaims(statement.predicate, policy, githubClaims);
  return { bundle, statement, predicate: statement.predicate, trustPolicy: policy, githubClaims, transparencyLog };
}

export function readProductionNativeSmokeTrustPolicy() {
  return productionTrustPolicy();
}
