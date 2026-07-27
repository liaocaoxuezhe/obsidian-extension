const assert = require("assert");
const { spawnSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const verifier = path.join(root, "scripts", "verify-release-version.mjs");

function verify(version) {
  return spawnSync(process.execPath, [verifier, version], {
    cwd: root,
    encoding: "utf8",
  });
}

const matching = verify("1.1.8");
assert.strictEqual(
  matching.status,
  0,
  `matching release metadata must pass:\n${matching.stdout}${matching.stderr}`,
);

const mismatched = verify("1.1.9");
assert.notStrictEqual(
  mismatched.status,
  0,
  "a tag that differs from package metadata must fail",
);
assert.match(
  `${mismatched.stdout}${mismatched.stderr}`,
  /does not match package\.json version 1\.1\.8/,
);

const prefixed = verify("v1.1.8");
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
