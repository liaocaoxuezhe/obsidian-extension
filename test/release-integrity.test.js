const assert = require("assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const publicFiles = new Set(execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { cwd: root, encoding: "utf8" },
).trim().split(/\r?\n/));
for (const file of [
  "scripts/prepare-release.mjs",
  "scripts/verify-local-plugin-artifact.mjs",
  "src/runtime/generated-embedding-runtime-manifest.ts",
  "src/runtime/runtime-manifest.ts",
]) {
  assert.ok(publicFiles.has(file), `${file} must be included in the public release source`);
}

const prepareRelease = fs.readFileSync(path.join(root, "scripts", "prepare-release.mjs"), "utf8");
const verifyArtifact = fs.readFileSync(path.join(root, "scripts", "verify-local-plugin-artifact.mjs"), "utf8");
assert.match(prepareRelease, /COMMUNITY_PLUGIN_FILES[^\n]+main\.js[^\n]+manifest\.json[^\n]+styles\.css/);
assert.match(prepareRelease, /development-fixture/);
assert.match(prepareRelease, /example\.invalid/);
assert.match(verifyArtifact, /requiredFiles\s*=\s*\["main\.js",\s*"manifest\.json",\s*"styles\.css"\]/);
assert.match(verifyArtifact, /LOCAL_PLUGIN_ARTIFACT_FILE_SET_INVALID/);

console.log("Release integrity test passed");
