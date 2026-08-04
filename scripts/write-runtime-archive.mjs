#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createDeterministicRuntimeArchive } from "./runtime-archive.mjs";

function parse(argv) {
  if (argv.length !== 8) throw new Error("Expected --pack-parent, --pack-root, --kind, and --output");
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    if (!["pack-parent", "pack-root", "kind", "output"].includes(key) || values[key]) throw new Error(`Invalid archive writer argument: ${argv[index]}`);
    values[key] = argv[index + 1];
  }
  return values;
}

async function main() {
  const options = parse(process.argv.slice(2));
  const packParent = path.resolve(options["pack-parent"]);
  const packRoot = path.resolve(options["pack-root"]);
  const output = path.resolve(options.output);
  if (path.dirname(packRoot) !== packParent) throw new Error("Pack root must be an immediate child of pack parent");
  const body = await createDeterministicRuntimeArchive(packParent, packRoot, options.kind);
  const handle = await fs.promises.open(output, "wx", 0o600);
  try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
  if (process.platform !== "win32") {
    const directory = await fs.promises.open(path.dirname(output), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  process.stdout.write(`${JSON.stringify({ node: process.version, zlib: process.versions.zlib, bytes: body.length })}\n`);
}

main().catch((error) => {
  console.error(`[runtime-archive-writer] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
