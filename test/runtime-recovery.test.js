"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const loaded = new Map();
function loadTypeScriptFile(filename) {
  if (loaded.has(filename)) return loaded.get(filename);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: filename,
  }).outputText;
  const module = { exports: {} };
  loaded.set(filename, module.exports);
  const localRequire = (specifier) => {
    if (!specifier.startsWith(".")) {
      return require(require.resolve(specifier, {
        paths: [path.join(process.cwd(), "node_modules")],
      }));
    }
    const resolved = path.resolve(path.dirname(filename), specifier);
    return fs.existsSync(`${resolved}.ts`) ? loadTypeScriptFile(`${resolved}.ts`) : require(resolved);
  };
  Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports, localRequire, module, filename, path.dirname(filename),
  );
  loaded.set(filename, module.exports);
  return module.exports;
}

function modules() {
  return {
    ...loadTypeScriptFile(path.join(process.cwd(), "src/runtime/runtime-paths.ts")),
    ...loadTypeScriptFile(path.join(process.cwd(), "src/runtime/environment-detector.ts")),
  };
}

async function fixture(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "Analogy detector 中文 "));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  return {
    root,
    paths: modules().createRuntimePaths(root, "vault-v2-0123456789abcdef"),
  };
}

function sha256(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function writeFixtureFile(filename, body, mode = 0o600) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filename, body, { mode });
}

async function embeddingFixture(t) {
  const { root, paths } = await fixture(t);
  const platform = "darwin-arm64";
  const asset = {
    id: "embedding-runtime-node22-v1-darwin-arm64",
    kind: "embedding-runtime",
    platform,
    version: "node22-v1",
    url: "https://example.invalid/runtime",
    fileName: "runtime.tar.gz",
    archive: "tar.gz",
    size: 123,
    sha256: sha256(Buffer.from("archive")),
    executableRelativePath: "analogy-embedding-runtime-node22-v1/node/bin/node",
    licenseName: "fixture",
    licenseUrl: "https://example.invalid/license",
    source: "published",
    runtimeVersions: { node: "22.23.2", transformers: "4.2.0", onnxruntime: "1.26.0" },
  };
  const installedPath = path.join(paths.embeddingVersions, asset.id);
  const packRoot = path.join(installedPath, "analogy-embedding-runtime-node22-v1");
  const executablePath = path.join(packRoot, "node", "bin", "node");
  const moduleRoot = path.join(packRoot, "node_modules");
  const nativeRoot = path.join(moduleRoot, "onnxruntime-node", "bin", "napi-v6", "darwin", "arm64");
  writeFixtureFile(executablePath, "managed node", 0o700);
  writeFixtureFile(path.join(moduleRoot, "package.json"), "{\"private\":true}\n");
  writeFixtureFile(
    path.join(moduleRoot, "@huggingface", "transformers", "package.json"),
    "{\"name\":\"@huggingface/transformers\",\"version\":\"4.2.0\"}\n",
  );
  writeFixtureFile(path.join(moduleRoot, "@huggingface", "transformers", "index.js"), "exports.env = {};\n");
  writeFixtureFile(
    path.join(moduleRoot, "onnxruntime-node", "package.json"),
    "{\"name\":\"onnxruntime-node\",\"version\":\"1.26.0\"}\n",
  );
  writeFixtureFile(path.join(moduleRoot, "onnxruntime-node", "index.js"), "module.exports = {};\n");
  writeFixtureFile(path.join(nativeRoot, "onnxruntime_binding.node"), "binding");
  writeFixtureFile(path.join(nativeRoot, "libonnxruntime.dylib"), "native");
  writeFixtureFile(path.join(packRoot, "THIRD_PARTY_NOTICES.txt"), "notices\n");

  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile() && filename !== path.join(packRoot, "manifest.json")) {
        const body = fs.readFileSync(filename);
        files.push({
          path: path.relative(packRoot, filename).split(path.sep).join("/"),
          size: body.length,
          sha256: sha256(body),
        });
      }
    }
  };
  visit(packRoot);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    schemaVersion: 1,
    id: asset.id,
    kind: "embedding-runtime",
    platform,
    version: asset.version,
    runtimeVersions: asset.runtimeVersions,
    executableRelativePath: "node/bin/node",
    moduleRootRelativePath: "node_modules",
    noticesRelativePath: "THIRD_PARTY_NOTICES.txt",
    files,
  };
  const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFixtureFile(path.join(packRoot, "manifest.json"), manifestBody);
  asset.internalManifestSha256 = sha256(Buffer.from(manifestBody));
  fs.mkdirSync(paths.current, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(paths.current, "embedding-runtime.json"), `${JSON.stringify({
    schemaVersion: 1,
    kind: "embedding-runtime",
    runtimeId: asset.id,
    installedPath,
    assetSha256: asset.sha256,
    installedAt: 1,
    previousRuntimeId: null,
  })}\n`, { mode: 0o600 });
  return { root, paths, platform, asset, executablePath, moduleRoot, nativeRoot };
}

function inspectors(overrides = {}) {
  return {
    chromaRuntime: async () => "installed",
    embeddingRuntime: async () => "ready",
    embeddingModel: async () => "ready",
    index: async () => "ready",
    chromaHealth: async () => "running",
    ...overrides,
  };
}

async function chromaFixture(t) {
  const { root, paths } = await fixture(t);
  const platform = "darwin-arm64";
  const executableBody = Buffer.from("managed chroma fixture\n");
  const asset = {
    id: "chroma-cli-1.4.4-darwin-arm64",
    kind: "chroma",
    platform,
    version: "cli-1.4.4",
    url: "https://example.invalid/chroma",
    fileName: "chroma-macos-arm64",
    archive: "none",
    size: executableBody.length,
    sha256: sha256(executableBody),
    executableRelativePath: "chroma-macos-arm64",
    licenseName: "Apache-2.0",
    licenseUrl: "https://example.invalid/license",
    source: "published",
  };
  const installedPath = path.join(paths.chromaVersions, asset.id);
  const executablePath = path.join(installedPath, asset.executableRelativePath);
  writeFixtureFile(executablePath, executableBody, 0o700);
  fs.mkdirSync(paths.current, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(paths.current, "chroma.json"), `${JSON.stringify({
    schemaVersion: 1,
    kind: "chroma",
    runtimeId: asset.id,
    installedPath,
    assetSha256: asset.sha256,
    installedAt: 1,
    previousRuntimeId: null,
  })}\n`, { mode: 0o600 });
  return { root, paths, platform, asset, executablePath };
}

function managedManager(executablePath, overrides = {}) {
  const state = {
    ownership: "analogy",
    pid: process.pid,
    executablePath,
    port: 8000,
    runtimeVersion: "cli-1.4.4",
    startedAt: 1,
    ...overrides,
  };
  return {
    getState: () => ({ ...state }),
    health: async () => true,
  };
}

test("detector is observational and empty environment requires setup", async (t) => {
  const { root, paths } = await fixture(t);
  const before = await fs.promises.stat(root);
  const report = await modules().detectEnvironment({ platform: "darwin-arm64", paths });
  const after = await fs.promises.stat(root);
  assert.deepEqual(report, {
    platform: "darwin-arm64",
    chroma: "missing",
    embeddingRuntime: "missing",
    embeddingModel: "missing",
    index: "empty",
    recommendedAction: "setup",
  });
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(await fs.promises.readdir(root), []);
});

test("detector migrates an exact legacy embedding pointer before reporting readiness", async (t) => {
  const value = await embeddingFixture(t);
  const localPointer = path.join(value.paths.current, "embedding-runtime.json");
  const legacyPointer = path.join(value.paths.legacyCurrent, "embedding-runtime.json");
  const pointerBody = await fs.promises.readFile(localPointer, "utf8");
  await fs.promises.mkdir(value.paths.legacyCurrent, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(legacyPointer, pointerBody, { mode: 0o600 });
  await fs.promises.unlink(localPointer);

  const report = await modules().detectEnvironment({
    platform: value.platform,
    paths: value.paths,
    getRuntimeAsset: (kind) => kind === "embedding-runtime" ? value.asset : null,
  });

  assert.equal(report.embeddingRuntime, "ready");
  assert.equal(await fs.promises.readFile(localPointer, "utf8"), pointerBody);
  assert.equal(await fs.promises.readFile(legacyPointer, "utf8"), pointerBody);
});

test("health probing is loopback-only, abortable, and bounded by a finite timeout", async (t) => {
  const { paths } = await fixture(t);
  let input = null;
  const report = await modules().detectEnvironment({
    platform: "darwin-arm64",
    paths,
    chromaPort: 8123,
    healthTimeoutMs: 25,
    externalChromaConfirmed: true,
    inspectors: inspectors({
      chromaHealth: async (value) => {
        input = value;
        assert.equal(value.signal.aborted, false);
        return "running";
      },
    }),
  });
  assert.equal(report.chroma, "running");
  assert.equal(input.host, "127.0.0.1");
  assert.equal(input.port, 8123);
  assert.equal(input.timeoutMs, 25);
  assert.ok(input.signal instanceof AbortSignal);

  await assert.rejects(modules().detectEnvironment({
    platform: "darwin-arm64", paths, chromaPort: 8123, healthTimeoutMs: 20,
    inspectors: inspectors({ chromaHealth: async () => new Promise(() => {}) }),
  }), /ENVIRONMENT_HEALTH_TIMEOUT/);
});

test("managed Chroma identity cannot be supplied as a public boolean option", () => {
  const virtualFile = path.join(process.cwd(), "test/environment-detector-options.type-check.ts");
  const source = `
    import type { EnvironmentDetectorOptions } from "../src/runtime/environment-detector";
    const options: EnvironmentDetectorOptions = {
      platform: "darwin-arm64",
      paths: {} as EnvironmentDetectorOptions["paths"],
      managedChromaIdentityVerified: true,
    };
    void options;
  `;
  const compilerOptions = {
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    target: ts.ScriptTarget.ES2020,
    strictNullChecks: true,
    skipLibCheck: true,
    noEmit: true,
  };
  const host = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (filename) => filename === virtualFile || fs.existsSync(filename);
  host.readFile = (filename) => filename === virtualFile ? source : fs.readFileSync(filename, "utf8");
  host.getSourceFile = (filename, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (filename === virtualFile) return ts.createSourceFile(filename, source, languageVersion, true);
    return originalGetSourceFile(filename, languageVersion, onError, shouldCreateNewSourceFile);
  };
  const program = ts.createProgram([virtualFile], compilerOptions, host);
  const diagnostics = ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName === virtualFile);
  assert.ok(
    diagnostics.some((diagnostic) => [2322, 2353].includes(diagnostic.code)),
    diagnostics.map((value) => value.messageText),
  );
});

test("detector rejects non-loopback endpoint input instead of contacting it", async (t) => {
  const { paths } = await fixture(t);
  let called = false;
  await assert.rejects(modules().detectEnvironment({
    platform: "darwin-arm64", paths, chromaPort: 8000, chromaHost: "0.0.0.0",
    inspectors: inspectors({ chromaHealth: async () => { called = true; return "running"; } }),
  }), /ENVIRONMENT_LOOPBACK_ONLY/);
  assert.equal(called, false);
});

test("a same-version loopback service cannot promote a missing or idle managed runtime to running", async (t) => {
  const { paths } = await fixture(t);
  const report = await modules().detectEnvironment({
    platform: "darwin-arm64", paths, chromaPort: 8000,
    inspectors: inspectors({
      chromaRuntime: async () => "missing",
      chromaHealth: async () => "running",
      embeddingRuntime: async () => "ready",
      embeddingModel: async () => "ready",
      index: async () => "ready",
    }),
  });
  assert.equal(report.chroma, "missing");
  assert.equal(report.recommendedAction, "setup");

  const installedButUnowned = await modules().detectEnvironment({
    platform: "darwin-arm64", paths, chromaPort: 8000,
    inspectors: inspectors({ chromaRuntime: async () => "installed", chromaHealth: async () => "running" }),
  });
  assert.equal(installedButUnowned.chroma, "installed");
  assert.equal(installedButUnowned.recommendedAction, "start-services");

  const confirmedExternal = await modules().detectEnvironment({
    platform: "darwin-arm64", paths, chromaPort: 8000, externalChromaConfirmed: true,
    inspectors: inspectors({ chromaRuntime: async () => "missing", chromaHealth: async () => "running" }),
  });
  assert.equal(confirmedExternal.chroma, "running");
});

test("managed Chroma promotion verifies every manager field against process, disk, and health", async (t) => {
  const value = await chromaFixture(t);
  const otherExecutable = path.join(value.paths.chromaVersions, "untrusted", "chroma-macos-arm64");
  writeFixtureFile(otherExecutable, "managed chroma fixture\n", 0o700);
  const baseOptions = {
    platform: value.platform,
    paths: value.paths,
    chromaPort: 8000,
    getRuntimeAsset: (kind) => kind === "chroma" ? value.asset : null,
    inspectors: {
      embeddingRuntime: async () => "ready",
      embeddingModel: async () => "ready",
      index: async () => "ready",
      chromaHealth: async () => "running",
      processExists: (pid) => pid === process.pid,
    },
  };
  const cases = [
    ["ownership", { ownership: "external" }],
    ["executable", { executablePath: otherExecutable }],
    ["port", { port: 8001 }],
    ["pid", { pid: 0 }],
    ["dead pid", { pid: process.pid + 100_000 }],
    ["runtime", { runtimeVersion: "1.0.0" }],
  ];
  for (const [label, overrides] of cases) {
    await t.test(label, async () => {
      const report = await modules().detectEnvironment({
        ...baseOptions,
        chromaRuntimeManager: managedManager(value.executablePath, overrides),
      });
      assert.equal(report.chroma, "installed");
      assert.equal(report.recommendedAction, "start-services");
    });
  }

  const unhealthy = managedManager(value.executablePath);
  unhealthy.health = async () => false;
  assert.equal((await modules().detectEnvironment({
    ...baseOptions, chromaRuntimeManager: unhealthy,
  })).chroma, "installed");

  const running = await modules().detectEnvironment({
    ...baseOptions,
    chromaRuntimeManager: managedManager(value.executablePath),
  });
  assert.equal(running.chroma, "running");
  assert.equal(running.recommendedAction, "none");
});

test("embedding readiness performs full managed payload verification", async (t) => {
  const targets = [
    ["node executable", (value) => value.executablePath],
    ["Transformers module", (value) => path.join(value.moduleRoot, "@huggingface", "transformers", "index.js")],
    ["ONNX native binding", (value) => path.join(value.nativeRoot, "onnxruntime_binding.node")],
  ];
  for (const [label, target] of targets) {
    await t.test(label, async (subtest) => {
      const value = await embeddingFixture(subtest);
      const options = {
        platform: value.platform,
        paths: value.paths,
        getRuntimeAsset: (kind) => kind === "embedding-runtime" ? value.asset : null,
        inspectors: {
          chromaRuntime: async () => "missing",
          embeddingModel: async () => "ready",
          index: async () => "ready",
        },
      };
      assert.equal((await modules().detectEnvironment(options)).embeddingRuntime, "ready");
      fs.appendFileSync(target(value), "tampered");
      const corrupt = await modules().detectEnvironment(options);
      assert.equal(corrupt.embeddingRuntime, "corrupt");
      assert.equal(corrupt.recommendedAction, "repair");
    });
  }
});

test("mixed-state action precedence is repair, resume, setup, start-services, then none", async (t) => {
  const { paths } = await fixture(t);
  const detect = (overrides, detectorOverrides = {}) => modules().detectEnvironment({
    platform: "darwin-arm64", paths, chromaPort: 8000,
    inspectors: inspectors(overrides),
    ...detectorOverrides,
  });

  assert.equal((await detect({
    chromaRuntime: async () => "corrupt", embeddingModel: async () => "cached", index: async () => "partial",
  })).recommendedAction, "repair");
  assert.equal((await detect({
    chromaRuntime: async () => "missing", embeddingModel: async () => "cached", index: async () => "partial",
    chromaHealth: async () => "missing",
  })).recommendedAction, "resume");
  assert.equal((await detect({
    chromaRuntime: async () => "missing", embeddingRuntime: async () => "missing",
    embeddingModel: async () => "missing", index: async () => "empty", chromaHealth: async () => "missing",
  })).recommendedAction, "setup");
  assert.equal((await detect({ chromaHealth: async () => "installed" })).recommendedAction, "start-services");
  assert.equal((await detect({}, { externalChromaConfirmed: true })).recommendedAction, "none");
});

test("all environment state variants are preserved in the report", async (t) => {
  const { paths } = await fixture(t);
  const cases = [
    ["missing", "missing", "missing", "empty"],
    ["installed", "installed", "cached", "partial"],
    ["running", "ready", "ready", "ready"],
    ["incompatible", "corrupt", "corrupt", "legacy"],
    ["corrupt", "ready", "ready", "ready"],
  ];
  for (const [chroma, embeddingRuntime, embeddingModel, index] of cases) {
    const report = await modules().detectEnvironment({
      platform: "win32-x64", paths, chromaPort: 8000,
      externalChromaConfirmed: true,
      inspectors: inspectors({
        chromaRuntime: async () => chroma === "running" ? "installed" : chroma,
        chromaHealth: async () => chroma,
        embeddingRuntime: async () => embeddingRuntime,
        embeddingModel: async () => embeddingModel,
        index: async () => index,
      }),
    });
    assert.equal(report.chroma, chroma);
    assert.equal(report.embeddingRuntime, embeddingRuntime);
    assert.equal(report.embeddingModel, embeddingModel);
    assert.equal(report.index, index);
  }
});

test("index inspection classifies empty, partial, ready, legacy, and corruption without rebuilding", async (t) => {
  const { paths } = await fixture(t);
  const inspect = async (indexState) => (await modules().detectEnvironment({
    platform: "darwin-arm64", paths, indexState,
    inspectors: {
      chromaRuntime: async () => "missing",
      embeddingRuntime: async () => "missing",
      embeddingModel: async () => "missing",
    },
  })).index;
  assert.equal(await inspect({ entries: 0, total: 0 }), "empty");
  assert.equal(await inspect({ entries: 2, total: 5 }), "partial");
  assert.equal(await inspect({ entries: 5, total: 5 }), "ready");
  assert.equal(await inspect({ entries: 2, total: 2, legacy: true }), "legacy");
  assert.equal(await inspect({ entries: 2, total: 2, corrupt: true }), "partial");
});

test("default inspection rejects symlinked model cache rather than following it", async (t) => {
  const { root, paths } = await fixture(t);
  const outside = path.join(root, "outside-model");
  await fs.promises.mkdir(outside);
  await fs.promises.mkdir(path.dirname(paths.modelCache), { recursive: true });
  await fs.promises.symlink(outside, paths.modelCache);
  const report = await modules().detectEnvironment({
    platform: "darwin-arm64", paths, modelCacheKey: "bge-small-en-v1.5",
  });
  assert.equal(report.embeddingModel, "corrupt");
  assert.equal(report.recommendedAction, "repair");
});

test("default inspection rejects a symlink ancestor above the model cache", async (t) => {
  const { root, paths } = await fixture(t);
  const outside = path.join(root, "outside-model-parent");
  await fs.promises.mkdir(path.join(outside, "transformers-cache", "bge-small-en-v1.5"), { recursive: true });
  await fs.promises.writeFile(
    path.join(outside, "transformers-cache", "bge-small-en-v1.5", "model.onnx"),
    "outside",
  );
  await fs.promises.symlink(outside, path.join(root, "models"));
  const report = await modules().detectEnvironment({
    platform: "darwin-arm64", paths, modelCacheKey: "bge-small-en-v1.5",
  });
  assert.equal(report.embeddingModel, "corrupt");
  assert.equal(report.recommendedAction, "repair");
});

test("managed embedding verification rejects a symlinked runtime ancestor", async (t) => {
  const value = await embeddingFixture(t);
  const outside = path.join(value.root, "outside-embedding");
  await fs.promises.rename(value.paths.embeddingVersions, outside);
  await fs.promises.symlink(outside, value.paths.embeddingVersions);
  const report = await modules().detectEnvironment({
    platform: value.platform,
    paths: value.paths,
    getRuntimeAsset: (kind) => kind === "embedding-runtime" ? value.asset : null,
    inspectors: {
      chromaRuntime: async () => "missing",
      embeddingModel: async () => "ready",
      index: async () => "ready",
    },
  });
  assert.equal(report.embeddingRuntime, "corrupt");
  assert.equal(report.recommendedAction, "repair");
});
