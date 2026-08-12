"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadTypeScriptModule(relativePath) {
  const filename = path.join(process.cwd(), relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports,
    require,
    module,
    filename,
    path.dirname(filename),
  );
  return module.exports;
}

test("detectSupportedPlatform maps the managed macOS and Windows targets", () => {
  const { detectSupportedPlatform } = loadTypeScriptModule("src/runtime/platform-detector.ts");

  assert.equal(detectSupportedPlatform("darwin", "arm64"), "darwin-arm64");
  assert.equal(detectSupportedPlatform("darwin", "x64"), "darwin-x64");
  assert.equal(detectSupportedPlatform("win32", "x64"), "win32-x64");
});

test("detectSupportedPlatform rejects an unmanaged platform or architecture", () => {
  const { detectSupportedPlatform } = loadTypeScriptModule("src/runtime/platform-detector.ts");

  assert.throws(() => detectSupportedPlatform("win32", "arm64"), /UNSUPPORTED_PLATFORM/);
  assert.throws(() => detectSupportedPlatform("linux", "x64"), /UNSUPPORTED_PLATFORM/);
});
