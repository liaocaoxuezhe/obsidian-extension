const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const verifierUrl = pathToFileURL(path.join(__dirname, "..", "scripts", "verify-test-execution-set.mjs")).href;

function fixture(overrides = {}) {
  return {
    inventory: {
      assets: [{
        path: "test/kept.test.js",
        kind: "test",
        runner: "public",
        ciJob: "public-ci",
        conflictAction: "retain-public",
        testNames: ["kept behavior"],
      }],
      platformSkips: [],
    },
    runnerManifest: { sets: { public: { assets: ["test/kept.test.js"] } } },
    ciManifest: { jobs: { "public-ci": { runners: ["public"] } } },
    trackedAssets: ["test/kept.test.js"],
    diskTests: ["test/kept.test.js"],
    diskTestNames: { "test/kept.test.js": ["kept behavior"] },
    ...overrides,
  };
}

test("an ignored new test on disk fails the inventory gate", async () => {
  const { verifyTestExecutionSet } = await import(verifierUrl);
  const errors = verifyTestExecutionSet(fixture({ diskTests: ["test/kept.test.js", "test/ignored-new.test.js"] }));
  assert.ok(errors.includes("DISK_TEST_NOT_IN_INVENTORY: test/ignored-new.test.js"));
});

test("a tracked test omitted by every runner fails", async () => {
  const { verifyTestExecutionSet } = await import(verifierUrl);
  const errors = verifyTestExecutionSet(fixture({ runnerManifest: { sets: { public: { assets: [] } } } }));
  assert.ok(errors.includes("EXPECTED_NOT_ENUMERATED: test/kept.test.js"));
});

test("a runner test omitted by CI fails", async () => {
  const { verifyTestExecutionSet } = await import(verifierUrl);
  const errors = verifyTestExecutionSet(fixture({ ciManifest: { jobs: { "public-ci": { runners: [] } } } }));
  assert.ok(errors.includes("RUNNER_NOT_IN_CI: test/kept.test.js"));
});

test("a platform skip with complete ownership metadata is valid", async () => {
  const { verifyTestExecutionSet } = await import(verifierUrl);
  const configured = fixture();
  configured.inventory.platformSkips = [{
    path: "test/kept.test.js",
    when: { envMissing: "PINNED_NATIVE_BINARY" },
    reason: "The owning native job provisions this binary.",
    platform: "local-without-native-binary",
    workflowJob: "runtime-matrix/native-runtime",
  }];
  assert.deepEqual(verifyTestExecutionSet(configured), []);
});

test("a test cannot disguise itself as support", async () => {
  const { verifyTestExecutionSet } = await import(verifierUrl);
  const configured = fixture();
  configured.inventory.assets[0].kind = "support";
  assert.ok(verifyTestExecutionSet(configured).includes("TEST_KIND_MISMATCH: test/kept.test.js"));
});

test("inventory runner and CI ownership must agree with both manifests", async () => {
  const { verifyTestExecutionSet } = await import(verifierUrl);
  const configured = fixture();
  configured.inventory.assets[0].runner = "runtime";
  configured.inventory.assets[0].ciJob = "runtime-ci";
  assert.ok(verifyTestExecutionSet(configured).some((error) => error.startsWith("INVENTORY_UNKNOWN_RUNNER:")));
  assert.ok(verifyTestExecutionSet(configured).some((error) => error.startsWith("INVENTORY_CI_OWNERSHIP_MISMATCH:")));
});

test("duplicate inventory and runner paths are rejected", async () => {
  const { verifyTestExecutionSet } = await import(verifierUrl);
  const configured = fixture();
  configured.inventory.assets.push({ ...configured.inventory.assets[0] });
  configured.runnerManifest.sets.public.assets.push("test/kept.test.js");
  const errors = verifyTestExecutionSet(configured);
  assert.ok(errors.includes("INVENTORY_DUPLICATE_PATH"));
  assert.ok(errors.includes("RUNNER_DUPLICATE_ASSET"));
});

test("modern test module extensions are treated as executable tests", async () => {
  const { verifyTestExecutionSet } = await import(verifierUrl);
  for (const pathname of ["test/new.test.cjs", "test/new.test.mjs", "test/new.test.ts", "test/new.test.tsx", "test/new.spec.js"]) {
    const errors = verifyTestExecutionSet(fixture({ diskTests: ["test/kept.test.js", pathname] }));
    assert.ok(errors.includes(`DISK_TEST_NOT_IN_INVENTORY: ${pathname}`), pathname);
  }
});

test("a Task 1 test name cannot disappear silently from a retained file", async () => {
  const { verifyTestExecutionSet } = await import(verifierUrl);
  const configured = fixture({ diskTestNames: { "test/kept.test.js": ["replacement behavior"] } });
  assert.ok(verifyTestExecutionSet(configured).includes(
    "TEST_NAME_REMOVED: test/kept.test.js :: kept behavior",
  ));
});

test("an explicit Task 1 test-name rename preserves the semantic inventory", async () => {
  const { verifyTestExecutionSet } = await import(verifierUrl);
  const configured = fixture({ diskTestNames: { "test/kept.test.js": ["renamed behavior"] } });
  configured.inventory.assets[0].testNameRenames = { "kept behavior": "renamed behavior" };
  assert.deepEqual(verifyTestExecutionSet(configured), []);
});

test("every test records its Task 1 conflict decision and test-name baseline", async () => {
  const { verifyTestExecutionSet } = await import(verifierUrl);
  const configured = fixture();
  delete configured.inventory.assets[0].conflictAction;
  delete configured.inventory.assets[0].testNames;
  const errors = verifyTestExecutionSet(configured);
  assert.ok(errors.includes("CONFLICT_ACTION_MISSING: test/kept.test.js"));
  assert.ok(errors.includes("TEST_NAMES_MISSING: test/kept.test.js"));
});

// Command lines of live processes containing `needle`. The needle travels through the
// environment so the lookup command itself never matches.
function processesMentioning(needle) {
  const result = process.platform === "win32"
    ? spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:ANALOGY_PROCESS_NEEDLE) } | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }",
    ], {encoding: "utf8", env: {...process.env, ANALOGY_PROCESS_NEEDLE: needle}, windowsHide: true})
    : spawnSync("ps", ["-A", "-o", "pid=,command="], {encoding: "utf8"});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split(/\r?\n/).filter((line) => line.includes(needle));
}

test("a hung test process is terminated by the per-test timeout", async (t) => {
  const runnerUrl = pathToFileURL(path.join(__dirname, "..", "scripts", "run-test-set.mjs")).href;
  const {runSingleNodeTest} = await import(runnerUrl);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-test-timeout-"));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const hanging = path.join(directory, "hang.js");
  fs.writeFileSync(hanging, "setInterval(() => {}, 1000);\n", "utf8");
  const startedAt = Date.now();
  const result = await runSingleNodeTest(hanging, {timeoutMs: 100});
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - startedAt < 2_000);
  let survivors = processesMentioning(hanging);
  for (const deadline = Date.now() + 5_000; survivors.length > 0 && Date.now() < deadline;) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    survivors = processesMentioning(hanging);
  }
  for (const line of survivors) {
    try { process.kill(Number.parseInt(line.trim(), 10), "SIGKILL"); } catch {}
  }
  assert.deepEqual(survivors, [], "the timed-out test's child processes must not outlive the timeout");
});
