"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const loadedTypeScriptModules = new Map();

function loadTypeScriptFile(filename) {
  if (loadedTypeScriptModules.has(filename)) return loadedTypeScriptModules.get(filename);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: filename,
  }).outputText;
  const module = { exports: {} };
  loadedTypeScriptModules.set(filename, module.exports);
  const localRequire = (specifier) => {
    if (!specifier.startsWith(".")) return require(specifier);
    const resolved = path.resolve(path.dirname(filename), specifier);
    return fs.existsSync(`${resolved}.ts`) ? loadTypeScriptFile(`${resolved}.ts`) : require(resolved);
  };
  Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports, localRequire, module, filename, path.dirname(filename),
  );
  loadedTypeScriptModules.set(filename, module.exports);
  return module.exports;
}

function modules() {
  const runtimeDir = path.join(process.cwd(), "src/runtime");
  return {
    ...loadTypeScriptFile(path.join(runtimeDir, "runtime-paths.ts")),
    ...loadTypeScriptFile(path.join(runtimeDir, "atomic-runtime-installer.ts")),
  };
}

async function setup(t) {
  const localDataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "Analogy 安装 空格 "));
  t.after(() => fs.promises.rm(localDataRoot, { recursive: true, force: true }));
  return { localDataRoot, paths: modules().createRuntimePaths(localDataRoot, "vault-v2-0123456789abcdef") };
}

test("runtime pointers and process leases are isolated per Vault while immutable assets stay shared", async (t) => {
  const localDataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "Analogy 双 Vault 中文 "));
  t.after(() => fs.promises.rm(localDataRoot, { recursive: true, force: true }));
  const first = modules().createRuntimePaths(localDataRoot, "vault-v2-0123456789abcdef");
  const second = modules().createRuntimePaths(localDataRoot, "vault-v2-fedcba9876543210");

  assert.equal(first.runtimeVaultId, "vault-v2-0123456789abcdef");
  assert.equal(second.runtimeVaultId, "vault-v2-fedcba9876543210");
  assert.notEqual(first.current, second.current);
  assert.equal(first.current, path.join(first.vaultRoot, "current"));
  assert.equal(second.current, path.join(second.vaultRoot, "current"));
  assert.equal(first.embeddingVersions, second.embeddingVersions);
  assert.equal(first.chromaVersions, second.chromaVersions);
  assert.equal(first.installRecords, second.installRecords);
  assert.equal(first.legacyCurrent, second.legacyCurrent);
  assert.equal(first.chromaProcessLease, path.join(first.vaultRoot, "chroma-process-lease.json"));
  assert.equal(second.chromaProcessLease, path.join(second.vaultRoot, "chroma-process-lease.json"));
});

async function inputFor(root, paths, id, body, overrides = {}) {
  const verifiedAssetPath = path.join(root, `${id} 已校验.part`);
  await fs.promises.writeFile(verifiedAssetPath, body, { mode: 0o600 });
  return {
    paths,
    verifiedAssetPath,
    asset: {
      id, kind: "chroma", platform: "darwin-arm64", version: id,
      url: "https://example.test/runtime", fileName: "chroma runtime", archive: "none",
      size: body.length, sha256: crypto.createHash("sha256").update(body).digest("hex"),
      executableRelativePath: "chroma runtime", licenseName: "Apache-2.0",
      licenseUrl: "https://example.test/license", source: "development-fixture", ...overrides,
    },
  };
}

function pointerFor(paths, runtimeId, overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "chroma",
    runtimeId,
    installedPath: path.join(paths.chromaVersions, runtimeId),
    assetSha256: "a".repeat(64),
    installedAt: 1,
    previousRuntimeId: null,
    ...overrides,
  };
}

function lockMetadata(overrides = {}) {
  return {
    schemaVersion: 1,
    pid: 2147483647,
    token: "00000000-0000-4000-8000-000000000001",
    createdAt: 1,
    ...overrides,
  };
}

function recoveryState(paths, runtimeId, state, overrides = {}) {
  return {
    schemaVersion: 1,
    state,
    kind: "chroma",
    runtimeId,
    installedPath: path.join(paths.chromaVersions, runtimeId),
    stagingPath: path.join(paths.staging, `${runtimeId}-00000000-0000-4000-8000-000000000002`),
    updatedAt: 1,
    lockToken: "00000000-0000-4000-8000-000000000001",
    ...overrides,
  };
}

test("smoke failure preserves current and the old runtime while isolating the candidate", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const oldInput = await inputFor(localDataRoot, paths, "runtime-old", Buffer.from("old"));
  await modules().installRuntime({ ...oldInput, smokeTest: async () => undefined, now: () => 100 });
  const currentFile = path.join(paths.current, "chroma.json");
  const oldJson = await fs.promises.readFile(currentFile, "utf8");
  const oldPointer = JSON.parse(oldJson);

  const nextInput = await inputFor(localDataRoot, paths, "runtime-new", Buffer.from("new"));
  await assert.rejects(
    modules().installRuntime({ ...nextInput, smokeTest: async () => { throw new Error("not runnable"); }, now: () => 200 }),
    /RUNTIME_SMOKE_TEST_FAILED/,
  );

  assert.equal(await fs.promises.readFile(currentFile, "utf8"), oldJson);
  assert.equal(await fs.promises.readFile(path.join(oldPointer.installedPath, "chroma runtime"), "utf8"), "old");
  assert.equal(fs.existsSync(path.join(paths.chromaVersions, "runtime-new")), false);
  const quarantined = await fs.promises.readdir(path.join(paths.staging, "quarantine", "chroma"));
  assert.equal(quarantined.length, 1);
  assert.match(quarantined[0], /^runtime-new-/);
});

test("successful install atomically publishes a JSON pointer from a UTF-8 path", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const input = await inputFor(localDataRoot, paths, "runtime-中文", Buffer.from("safe runtime"));
  const seen = [];
  const installed = await modules().installRuntime({
    ...input,
    smokeTest: async (candidatePath) => {
      const executablePath = path.join(candidatePath, "chroma runtime");
      seen.push({
        body: await fs.promises.readFile(executablePath, "utf8"),
        ownerExecutable: Boolean((await fs.promises.stat(executablePath)).mode & 0o100),
      });
    },
    now: () => 123456,
  });
  const pointer = await modules().readCurrentRuntime(paths, "chroma");

  assert.deepEqual(seen, [{ body: "safe runtime", ownerExecutable: true }]);
  assert.deepEqual(pointer, {
    schemaVersion: 1,
    kind: "chroma",
    runtimeId: "runtime-中文",
    installedPath: path.join(paths.chromaVersions, "runtime-中文"),
    assetSha256: input.asset.sha256,
    installedAt: 123456,
    previousRuntimeId: null,
  });
  assert.equal(installed.executablePath, path.join(pointer.installedPath, "chroma runtime"));
  assert.equal((await fs.promises.readdir(paths.current)).some((name) => name.endsWith(".tmp")), false);
  assert.equal((await fs.promises.lstat(path.join(paths.current, "chroma.json"))).isSymbolicLink(), false);
});

test("a second Vault reuses an identical immutable runtime and publishes only its own pointer", async (t) => {
  const localDataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "Analogy 共享 runtime "));
  t.after(() => fs.promises.rm(localDataRoot, { recursive: true, force: true }));
  const firstPaths = modules().createRuntimePaths(localDataRoot, "vault-v2-0123456789abcdef");
  const secondPaths = modules().createRuntimePaths(localDataRoot, "vault-v2-fedcba9876543210");
  const firstInput = await inputFor(localDataRoot, firstPaths, "runtime-shared", Buffer.from("same runtime"));
  const secondInput = { ...firstInput, paths: secondPaths };
  let smokeCount = 0;
  const smokeTest = async () => { smokeCount += 1; };

  const first = await modules().installRuntime({ ...firstInput, smokeTest, now: () => 100 });
  const second = await modules().installRuntime({ ...secondInput, smokeTest, now: () => 200 });

  assert.equal(first.installedPath, second.installedPath);
  assert.equal(smokeCount, 2);
  assert.equal((await modules().readCurrentRuntime(firstPaths, "chroma")).runtimeId, "runtime-shared");
  assert.equal((await modules().readCurrentRuntime(secondPaths, "chroma")).runtimeId, "runtime-shared");
  assert.equal(await fs.promises.readFile(path.join(first.installedPath, "chroma runtime"), "utf8"), "same runtime");
});

test("the same runtime ID with different bytes is rejected without changing either Vault pointer", async (t) => {
  const localDataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "Analogy runtime 身份 "));
  t.after(() => fs.promises.rm(localDataRoot, { recursive: true, force: true }));
  const firstPaths = modules().createRuntimePaths(localDataRoot, "vault-v2-0123456789abcdef");
  const secondPaths = modules().createRuntimePaths(localDataRoot, "vault-v2-fedcba9876543210");
  const firstInput = await inputFor(localDataRoot, firstPaths, "runtime-same-id", Buffer.from("release bytes"));
  const conflictingInput = await inputFor(localDataRoot, secondPaths, "runtime-same-id", Buffer.from("development bytes"));
  await modules().installRuntime({ ...firstInput, smokeTest: async () => undefined, now: () => 100 });
  const firstPointerBytes = await fs.promises.readFile(path.join(firstPaths.current, "chroma.json"), "utf8");

  await assert.rejects(
    modules().installRuntime({ ...conflictingInput, smokeTest: async () => undefined, now: () => 200 }),
    /RUNTIME_IDENTITY_CONFLICT/,
  );

  assert.equal(await fs.promises.readFile(path.join(firstPaths.current, "chroma.json"), "utf8"), firstPointerBytes);
  assert.equal(await modules().readCurrentRuntime(secondPaths, "chroma"), null);
});

test("a matching 1.2.0 global pointer migrates once into only the requesting Vault", async (t) => {
  const localDataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "Analogy 旧指针迁移 "));
  t.after(() => fs.promises.rm(localDataRoot, { recursive: true, force: true }));
  const sourcePaths = modules().createRuntimePaths(localDataRoot, "vault-v2-0123456789abcdef");
  const targetPaths = modules().createRuntimePaths(localDataRoot, "vault-v2-fedcba9876543210");
  const untouchedPaths = modules().createRuntimePaths(localDataRoot, "vault-v2-aaaaaaaaaaaaaaaa");
  const input = await inputFor(localDataRoot, sourcePaths, "runtime-legacy-current", Buffer.from("legacy current"));
  await modules().installRuntime({ ...input, smokeTest: async () => undefined, now: () => 100 });
  const sourcePointerBytes = await fs.promises.readFile(path.join(sourcePaths.current, "chroma.json"), "utf8");
  await fs.promises.mkdir(sourcePaths.legacyCurrent, { recursive: true });
  await fs.promises.writeFile(path.join(sourcePaths.legacyCurrent, "chroma.json"), sourcePointerBytes, { mode: 0o600 });

  const migrated = await modules().readCurrentRuntimeForAsset(targetPaths, input.asset);

  assert.equal(migrated.runtimeId, input.asset.id);
  assert.equal(migrated.assetSha256, input.asset.sha256);
  assert.equal(await fs.promises.readFile(path.join(sourcePaths.legacyCurrent, "chroma.json"), "utf8"), sourcePointerBytes);
  assert.equal(fs.existsSync(path.join(untouchedPaths.current, "chroma.json")), false);
});

test("a global pointer for another build is ignored without being marked corrupt", async (t) => {
  const localDataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "Analogy 旧指针不匹配 "));
  t.after(() => fs.promises.rm(localDataRoot, { recursive: true, force: true }));
  const sourcePaths = modules().createRuntimePaths(localDataRoot, "vault-v2-0123456789abcdef");
  const targetPaths = modules().createRuntimePaths(localDataRoot, "vault-v2-fedcba9876543210");
  const installed = await inputFor(localDataRoot, sourcePaths, "runtime-development", Buffer.from("development"));
  const requested = await inputFor(localDataRoot, targetPaths, "runtime-release", Buffer.from("release"));
  await modules().installRuntime({ ...installed, smokeTest: async () => undefined, now: () => 100 });
  const legacyBytes = await fs.promises.readFile(path.join(sourcePaths.current, "chroma.json"), "utf8");
  await fs.promises.mkdir(sourcePaths.legacyCurrent, { recursive: true });
  await fs.promises.writeFile(path.join(sourcePaths.legacyCurrent, "chroma.json"), legacyBytes, { mode: 0o600 });

  assert.equal(await modules().readCurrentRuntimeForAsset(targetPaths, requested.asset), null);
  assert.equal(await fs.promises.readFile(path.join(sourcePaths.legacyCurrent, "chroma.json"), "utf8"), legacyBytes);
  assert.equal(fs.existsSync(path.join(targetPaths.current, "chroma.json")), false);
});

test("executableRelativePath cannot leave the candidate runtime root", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const input = await inputFor(localDataRoot, paths, "runtime-escape", Buffer.from("bad"), {
    executableRelativePath: "../outside",
  });
  await assert.rejects(
    modules().installRuntime({ ...input, smokeTest: async () => undefined }),
    /RUNTIME_EXECUTABLE_OUTSIDE_ROOT/,
  );
  assert.equal(await modules().readCurrentRuntime(paths, "chroma"), null);
});

test("rollback switches current back without deleting either installed runtime", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const first = await inputFor(localDataRoot, paths, "runtime-one", Buffer.from("one"));
  const second = await inputFor(localDataRoot, paths, "runtime-two", Buffer.from("two"));
  await modules().installRuntime({ ...first, smokeTest: async () => undefined, now: () => 10 });
  await modules().installRuntime({ ...second, smokeTest: async () => undefined, now: () => 20 });

  const rolledBack = await modules().rollbackRuntime(paths, "chroma");

  assert.equal(rolledBack.runtimeId, "runtime-one");
  assert.equal(rolledBack.previousRuntimeId, "runtime-two");
  assert.equal((await modules().readCurrentRuntime(paths, "chroma")).runtimeId, "runtime-one");
  assert.equal(await fs.promises.readFile(path.join(paths.chromaVersions, "runtime-one", "chroma runtime"), "utf8"), "one");
  assert.equal(await fs.promises.readFile(path.join(paths.chromaVersions, "runtime-two", "chroma runtime"), "utf8"), "two");
});

test("managed runtime ancestors cannot be symlinks", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), "Analogy outside "));
  t.after(() => fs.promises.rm(outside, { recursive: true, force: true }));
  await fs.promises.symlink(outside, path.join(paths.root, "runtime"), "dir");
  const input = await inputFor(localDataRoot, paths, "runtime-symlink", Buffer.from("bad"));

  await assert.rejects(
    modules().installRuntime({ ...input, smokeTest: async () => undefined }),
    /RUNTIME_UNSAFE_DIRECTORY/,
  );
  assert.deepEqual(await fs.promises.readdir(outside), []);
});

test("current pointer installedPath must exactly equal its derived version path", async (t) => {
  const { paths } = await setup(t);
  await fs.promises.mkdir(paths.current, { recursive: true });
  await fs.promises.mkdir(paths.chromaVersions, { recursive: true });
  const pointer = pointerFor(paths, "runtime-strict", {
    installedPath: `${paths.chromaVersions}${path.sep}child${path.sep}..${path.sep}runtime-strict`,
  });
  await fs.promises.writeFile(path.join(paths.current, "chroma.json"), JSON.stringify(pointer));

  await assert.rejects(modules().readCurrentRuntime(paths, "chroma"), /RUNTIME_CURRENT_INVALID/);
});

for (const collision of ["empty-directory", "file", "non-empty-directory"]) {
  test(`install never replaces an existing ${collision} at finalPath`, async (t) => {
    const { localDataRoot, paths } = await setup(t);
    await fs.promises.mkdir(paths.chromaVersions, { recursive: true });
    const finalPath = path.join(paths.chromaVersions, "runtime-collision");
    if (collision === "file") {
      await fs.promises.writeFile(finalPath, "sentinel");
    } else {
      await fs.promises.mkdir(finalPath);
      if (collision === "non-empty-directory") await fs.promises.writeFile(path.join(finalPath, "sentinel"), "keep");
    }
    const input = await inputFor(localDataRoot, paths, "runtime-collision", Buffer.from("candidate"));

    await assert.rejects(
      modules().installRuntime({ ...input, smokeTest: async () => undefined }),
      /RUNTIME_VERSION_EXISTS/,
    );
    if (collision === "file") assert.equal(await fs.promises.readFile(finalPath, "utf8"), "sentinel");
    else if (collision === "non-empty-directory") {
      assert.equal(await fs.promises.readFile(path.join(finalPath, "sentinel"), "utf8"), "keep");
    } else assert.deepEqual(await fs.promises.readdir(finalPath), []);
  });
}

test("pre-publish validation failure removes the candidate staging directory", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const input = await inputFor(localDataRoot, paths, "runtime-invalid", Buffer.from("candidate"), {
    executableRelativePath: "missing executable",
  });

  await assert.rejects(
    modules().installRuntime({ ...input, smokeTest: async () => undefined }),
    /RUNTIME_EXECUTABLE_INVALID/,
  );
  assert.deepEqual(await fs.promises.readdir(paths.staging), []);
});

test("archive extraction failure removes the staging directory it created", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const input = await inputFor(localDataRoot, paths, "runtime-broken-archive", Buffer.from("not gzip"), {
    archive: "tar.gz",
  });
  await assert.rejects(
    modules().installRuntime({ ...input, smokeTest: async () => undefined }),
    /ARCHIVE_INVALID_FORMAT/,
  );
  assert.deepEqual(await fs.promises.readdir(paths.staging), []);
});

test("smoke failures retain at most three quarantined candidates", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const input = await inputFor(localDataRoot, paths, "runtime-bad", Buffer.from(`candidate-${attempt}`));
    await assert.rejects(
      modules().installRuntime({ ...input, smokeTest: async () => { throw new Error("bad"); } }),
      /RUNTIME_SMOKE_TEST_FAILED/,
    );
  }
  const quarantined = await fs.promises.readdir(path.join(paths.staging, "quarantine", "chroma"));
  assert.equal(quarantined.length, 3);
});

test("rollback reads immutable history instead of a mutable previous file", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const first = await inputFor(localDataRoot, paths, "runtime-history-one", Buffer.from("one"));
  const second = await inputFor(localDataRoot, paths, "runtime-history-two", Buffer.from("two"));
  await modules().installRuntime({ ...first, smokeTest: async () => undefined });
  await modules().installRuntime({ ...second, smokeTest: async () => undefined });
  await fs.promises.writeFile(path.join(paths.current, "chroma.previous.json"), "corrupt legacy pointer");

  const rolledBack = await modules().rollbackRuntime(paths, "chroma");

  assert.equal(rolledBack.runtimeId, "runtime-history-one");
  assert.equal(rolledBack.previousRuntimeId, "runtime-history-two");
});

test("current publication interruption preserves old current and leaves durable recovery metadata", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const oldInput = await inputFor(localDataRoot, paths, "runtime-before-crash", Buffer.from("old"));
  await modules().installRuntime({ ...oldInput, smokeTest: async () => undefined });
  const oldCurrent = await fs.promises.readFile(path.join(paths.current, "chroma.json"), "utf8");
  const nextInput = await inputFor(localDataRoot, paths, "runtime-after-crash", Buffer.from("new"));
  const originalRename = fs.promises.rename;
  fs.promises.rename = async (source, destination) => {
    if (destination === path.join(paths.current, "chroma.json")) {
      const error = new Error("injected current rename failure");
      error.code = "EIO";
      throw error;
    }
    return originalRename(source, destination);
  };
  t.after(() => { fs.promises.rename = originalRename; });

  await assert.rejects(
    modules().installRuntime({ ...nextInput, smokeTest: async () => undefined }),
    /injected current rename failure/,
  );
  fs.promises.rename = originalRename;

  assert.equal(await fs.promises.readFile(path.join(paths.current, "chroma.json"), "utf8"), oldCurrent);
  assert.equal(await fs.promises.readFile(
    path.join(paths.current, "history", "chroma", "runtime-after-crash.json"), "utf8",
  ).then(JSON.parse).then((pointer) => pointer.runtimeId), "runtime-after-crash");
  assert.equal(await fs.promises.readFile(
    path.join(paths.current, "recovery", "chroma", "runtime-after-crash.json"), "utf8",
  ).then(JSON.parse).then((state) => state.state), "published-not-current");
  assert.equal(await fs.promises.readFile(
    path.join(paths.chromaVersions, "runtime-after-crash", "chroma runtime"), "utf8",
  ), "new");
});

test("invalid old current aborts before smoke or final publication", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  await fs.promises.mkdir(paths.current, { recursive: true });
  await fs.promises.writeFile(path.join(paths.current, "chroma.json"), "{invalid");
  const input = await inputFor(localDataRoot, paths, "runtime-after-invalid", Buffer.from("new"));
  let smoked = false;

  await assert.rejects(
    modules().installRuntime({ ...input, smokeTest: async () => { smoked = true; } }),
    /RUNTIME_CURRENT_INVALID/,
  );
  assert.equal(smoked, false);
  assert.equal(fs.existsSync(path.join(paths.chromaVersions, "runtime-after-invalid")), false);
  assert.deepEqual(await fs.promises.readdir(paths.staging), []);
});

test("old current pointing to a missing runtime aborts before smoke", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  await fs.promises.mkdir(paths.current, { recursive: true });
  await fs.promises.mkdir(paths.chromaVersions, { recursive: true });
  await fs.promises.writeFile(
    path.join(paths.current, "chroma.json"),
    JSON.stringify(pointerFor(paths, "runtime-missing")),
  );
  const input = await inputFor(localDataRoot, paths, "runtime-after-missing", Buffer.from("new"));
  let smoked = false;
  await assert.rejects(
    modules().installRuntime({ ...input, smokeTest: async () => { smoked = true; } }),
    /RUNTIME_CURRENT_TARGET_INVALID/,
  );
  assert.equal(smoked, false);
  assert.equal(fs.existsSync(path.join(paths.chromaVersions, "runtime-after-missing")), false);
});

test("readCurrentRuntime rejects a dangling symlink used as the current directory", async (t) => {
  const { paths } = await setup(t);
  await fs.promises.mkdir(path.dirname(paths.current), { recursive: true });
  await fs.promises.symlink(path.join(paths.root, "missing-target"), paths.current, "dir");
  await assert.rejects(modules().readCurrentRuntime(paths, "chroma"), /RUNTIME_UNSAFE_DIRECTORY/);
});

test("readCurrentRuntime rejects a pointer file replaced by a symlink", async (t) => {
  const { paths } = await setup(t);
  await fs.promises.mkdir(paths.current, { recursive: true });
  const outsidePointer = path.join(paths.root, "outside-pointer.json");
  await fs.promises.writeFile(outsidePointer, JSON.stringify(pointerFor(paths, "runtime-link")));
  await fs.promises.symlink(outsidePointer, path.join(paths.current, "chroma.json"));
  await assert.rejects(modules().readCurrentRuntime(paths, "chroma"), /RUNTIME_CURRENT_INVALID/);
});

test("same runtimeId installations are serialized by an exclusive lock", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const first = await inputFor(localDataRoot, paths, "runtime-concurrent", Buffer.from("one"));
  const second = await inputFor(localDataRoot, paths, "runtime-concurrent-second-part", Buffer.from("two"), {
    id: "runtime-concurrent",
  });
  let enteredSmoke;
  const smokeEntered = new Promise((resolve) => { enteredSmoke = resolve; });
  let releaseSmoke;
  const smokeReleased = new Promise((resolve) => { releaseSmoke = resolve; });
  const installing = modules().installRuntime({
    ...first,
    smokeTest: async () => { enteredSmoke(); await smokeReleased; },
  });
  await smokeEntered;

  await assert.rejects(
    modules().installRuntime({ ...second, smokeTest: async () => undefined }),
    /RUNTIME_INSTALL_IN_PROGRESS/,
  );
  releaseSmoke();
  await installing;
  assert.equal((await modules().readCurrentRuntime(paths, "chroma")).runtimeId, "runtime-concurrent");
});

test("immutable history failure cannot switch current and leaves recovery state", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const first = await inputFor(localDataRoot, paths, "runtime-link-before", Buffer.from("old"));
  await modules().installRuntime({ ...first, smokeTest: async () => undefined });
  const oldCurrent = await fs.promises.readFile(path.join(paths.current, "chroma.json"), "utf8");
  const second = await inputFor(localDataRoot, paths, "runtime-link-after", Buffer.from("new"));
  const originalLink = fs.promises.link;
  fs.promises.link = async (source, destination) => {
    if (destination.includes(`${path.sep}history${path.sep}chroma${path.sep}`)
      && destination.endsWith(`${path.sep}runtime-link-after.json`)) {
      const error = new Error("injected history link failure");
      error.code = "EIO";
      throw error;
    }
    return originalLink(source, destination);
  };
  t.after(() => { fs.promises.link = originalLink; });

  await assert.rejects(
    modules().installRuntime({ ...second, smokeTest: async () => undefined }),
    /injected history link failure/,
  );
  fs.promises.link = originalLink;
  assert.equal(await fs.promises.readFile(path.join(paths.current, "chroma.json"), "utf8"), oldCurrent);
  assert.equal(JSON.parse(await fs.promises.readFile(
    path.join(paths.current, "recovery", "chroma", "runtime-link-after.json"), "utf8",
  )).state, "published-not-current");
});

test("managed directories remain private after publication", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const input = await inputFor(localDataRoot, paths, "runtime-private", Buffer.from("safe"));
  await modules().installRuntime({ ...input, smokeTest: async () => undefined });
  for (const directory of [paths.root, paths.staging, paths.chromaVersions, paths.current]) {
    assert.equal((await fs.promises.stat(directory)).mode & 0o777, 0o700);
  }
});

test("immutable runtime identity ignores rollback's dynamic previous edge", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const first = await inputFor(localDataRoot, paths, "runtime-edge-a", Buffer.from("a"));
  const second = await inputFor(localDataRoot, paths, "runtime-edge-b", Buffer.from("b"));
  const third = await inputFor(localDataRoot, paths, "runtime-edge-c", Buffer.from("c"));
  await modules().installRuntime({ ...first, smokeTest: async () => undefined });
  await modules().installRuntime({ ...second, smokeTest: async () => undefined });
  await modules().rollbackRuntime(paths, "chroma");

  const installed = await modules().installRuntime({ ...third, smokeTest: async () => undefined });

  assert.equal(installed.runtimeId, "runtime-edge-c");
  assert.equal(installed.previousRuntimeId, "runtime-edge-a");
});

test("concurrent different runtimeIds record the actual predecessor at publication", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const first = await inputFor(localDataRoot, paths, "runtime-concurrent-a", Buffer.from("a"));
  const second = await inputFor(localDataRoot, paths, "runtime-concurrent-b", Buffer.from("b"));
  let releaseFirst;
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  let firstEntered;
  const firstSmokeEntered = new Promise((resolve) => { firstEntered = resolve; });
  const installingFirst = modules().installRuntime({
    ...first,
    smokeTest: async () => { firstEntered(); await firstReleased; },
  });
  await firstSmokeEntered;

  await modules().installRuntime({ ...second, smokeTest: async () => undefined });
  releaseFirst();
  await installingFirst;

  const current = await modules().readCurrentRuntime(paths, "chroma");
  assert.equal(current.runtimeId, "runtime-concurrent-a");
  assert.equal(current.previousRuntimeId, "runtime-concurrent-b");
});

test("install after a concurrent rollback records the rollback target as predecessor", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const first = await inputFor(localDataRoot, paths, "runtime-race-a", Buffer.from("a"));
  const second = await inputFor(localDataRoot, paths, "runtime-race-b", Buffer.from("b"));
  const third = await inputFor(localDataRoot, paths, "runtime-race-c", Buffer.from("c"));
  await modules().installRuntime({ ...first, smokeTest: async () => undefined });
  await modules().installRuntime({ ...second, smokeTest: async () => undefined });
  let releaseThird;
  const thirdReleased = new Promise((resolve) => { releaseThird = resolve; });
  let thirdEntered;
  const thirdSmokeEntered = new Promise((resolve) => { thirdEntered = resolve; });
  const installingThird = modules().installRuntime({
    ...third,
    smokeTest: async () => { thirdEntered(); await thirdReleased; },
  });
  await thirdSmokeEntered;

  const rolledBack = await modules().rollbackRuntime(paths, "chroma");
  assert.equal(rolledBack.runtimeId, "runtime-race-a");
  releaseThird();
  const installed = await installingThird;

  assert.equal(installed.runtimeId, "runtime-race-c");
  assert.equal(installed.previousRuntimeId, "runtime-race-a");
});

test("install captures a finite timestamp exactly once", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const input = await inputFor(localDataRoot, paths, "runtime-time", Buffer.from("time"));
  let calls = 0;
  const installed = await modules().installRuntime({
    ...input,
    smokeTest: async () => undefined,
    now: () => { calls += 1; return 123456; },
  });
  assert.equal(calls, 1);
  assert.equal(installed.installedAt, 123456);
});

test("install rejects a non-finite timestamp before creating runtime state", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const input = await inputFor(localDataRoot, paths, "runtime-invalid-time", Buffer.from("time"));
  await assert.rejects(
    modules().installRuntime({ ...input, smokeTest: async () => undefined, now: () => Number.NaN }),
    /RUNTIME_INVALID_TIME/,
  );
  assert.equal(fs.existsSync(paths.staging), false);
});

test("pre-smoke recovery and runtime lock are durable before smoke executes", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const input = await inputFor(localDataRoot, paths, "runtime-pre-smoke", Buffer.from("safe"));
  let observedRecovery;
  let observedLock;
  await modules().installRuntime({
    ...input,
    smokeTest: async (candidatePath) => {
      observedRecovery = JSON.parse(await fs.promises.readFile(
        path.join(paths.current, "recovery", "chroma", "runtime-pre-smoke.json"), "utf8",
      ));
      observedLock = JSON.parse(await fs.promises.readFile(
        path.join(paths.chromaVersions, ".locks", "runtime-pre-smoke.lock"), "utf8",
      ));
      assert.equal(observedRecovery.stagingPath, candidatePath);
    },
  });
  assert.equal(observedRecovery.state, "pre-smoke");
  assert.equal(observedRecovery.lockToken, observedLock.token);
  assert.equal(observedLock.pid, process.pid);
});

test("retry reclaims a dead runtime lock and removes its pre-smoke orphan staging", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const runtimeId = "runtime-stale";
  const lockDirectory = path.join(paths.chromaVersions, ".locks");
  const recoveryDirectory = path.join(paths.current, "recovery", "chroma");
  const orphan = path.join(paths.staging, `${runtimeId}-00000000-0000-4000-8000-000000000002`);
  await fs.promises.mkdir(lockDirectory, { recursive: true });
  await fs.promises.mkdir(recoveryDirectory, { recursive: true });
  await fs.promises.mkdir(orphan, { recursive: true });
  await fs.promises.writeFile(path.join(orphan, "partial"), "orphan");
  await fs.promises.writeFile(
    path.join(lockDirectory, `${runtimeId}.lock`), JSON.stringify(lockMetadata()),
  );
  await fs.promises.writeFile(
    path.join(recoveryDirectory, `${runtimeId}.json`),
    JSON.stringify(recoveryState(paths, runtimeId, "pre-smoke", { stagingPath: orphan })),
  );
  const input = await inputFor(localDataRoot, paths, runtimeId, Buffer.from("fresh"));

  const installed = await modules().installRuntime({ ...input, smokeTest: async () => undefined });

  assert.equal(installed.runtimeId, runtimeId);
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(path.join(lockDirectory, `${runtimeId}.lock`)), false);
});

test("retry removes same-runtime orphan staging even when recovery was never written", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const runtimeId = "runtime-orphan";
  await fs.promises.mkdir(paths.staging, { recursive: true });
  for (let index = 0; index < 4; index += 1) {
    await fs.promises.mkdir(path.join(
      paths.staging,
      `${runtimeId}-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ));
  }
  const input = await inputFor(localDataRoot, paths, runtimeId, Buffer.from("fresh"));
  await modules().installRuntime({ ...input, smokeTest: async () => undefined });
  assert.deepEqual(
    (await fs.promises.readdir(paths.staging)).filter((name) => name.startsWith(`${runtimeId}-`)),
    [],
  );
});

test("orphan cleanup does not remove a runtimeId that merely shares a prefix", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const other = path.join(
    paths.staging,
    "runtime-prefix-other-00000000-0000-4000-8000-000000000003",
  );
  await fs.promises.mkdir(other, { recursive: true });
  await fs.promises.writeFile(path.join(other, "keep"), "other runtime");
  const input = await inputFor(localDataRoot, paths, "runtime-prefix", Buffer.from("fresh"));

  await modules().installRuntime({ ...input, smokeTest: async () => undefined });

  assert.equal(await fs.promises.readFile(path.join(other, "keep"), "utf8"), "other runtime");
});

test("retry cleans a publishing recovery whose final rename never happened", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const runtimeId = "runtime-publishing-stale";
  const lockDirectory = path.join(paths.chromaVersions, ".locks");
  const recoveryDirectory = path.join(paths.current, "recovery", "chroma");
  const orphan = path.join(
    paths.staging,
    `${runtimeId}-00000000-0000-4000-8000-000000000004`,
  );
  await fs.promises.mkdir(lockDirectory, { recursive: true });
  await fs.promises.mkdir(recoveryDirectory, { recursive: true });
  await fs.promises.mkdir(orphan, { recursive: true });
  await fs.promises.writeFile(path.join(orphan, "partial"), "orphan");
  await fs.promises.writeFile(
    path.join(lockDirectory, `${runtimeId}.lock`), JSON.stringify(lockMetadata()),
  );
  await fs.promises.writeFile(
    path.join(recoveryDirectory, `${runtimeId}.json`),
    JSON.stringify(recoveryState(paths, runtimeId, "publishing", { stagingPath: orphan })),
  );
  const input = await inputFor(localDataRoot, paths, runtimeId, Buffer.from("fresh"));

  const installed = await modules().installRuntime({ ...input, smokeTest: async () => undefined });

  assert.equal(installed.runtimeId, runtimeId);
  assert.equal(fs.existsSync(orphan), false);
});

test("untrusted runtime lock content fails closed without deleting the lock", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const runtimeId = "runtime-bad-lock";
  const lockDirectory = path.join(paths.chromaVersions, ".locks");
  const lockFile = path.join(lockDirectory, `${runtimeId}.lock`);
  await fs.promises.mkdir(lockDirectory, { recursive: true });
  await fs.promises.writeFile(lockFile, "not trusted json");
  const input = await inputFor(localDataRoot, paths, runtimeId, Buffer.from("fresh"));
  await assert.rejects(
    modules().installRuntime({ ...input, smokeTest: async () => undefined }),
    /RUNTIME_LOCK_INVALID/,
  );
  assert.equal(await fs.promises.readFile(lockFile, "utf8"), "not trusted json");
});

test("runtime lock symlinks fail closed without modifying their target", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const runtimeId = "runtime-link-lock";
  const lockDirectory = path.join(paths.chromaVersions, ".locks");
  const lockFile = path.join(lockDirectory, `${runtimeId}.lock`);
  const outsideFile = path.join(localDataRoot, "outside-lock.json");
  const outsideBody = JSON.stringify(lockMetadata());
  await fs.promises.mkdir(lockDirectory, { recursive: true });
  await fs.promises.writeFile(outsideFile, outsideBody);
  await fs.promises.symlink(outsideFile, lockFile);
  const input = await inputFor(localDataRoot, paths, runtimeId, Buffer.from("fresh"));

  await assert.rejects(
    modules().installRuntime({ ...input, smokeTest: async () => undefined }),
    /RUNTIME_LOCK_INVALID/,
  );

  assert.equal((await fs.promises.lstat(lockFile)).isSymbolicLink(), true);
  assert.equal(await fs.promises.readFile(outsideFile, "utf8"), outsideBody);
});

test("rollback reclaims a dead kind publication lock", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const first = await inputFor(localDataRoot, paths, "runtime-kind-a", Buffer.from("a"));
  const second = await inputFor(localDataRoot, paths, "runtime-kind-b", Buffer.from("b"));
  await modules().installRuntime({ ...first, smokeTest: async () => undefined });
  await modules().installRuntime({ ...second, smokeTest: async () => undefined });
  const lockDirectory = path.join(paths.current, ".locks");
  const lockFile = path.join(lockDirectory, "chroma.lock");
  await fs.promises.mkdir(lockDirectory, { recursive: true });
  await fs.promises.writeFile(lockFile, JSON.stringify(lockMetadata()));

  const rolledBack = await modules().rollbackRuntime(paths, "chroma");

  assert.equal(rolledBack.runtimeId, "runtime-kind-a");
  assert.equal(fs.existsSync(lockFile), false);
});

test("recovery pruning preserves active pre-smoke state", async (t) => {
  const { localDataRoot, paths } = await setup(t);
  const directory = path.join(paths.current, "recovery", "chroma");
  await fs.promises.mkdir(directory, { recursive: true });
  const activeFile = path.join(directory, "runtime-active.json");
  await fs.promises.writeFile(
    activeFile,
    JSON.stringify(recoveryState(paths, "runtime-active", "pre-smoke")),
  );
  await fs.promises.utimes(activeFile, new Date(0), new Date(0));
  for (let index = 0; index < 10; index += 1) {
    const runtimeId = `runtime-recovery-${index}`;
    await fs.promises.writeFile(
      path.join(directory, `${runtimeId}.json`),
      JSON.stringify(recoveryState(paths, runtimeId, "published-not-current")),
    );
  }
  const input = await inputFor(localDataRoot, paths, "runtime-pruner", Buffer.from("fresh"));
  await modules().installRuntime({ ...input, smokeTest: async () => undefined });
  assert.equal(JSON.parse(await fs.promises.readFile(activeFile, "utf8")).state, "pre-smoke");
});
