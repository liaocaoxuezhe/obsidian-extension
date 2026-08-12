#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repositoryRoot = process.cwd();
const packageMetadata = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
const requestedRoot = process.argv[2]
  || path.join("release", packageMetadata.version, "community");
const artifactRoot = path.resolve(requestedRoot);
const requiredFiles = ["main.js", "manifest.json", "styles.css"];

function fail(code) {
  throw new Error(code);
}

const rootStat = fs.lstatSync(artifactRoot);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
  fail("LOCAL_PLUGIN_ARTIFACT_DIRECTORY_INVALID");
}
const files = fs.readdirSync(artifactRoot).sort();
if (JSON.stringify(files) !== JSON.stringify(requiredFiles.slice().sort())) {
  fail("LOCAL_PLUGIN_ARTIFACT_FILE_SET_INVALID");
}
for (const name of requiredFiles) {
  const stat = fs.lstatSync(path.join(artifactRoot, name));
  if (!stat.isFile() || stat.isSymbolicLink()) fail("LOCAL_PLUGIN_ARTIFACT_FILE_INVALID");
}

const bundle = fs.readFileSync(path.join(artifactRoot, "main.js"), "utf8");
if (bundle.includes("development-fixture") || bundle.includes("example.invalid")) {
  fail("LOCAL_PLUGIN_DEVELOPMENT_RUNTIME_FORBIDDEN");
}

const manifest = JSON.parse(fs.readFileSync(path.join(artifactRoot, "manifest.json"), "utf8"));
if (manifest.id !== "analogy-rag-in-your-vault" || manifest.version !== packageMetadata.version) {
  fail("LOCAL_PLUGIN_MANIFEST_INVALID");
}

console.log(`[local-plugin] verified ${artifactRoot}`);
