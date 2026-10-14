"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const repositoryRoot = path.resolve(__dirname, "..");
const script = path.join(repositoryRoot, "scripts", "runtime-platform-versions.mjs");
const modulePromise = import(pathToFileURL(script).href);

function table(platforms, releaseRoot = "https://github.com/liaocaoxuezhe/obsidian-extension/releases/download") {
  return { schemaVersion: 1, releaseRoot, platforms };
}

const reviewed = table({
  "darwin-arm64": { version: "node22-v1" },
  "win32-x64": { version: "node22-v2", windows: { visualCppRuntime: "bundled", directMl: "stripped" } },
});

test("the reviewed table moves only Windows to node22-v2 and keeps macOS on its published version", async () => {
  const { loadPlatformVersionTable, platformVersionMap } = await modulePromise;
  const checkedIn = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "runtime-package", "platform-versions.json"), "utf8"));
  assert.deepEqual(checkedIn, reviewed);
  assert.deepEqual(platformVersionMap(loadPlatformVersionTable()), { "darwin-arm64": "node22-v1", "win32-x64": "node22-v2" });
});

test("platform version table rejects unsupported platforms, versions and Windows profiles", async () => {
  const { parsePlatformVersionTable } = await modulePromise;
  assert.doesNotThrow(() => parsePlatformVersionTable(reviewed));
  const invalid = [
    [{ ...reviewed, schemaVersion: 2 }, /schemaVersion/],
    [table(reviewed.platforms, "http://github.com/x/releases/download"), /releaseRoot/],
    [table(reviewed.platforms, "https://github.com/x/releases/download/latest"), /releaseRoot/],
    [table({ ...reviewed.platforms, "darwin-x64": { version: "node22-v1" } }), /exactly darwin-arm64, win32-x64/],
    [table({ "win32-x64": reviewed.platforms["win32-x64"], "darwin-arm64": reviewed.platforms["darwin-arm64"] }), /in that order/],
    [table({ ...reviewed.platforms, "darwin-arm64": { version: "v2" } }), /node22-vN/],
    [table({ ...reviewed.platforms, "darwin-arm64": { version: "node22-v1", windows: reviewed.platforms["win32-x64"].windows } }), /cannot declare a Windows payload profile/],
    [table({ ...reviewed.platforms, "win32-x64": { version: "node22-v2" } }), /must declare windows/],
    [table({ ...reviewed.platforms, "win32-x64": { version: "node22-v2", windows: { visualCppRuntime: "system", directMl: "kept" } } }), /must declare windows/],
    [table({ ...reviewed.platforms, "darwin-arm64": { version: "node22-v1", url: "https://example.invalid" } }), /unexpected fields/],
  ];
  for (const [value, error] of invalid) assert.throws(() => parsePlatformVersionTable(value), error);
});

test("runtime names derive from the per-platform version", async () => {
  const { packFileName, packRootName, runtimeAssetId, runtimeReleaseBaseUrl, runtimeReleaseTag } = await modulePromise;
  assert.equal(packRootName("node22-v2"), "analogy-embedding-runtime-node22-v2");
  assert.equal(packFileName("node22-v2", "win32-x64"), "analogy-embedding-runtime-node22-v2-win32-x64.zip");
  assert.equal(packFileName("node22-v1", "darwin-arm64"), "analogy-embedding-runtime-node22-v1-darwin-arm64.tar.gz");
  assert.equal(runtimeAssetId("node22-v2", "win32-x64"), "embedding-runtime-node22-v2-win32-x64");
  assert.equal(runtimeReleaseTag("node22-v2"), "runtime-node22-v2");
  assert.equal(runtimeReleaseBaseUrl("https://example.test/releases/download", "node22-v1"), "https://example.test/releases/download/runtime-node22-v1");
  assert.throws(() => packRootName("node22-v1/../x"), /invalid runtime version/);
});

test("a runtime release publishes one version and carries every other platform from its own release", async () => {
  const { parsePlatformVersionTable, planRuntimeRelease } = await modulePromise;
  const parsed = parsePlatformVersionTable(reviewed);
  assert.deepEqual(planRuntimeRelease("win32-x64", parsed), {
    tag: "runtime-node22-v2",
    version: "node22-v2",
    platforms: ["win32-x64"],
    carried: [{
      platform: "darwin-arm64",
      version: "node22-v1",
      tag: "runtime-node22-v1",
      fileName: "analogy-embedding-runtime-node22-v1-darwin-arm64.tar.gz",
    }],
  });
  assert.throws(() => planRuntimeRelease("darwin-arm64,win32-x64", parsed), /span node22-v1, node22-v2/);
  assert.throws(() => planRuntimeRelease("darwin-x64", parsed), /unsupported platforms: darwin-x64/);
  assert.throws(() => planRuntimeRelease("win32-x64,win32-x64", parsed), /duplicate platforms/);
  assert.throws(() => planRuntimeRelease("", parsed), /at least one platform/);
});

test("workflow helper refuses a runtime tag that does not match the selected platforms", () => {
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  const good = run("plan", "--platforms", "win32-x64", "--tag", "runtime-node22-v2");
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).tag, "runtime-node22-v2");
  const wrongTag = run("plan", "--platforms", "win32-x64", "--tag", "runtime-node22-v1");
  assert.notEqual(wrongTag.status, 0);
  assert.match(wrongTag.stderr, /does not match runtime-node22-v2/);
  const ciBuild = run("plan", "--platforms", "darwin-arm64,win32-x64");
  assert.equal(ciBuild.status, 0, "non-publishing CI builds every platform at its own version");
  const downloads = run("downloads");
  assert.equal(downloads.stdout, [
    "runtime-node22-v1 analogy-embedding-runtime-node22-v1-darwin-arm64.tar.gz",
    "runtime-node22-v2 analogy-embedding-runtime-node22-v2-win32-x64.zip",
    "",
  ].join("\n"));
  assert.equal(run("archive", "--platform", "win32-x64").stdout, "analogy-embedding-runtime-node22-v2-win32-x64.zip");
});

test("release verification requires the runtime manifest to follow the reviewed version table", async () => {
  const validator = await import(pathToFileURL(path.join(repositoryRoot, "scripts", "runtime-package-validator.mjs")).href);
  assert.deepEqual(validator.EXPECTED_PACKS.map((pack) => [pack.platform, pack.version, pack.fileName, pack.windows]), [
    ["darwin-arm64", "node22-v1", "analogy-embedding-runtime-node22-v1-darwin-arm64.tar.gz", null],
    ["win32-x64", "node22-v2", "analogy-embedding-runtime-node22-v2-win32-x64.zip", { visualCppRuntime: "bundled", directMl: "stripped" }],
  ]);
  const prepare = fs.readFileSync(path.join(repositoryRoot, "scripts", "prepare-release.mjs"), "utf8");
  assert.match(prepare, /platformVersionMap\(\)/);
  assert.doesNotMatch(prepare, /node22-v\d/, "release verification must not hard-code a runtime version");
  for (const file of ["build-embedding-runtime.mjs", "generate-runtime-manifest.mjs", "runtime-package-validator.mjs",
    "local-development-build.mjs", "run-native-runtime-smoke.mjs"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(repositoryRoot, "scripts", file), "utf8"), /node22-v\d/, file);
  }
});
