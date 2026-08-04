import path from "node:path";
import {spawnSync} from "node:child_process";
import {existsSync} from "node:fs";

const repositoryRoot = process.cwd();
if (process.env.ANALOGY_LEGACY_CHROMA_BIN && !process.env.ANALOGY_CHROMA_BIN) {
  throw new Error("ANALOGY_CHROMA_BIN is required for the real 0.5.x-to-1.4.4 migration contract");
}
const trackedTestResult = spawnSync("git", ["ls-files", "test/*.test.js"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  windowsHide: true,
});
if (trackedTestResult.status !== 0) {
  throw new Error(`Unable to enumerate tracked public tests: ${trackedTestResult.stderr || "git ls-files failed"}`);
}
const tests = trackedTestResult.stdout.split(/\r?\n/).filter(Boolean).sort()
  .map((name) => path.join(repositoryRoot, name))
  .filter(existsSync);
if (tests.length === 0) throw new Error("No runtime tests found");
// The opt-in real migration starts two native Chroma processes. Keep enough memory for the
// managed embedding worker smoke test when both contracts run in the same release gate.
// Public tests share the generated root bundle, so serialize them to avoid esbuild/worker races.
const concurrency = "1";
const reporter = process.env.ANALOGY_TEST_REPORTER;
const testArguments = ["--test", `--test-concurrency=${concurrency}`,
  ...(reporter ? [`--test-reporter=${reporter}`] : []), ...tests];
const result = spawnSync(process.execPath, testArguments, {
  cwd: repositoryRoot,
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
console.log(`[runtime-tests] files=${tests.length} concurrency=${concurrency} exit=${result.status ?? 1}`);
process.exitCode = result.status ?? 1;
