"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const repositoryRoot = path.resolve(__dirname, "..");
const runtimePackageRoot = path.join(repositoryRoot, "runtime-package");
const validatorUrl = pathToFileURL(path.join(
  repositoryRoot,
  "scripts",
  "runtime-lockfile-validator.mjs",
)).href;

const expectedDependencies = Object.freeze({
  "@huggingface/transformers": "4.2.0",
  "onnxruntime-node": "1.26.0",
});

async function loadValidator() {
  try {
    return await import(validatorUrl);
  } catch {
    return {};
  }
}

function runtimeLock() {
  return JSON.parse(fs.readFileSync(path.join(runtimePackageRoot, "package-lock.json"), "utf8"));
}

test("runtime lock validator accepts the reviewed immutable dependency graph", async () => {
  const { validateRuntimeLockfile } = await loadValidator();
  assert.equal(typeof validateRuntimeLockfile, "function", "a standalone lock validator must be exported");
  assert.doesNotThrow(() => validateRuntimeLockfile(runtimeLock(), expectedDependencies));
});

test("runtime lock validator rejects every mutable or non-registry source shape", async () => {
  const { validateRuntimeLockfile } = await loadValidator();
  assert.equal(typeof validateRuntimeLockfile, "function", "a standalone lock validator must be exported");
  const mutations = [
    ["lockfileVersion", (lock) => { lock.lockfileVersion = 2; }, /lockfileVersion 3/],
    ["root dependency drift", (lock) => { lock.packages[""].dependencies.extra = "1.0.0"; }, /root dependencies/],
    ["root package drift", (lock) => { lock.packages[""].name = "forged-runtime"; }, /root package metadata/],
    ["HTTP tarball", (lock) => { lock.packages["node_modules/onnxruntime-common"].resolved = "http://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.26.0.tgz"; }, /official registry HTTPS tarball/],
    ["alternate registry", (lock) => { lock.packages["node_modules/onnxruntime-common"].resolved = "https://registry.example/onnxruntime-common.tgz"; }, /official registry HTTPS tarball/],
    ["missing integrity", (lock) => { delete lock.packages["node_modules/onnxruntime-common"].integrity; }, /SHA-512 integrity/],
    ["short SHA-512", (lock) => { lock.packages["node_modules/onnxruntime-common"].integrity = "sha512-YQ=="; }, /SHA-512 integrity/],
    ["non-canonical SHA-512", (lock) => { lock.packages["node_modules/onnxruntime-common"].integrity = `sha512-${"A".repeat(85)}B==`; }, /SHA-512 integrity/],
    ["link entry", (lock) => { lock.packages["node_modules/onnxruntime-common"].link = true; }, /link, git, file, or workspace/],
    ["git source", (lock) => { lock.packages["node_modules/onnxruntime-common"].resolved = "git+https://github.com/microsoft/onnxruntime.git"; }, /link, git, file, or workspace|official registry HTTPS tarball/],
    ["file source", (lock) => { lock.packages["node_modules/onnxruntime-common"].resolved = "file:../onnxruntime-common.tgz"; }, /link, git, file, or workspace|official registry HTTPS tarball/],
    ["workspace source", (lock) => { lock.packages["node_modules/onnxruntime-common"].resolved = "workspace:*"; }, /link, git, file, or workspace|official registry HTTPS tarball/],
    ["second ORT", (lock) => {
      lock.packages["node_modules/example/node_modules/onnxruntime-node"] = {
        version: "1.25.0",
        resolved: "https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.25.0.tgz",
        integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
      };
    }, /exactly one onnxruntime-node@1\.26\.0/],
  ];

  for (const [label, mutate, expectedError] of mutations) {
    const lock = runtimeLock();
    mutate(lock);
    assert.throws(
      () => validateRuntimeLockfile(lock, expectedDependencies),
      expectedError,
      label,
    );
  }
});
