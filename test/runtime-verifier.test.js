"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadVerifier() {
  const filename = path.join(process.cwd(), "src/runtime/runtime-verifier.ts");
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: filename,
  }).outputText;
  const module = { exports: {} };
  Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports, require, module, filename, path.dirname(filename),
  );
  return module.exports;
}

function assetFor(body, overrides = {}) {
  return {
    id: "verify-test", kind: "chroma", platform: "darwin-arm64", version: "test",
    url: "https://example.test/runtime", fileName: "runtime", archive: "none",
    size: body.length, sha256: crypto.createHash("sha256").update(body).digest("hex"),
    executableRelativePath: "runtime", licenseName: "Apache-2.0",
    licenseUrl: "https://example.test/license", source: "development-fixture", ...overrides,
  };
}

async function writeFixture(t, body) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy 校验 空格 "));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "下载 part 文件.part");
  await fs.promises.writeFile(file, body, { mode: 0o600 });
  return file;
}

test("streams SHA-256 and size verification for a valid UTF-8 path", async (t) => {
  const body = Buffer.from("verified payload");
  const file = await writeFixture(t, body);
  assert.deepEqual(await loadVerifier().verifyRuntimeAsset(assetFor(body), file), {
    ok: true,
    actualSize: body.length,
    actualSha256: "3aac0a1146ffe55bac7c05f61401fb1e7e4e6a94110b91585c646fe8cf745f28",
    errorCode: null,
  });
});

test("returns DOWNLOAD_SIZE_MISMATCH before considering a hash mismatch", async (t) => {
  const body = Buffer.from("short");
  const file = await writeFixture(t, body);
  const result = await loadVerifier().verifyRuntimeAsset(assetFor(Buffer.from("expected content")), file);
  assert.equal(result.ok, false);
  assert.equal(result.actualSize, 5);
  assert.equal(result.errorCode, "DOWNLOAD_SIZE_MISMATCH");
  assert.match(result.actualSha256, /^[0-9a-f]{64}$/);
});

test("returns DOWNLOAD_HASH_MISMATCH for equal-sized tampering and creates no executable", async (t) => {
  const expected = Buffer.from("safe payload");
  const actual = Buffer.from("evil payload");
  const file = await writeFixture(t, actual);
  const result = await loadVerifier().verifyRuntimeAsset(assetFor(expected), file);
  assert.equal(result.ok, false);
  assert.equal(result.actualSize, expected.length);
  assert.equal(result.errorCode, "DOWNLOAD_HASH_MISMATCH");
  assert.equal(fs.existsSync(file.replace(/\.part$/, "")), false);
});

test("rejects a symlink verification path", async (t) => {
  const body = Buffer.from("safe payload");
  const target = await writeFixture(t, body);
  const link = `${target}.link`;
  await fs.promises.symlink(target, link);
  await assert.rejects(loadVerifier().verifyRuntimeAsset(assetFor(body), link), /DOWNLOAD_UNSAFE_FILE/);
});
