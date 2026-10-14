#!/usr/bin/env node

/**
 * Bundles the Windows verification harness into one CommonJS file plus the asset
 * descriptors for its upgrade scenario. Used by test/manual/windows-clean-vm.sh.
 *
 *   node test/manual/build-windows-harness.mjs --output <dir> [--runtime-staging dist/runtime] [--from-ref 1.2.7]
 *
 * The "to" runtime comes from the candidate staging manifest (embedding-runtime-manifest.json);
 * the "from" runtime is the Windows entry of the generated manifest at --from-ref (the last
 * plugin release that shipped the superseded version).
 */

import esbuild from "esbuild";
import builtins from "builtin-modules";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const external = ["obsidian", "electron", "@huggingface/transformers", "onnxruntime-common", "onnxruntime-node", ...builtins];

function options(argv) {
  const values = { "runtime-staging": "dist/runtime", "from-ref": "1.2.7" };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/, "");
    if (!["output", "runtime-staging", "from-ref"].includes(name) || argv[index + 1] === undefined) {
      throw new Error("Usage: --output <dir> [--runtime-staging <dir>] [--from-ref <git ref>]");
    }
    values[name] = argv[index + 1];
  }
  if (!values.output) throw new Error("--output is required");
  return values;
}

function windowsAssetFromGenerated(ref) {
  const source = execFileSync("git", ["show", `${ref}:src/runtime/generated-embedding-runtime-manifest.ts`], {
    cwd: repositoryRoot, encoding: "utf8",
  });
  const assets = JSON.parse(source.match(/GENERATED_EMBEDDING_RUNTIME_ASSETS: RuntimeAsset\[\] = ([\s\S]*?);\n/)[1]);
  const asset = assets.find((entry) => entry.platform === "win32-x64");
  if (!asset) throw new Error(`${ref} has no win32-x64 runtime asset`);
  return asset;
}

function windowsAssetFromStaging(stagingRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(stagingRoot, "embedding-runtime-manifest.json"), "utf8"));
  const asset = manifest.assets.find((entry) => entry.platform === "win32-x64");
  if (!asset) throw new Error("candidate staging manifest has no win32-x64 runtime asset");
  return asset;
}

async function main() {
  const values = options(process.argv.slice(2));
  const output = path.resolve(values.output);
  fs.mkdirSync(output, { recursive: true });
  const worker = await esbuild.build({
    entryPoints: [path.join(repositoryRoot, "src/local-vector/embedding-worker.ts")],
    bundle: true, external, format: "cjs", platform: "node", target: "es2020", write: false, logLevel: "warning",
  });
  await esbuild.build({
    entryPoints: [path.join(repositoryRoot, "test/manual/windows-runtime-harness.ts")],
    bundle: true, external, format: "cjs", platform: "node", target: "es2020", logLevel: "warning",
    define: { WORKER_SOURCE: JSON.stringify(worker.outputFiles[0].text) },
    outfile: path.join(output, "harness.cjs"),
  });
  const stagingRoot = path.resolve(repositoryRoot, values["runtime-staging"]);
  const assets = { from: windowsAssetFromGenerated(values["from-ref"]), to: windowsAssetFromStaging(stagingRoot) };
  if (assets.from.id === assets.to.id) throw new Error("upgrade scenario needs two different runtime versions");
  fs.writeFileSync(path.join(output, "assets.json"), `${JSON.stringify(assets, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ harness: path.join(output, "harness.cjs"), from: assets.from.fileName, to: assets.to.fileName })}\n`);
}

main().catch((error) => {
  console.error(`[build-windows-harness] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
