"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const loaded = new Map();

function loadTypeScriptFile(filename) {
  if (loaded.has(filename)) return loaded.get(filename);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  loaded.set(filename, module.exports);
  const localRequire = (specifier) => {
    if (!specifier.startsWith(".")) return require(specifier);
    const resolved = path.resolve(path.dirname(filename), specifier);
    return fs.existsSync(`${resolved}.ts`) ? loadTypeScriptFile(`${resolved}.ts`) : require(resolved);
  };
  Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports, localRequire, module, filename, path.dirname(filename),
  );
  loaded.set(filename, module.exports);
  return module.exports;
}

function bridgeModule() {
  return loadTypeScriptFile(path.join(
    process.cwd(),
    "src/runtime/legacy-chroma-runtime-bridge.ts",
  ));
}

async function fixture(t, platform = "darwin-arm64") {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "Analogy 旧索引迁移 "));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const pluginDir = path.join(root, "插件 目录");
  const executablePath = platform === "win32-x64"
    ? path.join(pluginDir, "chroma-venv", "Scripts", "chroma.exe")
    : path.join(pluginDir, "chroma-venv", "bin", "chroma");
  const legacyDataPath = path.join(pluginDir, "chroma_data", "legacy-vault");
  await fs.promises.mkdir(path.dirname(executablePath), { recursive: true });
  await fs.promises.mkdir(legacyDataPath, { recursive: true });
  await fs.promises.writeFile(executablePath, "legacy executable", "utf8");
  await fs.promises.chmod(executablePath, 0o755);
  await fs.promises.writeFile(path.join(legacyDataPath, "chroma.sqlite3"), "legacy 中文", "utf8");
  return { root, pluginDir, executablePath, legacyDataPath, platform };
}

test("legacy runtime discovery accepts only the contained platform executable and data directory", async (t) => {
  const input = await fixture(t);
  const { discoverLegacyRuntime } = bridgeModule();

  const candidate = await discoverLegacyRuntime(input);

  assert.deepEqual(candidate, {
    executablePath: await fs.promises.realpath(input.executablePath),
    legacyDataPath: await fs.promises.realpath(input.legacyDataPath),
    versionRange: ">=0.5.23 <0.6.0",
  });
});

test("legacy runtime discovery rejects a symlinked executable outside chroma-venv", async (t) => {
  const input = await fixture(t);
  const outside = path.join(input.root, "outside-chroma");
  await fs.promises.writeFile(outside, "outside", "utf8");
  await fs.promises.rm(input.executablePath);
  await fs.promises.symlink(outside, input.executablePath);

  const { discoverLegacyRuntime } = bridgeModule();
  await assert.rejects(discoverLegacyRuntime(input), /LEGACY_RUNTIME_UNTRUSTED/);
});

test("legacy runtime discovery rejects a legacy data symlink instead of following it", async (t) => {
  const input = await fixture(t);
  const outsideData = path.join(input.root, "outside-data");
  await fs.promises.mkdir(outsideData);
  await fs.promises.rm(input.legacyDataPath, { recursive: true });
  await fs.promises.symlink(outsideData, input.legacyDataPath);

  const { discoverLegacyRuntime } = bridgeModule();
  await assert.rejects(discoverLegacyRuntime(input), /LEGACY_DATA_PATH_UNSAFE/);
});

test("legacy runtime discovery uses the Windows Scripts executable without shell translation", async (t) => {
  const input = await fixture(t, "win32-x64");
  const { discoverLegacyRuntime } = bridgeModule();

  const candidate = await discoverLegacyRuntime(input);

  assert.equal(candidate.executablePath, await fs.promises.realpath(input.executablePath));
  assert.ok(candidate.executablePath.endsWith(path.join("Scripts", "chroma.exe")));
});

test("legacy snapshot clones files into private staging and preserves the original", async (t) => {
  const input = await fixture(t);
  const { discoverLegacyRuntime, createLegacySnapshot } = bridgeModule();
  const candidate = await discoverLegacyRuntime(input);
  const sourceFile = path.join(input.legacyDataPath, "chroma.sqlite3");
  const before = await fs.promises.stat(sourceFile);
  const copyCalls = [];

  const snapshot = await createLegacySnapshot({
    candidate,
    stagingRoot: path.join(input.root, "device-local", "legacy-migration"),
    migrationId: "0123456789abcdef0123456789abcdef",
    availableBytes: async () => 1_000_000,
    copyFile: async (source, target, flags) => {
      copyCalls.push(flags);
      if (flags !== 0) throw Object.assign(new Error("clone unsupported"), { code: "ENOTSUP" });
      await fs.promises.copyFile(source, target);
    },
  });

  assert.notEqual(snapshot.snapshotPath, input.legacyDataPath);
  assert.ok(snapshot.snapshotPath.startsWith(path.join(input.root, "device-local", "legacy-migration")));
  assert.equal(await fs.promises.readFile(path.join(snapshot.snapshotPath, "chroma.sqlite3"), "utf8"), "legacy 中文");
  assert.deepEqual(copyCalls, [fs.constants.COPYFILE_FICLONE, 0]);
  assert.equal(await fs.promises.readFile(sourceFile, "utf8"), "legacy 中文");
  const after = await fs.promises.stat(sourceFile);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(snapshot.sourceIdentity.fileCount, 1);
  assert.equal(snapshot.sourceIdentity.totalBytes, Buffer.byteLength("legacy 中文"));
  assert.match(snapshot.sourceIdentity.digest, /^[0-9a-f]{64}$/);
});

test("legacy snapshot fails before copying when free space is smaller than source", async (t) => {
  const input = await fixture(t);
  const { discoverLegacyRuntime, createLegacySnapshot } = bridgeModule();
  const candidate = await discoverLegacyRuntime(input);
  let copies = 0;

  await assert.rejects(createLegacySnapshot({
    candidate,
    stagingRoot: path.join(input.root, "device-local", "legacy-migration"),
    migrationId: "1123456789abcdef0123456789abcdef",
    availableBytes: async () => 1,
    copyFile: async () => { copies += 1; },
  }), /INSUFFICIENT_DISK_SPACE/);

  assert.equal(copies, 0);
});

test("legacy snapshot rejects a source mutation during copy and removes partial staging", async (t) => {
  const input = await fixture(t);
  const { discoverLegacyRuntime, createLegacySnapshot } = bridgeModule();
  const candidate = await discoverLegacyRuntime(input);
  const stagingRoot = path.join(input.root, "device-local", "legacy-migration");
  let changed = false;

  await assert.rejects(createLegacySnapshot({
    candidate,
    stagingRoot,
    migrationId: "2123456789abcdef0123456789abcdef",
    availableBytes: async () => 1_000_000,
    copyFile: async (source, target) => {
      await fs.promises.copyFile(source, target);
      if (!changed) {
        changed = true;
        await fs.promises.appendFile(source, "changed", "utf8");
      }
    },
  }), /LEGACY_SOURCE_CHANGED/);

  assert.deepEqual(await fs.promises.readdir(stagingRoot), []);
});

test("legacy source identity rejects nested symbolic links", async (t) => {
  const input = await fixture(t);
  const outside = path.join(input.root, "secret");
  await fs.promises.writeFile(outside, "secret", "utf8");
  await fs.promises.symlink(outside, path.join(input.legacyDataPath, "linked"));
  const { discoverLegacyRuntime, createLegacySnapshot } = bridgeModule();
  const candidate = await discoverLegacyRuntime(input);

  await assert.rejects(createLegacySnapshot({
    candidate,
    stagingRoot: path.join(input.root, "device-local", "legacy-migration"),
    migrationId: "3123456789abcdef0123456789abcdef",
    availableBytes: async () => 1_000_000,
  }), /LEGACY_DATA_PATH_UNSAFE/);
});

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
  }

  kill(signal = "SIGTERM") {
    this.killed = true;
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

test("legacy bridge starts the trusted binary against only the snapshot and reads bounded v1 records", async (t) => {
  const input = await fixture(t);
  const { discoverLegacyRuntime, LegacyChromaRuntimeBridge } = bridgeModule();
  const candidate = await discoverLegacyRuntime(input);
  const snapshotPath = path.join(input.root, "device-local", "snapshot-safe");
  const child = new FakeChild();
  let spawnCall;
  const requests = [];
  const bridge = new LegacyChromaRuntimeBridge({
    candidate,
    stagingRoot: path.dirname(snapshotPath),
    migrationId: "4123456789abcdef0123456789abcdef",
    collectionName: "analogy_legacy-vault_bge-small-en-v1.5",
    platform: "darwin-arm64",
    createSnapshot: async () => ({
      snapshotPath,
      sourceIdentity: { digest: "a".repeat(64), totalBytes: 123, newestMtimeMs: 4, fileCount: 2 },
    }),
    allocatePort: async () => 8123,
    spawn(executable, args, options) {
      spawnCall = { executable, args, options };
      return child;
    },
    requestJson: async (request) => {
      requests.push(request);
      if (request.path === "/api/v1/heartbeat") return { nanosecond_heartbeat: 1 };
      if (request.path === "/api/v1/version") return "0.5.23";
      if (request.path.includes("/collections/analogy_legacy-vault_bge-small-en-v1.5")) {
        return { id: "source-collection-id", name: "analogy_legacy-vault_bge-small-en-v1.5" };
      }
      if (request.path.endsWith("/count")) return 2;
      if (request.path.endsWith("/get")) return {
        ids: ["chunk-a"], documents: ["正文"], metadatas: [{ doc_id: "a.md" }], embeddings: [[0.1, 0.2]],
      };
      if (request.path.endsWith("/query")) return { ids: [["chunk-a"]], distances: [[0.01]] };
      throw new Error(`unexpected ${request.method} ${request.path}`);
    },
  });

  const session = await bridge.prepare(new AbortController().signal);
  assert.deepEqual(spawnCall, {
    executable: candidate.executablePath,
    args: ["run", "--path", snapshotPath, "--host", "127.0.0.1", "--port", "8123"],
    options: { shell: false, cwd: snapshotPath },
  });
  assert.equal(JSON.stringify(spawnCall).includes(candidate.legacyDataPath), false);
  assert.equal(await session.count(), 2);
  assert.deepEqual(await session.readBatch(256, 128), {
    ids: ["chunk-a"], documents: ["正文"], metadatas: [{ doc_id: "a.md" }], embeddings: [[0.1, 0.2]],
  });
  assert.deepEqual(requests.at(-1).body, {
    offset: 256,
    limit: 128,
    include: ["documents", "metadatas", "embeddings"],
  });
  assert.deepEqual(await session.query([0.1, 0.2], 3), { ids: [["chunk-a"]], distances: [[0.01]] });
  await session.close();
  assert.equal(child.killed, true);
});

test("legacy bridge rejects a non-0.5 source and stops only its owned child", async (t) => {
  const input = await fixture(t);
  const { discoverLegacyRuntime, LegacyChromaRuntimeBridge } = bridgeModule();
  const candidate = await discoverLegacyRuntime(input);
  const child = new FakeChild();
  const bridge = new LegacyChromaRuntimeBridge({
    candidate,
    stagingRoot: path.join(input.root, "staging"),
    migrationId: "5123456789abcdef0123456789abcdef",
    collectionName: "analogy_legacy-vault_bge-small-en-v1.5",
    platform: "darwin-arm64",
    createSnapshot: async () => ({
      snapshotPath: path.join(input.root, "staging", "snapshot"),
      sourceIdentity: { digest: "b".repeat(64), totalBytes: 1, newestMtimeMs: 1, fileCount: 1 },
    }),
    allocatePort: async () => 8124,
    spawn: () => child,
    requestJson: async ({ path: requestPath }) => requestPath.endsWith("heartbeat")
      ? { nanosecond_heartbeat: 1 }
      : requestPath.endsWith("version") ? "1.4.4" : {},
  });

  await assert.rejects(bridge.prepare(new AbortController().signal), /LEGACY_CHROMA_VERSION_MISMATCH/);
  assert.equal(child.killed, true);
});

test("legacy bridge aborts before snapshot creation or process start", async (t) => {
  const input = await fixture(t);
  const { discoverLegacyRuntime, LegacyChromaRuntimeBridge } = bridgeModule();
  const candidate = await discoverLegacyRuntime(input);
  const controller = new AbortController();
  controller.abort();
  let prepared = false;
  let spawned = false;
  const bridge = new LegacyChromaRuntimeBridge({
    candidate,
    stagingRoot: path.join(input.root, "staging"),
    migrationId: "6123456789abcdef0123456789abcdef",
    collectionName: "analogy_legacy-vault_bge-small-en-v1.5",
    platform: "darwin-arm64",
    createSnapshot: async () => { prepared = true; throw new Error("unexpected"); },
    allocatePort: async () => 8125,
    spawn: () => { spawned = true; return new FakeChild(); },
    requestJson: async () => ({}),
  });

  await assert.rejects(bridge.prepare(controller.signal), /LEGACY_MIGRATION_CANCELLED/);
  assert.equal(prepared, false);
  assert.equal(spawned, false);
});
