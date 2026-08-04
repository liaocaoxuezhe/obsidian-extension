const OFFICIAL_NPM_TARBALL = /^https:\/\/registry\.npmjs\.org\/(?:@[^/]+\/)?[^/]+\/-\/[^/?#]+\.tgz$/;
const MUTABLE_SOURCE = /^(?:git(?:\+[^:]+)?:|github:|file:|link:|workspace:)/i;

function isCanonicalSha512Integrity(value) {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value)) return false;
  const encoded = value.slice("sha512-".length);
  const digest = Buffer.from(encoded, "base64");
  return digest.length === 64 && digest.toString("base64") === encoded;
}

function exactStringMap(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actualEntries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en"));
  const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right, "en"));
  return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
}

export function validateRuntimeLockfile(lock, expectedDependencies) {
  if (!lock || typeof lock !== "object" || lock.lockfileVersion !== 3
    || !lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
    throw new Error("Runtime package-lock.json must use lockfileVersion 3 and a packages object");
  }
  if (!expectedDependencies || !exactStringMap(lock.packages[""]?.dependencies, expectedDependencies)) {
    throw new Error("Runtime lock root dependencies must exactly match the reviewed runtime package dependencies");
  }
  if (JSON.stringify(Object.keys(lock.packages[""] || {}).sort()) !== JSON.stringify(["dependencies"])) {
    throw new Error("Runtime lock root package metadata must contain only the exact dependencies map");
  }

  const ortEntries = [];
  for (const [packagePath, metadata] of Object.entries(lock.packages)) {
    if (!packagePath) continue;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error(`Invalid non-root lock entry: ${packagePath}`);
    }
    const resolved = metadata.resolved;
    if (metadata.link === true || (typeof resolved === "string" && MUTABLE_SOURCE.test(resolved))) {
      throw new Error(`Runtime lock entries cannot use link, git, file, or workspace sources: ${packagePath}`);
    }
    if (typeof resolved !== "string" || !OFFICIAL_NPM_TARBALL.test(resolved)) {
      throw new Error(`Every non-root lock entry must pin an official registry HTTPS tarball: ${packagePath}`);
    }
    if (!isCanonicalSha512Integrity(metadata.integrity)) {
      throw new Error(`Every non-root lock entry must pin SHA-512 integrity: ${packagePath}`);
    }
    if (packagePath.endsWith("node_modules/onnxruntime-node")) ortEntries.push(metadata.version);
  }
  if (ortEntries.length !== 1 || ortEntries[0] !== "1.26.0") {
    throw new Error("Runtime lock must resolve exactly one onnxruntime-node@1.26.0");
  }
  return lock;
}
