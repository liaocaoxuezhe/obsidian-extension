#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { EXPECTED_PACKS, artifactNames, sha256File } from "./runtime-package-validator.mjs";

function parse(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    if (!["first", "second", "platform"].includes(key) || values[key] || !argv[index + 1]) throw new Error(`Invalid argument: ${argv[index] || "<end>"}`);
    values[key] = argv[index + 1];
  }
  for (const key of ["first", "second", "platform"]) if (!values[key]) throw new Error(`Missing --${key}`);
  return values;
}

function realDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Rebuild input must be a real directory: ${directory}`);
}

function regularHash(root, filename) {
  const pathname = path.join(root, filename);
  const stat = fs.lstatSync(pathname);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Rebuild output must be a regular file: ${pathname}`);
  return { size: stat.size, sha256: sha256File(pathname) };
}

const options = parse(process.argv.slice(2));
const expected = EXPECTED_PACKS.find((entry) => entry.platform === options.platform);
if (!expected) throw new Error(`Unsupported platform: ${options.platform}`);
const first = path.resolve(options.first);
const second = path.resolve(options.second);
realDirectory(first);
realDirectory(second);
const names = artifactNames(expected);
for (const filename of [expected.fileName, names.manifest, names.notices]) {
  const left = regularHash(first, filename);
  const right = regularHash(second, filename);
  if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error(`Clean-runner rebuild mismatch for ${filename}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`);
}
console.log(`[runtime-reproducibility] ${expected.platform} archive and bound sidecars are byte-identical across two clean runner outputs`);
