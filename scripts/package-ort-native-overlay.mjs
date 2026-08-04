import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {ORT_LICENSE_INPUT, ORT_NATIVE_FILES, ORT_SOURCE} from "./runtime-native-overlay.mjs";

function parse(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    const value = argv[index + 1];
    if (!["input", "output"].includes(key) || !value || values[key]) throw new Error("Usage: --input <onnxruntime-build-root> --output <overlay-root>");
    values[key] = value;
  }
  if (!values.input || !values.output) throw new Error("Both --input and --output are required");
  return values;
}

function findFiles(root, basename, results = []) {
  for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) findFiles(target, basename, results);
    else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name === basename) results.push(target);
  }
  return results;
}

function choose(candidates, basename) {
  if (candidates.length === 0) throw new Error(`ORT build did not produce ${basename}`);
  const preferred = candidates.filter((candidate) => /(?:Release|napi-v6[\\/]darwin[\\/]x64)/.test(candidate));
  const choices = preferred.length > 0 ? preferred : candidates;
  choices.sort((left, right) => left.length - right.length || left.localeCompare(right));
  return choices[0];
}

function sha256(filename) {
  return crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

export function packageOrtNativeOverlay({input, output}) {
  const inputRoot = path.resolve(input);
  const outputRoot = path.resolve(output);
  fs.rmSync(outputRoot, {recursive: true, force: true});
  fs.mkdirSync(outputRoot, {recursive: true, mode: 0o700});
  const files = ORT_NATIVE_FILES.map((name) => {
    const source = choose(findFiles(inputRoot, name), name);
    const destination = path.join(outputRoot, name);
    fs.copyFileSync(source, destination);
    const stat = fs.statSync(destination);
    return {path: name, size: stat.size, sha256: sha256(destination)};
  });
  const metadata = {
    schemaVersion: 1,
    platform: "darwin-x64",
    onnxruntimeVersion: "1.26.0",
    source: ORT_SOURCE,
    licenseInput: ORT_LICENSE_INPUT,
    files,
  };
  fs.writeFileSync(path.join(outputRoot, "analogy-ort-native-overlay.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return metadata;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageOrtNativeOverlay(parse(process.argv.slice(2)));
}
