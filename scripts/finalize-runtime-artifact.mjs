#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_PACKS,
  artifactNames,
  sha256Bytes,
  validateRuntimeArtifactGroup,
} from "./runtime-package-validator.mjs";
import { compareUtf8Bytes } from "./runtime-archive.mjs";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`Invalid argument sequence near ${option || "<end>"}`);
    const name = option.slice(2);
    if (!["platform", "input", "attestation"].includes(name) || values.has(name)) throw new Error(`Unknown or duplicate argument: ${option}`);
    values.set(name, value);
  }
  const missing = ["platform", "input", "attestation"].filter((name) => !values.has(name));
  if (missing.length) throw new Error(`Missing required arguments: ${missing.map((name) => `--${name}`).join(", ")}`);
  return Object.fromEntries(values);
}

function requireRegular(filename, label) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file: ${filename}`);
}

async function writeExclusive(filename, bytes) {
  const handle = await fs.promises.open(filename, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function fsyncDirectory(directory) {
  const handle = await fs.promises.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function finalizeRuntimeArtifact({ platform, inputRoot: requestedInputRoot, attestationSource: requestedAttestationSource, trustPolicy } = {}) {
  const expected = EXPECTED_PACKS.find((candidate) => candidate.platform === platform);
  if (!expected) throw new Error(`Unsupported runtime platform: ${platform}`);
  const inputRoot = path.resolve(requestedInputRoot);
  const inputStat = fs.lstatSync(inputRoot);
  if (!inputStat.isDirectory() || inputStat.isSymbolicLink()) throw new Error("Runtime input must be a real directory");
  const names = artifactNames(expected);
  const sourceNames = [expected.fileName, names.manifest, names.notices];
  for (const filename of sourceNames) requireRegular(path.join(inputRoot, filename), filename);
  const attestationSource = path.resolve(requestedAttestationSource);
  requireRegular(attestationSource, "Native smoke attestation");

  const lockRoot = path.join(inputRoot, ".locks");
  const lockPath = path.join(lockRoot, `${expected.platform}.lock`);
  await fs.promises.mkdir(lockRoot, { recursive: true, mode: 0o700 });
  try {
    await fs.promises.mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`Another runtime publication owns ${expected.platform}`);
    throw error;
  }

  const stageRoot = path.join(inputRoot, `.finalize-${expected.platform}-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  try {
    await fs.promises.mkdir(stageRoot, { mode: 0o700 });
    for (const filename of sourceNames) await writeExclusive(path.join(stageRoot, filename), fs.readFileSync(path.join(inputRoot, filename)));
    await writeExclusive(path.join(stageRoot, names.attestation), fs.readFileSync(attestationSource));
    await fsyncDirectory(stageRoot);

    // Validate the entire staged generation, including pack-bound native smoke,
    // before anything from it becomes visible as complete.
    validateRuntimeArtifactGroup(stageRoot, expected, { requireCompletion: false, trustPolicy });
    const groupNames = [...sourceNames, names.attestation].sort(compareUtf8Bytes);
    const files = groupNames.map((name) => {
      const bytes = fs.readFileSync(path.join(stageRoot, name));
      return { name, size: bytes.length, sha256: sha256Bytes(bytes) };
    });
    const generationId = sha256Bytes(Buffer.from(files.map((entry) => `${entry.name}\0${entry.size}\0${entry.sha256}\n`).join(""), "utf8"));
    const marker = Buffer.from(`${JSON.stringify({ schemaVersion: 1, platform: expected.platform, generationId, files }, null, 2)}\n`, "utf8");
    await writeExclusive(path.join(stageRoot, names.completion), marker);
    await fsyncDirectory(stageRoot);

    await fs.promises.rm(path.join(inputRoot, names.completion), { force: true });
    for (const filename of groupNames) {
      const stat = await fs.promises.lstat(path.join(stageRoot, filename));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Staged artifact changed type: ${filename}`);
      await fs.promises.rm(path.join(inputRoot, filename), { force: true });
      await fs.promises.rename(path.join(stageRoot, filename), path.join(inputRoot, filename));
    }
    // The marker is deliberately last: crashes and mixed generations remain unusable.
    await fs.promises.rename(path.join(stageRoot, names.completion), path.join(inputRoot, names.completion));
    await fsyncDirectory(inputRoot);
    validateRuntimeArtifactGroup(inputRoot, expected, { trustPolicy });
    console.log(`[runtime-finalize] Published completed ${expected.platform} generation ${generationId}`);
  } finally {
    await fs.promises.rm(stageRoot, { recursive: true, force: true });
    await fs.promises.rm(lockPath, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await finalizeRuntimeArtifact({
    platform: options.platform,
    inputRoot: options.input,
    attestationSource: options.attestation,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[runtime-finalize] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
