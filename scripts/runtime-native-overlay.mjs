import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { validateMachOImage } from "./runtime-native-binary.mjs";

export const ORT_NATIVE_OVERLAY_METADATA = "analogy-ort-native-overlay.json";
export const ORT_SOURCE = Object.freeze({
  repository: "https://github.com/microsoft/onnxruntime",
  tag: "v1.26.0",
  commit: "8c546c37b43caaca1fa25db430dab94b901cf277",
});
export const ORT_LICENSE_INPUT = Object.freeze({
  licenseUrl: "https://raw.githubusercontent.com/microsoft/onnxruntime/v1.26.0/LICENSE",
  licenseSha256: "2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c",
  thirdPartyNoticesUrl: "https://raw.githubusercontent.com/microsoft/onnxruntime/v1.26.0/ThirdPartyNotices.txt",
  thirdPartyNoticesSha256: "0e07b95f3a8d6230037707c5c4a2b554d12c4cb67369669ac255635528ffcee2",
});
export const ORT_NATIVE_FILES = Object.freeze([
  "libonnxruntime.1.26.0.dylib",
  "libonnxruntime.1.dylib",
  "onnxruntime_binding.node",
]);

export function validateOrtNativeOverlayProvenance(provenance, platformKey) {
  if (provenance?.schemaVersion !== 1
    || provenance.platform !== platformKey
    || provenance.onnxruntimeVersion !== "1.26.0"
    || JSON.stringify(provenance.source) !== JSON.stringify(ORT_SOURCE)
    || JSON.stringify(provenance.licenseInput) !== JSON.stringify(ORT_LICENSE_INPUT)) {
    throw new Error(`ORT native overlay provenance must identify ${ORT_SOURCE.tag} at ${ORT_SOURCE.commit}`);
  }
  if (!Array.isArray(provenance.files)
    || JSON.stringify(provenance.files.map((entry) => entry?.path)) !== JSON.stringify(ORT_NATIVE_FILES)) {
    throw new Error(`ORT native overlay must describe exactly: ${ORT_NATIVE_FILES.join(", ")}`);
  }
  for (const entry of provenance.files) {
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || !/^[0-9a-f]{64}$/.test(entry.sha256 || "")) {
      throw new Error(`Invalid ORT native overlay metadata for ${entry.path}`);
    }
  }
  return provenance;
}

export function validateOrtNativeOverlayPayload(provenance, platformKey, manifestFiles) {
  validateOrtNativeOverlayProvenance(provenance, platformKey);
  if (!Array.isArray(manifestFiles)) throw new Error("ORT native overlay requires pack payload hashes");
  for (const entry of provenance.files) {
    const payloadPath = `node_modules/onnxruntime-node/bin/napi-v6/darwin/x64/${entry.path}`;
    const payloadEntry = manifestFiles.find((candidate) => candidate.path === payloadPath);
    if (!payloadEntry || payloadEntry.size !== entry.size || payloadEntry.sha256 !== entry.sha256) {
      throw new Error(`darwin-x64 ORT source overlay hash is not bound to pack payload: ${entry.path}`);
    }
  }
}

async function sha256File(filename) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

function requireRegularFile(filename, label) {
  if (!fs.existsSync(filename)) throw new Error(`Missing ${label}: ${path.basename(filename)}`);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${path.basename(filename)}`);
  }
  return stat;
}

function requireThinX64MachO(filename, relativePath) {
  const image = fs.readFileSync(filename);
  const expectedFileTypes = relativePath.endsWith(".node") ? [6, 8] : [6];
  try {
    validateMachOImage(image, "x64", expectedFileTypes, relativePath);
  } catch (error) {
    throw new Error(`ORT native overlay is not a thin x86_64 Mach-O file: ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function verifyOrtNativeOverlay(directory, platformKey) {
  if (platformKey !== "darwin-x64") {
    throw new Error(`ORT native overlay is only supported for darwin-x64, got ${platformKey}`);
  }
  const overlayRoot = path.resolve(directory);
  const rootStat = fs.lstatSync(overlayRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`ORT native overlay must be a real directory: ${overlayRoot}`);
  }

  const metadataPath = path.join(overlayRoot, ORT_NATIVE_OVERLAY_METADATA);
  requireRegularFile(metadataPath, "ORT native overlay metadata");
  const provenance = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  validateOrtNativeOverlayProvenance(provenance, platformKey);

  const files = [];
  for (const entry of provenance.files) {
    const filename = path.join(overlayRoot, entry.path);
    const stat = requireRegularFile(filename, "ORT native overlay file");
    if (stat.size !== entry.size) {
      throw new Error(`ORT native overlay size mismatch for ${entry.path}: expected ${entry.size}, got ${stat.size}`);
    }
    const actualSha256 = await sha256File(filename);
    if (actualSha256 !== entry.sha256) {
      throw new Error(`ORT native overlay SHA-256 mismatch for ${entry.path}: expected ${entry.sha256}, got ${actualSha256}`);
    }
    requireThinX64MachO(filename, entry.path);
    files.push({ absolutePath: filename, relativePath: entry.path, size: entry.size, sha256: entry.sha256 });
  }

  return { root: overlayRoot, provenance, files };
}

export async function installOrtNativeOverlay(verifiedOverlay, destination) {
  await fs.promises.rm(destination, { recursive: true, force: true });
  await fs.promises.mkdir(destination, { recursive: true });
  for (const file of verifiedOverlay.files) {
    const destinationPath = path.join(destination, file.relativePath);
    await fs.promises.copyFile(file.absolutePath, destinationPath);
    await fs.promises.chmod(destinationPath, 0o644);
  }
}
