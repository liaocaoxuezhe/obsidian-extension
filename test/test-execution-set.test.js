const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const verifierUrl = pathToFileURL(path.join(__dirname, "..", "scripts", "verify-test-execution-set.mjs")).href;

function fixture(overrides = {}) {
  return {
    inventory: {
      assets: [{ path: "test/kept.test.js", kind: "test", runner: "public", ciJob: "public-ci" }],
      platformSkips: [],
    },
    runnerManifest: { sets: { public: { assets: ["test/kept.test.js"] } } },
    ciManifest: { jobs: { "public-ci": { runners: ["public"] } } },
    trackedAssets: ["test/kept.test.js"],
    diskTests: ["test/kept.test.js"],
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
