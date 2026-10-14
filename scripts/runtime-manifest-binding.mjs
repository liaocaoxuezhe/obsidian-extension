import crypto from "node:crypto";

const SIDECAR_FIELDS = new Set([
  "internalManifestFile",
  "internalManifestSha256",
  "noticesFile",
  "noticesSize",
  "noticesSha256",
  "smokeAttestationFile",
  "smokeAttestationSha256",
  "completionMarkerFile",
  "completionMarkerSha256",
]);
const EXACT_DEVELOPMENT_FIXTURE_SOURCE_SHA256 = "9bc4064d8862df6e46ed01e40da23154bc4a4fa6f144783d1bdf230704aea891";

function publicAsset(asset) {
  return Object.fromEntries(Object.entries(asset).filter(([name]) => !SIDECAR_FIELDS.has(name)));
}

function runtimeAsset(asset) {
  return {
    ...publicAsset(asset),
    internalManifestSha256: asset.internalManifestSha256,
  };
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Runtime manifest canonical JSON cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("Runtime manifest canonical JSON contains an unsupported value");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

const RELEASE_TAG_PREFIX = "runtime-";

/** The immutable per-version release directory every asset of that version is served from. */
export function runtimeAssetBaseUrl(releaseRoot, version) {
  return `${releaseRoot}/${RELEASE_TAG_PREFIX}${version}`;
}

function derivedPlatformVersions(assets) {
  return Object.fromEntries(assets.map((asset) => [asset.platform, asset.version]));
}

/**
 * Schema 2: each platform carries its own runtime version and is served from the
 * release tagged with that version, so one platform can be upgraded alone.
 */
function publicRuntimeManifest(releaseManifest) {
  if (!releaseManifest || releaseManifest.schemaVersion !== 2
    || typeof releaseManifest.releaseRoot !== "string" || !releaseManifest.releaseRoot
    || !Array.isArray(releaseManifest.assets) || releaseManifest.assets.length === 0) {
    throw new Error("Canonical staging runtime manifest has no complete public asset matrix");
  }
  const runtimeVersions = releaseManifest.assets[0]?.runtimeVersions;
  if (!runtimeVersions || typeof runtimeVersions !== "object" || Array.isArray(runtimeVersions)
    || releaseManifest.assets.some((asset) => JSON.stringify(asset.runtimeVersions) !== JSON.stringify(runtimeVersions))) {
    throw new Error("Canonical staging runtime manifest assets do not share one runtimeVersions value");
  }
  const platforms = releaseManifest.assets.map((asset) => asset.platform);
  if (new Set(platforms).size !== platforms.length) {
    throw new Error("Canonical staging runtime manifest lists a platform more than once");
  }
  for (const asset of releaseManifest.assets) {
    if (typeof asset.version !== "string" || typeof asset.fileName !== "string"
      || asset.url !== `${runtimeAssetBaseUrl(releaseManifest.releaseRoot, asset.version)}/${asset.fileName}`) {
      throw new Error(`Runtime asset ${asset.platform} is not served from its own versioned release`);
    }
  }
  if (releaseManifest.platformVersions !== undefined
    && JSON.stringify(releaseManifest.platformVersions) !== JSON.stringify(derivedPlatformVersions(releaseManifest.assets))) {
    throw new Error("Canonical staging runtime manifest platformVersions disagree with its assets");
  }
  return {
    schemaVersion: releaseManifest.schemaVersion,
    releaseRoot: releaseManifest.releaseRoot,
    runtimeVersions,
    assets: releaseManifest.assets.map(publicAsset),
  };
}

function parseSingleJsonExport(source, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...source.matchAll(new RegExp(`export\\s+const\\s+${escapedName}(?:\\s*:[^=;]+)?\\s*=\\s*([\\s\\S]*?);`, "g"))];
  if (matches.length !== 1) throw new Error(`Published canonical generated runtime manifest must export exactly one ${name}`);
  try {
    return JSON.parse(matches[0][1]);
  } catch (error) {
    throw new Error(`Published canonical generated runtime manifest ${name} is not literal JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function computePublicRuntimeManifestSha256(releaseManifest) {
  return crypto.createHash("sha256").update(canonicalJson(publicRuntimeManifest(releaseManifest)), "utf8").digest("hex");
}

export function extractGeneratedRuntimeManifestSha256(source, { allowExactDevelopmentFixture = false } = {}) {
  if (typeof source !== "string") throw new Error("Generated TypeScript runtime manifest source is missing");
  const normalizedSource = source.replace(/\r\n/g, "\n");
  const matches = [...normalizedSource.matchAll(/export const EMBEDDING_RUNTIME_PUBLIC_MANIFEST_SHA256 = "([0-9a-f]{64})" as const;/g)];
  if (matches.length !== 1) throw new Error("Generated TypeScript must contain exactly one public runtime manifest digest constant");
  const declaredDigest = matches[0][1];
  if (normalizedSource.includes('EMBEDDING_RUNTIME_MANIFEST_SOURCE = "development-fixture"')) {
    const sourceSha256 = crypto.createHash("sha256").update(normalizedSource, "utf8").digest("hex");
    if (!allowExactDevelopmentFixture || sourceSha256 !== EXACT_DEVELOPMENT_FIXTURE_SOURCE_SHA256) {
      throw new Error("Build input is not the published canonical generated runtime manifest");
    }
    const markerMatches = [...normalizedSource.matchAll(/ANALOGY_EMBEDDING_RUNTIME_MANIFEST_SHA256:([0-9a-f]{64})/g)];
    if (markerMatches.length !== 1 || markerMatches[0][1] !== declaredDigest) {
      throw new Error("Exact development runtime fixture has an inconsistent build binding");
    }
    return declaredDigest;
  }
  const runtimeVersions = parseSingleJsonExport(normalizedSource, "EMBEDDING_RUNTIME_VERSIONS");
  const assets = parseSingleJsonExport(normalizedSource, "GENERATED_EMBEDDING_RUNTIME_ASSETS");
  const firstAsset = assets[0];
  const suffix = typeof firstAsset?.fileName === "string" && typeof firstAsset?.version === "string"
    ? `/${RELEASE_TAG_PREFIX}${firstAsset.version}/${firstAsset.fileName}`
    : "";
  if (!suffix || typeof firstAsset?.url !== "string" || !firstAsset.url.endsWith(suffix)) {
    throw new Error("Published canonical generated runtime manifest cannot derive its release identity");
  }
  const releaseRoot = firstAsset.url.slice(0, -suffix.length);
  if (assets.some((asset) => asset.url !== `${runtimeAssetBaseUrl(releaseRoot, asset.version)}/${asset.fileName}`
    || JSON.stringify(asset.runtimeVersions) !== JSON.stringify(runtimeVersions))) {
    throw new Error("Published canonical generated runtime manifest assets do not share one release identity");
  }
  const inferredManifest = {
    schemaVersion: 2,
    releaseRoot,
    assets,
  };
  if (computePublicRuntimeManifestSha256(inferredManifest) !== declaredDigest) {
    throw new Error("Published canonical generated runtime manifest digest mismatch");
  }
  if (renderPublishedRuntimeTypeScript(inferredManifest) !== normalizedSource) {
    throw new Error("Build input is not the published canonical generated runtime manifest");
  }
  return declaredDigest;
}

export function renderPublishedRuntimeTypeScript(releaseManifest) {
  const publicManifest = publicRuntimeManifest(releaseManifest);
  const runtimeAssets = releaseManifest.assets.map(runtimeAsset);
  const digest = computePublicRuntimeManifestSha256(releaseManifest);
  return `import type { EmbeddingRuntimeVersions, RuntimeAsset } from "./runtime-types";\n\n`
    + `// Generated by scripts/generate-runtime-manifest.mjs from a complete, cryptographically native-attested CI matrix.\n`
    + `export const EMBEDDING_RUNTIME_MANIFEST_SOURCE = "published" as const;\n`
    + `export const EMBEDDING_RUNTIME_PUBLIC_MANIFEST_SHA256 = "${digest}" as const;\n`
    + `export const EMBEDDING_RUNTIME_BUILD_BINDING = "ANALOGY_EMBEDDING_RUNTIME_MANIFEST_SHA256:${digest}" as const;\n`
    + `export const EMBEDDING_RUNTIME_VERSIONS: EmbeddingRuntimeVersions = ${JSON.stringify(publicManifest.runtimeVersions, null, 2)};\n\n`
    + `export const GENERATED_EMBEDDING_RUNTIME_ASSETS: RuntimeAsset[] = ${JSON.stringify(runtimeAssets, null, 2)};\n`;
}

export function assertGeneratedRuntimeBinding(source, releaseManifest) {
  const expectedSource = renderPublishedRuntimeTypeScript(releaseManifest);
  if (source.replace(/\r\n/g, "\n") !== expectedSource) {
    throw new Error("Generated TypeScript runtime manifest must equal the exact canonical renderer output");
  }
  const publicManifest = publicRuntimeManifest(releaseManifest);
  return {
    runtimeVersions: publicManifest.runtimeVersions,
    assets: publicManifest.assets,
    publicManifestSha256: computePublicRuntimeManifestSha256(releaseManifest),
  };
}

export function runtimePublicAssets(assets) {
  return assets.map(publicAsset);
}
