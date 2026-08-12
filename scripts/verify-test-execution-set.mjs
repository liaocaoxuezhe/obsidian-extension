import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function difference(left, right) {
  const rightSet = new Set(right);
  return [...new Set(left)].filter((value) => !rightSet.has(value)).sort();
}

function sameSet(left, right) {
  return difference(left, right).length === 0 && difference(right, left).length === 0;
}

function isTestFile(pathname) {
  if (pathname.includes("/fixtures/") || pathname.includes("/helpers/")) return false;
  return /\.(?:test|spec)\.(?:js|cjs|mjs|ts|tsx)$/.test(pathname);
}

export function extractTestNames(content) {
  return [...content.matchAll(/(?:^|[^\w])(test|it)\s*\(\s*(["'`])([^\n]*?)\2/gm)]
    .map((match) => match[3]);
}

export function verifyTestExecutionSet({ inventory, runnerManifest, ciManifest, trackedAssets, diskTests, diskTestNames = {} }) {
  const errors = [];
  const expected = inventory.assets.map((entry) => entry.path);
  const uniqueExpected = new Set(expected);
  if (uniqueExpected.size !== expected.length) errors.push("INVENTORY_DUPLICATE_PATH");
  const runnerNames = Object.keys(runnerManifest.sets);
  const runnerAssets = runnerNames.flatMap((name) => runnerManifest.sets[name].assets || []);
  if (new Set(runnerAssets).size !== runnerAssets.length) errors.push("RUNNER_DUPLICATE_ASSET");
  const ciRunnerNames = Object.values(ciManifest.jobs).flatMap((job) => job.runners || []);
  const ciAssets = ciRunnerNames.flatMap((name) => runnerManifest.sets[name]?.assets || []);

  for (const pathname of difference(expected, trackedAssets)) errors.push(`EXPECTED_NOT_TRACKED: ${pathname}`);
  for (const pathname of difference(trackedAssets, expected)) errors.push(`TRACKED_NOT_EXPECTED: ${pathname}`);
  for (const pathname of difference(expected, runnerAssets)) errors.push(`EXPECTED_NOT_ENUMERATED: ${pathname}`);
  for (const pathname of difference(runnerAssets, expected)) errors.push(`RUNNER_NOT_EXPECTED: ${pathname}`);
  for (const pathname of difference(runnerAssets, ciAssets)) errors.push(`RUNNER_NOT_IN_CI: ${pathname}`);
  for (const pathname of difference(ciAssets, runnerAssets)) errors.push(`CI_NOT_IN_RUNNER: ${pathname}`);
  for (const pathname of difference(diskTests, expected)) errors.push(`DISK_TEST_NOT_IN_INVENTORY: ${pathname}`);

  for (const runner of ciRunnerNames) {
    if (!runnerNames.includes(runner)) errors.push(`CI_UNKNOWN_RUNNER: ${runner}`);
  }
  for (const entry of inventory.assets) {
    if (!entry.runner || !runnerManifest.sets[entry.runner]) errors.push(`INVENTORY_UNKNOWN_RUNNER: ${entry.path}`);
    else if (!runnerManifest.sets[entry.runner].assets.includes(entry.path)) errors.push(`INVENTORY_RUNNER_MISMATCH: ${entry.path}`);
    if (isTestFile(entry.path) && entry.kind !== "test") errors.push(`TEST_KIND_MISMATCH: ${entry.path}`);
    if (!isTestFile(entry.path) && entry.kind === "test") errors.push(`SUPPORT_KIND_MISMATCH: ${entry.path}`);
    if (!entry.conflictAction) errors.push(`CONFLICT_ACTION_MISSING: ${entry.path}`);
    if (entry.kind === "test") {
      if (!Array.isArray(entry.testNames)) errors.push(`TEST_NAMES_MISSING: ${entry.path}`);
      else {
        const currentNames = diskTestNames[entry.path] || [];
        for (const testName of difference(entry.testNames, currentNames)) {
          const renamed = entry.testNameRenames?.[testName];
          if (!renamed || !currentNames.includes(renamed)) {
            errors.push(`TEST_NAME_REMOVED: ${entry.path} :: ${testName}`);
          }
        }
        for (const [previous, current] of Object.entries(entry.testNameRenames || {})) {
          if (!entry.testNames.includes(previous) || !currentNames.includes(current)) {
            errors.push(`TEST_NAME_RENAME_INVALID: ${entry.path} :: ${previous} -> ${current}`);
          }
        }
      }
    }
    const ciJob = ciManifest.jobs[entry.ciJob];
    if (!ciJob || !ciJob.runners?.includes(entry.runner)) errors.push(`INVENTORY_CI_OWNERSHIP_MISMATCH: ${entry.path}`);
  }
  for (const skip of inventory.platformSkips || []) {
    if (!expected.includes(skip.path)) errors.push(`SKIP_NOT_EXPECTED: ${skip.path}`);
    if (!skip.reason || !skip.platform || !skip.workflowJob || !skip.when?.envMissing) {
      errors.push(`SKIP_METADATA_INCOMPLETE: ${skip.path}`);
    }
  }
  return errors;
}

function trackedTestAssets() {
  const result = spawnSync("git", ["ls-files", "-z", "test"], { cwd: repositoryRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "git ls-files failed");
  return result.stdout.split("\0").filter(Boolean);
}

function diskTestFiles(root) {
  const found = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else {
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        if (isTestFile(relative)) found.push(relative);
      }
    }
  }
  walk(path.join(root, "test"));
  return found;
}

function diskTestNameMap(root, paths) {
  return Object.fromEntries(paths.map((pathname) => [
    pathname,
    extractTestNames(fs.readFileSync(path.join(root, pathname), "utf8")),
  ]));
}

function verifyExecutionManifest(filename, setName, inventory, runnerManifest) {
  const execution = JSON.parse(fs.readFileSync(filename, "utf8"));
  const errors = [];
  const expectedAssets = runnerManifest.sets[setName]?.assets || [];
  if (!sameSet(execution.enumeratedPaths || [], expectedAssets)) errors.push(`EXECUTION_ENUMERATION_MISMATCH: ${setName}`);
  if (execution.status !== "completed") errors.push(`EXECUTION_NOT_COMPLETED: ${execution.status || "missing"}`);
  const testPaths = inventory.assets.filter((entry) => entry.runner === setName && entry.kind === "test").map((entry) => entry.path);
  const resultByPath = new Map((execution.tests || []).map((entry) => [entry.path, entry]));
  for (const pathname of testPaths) {
    const status = resultByPath.get(pathname)?.status;
    if (status !== "completed" && status !== "skipped") errors.push(`TEST_NOT_COMPLETED: ${pathname} (${status || "missing"})`);
  }
  for (const skip of execution.explicitSkips || []) {
    const declared = (inventory.platformSkips || []).find((entry) => entry.path === skip.path);
    if (!declared || !skip.reason || !skip.platform || !skip.workflowJob) errors.push(`UNDECLARED_EXECUTION_SKIP: ${skip.path}`);
  }
  return errors;
}

function main() {
  const inventory = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "docs/migration/test-execution-inventory.json"), "utf8"));
  const runnerManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "test/test-runner-manifest.json"), "utf8"));
  const ciManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "test/test-ci-manifest.json"), "utf8"));
  const diskTests = diskTestFiles(repositoryRoot);
  const errors = verifyTestExecutionSet({
    inventory,
    runnerManifest,
    ciManifest,
    trackedAssets: trackedTestAssets(),
    diskTests,
    diskTestNames: diskTestNameMap(repositoryRoot, diskTests),
  });
  for (const [jobName, job] of Object.entries(ciManifest.jobs)) {
    const workflow = parseYaml(fs.readFileSync(path.join(repositoryRoot, job.workflow), "utf8"));
    const workflowJob = workflow.jobs?.[job.workflowJob];
    if (!workflowJob) {
      errors.push(`WORKFLOW_JOB_MISSING: ${jobName}/${job.workflowJob}`);
      continue;
    }
    const steps = workflowJob.steps || [];
    for (const runner of job.runners) {
      const executionPath = `artifacts/test-execution/${runner}`;
      const testStep = steps.find((step) => String(step.run || "").includes(`npm run test:${runner}`));
      if (!testStep) errors.push(`WORKFLOW_RUNNER_MISSING: ${jobName}/${runner}`);
      else if (!String(testStep.env?.ANALOGY_TEST_EXECUTION_MANIFEST || "").includes(executionPath)) {
        errors.push(`WORKFLOW_EXECUTION_ENV_MISMATCH: ${jobName}/${runner}`);
      }
      const verifyStep = steps.find((step) => String(step.run || "").includes("verify-test-execution-set.mjs")
        && String(step.run || "").includes(`--set ${runner}`));
      if (!verifyStep || verifyStep.if !== "always()" || !String(verifyStep.run).includes(executionPath)) {
        errors.push(`WORKFLOW_VERIFY_STEP_INVALID: ${jobName}/${runner}`);
      }
      const uploadStep = steps.find((step) => String(step.uses || "").startsWith("actions/upload-artifact")
        && String(step.with?.path || "").includes(executionPath));
      if (!uploadStep || uploadStep.if !== "always()" || uploadStep.with?.["if-no-files-found"] !== "error") {
        errors.push(`WORKFLOW_UPLOAD_STEP_INVALID: ${jobName}/${runner}`);
      }
    }
  }
  const executionIndex = process.argv.indexOf("--execution");
  const setIndex = process.argv.indexOf("--set");
  if (executionIndex >= 0 || setIndex >= 0) {
    if (executionIndex < 0 || setIndex < 0) errors.push("EXECUTION_ARGUMENTS_INCOMPLETE");
    else errors.push(...verifyExecutionManifest(path.resolve(process.argv[executionIndex + 1]), process.argv[setIndex + 1], inventory, runnerManifest));
  }
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`Test execution sets verified: expected=${inventory.assets.length}, public=${runnerManifest.sets.public.assets.length}, runtime=${runnerManifest.sets.runtime.assets.length}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
