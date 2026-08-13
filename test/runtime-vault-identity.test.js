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

test("deriveRuntimeVaultId normalizes resolved macOS vault paths including Chinese names", () => {
  const { deriveRuntimeVaultId } = loadTypeScriptModule("src/runtime/vault-identity.ts");
  const vault = "/Users/analogy/测试 Vault/.obsidian/plugins/analogy/../../..";

  const direct = deriveRuntimeVaultId("/Users/analogy/测试 Vault", "darwin-arm64");
  assert.equal(deriveRuntimeVaultId(vault, "darwin-arm64"), direct);
  assert.equal(deriveRuntimeVaultId("/Users/analogy/测试 Vault/", "darwin-arm64"), direct);
  assert.match(direct, /^vault-v2-[0-9a-f]{16}$/);
});

test("deriveRuntimeVaultId normalizes composed and decomposed Unicode Vault names", () => {
  const { deriveRuntimeVaultId } = loadTypeScriptModule("src/runtime/vault-identity.ts");
  const composed = "Café";
  const decomposed = "Cafe\u0301";

  assert.equal(
    deriveRuntimeVaultId(`/Users/analogy/${composed} Vault`, "darwin-arm64"),
    deriveRuntimeVaultId(`/Users/analogy/${decomposed} Vault`, "darwin-arm64"),
  );
  assert.equal(
    deriveRuntimeVaultId(`C:\\Users\\analogy\\${composed} Vault`, "win32-x64"),
    deriveRuntimeVaultId(`c:/users/analogy/${decomposed} Vault/`, "win32-x64"),
  );
});

test("deriveRuntimeVaultId normalizes Windows separators, drive casing, and trailing separators", () => {
  const { deriveRuntimeVaultId } = loadTypeScriptModule("src/runtime/vault-identity.ts");
  const direct = deriveRuntimeVaultId("C:\\Users\\analogy\\测试 Vault", "win32-x64");

  assert.equal(deriveRuntimeVaultId("c:/Users/analogy/测试 Vault/", "win32-x64"), direct);
  assert.equal(deriveRuntimeVaultId("C:\\Users\\analogy\\测试 Vault\\", "win32-x64"), direct);
  assert.match(direct, /^vault-v2-[0-9a-f]{16}$/);
});
