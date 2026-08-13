const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {pathToFileURL} = require("node:url");

const repositoryRoot = path.join(__dirname, "..");

async function loadBoundary() {
  return import(pathToFileURL(path.join(repositoryRoot, "scripts", "check-public-boundary.mjs")).href);
}

test("tracked Git files reject commercial service implementation", async () => {
  const {scanPaths} = await loadBoundary();
  const fixtureRoot = path.join(__dirname, "fixtures", "public-boundary", "tracked");
  const violations = scanPaths(fixtureRoot, ["mcp-server/src/commercial/server.ts"], {
    excludeBaselineFixtures: false,
  });
  assert.ok(violations.some((violation) => violation.rule === "forbidden-path"));
});

test("ignored workspace residue is rejected independently", async () => {
  const {collectWorkspaceFiles, scanPaths} = await loadBoundary();
  const fixtureRoot = path.join(__dirname, "fixtures", "public-boundary", "workspace");
  const violations = scanPaths(fixtureRoot, collectWorkspaceFiles(fixtureRoot), {
    excludeBaselineFixtures: false,
  });
  assert.ok(violations.some((violation) => violation.path === "test/commercial-leak.test.js"));
});

test("release assets reject an obvious fake live secret", async () => {
  const {runBoundaryMode} = await loadBoundary();
  const fixtureRoot = path.join(__dirname, "fixtures", "public-boundary", "release");
  const violations = runBoundaryMode("release", fixtureRoot);
  assert.ok(violations.some((violation) => violation.rule === "stripe-live-secret"));
});

test("repository tracked and workspace layers are clean", async () => {
  const {runBoundaryMode} = await loadBoundary();
  assert.deepEqual(runBoundaryMode("tracked", repositoryRoot), []);
  assert.deepEqual(runBoundaryMode("workspace", repositoryRoot), []);
});

test("latest local release directory is clean when present", async (t) => {
  const {runBoundaryMode} = await loadBoundary();
  const releaseRoot = path.join(repositoryRoot, "release", "1.2.4");
  if (!fs.existsSync(releaseRoot)) {
    t.skip("release/1.2.4 is not present in this checkout");
    return;
  }
  assert.deepEqual(runBoundaryMode("release", releaseRoot), []);
});
