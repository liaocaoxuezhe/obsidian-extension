"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const modulePromise = import(pathToFileURL(path.join(__dirname, "..", "scripts", "vc-runtime-bundle.mjs")).href);

function makeCrt(root, version = "14.40.33807", toolset = "Microsoft.VC143.CRT", files) {
  const directory = path.join(root, "VC", "Redist", "MSVC", version, "x64", toolset);
  fs.mkdirSync(directory, { recursive: true });
  for (const name of files) fs.writeFileSync(path.join(directory, name), name);
  return directory;
}

test("the Visual C++ runtime is found in the Visual Studio redistributable folder only", async (t) => {
  const { resolveVisualCppRuntimeDirectory, VC_RUNTIME_FILES } = await modulePromise;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-vcrt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  makeCrt(root, "14.38.33130", "Microsoft.VC143.CRT", VC_RUNTIME_FILES);
  const newest = makeCrt(root, "14.40.33807", "Microsoft.VC143.CRT", VC_RUNTIME_FILES);
  makeCrt(root, "14.41.0", "Microsoft.VC143.CRT", ["vcruntime140.dll"]);

  const fromVswhere = resolveVisualCppRuntimeDirectory({ env: {}, runVswhere: () => `${root}\n` });
  assert.equal(fromVswhere, newest, "the newest complete CRT folder wins");

  const explicit = resolveVisualCppRuntimeDirectory({ explicit: newest, env: {}, runVswhere: () => "" });
  assert.equal(explicit, newest);
  assert.throws(() => resolveVisualCppRuntimeDirectory({ explicit: root, env: {}, runVswhere: () => "" }),
    /does not contain/);
  assert.throws(() => resolveVisualCppRuntimeDirectory({ env: {}, runVswhere: () => { throw new Error("no vswhere"); } }),
    /must ship the Visual C\+\+ runtime/);
});

test("the runtime DLLs are copied next to onnxruntime_binding.node", async (t) => {
  const { bundleVisualCppRuntime, VC_RUNTIME_FILES } = await modulePromise;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-vcrt-copy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const crt = makeCrt(root, "14.40.33807", "Microsoft.VC143.CRT", VC_RUNTIME_FILES);
  const native = path.join(root, "napi-v6", "win32", "x64");
  fs.mkdirSync(native, { recursive: true });
  await assert.rejects(bundleVisualCppRuntime(crt, native), /onnxruntime_binding\.node not found/);
  fs.writeFileSync(path.join(native, "onnxruntime_binding.node"), "binding");
  assert.deepEqual(await bundleVisualCppRuntime(crt, native), [...VC_RUNTIME_FILES]);
  for (const name of VC_RUNTIME_FILES) assert.equal(fs.readFileSync(path.join(native, name), "utf8"), name);
});
