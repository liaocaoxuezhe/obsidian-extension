import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8"));
}

function commitSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function writeManifest(filename, manifest) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filename);
}

function activeSkip(pathname, inventory) {
  return inventory.platformSkips.find((entry) =>
    entry.path === pathname
    && entry.when?.envMissing
    && !process.env[entry.when.envMissing]);
}

function sha256Files(pathnames) {
  const hash = crypto.createHash("sha256");
  for (const pathname of [...pathnames].sort()) {
    hash.update(pathname);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(repositoryRoot, pathname)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function workspaceFingerprint() {
  const result = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || "git status failed");
  return crypto.createHash("sha256").update(result.stdout).digest("hex");
}

function configuredTestTimeoutMs() {
  const raw = process.env.ANALOGY_TEST_TIMEOUT_MS || "600000";
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1_000 || value > 1_800_000) {
    throw new Error(`INVALID_TEST_TIMEOUT_MS: ${raw}`);
  }
  return value;
}

export function runSingleNodeTest(testPath, options = {}) {
  const arguments_ = ["--test", "--test-concurrency=1", testPath];
  if (options.reporter) arguments_.splice(2, 0, `--test-reporter=${options.reporter}`);
  const childEnvironment = {...(options.env || process.env)};
  delete childEnvironment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, arguments_, {
    cwd: options.cwd || repositoryRoot,
    env: childEnvironment,
    stdio: options.stdio || "inherit",
    windowsHide: true,
    timeout: options.timeoutMs ?? configuredTestTimeoutMs(),
    killSignal: "SIGKILL",
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    timedOut: result.error?.code === "ETIMEDOUT",
  };
}

export function runTestSet(setName) {
  const runnerManifest = readJson("test/test-runner-manifest.json");
  const inventory = readJson("docs/migration/test-execution-inventory.json");
  const set = runnerManifest.sets[setName];
  if (!set || !Array.isArray(set.assets) || set.assets.length === 0) {
    throw new Error(`TEST_SET_EMPTY: ${setName}`);
  }

  const inventoryByPath = new Map(inventory.assets.map((entry) => [entry.path, entry]));
  const tests = set.assets.filter((pathname) => inventoryByPath.get(pathname)?.kind === "test");
  if (tests.length === 0) throw new Error(`TEST_SET_HAS_NO_EXECUTABLES: ${setName}`);
  for (const pathname of set.assets) {
    if (!inventoryByPath.has(pathname)) throw new Error(`RUNNER_ASSET_NOT_IN_INVENTORY: ${pathname}`);
    if (!fs.existsSync(path.join(repositoryRoot, pathname))) throw new Error(`RUNNER_ASSET_MISSING: ${pathname}`);
  }

  const output = path.resolve(
    process.env.ANALOGY_TEST_EXECUTION_MANIFEST
      || path.join(repositoryRoot, "artifacts", "test-execution", `${setName}-${process.platform}-${process.arch}.json`),
  );
  const manifest = {
    schemaVersion: 1,
    commitSha: commitSha(),
    job: process.env.GITHUB_JOB || "local",
    platform: { os: process.platform, arch: process.arch, node: process.version },
    contentSha256: sha256Files([
      set.runner,
      "scripts/run-test-set.mjs",
      "scripts/verify-test-execution-set.mjs",
      "test/test-runner-manifest.json",
      "test/test-ci-manifest.json",
      "docs/migration/test-execution-inventory.json",
      ...set.assets,
    ]),
    workspaceFingerprint: workspaceFingerprint(),
    runner: set.runner,
    set: setName,
    enumeratedPaths: [...set.assets],
    tests: tests.map((pathname) => ({ path: pathname, status: "pending" })),
    explicitSkips: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: "running",
  };
  if (process.env.ANALOGY_TEST_RESUME === "1" && fs.existsSync(output)) {
    const previous = JSON.parse(fs.readFileSync(output, "utf8"));
    const sameExecution = previous.commitSha === manifest.commitSha
      && previous.set === setName
      && JSON.stringify(previous.platform) === JSON.stringify(manifest.platform)
      && previous.contentSha256 === manifest.contentSha256
      && previous.workspaceFingerprint === manifest.workspaceFingerprint
      && JSON.stringify(previous.enumeratedPaths) === JSON.stringify(manifest.enumeratedPaths);
    if (!sameExecution) throw new Error(`TEST_RESUME_MANIFEST_MISMATCH: ${output}`);
    const previousByPath = new Map((previous.tests || []).map((entry) => [entry.path, entry]));
    manifest.tests = manifest.tests.map((entry) => {
      const prior = previousByPath.get(entry.path);
      return prior?.status === "completed" && prior.exitCode === 0 && prior.completedAt ? prior : entry;
    });
  }
  writeManifest(output, manifest);

  let failed = false;
  for (const testEntry of manifest.tests) {
    if (testEntry.status === "completed") continue;
    const skip = activeSkip(testEntry.path, inventory);
    if (skip) {
      testEntry.status = "skipped";
      testEntry.reason = skip.reason;
      manifest.explicitSkips.push({
        path: skip.path,
        reason: skip.reason,
        platform: skip.platform,
        workflowJob: skip.workflowJob,
        condition: skip.when,
      });
      writeManifest(output, manifest);
      continue;
    }
    testEntry.status = "started";
    testEntry.startedAt = new Date().toISOString();
    writeManifest(output, manifest);
    const result = runSingleNodeTest(testEntry.path, {
      cwd: repositoryRoot,
      env: process.env,
      reporter: process.env.ANALOGY_TEST_REPORTER,
    });
    testEntry.completedAt = new Date().toISOString();
    testEntry.exitCode = result.status ?? 1;
    if (result.signal) testEntry.signal = result.signal;
    if (result.timedOut) testEntry.errorCode = "TEST_TIMEOUT";
    testEntry.status = result.status === 0 ? "completed" : "failed";
    writeManifest(output, manifest);
    if (result.timedOut) {
      console.error(`TEST_TIMEOUT: ${testEntry.path}`);
    } else if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      failed = true;
      break;
    }
  }

  manifest.completedAt = new Date().toISOString();
  manifest.status = failed ? "failed" : "completed";
  writeManifest(output, manifest);
  console.log(`[test-set] set=${setName} assets=${set.assets.length} tests=${tests.length} status=${manifest.status} manifest=${output}`);
  if (failed) process.exitCode = 1;
  return manifest;
}
