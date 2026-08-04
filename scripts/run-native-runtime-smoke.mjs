import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {fileURLToPath, pathToFileURL} from "node:url";
import {
  EXPECTED_PACKS, SMOKE_MODEL_CATALOG_SHA256, artifactNames, sha256File,
} from "./runtime-package-validator.mjs";
import {NATIVE_SMOKE_PREDICATE_TYPE} from "./runtime-smoke-attestation.mjs";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parse(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    const value = argv[index + 1];
    if (!["platform", "input", "output"].includes(key) || !value || values[key]) throw new Error("Usage: --platform <key> --input <runtime-root> --output <statement.json>");
    values[key] = value;
  }
  if (!values.platform || !values.input || !values.output) throw new Error("platform, input and output are required");
  return values;
}

async function downloadModel(model, modelRoot) {
  fs.mkdirSync(modelRoot, {recursive: true, mode: 0o700});
  for (const file of model.files) {
    const url = `https://huggingface.co/${model.modelId}/resolve/${model.revision}/${file.path}`;
    const response = await fetch(url, {headers: {"user-agent": "Analogy-Native-Smoke/1"}});
    if (!response.ok) throw new Error(`Smoke model download failed: HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length !== file.size || crypto.createHash("sha256").update(body).digest("hex") !== file.sha256) {
      throw new Error(`Smoke model hash mismatch: ${file.path}`);
    }
    const target = path.join(modelRoot, ...file.path.split("/"));
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, body, {mode: 0o600});
  }
}

function runnerIdentity(expected) {
  const expectedOs = expected.platform.startsWith("darwin-") ? "darwin" : "win32";
  const expectedArch = expected.platform.endsWith("arm64") ? "arm64" : "x64";
  const machine = os.machine().toLowerCase() === "amd64" ? "x86_64" : os.machine().toLowerCase();
  if (process.platform !== expectedOs || process.arch !== expectedArch || machine !== (expectedArch === "x64" ? "x86_64" : "arm64")) {
    throw new Error(`Native smoke runner mismatch: ${process.platform}-${process.arch}-${machine}`);
  }
  return {
    os: expectedOs, processArch: expectedArch, osMachine: machine, translated: false, emulated: false,
    environment: "github-hosted", image: process.env.ImageOS || process.env.ImageVersion || "github-hosted",
    workflowRunId: process.env.GITHUB_RUN_ID || "",
  };
}

export async function runNativeRuntimeSmoke({platform, input, output}) {
  const expected = EXPECTED_PACKS.find((entry) => entry.platform === platform);
  if (!expected) throw new Error(`Unsupported platform ${platform}`);
  const runner = runnerIdentity(expected);
  if (!runner.workflowRunId) throw new Error("Native smoke requires a GitHub-hosted workflow run ID");
  const inputRoot = path.resolve(input);
  const names = artifactNames(expected);
  const archivePath = path.join(inputRoot, expected.fileName);
  const manifestPath = path.join(inputRoot, names.manifest);
  const noticesPath = path.join(inputRoot, names.notices);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const modelBytes = fs.readFileSync(path.join(extensionRoot, "runtime-package", "smoke-model.json"));
  if (crypto.createHash("sha256").update(modelBytes).digest("hex") !== SMOKE_MODEL_CATALOG_SHA256) throw new Error("Smoke model catalog hash mismatch");
  const model = JSON.parse(modelBytes.toString("utf8"));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-native-smoke-"));
  try {
    execFileSync("tar", [expected.archive === "tar.gz" ? "-xzf" : "-xf", archivePath, "-C", tempRoot], {stdio: "inherit"});
    const packRoot = path.join(tempRoot, "analogy-embedding-runtime-node22-v1");
    const nodeExecutable = path.join(packRoot, ...manifest.executableRelativePath.split("/"));
    const modelRoot = path.join(tempRoot, "fresh-model-cache", "model");
    await downloadModel(model, modelRoot);
    const transformersModule = path.join(packRoot, "node_modules", "@huggingface", "transformers", "dist", "transformers.node.mjs");
    const smokeProgram = `
      const {env, pipeline} = await import(${JSON.stringify(pathToFileURL(transformersModule).href)});
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      const extractor = await pipeline("feature-extraction", ${JSON.stringify(modelRoot)}, {dtype:"fp32", local_files_only:true});
      const tensor = await extractor("Analogy native runtime smoke", {pooling:"mean", normalize:true});
      const values = Array.from(tensor.data);
      const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
      if (!values.length || values.some((value) => !Number.isFinite(value)) || Math.abs(norm - 1) > 0.01) process.exit(2);
      process.stdout.write(JSON.stringify({dimensions: values.length, finite:true, normalized:true}));
    `;
    const inference = JSON.parse(execFileSync(nodeExecutable, ["--input-type=module", "-e", smokeProgram], {
      encoding: "utf8", windowsHide: true, timeout: 180_000,
      env: {...process.env, TRANSFORMERS_CACHE: path.join(tempRoot, "fresh-model-cache")},
    }));
    const binaries = manifest.files.filter((entry) => entry.path === manifest.executableRelativePath
      || (entry.path.startsWith("node_modules/onnxruntime-node/bin/napi-v6/") && /\.(?:node|dylib|dll)$/i.test(entry.path)))
      .map(({path: binaryPath, size, sha256}) => ({path: binaryPath, size, sha256}));
    const predicate = {
      schemaVersion: 1,
      platform,
      pack: {fileName: expected.fileName, size: fs.statSync(archivePath).size, sha256: sha256File(archivePath),
        internalManifestSha256: sha256File(manifestPath), noticesSha256: sha256File(noticesPath)},
      runner,
      binaries,
      modelCatalogSha256: SMOKE_MODEL_CATALOG_SHA256,
      model,
      cache: {freshTemporary: true, persistentCacheUsed: false, preexistingEntries: 0,
        pathSha256: crypto.createHash("sha256").update(tempRoot).digest("hex")},
      result: {health: "passed", inference: "passed", vectors: 1, dimensions: inference.dimensions,
        finite: inference.finite, normalized: inference.normalized},
      provenance: {
        issuer: "https://token.actions.githubusercontent.com", repository: process.env.GITHUB_REPOSITORY || "",
        workflow: ".github/workflows/obsidian-runtime-matrix.yml",
        workflowRef: `${process.env.GITHUB_REPOSITORY}/.github/workflows/obsidian-runtime-matrix.yml@${process.env.GITHUB_REF}`,
        workflowIdentity: `https://github.com/${process.env.GITHUB_REPOSITORY}/.github/workflows/obsidian-runtime-matrix.yml@${process.env.GITHUB_REF}`,
        commit: process.env.GITHUB_SHA || "", runId: process.env.GITHUB_RUN_ID || "",
        runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT || "0"),
      },
    };
    const statement = {_type: "https://in-toto.io/Statement/v1",
      subject: [{name: expected.fileName, digest: {sha256: predicate.pack.sha256}}],
      predicateType: NATIVE_SMOKE_PREDICATE_TYPE, predicate};
    fs.writeFileSync(path.resolve(output), `${JSON.stringify(statement, null, 2)}\n`, "utf8");
    return statement;
  } finally {
    fs.rmSync(tempRoot, {recursive: true, force: true});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runNativeRuntimeSmoke(parse(process.argv.slice(2))).catch((error) => {
    console.error(`[native-smoke] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
