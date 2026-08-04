"use strict";

const { createHash } = require("node:crypto");
const { createReadStream, createWriteStream } = require("node:fs");
const { chmod, lstat, mkdir, rename, rm, stat } = require("node:fs/promises");
const https = require("node:https");
const path = require("node:path");

const REPOSITORY_ROOT = path.resolve(__dirname, "../..");
const TEST_RUNTIME_DIRECTORY = path.join(REPOSITORY_ROOT, "test/.runtime");
const MANIFEST = require("../fixtures/chroma-runtime-manifest.fixture.json");
const VERSION = "cli-1.4.4";
const RELEASE_URL = `https://github.com/chroma-core/chroma/releases/download/${VERSION}`;

function platformKey(platform = process.platform, architecture = process.arch) {
  return `${platform}-${architecture}`;
}

function resolvePinnedAsset(platform = process.platform, architecture = process.arch) {
  const asset = MANIFEST.assets[platformKey(platform, architecture)];
  if (!asset) {
    throw new Error(`Chroma ${VERSION} has no pinned asset for ${platformKey(platform, architecture)}`);
  }
  return {
    ...asset,
    url: `${RELEASE_URL}/${asset.filename}`,
  };
}

function parseArguments(argv) {
  if (argv.length !== 4 || argv[0] !== "--version" || argv[2] !== "--output") {
    throw new Error(`Usage: node test/helpers/download-pinned-chroma.js --version ${VERSION} --output test/.runtime/chroma`);
  }
  if (argv[1] !== VERSION) {
    throw new Error(`Only ${VERSION} is supported; received ${argv[1]}`);
  }
  return { output: argv[3] };
}

function resolveOutputPath(output) {
  const resolved = path.resolve(REPOSITORY_ROOT, output);
  const relative = path.relative(TEST_RUNTIME_DIRECTORY, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Pinned Chroma output must be a file inside test/.runtime/");
  }
  return resolved;
}

function download(url, output) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const redirect = new URL(response.headers.location, url);
        if (redirect.protocol !== "https:") {
          reject(new Error(`Pinned Chroma redirect must use HTTPS: ${redirect}`));
          return;
        }
        download(redirect, output).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Pinned Chroma download failed with HTTP ${response.statusCode}`));
        return;
      }
      const hash = createHash("sha256");
      const file = createWriteStream(output, { flags: "wx" });
      response.on("data", (chunk) => hash.update(chunk));
      response.on("error", reject);
      file.on("error", reject);
      file.on("finish", () => file.close(() => resolve(hash.digest("hex"))));
      response.pipe(file);
    });
    request.on("error", reject);
  });
}

function hashFile(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const file = createReadStream(filename);
    file.on("data", (chunk) => hash.update(chunk));
    file.on("error", reject);
    file.on("end", () => resolve(hash.digest("hex")));
  });
}

async function validateExistingArtifact(filename, asset) {
  try {
    const existing = await lstat(filename);
    if (!existing.isFile() || existing.size !== asset.size) return null;
    const sha256 = await hashFile(filename);
    return sha256 === asset.sha256 ? sha256 : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function downloadPinnedChroma({ version, output, platform, architecture } = {}) {
  if (version !== VERSION) {
    throw new Error(`Only ${VERSION} is supported; received ${version ?? "nothing"}`);
  }
  const asset = resolvePinnedAsset(platform, architecture);
  const outputPath = resolveOutputPath(output);
  await mkdir(TEST_RUNTIME_DIRECTORY, { recursive: true });
  const existingSha256 = await validateExistingArtifact(outputPath, asset);
  if (existingSha256) {
    await chmod(outputPath, 0o755);
    return { ...asset, outputPath, sha256: existingSha256 };
  }
  const temporaryPath = `${outputPath}.partial-${process.pid}-${Date.now()}`;
  await rm(temporaryPath, { force: true });
  try {
    const sha256 = await download(asset.url, temporaryPath);
    const downloaded = await stat(temporaryPath);
    if (downloaded.size !== asset.size) {
      throw new Error(`Pinned Chroma size mismatch: expected ${asset.size}, received ${downloaded.size}`);
    }
    if (sha256 !== asset.sha256) {
      throw new Error(`Pinned Chroma SHA-256 mismatch: expected ${asset.sha256}, received ${sha256}`);
    }
    await chmod(temporaryPath, 0o755);
    await rename(temporaryPath, outputPath);
    return { ...asset, outputPath, sha256 };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function main() {
  const { output } = parseArguments(process.argv.slice(2));
  const result = await downloadPinnedChroma({ version: VERSION, output });
  process.stdout.write(`${VERSION} ${platformKey()} SHA-256 ${result.sha256}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { downloadPinnedChroma, parseArguments, resolvePinnedAsset, resolveOutputPath };
