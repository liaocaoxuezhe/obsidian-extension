const assert = require("assert");
const { spawnSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const verifier = path.join(root, "scripts", "verify-release-version.mjs");
const packageVersion = require(path.join(root, "package.json")).version;
const versionParts = packageVersion.split(".").map(Number);
const mismatchedVersion = `${versionParts[0]}.${versionParts[1]}.${versionParts[2] + 1}`;

function verify(version) {
  return spawnSync(process.execPath, [verifier, version], {
    cwd: root,
    encoding: "utf8",
  });
}

const matching = verify(packageVersion);
assert.strictEqual(
  matching.status,
  0,
  `matching release metadata must pass:\n${matching.stdout}${matching.stderr}`,
);

const mismatched = verify(mismatchedVersion);
assert.notStrictEqual(
  mismatched.status,
  0,
  "a tag that differs from package metadata must fail",
);
assert.match(
  `${mismatched.stdout}${mismatched.stderr}`,
  new RegExp(`does not match package\\.json version ${packageVersion.replaceAll(".", "\\.")}`),
);

const prefixed = verify(`v${packageVersion}`);
assert.notStrictEqual(
  prefixed.status,
  0,
  "Obsidian releases require a bare semantic version tag",
);
assert.match(
  `${prefixed.stdout}${prefixed.stderr}`,
  /bare semantic version/,
);

console.log("Release version verification test passed");
