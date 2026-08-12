const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const guard = path.join(root, "scripts", "build-mode-guard.mjs");

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
}

test("ambiguous and unknown build modes fail before producing output", () => {
  for (const args of [[], ["unknown"]]) {
    const result = run(process.execPath, [guard, ...args]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /BUILD_MODE_REQUIRED/);
  }
  const npmBuild = run("npm", ["run", "build"]);
  assert.notEqual(npmBuild.status, 0);
  assert.match(`${npmBuild.stdout}\n${npmBuild.stderr}`, /BUILD_MODE_REQUIRED/);

  const legacyDirectBuild = run(process.execPath, [path.join(root, "esbuild.config.mjs"), "production"]);
  assert.notEqual(legacyDirectBuild.status, 0);
  assert.match(`${legacyDirectBuild.stdout}\n${legacyDirectBuild.stderr}`, /BUILD_MODE_REQUIRED/);
});

test("mutually exclusive mode markers and a mismatched declared mode fail", () => {
  const conflicting = run(process.execPath, [guard, "ci"], {
    env: { ...process.env, ANALOGY_BUILD_MODE_CI: "1", ANALOGY_BUILD_MODE_RELEASE: "1" },
  });
  assert.notEqual(conflicting.status, 0);
  assert.match(`${conflicting.stdout}\n${conflicting.stderr}`, /BUILD_MODE_CONFLICT/);

  const mismatched = run(process.execPath, [guard, "ci"], {
    env: { ...process.env, ANALOGY_BUILD_MODE: "release" },
  });
  assert.notEqual(mismatched.status, 0);
  assert.match(`${mismatched.stdout}\n${mismatched.stderr}`, /BUILD_MODE_CONFLICT/);
});

test("build:local fails clearly when the local runtime is missing", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-missing-local-runtime-"));
  test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const result = run("npm", ["run", "build:local"], {
    env: {
      ...process.env,
      ANALOGY_LOCAL_DATA_ROOT: temporary,
      ANALOGY_LOCAL_PLUGIN_DIR: path.join(temporary, "plugin"),
      ANALOGY_LOCAL_RUNTIME_PLATFORM: "darwin-arm64",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /LOCAL_DEVELOPMENT_RUNTIME_[A-Z_]+/);
  assert.match(`${result.stdout}\n${result.stderr}`, /npm run setup:local/);
});

test("release preparation rejects a development fixture before reading release metadata", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-release-fixture-"));
  test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const runtimeDirectory = path.join(temporary, "src", "runtime");
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(runtimeDirectory, "generated-embedding-runtime-manifest.ts"),
    'export const EMBEDDING_RUNTIME_MANIFEST_SOURCE = "development-fixture";\nexport const url = "https://example.invalid/runtime.tar.gz";\n',
    "utf8",
  );
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "prepare-release.mjs")], {
    cwd: temporary,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /RELEASE_RUNTIME_FIXTURE_FORBIDDEN/);
});

test("build:ci neither deploys a local plugin nor creates an uploadable release directory", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-ci-build-"));
  test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const pluginDirectory = path.join(temporary, "plugin");
  fs.mkdirSync(pluginDirectory);
  fs.writeFileSync(path.join(pluginDirectory, "sentinel"), "unchanged", "utf8");
  const buildId = `${require(path.join(root, "package.json")).version}+ci.guard-test`;
  const artifactDirectory = path.join(root, "artifacts", buildId);
  fs.rmSync(artifactDirectory, { recursive: true, force: true });

  const result = run("npm", ["run", "build:ci"], {
    env: { ...process.env, ANALOGY_BUILD_ID: buildId, ANALOGY_LOCAL_PLUGIN_DIR: pluginDirectory },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(path.join(pluginDirectory, "sentinel"), "utf8"), "unchanged");
  assert.deepEqual(fs.readdirSync(pluginDirectory), ["sentinel"]);
  assert.equal(fs.existsSync(artifactDirectory), false);
  assert.equal(fs.existsSync(path.join(root, "release", buildId)), false);
});

test("all former ambiguous build callers use an explicit mode", () => {
  const pkg = require(path.join(root, "package.json"));
  assert.equal(pkg.scripts.build, "node scripts/build-mode-guard.mjs");
  assert.match(pkg.scripts.check, /npm run build:ci/);
  assert.match(pkg.scripts["release:prepare"], /npm run build:release/);
  assert.equal(Object.hasOwn(pkg.scripts, "release:prepare:development"), false);
  for (const workflow of ["ci.yml", "obsidian-runtime-matrix.yml"]) {
    const source = fs.readFileSync(path.join(root, ".github", "workflows", workflow), "utf8");
    assert.doesNotMatch(source, /npm run build(?:\s|$)/m, workflow);
    assert.match(source, /npm run build:ci/, workflow);
  }
  const releaseWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
  assert.match(releaseWorkflow, /npm run release:prepare/);
});
