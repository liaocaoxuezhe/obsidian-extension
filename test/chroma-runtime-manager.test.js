"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const ts = require("typescript");

const loadedTypeScriptModules = new Map();

function loadTypeScriptFile(filename) {
  if (loadedTypeScriptModules.has(filename)) return loadedTypeScriptModules.get(filename);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  loadedTypeScriptModules.set(filename, module.exports);
  const localRequire = (specifier) => {
    if (!specifier.startsWith(".")) return require(specifier);
    const resolved = path.resolve(path.dirname(filename), specifier);
    return fs.existsSync(`${resolved}.ts`) ? loadTypeScriptFile(`${resolved}.ts`) : require(resolved);
  };
  Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports,
    localRequire,
    module,
    filename,
    path.dirname(filename),
  );
  loadedTypeScriptModules.set(filename, module.exports);
  return module.exports;
}

function runtimeModule() {
  const runtime = loadTypeScriptFile(path.join(
    process.cwd(),
    "src/runtime/chroma-runtime-manager.ts",
  ));
  return {
    ...runtime,
    ChromaRuntimeManager: class TestChromaRuntimeManager extends runtime.ChromaRuntimeManager {
      constructor(options = {}) {
        super({ platform: "darwin", ...options });
      }
    },
  };
}

function leaseModule() {
  return loadTypeScriptFile(path.join(
    process.cwd(),
    "src/runtime/chroma-process-lease.ts",
  ));
}

function facadeModule() {
  return loadTypeScriptFile(path.join(
    process.cwd(),
    "src/local-vector/chroma-process.ts",
  ));
}

class FakeChild extends EventEmitter {
  constructor(options = {}) {
    const {
      exitOnKill = true,
      exitOnSigkill = true,
      errorOnKill = false,
      autoSpawn = true,
      autoReady = true,
      readyPort = 8000,
    } = options;
    super();
    this.pid = Object.prototype.hasOwnProperty.call(options, "pid") ? options.pid : 4242;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.killCalls = [];
    this.exitOnKill = exitOnKill;
    this.exitOnSigkill = exitOnSigkill;
    this.errorOnKill = errorOnKill;
    if (autoSpawn) {
      const announceSpawn = (event) => {
        if (event !== "spawn") return;
        this.removeListener("newListener", announceSpawn);
        queueMicrotask(() => this.emit("spawn"));
      };
      this.on("newListener", announceSpawn);
    }
    if (autoReady) {
      let announced = false;
      this.stdout.on("newListener", (event) => {
        if (event !== "data" || announced) return;
        announced = true;
        queueMicrotask(() => this.stdout.write(
          `Frontend server listening on address, addr: 127.0.0.1:${readyPort}\n`,
        ));
      });
    }
  }

  kill(signal) {
    this.killCalls.push(signal);
    this.killed = true;
    if (this.errorOnKill) {
      const error = new Error(`kill ${signal ?? "default"} EPERM`);
      error.code = "EPERM";
      queueMicrotask(() => this.emit("error", error));
      return false;
    }
    if (this.exitOnKill || (signal === "SIGKILL" && this.exitOnSigkill)) {
      this.signalCode = signal || "SIGTERM";
      queueMicrotask(() => this.emit("exit", null, this.signalCode));
    }
    return true;
  }
}

function deadline(promise, ms = 500) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("TEST_TIMEOUT");
      error.code = "TEST_TIMEOUT";
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function runNodeScript(source, timeout = 800) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["-e", source], { cwd: process.cwd(), timeout }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function compatibleProbe() {
  return Promise.resolve({ healthy: true, compatible: true, version: "1.0.0" });
}

async function temporaryDataPath(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "Analogy Chroma 中文 "));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  return path.join(root, "vault data 空格");
}

test("Vault lease stores publish and clear only their own token", async (t) => {
  const { ChromaProcessLeaseStore } = leaseModule();
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "Analogy lease 中文 "));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const firstPath = path.join(root, "vaults", "vault-v2-0123456789abcdef", "chroma-process-lease.json");
  const secondPath = path.join(root, "vaults", "vault-v2-fedcba9876543210", "chroma-process-lease.json");
  const first = new ChromaProcessLeaseStore({
    root,
    leasePath: firstPath,
    runtimeVaultId: "vault-v2-0123456789abcdef",
  });
  const second = new ChromaProcessLeaseStore({
    root,
    leasePath: secondPath,
    runtimeVaultId: "vault-v2-fedcba9876543210",
  });
  const common = {
    schemaVersion: 1,
    pid: 4242,
    port: 8000,
    executablePath: path.join(root, "runtime", "chroma"),
    dataPath: path.join(root, "vault-data"),
    runtimeVersion: "cli-1.4.4",
    startedAt: 1,
  };
  await first.publish({ ...common, runtimeVaultId: "vault-v2-0123456789abcdef", token: "a".repeat(32) });
  await second.publish({ ...common, runtimeVaultId: "vault-v2-fedcba9876543210", token: "b".repeat(32) });

  assert.equal(await first.clearIfTokenMatches("wrong"), false);
  assert.equal((await second.read()).token, "b".repeat(32));
  assert.equal(await first.clearIfTokenMatches("a".repeat(32)), true);
  assert.equal(await first.read(), null);
  assert.equal((await second.read()).runtimeVaultId, "vault-v2-fedcba9876543210");
});

test("manager publishes a Vault lease and adopts a verified healthy process without spawning", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const published = [];
  const leaseStore = {
    runtimeVaultId: "vault-v2-0123456789abcdef",
    value: null,
    async read() { return this.value; },
    async publish(value) { this.value = value; published.push(value); },
    async clearIfTokenMatches(token) { if (this.value?.token !== token) return false; this.value = null; return true; },
    async isolate() { this.value = null; },
  };
  const child = new FakeChild({ pid: 4321 });
  const first = new ChromaRuntimeManager({
    leaseStore,
    spawn: () => child,
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
    inspectProcessIdentity: async () => true,
    processExists: () => true,
  });
  const started = await first.start({ executablePath: "/runtime/chroma", dataPath, runtimeVersion: "cli-1.4.4" });
  assert.equal(published.length, 1);
  assert.equal(published[0].pid, started.pid);
  assert.equal(published[0].dataPath, dataPath);

  let spawns = 0;
  const second = new ChromaRuntimeManager({
    leaseStore,
    spawn: () => { spawns += 1; return new FakeChild(); },
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
    inspectProcessIdentity: async () => true,
    processExists: () => true,
  });
  const adopted = await second.start({ executablePath: "/runtime/chroma", dataPath, runtimeVersion: "cli-1.4.4" });
  assert.equal(spawns, 0);
  assert.equal(adopted.pid, 4321);
  assert.equal(adopted.ownership, "analogy");
});

test("identity mismatch isolates a stale lease without terminating that PID", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  let isolated = 0;
  let terminated = 0;
  const leaseStore = {
    runtimeVaultId: "vault-v2-0123456789abcdef",
    value: {
      schemaVersion: 1,
      runtimeVaultId: "vault-v2-0123456789abcdef",
      pid: 7777,
      port: 8000,
      executablePath: "/other/chroma",
      dataPath,
      runtimeVersion: "cli-1.4.4",
      startedAt: 1,
      token: "c".repeat(32),
    },
    async read() { return this.value; },
    async publish(value) { this.value = value; },
    async clearIfTokenMatches() { return false; },
    async isolate() { isolated += 1; this.value = null; },
  };
  let spawns = 0;
  const manager = new ChromaRuntimeManager({
    leaseStore,
    spawn: () => { spawns += 1; return new FakeChild(); },
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
    inspectProcessIdentity: async () => false,
    terminateProcess: async () => { terminated += 1; },
    processExists: () => true,
  });
  await manager.start({ executablePath: "/runtime/chroma", dataPath, runtimeVersion: "cli-1.4.4" });
  assert.equal(isolated, 1);
  assert.equal(terminated, 0);
  assert.equal(spawns, 1);
});

test("unhealthy verified lease exits before a replacement opens the same Vault database", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  let now = 0;
  let oldProcessExists = true;
  let terminationRequested = false;
  let probes = 0;
  const leaseStore = {
    runtimeVaultId: "vault-v2-0123456789abcdef",
    value: {
      schemaVersion: 1,
      runtimeVaultId: "vault-v2-0123456789abcdef",
      pid: 7777,
      port: 8000,
      executablePath: "/runtime/chroma",
      dataPath,
      runtimeVersion: "cli-1.4.4",
      startedAt: 1,
      token: "d".repeat(32),
    },
    async read() { return this.value; },
    async publish(value) { this.value = value; },
    async clearIfTokenMatches(token) {
      if (this.value?.token !== token) return false;
      this.value = null;
      return true;
    },
    async isolate() { this.value = null; },
  };
  const manager = new ChromaRuntimeManager({
    now: () => now,
    stopTimeoutMs: 500,
    leaseStore,
    processExists: (pid) => pid === 7777 ? oldProcessExists : true,
    inspectProcessIdentity: async () => true,
    terminateProcess: async (pid) => {
      assert.equal(pid, 7777);
      terminationRequested = true;
    },
    waitMs: async (ms) => {
      now += ms;
      if (terminationRequested && now >= 200) oldProcessExists = false;
    },
    probeHealth: async () => (++probes === 1
      ? { healthy: false, compatible: false, version: null }
      : { healthy: true, compatible: true, version: "1.0.0" }),
    isPortAvailable: async () => true,
    spawn: () => {
      assert.equal(oldProcessExists, false, "replacement must wait until the old process releases the database");
      return new FakeChild();
    },
  });

  const state = await manager.start({
    executablePath: "/runtime/chroma",
    dataPath,
    runtimeVersion: "cli-1.4.4",
  });

  assert.equal(state.ownership, "analogy");
  assert.equal(terminationRequested, true);
  await manager.stopOwnedProcess();
});

test("unhealthy verified lease times out with a frozen clock instead of spinning forever", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  let waits = 0;
  let spawns = 0;
  const leaseStore = {
    runtimeVaultId: "vault-v2-0123456789abcdef",
    value: {
      schemaVersion: 1,
      runtimeVaultId: "vault-v2-0123456789abcdef",
      pid: 7777,
      port: 8000,
      executablePath: "/runtime/chroma",
      dataPath,
      runtimeVersion: "cli-1.4.4",
      startedAt: 1,
      token: "e".repeat(32),
    },
    async read() { return this.value; },
    async publish(value) { this.value = value; },
    async clearIfTokenMatches() { return false; },
    async isolate() { this.value = null; },
  };
  const manager = new ChromaRuntimeManager({
    now: () => 0,
    stopTimeoutMs: 500,
    leaseStore,
    processExists: () => true,
    inspectProcessIdentity: async () => true,
    terminateProcess: async () => {},
    waitMs: async () => { waits += 1; },
    probeHealth: async () => ({ healthy: false, compatible: false, version: null }),
    isPortAvailable: async () => true,
    spawn: () => { spawns += 1; return new FakeChild(); },
  });

  await assert.rejects(
    manager.start({ executablePath: "/runtime/chroma", dataPath, runtimeVersion: "cli-1.4.4" }),
    (error) => error.code === "CHROMA_STOP_FAILED",
  );
  assert.equal(waits, 5);
  assert.equal(spawns, 0);
});

test("unhealthy lease is reverified before termination to avoid killing a reused PID", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  let identityChecks = 0;
  let isolated = 0;
  let terminated = 0;
  let spawns = 0;
  let probes = 0;
  const leaseStore = {
    runtimeVaultId: "vault-v2-0123456789abcdef",
    value: {
      schemaVersion: 1,
      runtimeVaultId: "vault-v2-0123456789abcdef",
      pid: 7777,
      port: 8000,
      executablePath: "/runtime/chroma",
      dataPath,
      runtimeVersion: "cli-1.4.4",
      startedAt: 1,
      token: "f".repeat(32),
    },
    async read() { return this.value; },
    async publish(value) { this.value = value; },
    async clearIfTokenMatches() { return false; },
    async isolate() { isolated += 1; this.value = null; },
  };
  const manager = new ChromaRuntimeManager({
    leaseStore,
    processExists: () => true,
    inspectProcessIdentity: async () => ++identityChecks === 1,
    terminateProcess: async () => { terminated += 1; },
    probeHealth: async () => (++probes === 1
      ? { healthy: false, compatible: false, version: null }
      : { healthy: true, compatible: true, version: "1.0.0" }),
    isPortAvailable: async () => true,
    spawn: () => { spawns += 1; return new FakeChild(); },
  });

  await manager.start({ executablePath: "/runtime/chroma", dataPath, runtimeVersion: "cli-1.4.4" });
  assert.equal(identityChecks, 2);
  assert.equal(isolated, 1);
  assert.equal(terminated, 0);
  assert.equal(spawns, 1);
  await manager.stopOwnedProcess();
});

test("managed start spawns the installed executable directly with literal arguments", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild();
  let spawnCall;
  const manager = new ChromaRuntimeManager({
    platform: "darwin",
    spawn(executable, args, options) {
      spawnCall = { executable, args, ...options };
      return child;
    },
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
  });

  const state = await manager.start({
    executablePath: "/runtime/chroma",
    dataPath,
    preferredPort: 8000,
    runtimeVersion: "cli-1.4.4",
  });

  assert.deepEqual(spawnCall, {
    executable: "/runtime/chroma",
    args: ["run", "--path", dataPath, "--host", "127.0.0.1", "--port", "8000"],
    shell: false,
  });
  assert.equal(state.ownership, "analogy");
  assert.equal(state.port, 8000);
  await manager.stopOwnedProcess();
});

test("Windows start uses the exe path and hides the child window without a command shell", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild();
  let spawnCall;
  const manager = new ChromaRuntimeManager({
    platform: "win32",
    spawn(executable, args, options) {
      spawnCall = { executable, args, ...options };
      return child;
    },
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
  });

  await manager.start({
    executablePath: "C:\\Analogy Runtime\\chroma-windows.exe",
    dataPath: "C:\\Analogy Data\\中文 vault",
    preferredPort: 8000,
  });

  assert.deepEqual(spawnCall, {
    executable: "C:\\Analogy Runtime\\chroma-windows.exe",
    args: [
      "run", "--path", "C:\\Analogy Data\\中文 vault",
      "--host", "127.0.0.1", "--port", "8000",
    ],
    shell: false,
    windowsHide: true,
  });
  assert.ok(spawnCall.executable.endsWith(".exe"));
  assert.equal(JSON.stringify(spawnCall).includes("cmd.exe"), false);
  assert.equal(JSON.stringify(spawnCall).toLowerCase().includes("powershell"), false);
  await manager.stopOwnedProcess();
});

for (const [name, probe] of [
  ["compatible unknown Chroma", compatibleProbe],
  ["non-Chroma service", async () => ({ healthy: false, compatible: false, version: null })],
]) {
  test(`default ownership scans past ${name} on port 8000`, async (t) => {
    const { ChromaRuntimeManager } = runtimeModule();
    const dataPath = await temporaryDataPath(t);
    const child = new FakeChild({ readyPort: 8001 });
    const spawnedPorts = [];
    const manager = new ChromaRuntimeManager({
      platform: "darwin",
      spawn(_executable, args) {
        spawnedPorts.push(Number(args.at(-1)));
        return child;
      },
      isPortAvailable: async (port) => port === 8001,
      probeHealth: async (port) => port === 8000 ? probe() : compatibleProbe(),
    });

    const state = await manager.start({ executablePath: "/runtime/chroma", dataPath, preferredPort: 8000 });

    assert.equal(state.ownership, "analogy");
    assert.equal(state.port, 8001);
    assert.deepEqual(spawnedPorts, [8001]);
    await manager.stopOwnedProcess();
  });
}

test("only an explicitly configured compatible endpoint is external and it is never stopped", async () => {
  const { ChromaRuntimeManager } = runtimeModule();
  let spawnCount = 0;
  const manager = new ChromaRuntimeManager({
    platform: "darwin",
    spawn() {
      spawnCount += 1;
      return new FakeChild();
    },
    probeHealth: compatibleProbe,
  });

  const state = await manager.start({
    executablePath: "/unused/chroma",
    dataPath: "/unused/data",
    preferredPort: 8123,
    external: true,
  });
  await manager.stopOwnedProcess();

  assert.deepEqual(state, {
    ownership: "external",
    pid: null,
    executablePath: null,
    port: 8123,
    runtimeVersion: "1.0.0",
    startedAt: null,
  });
  assert.equal(spawnCount, 0);
  assert.equal(manager.getState().ownership, "external");
});

test("an explicitly configured incompatible endpoint is rejected without stopping or spawning", async () => {
  const { ChromaRuntimeManager } = runtimeModule();
  let spawnCount = 0;
  const manager = new ChromaRuntimeManager({
    spawn() {
      spawnCount += 1;
      return new FakeChild();
    },
    probeHealth: async () => ({ healthy: true, compatible: false, version: "0.5.23" }),
  });

  await assert.rejects(
    manager.start({ executablePath: "/unused/chroma", dataPath: "/unused/data", external: true }),
    /CHROMA_VERSION_MISMATCH/,
  );
  assert.equal(spawnCount, 0);
  assert.equal(manager.getState().ownership, "none");
});

test("all ports occupied from 8000 through 8099 returns CHROMA_PORT_CONFLICT", async () => {
  const { ChromaRuntimeManager } = runtimeModule();
  const checked = [];
  const manager = new ChromaRuntimeManager({
    isPortAvailable: async (port) => {
      checked.push(port);
      return false;
    },
  });

  await assert.rejects(
    manager.start({ executablePath: "/runtime/chroma", dataPath: "/data", preferredPort: 8000 }),
    /CHROMA_PORT_CONFLICT/,
  );
  assert.equal(checked.length, 100);
  assert.deepEqual([checked[0], checked.at(-1)], [8000, 8099]);
  assert.equal(manager.getState().ownership, "none");
});

test("health requires the pinned v2 heartbeat and v2 wire version", async () => {
  const { ChromaRuntimeManager } = runtimeModule();
  const calls = [];
  const manager = new ChromaRuntimeManager({
    requestText: async (port, pathname) => {
      calls.push([port, pathname]);
      return pathname.endsWith("heartbeat") ? "{\"nanosecond heartbeat\":1}" : "\"1.0.0\"";
    },
  });

  assert.equal(await manager.health(8042), true);
  assert.deepEqual(calls, [
    [8042, "/api/v2/heartbeat"],
    [8042, "/api/v2/version"],
  ]);

  const mismatch = new ChromaRuntimeManager({
    requestText: async (_port, pathname) => pathname.endsWith("heartbeat") ? "1" : "\"0.5.23\"",
  });
  assert.equal(await mismatch.health(8042), false);
});

test("startup timeout is 30 seconds and stops the owned child", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild();
  let now = 0;
  const manager = new ChromaRuntimeManager({
    platform: "darwin",
    now: () => now,
    waitMs: async (ms) => { now += ms; },
    spawn: () => child,
    isPortAvailable: async () => true,
    probeHealth: async () => ({ healthy: false, compatible: false, version: null }),
  });

  await assert.rejects(
    manager.start({ executablePath: "/runtime/chroma", dataPath, preferredPort: 8000 }),
    /CHROMA_START_TIMEOUT/,
  );
  assert.ok(now <= 30_000, `startup and cleanup exceeded 30 seconds: ${now}`);
  assert.ok(now >= 25_000, `readiness ended before its cleanup reservation: ${now}`);
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
  assert.equal(manager.getState().ownership, "none");
});

test("a ready owned process with the wrong v2 version fails immediately", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild();
  let now = 0;
  let waited = 0;
  const manager = new ChromaRuntimeManager({
    platform: "darwin",
    now: () => now,
    waitMs: async (ms) => { waited += ms; now += ms; },
    spawn: () => child,
    isPortAvailable: async () => true,
    probeHealth: async () => ({ healthy: true, compatible: false, version: "0.5.23" }),
  });

  await assert.rejects(
    manager.start({ executablePath: "/runtime/chroma", dataPath }),
    /CHROMA_VERSION_MISMATCH/,
  );
  assert.equal(waited, 0);
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
});

test("startup logs retain at most the last 200 lines and 32 KiB", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild();
  let releaseSpawned;
  const spawned = new Promise((resolve) => { releaseSpawned = resolve; });
  const manager = new ChromaRuntimeManager({
    spawn: () => {
      releaseSpawned();
      return child;
    },
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
  });

  const started = manager.start({ executablePath: "/runtime/chroma", dataPath });
  await spawned;
  for (let index = 0; index < 250; index += 1) {
    child.stderr.write(`${String(index).padStart(3, "0")}-${"x".repeat(196)}\n`);
  }
  await started;
  const logTail = manager.getLogTail();

  assert.ok(logTail.split("\n").filter(Boolean).length <= 200);
  assert.ok(Buffer.byteLength(logTail, "utf8") <= 32 * 1024);
  assert.ok(logTail.includes("249-"));
  assert.equal(logTail.includes("000-"), false);
  await manager.stopOwnedProcess();
});

test("log limits count an unfinished line and preserve valid UTF-8 at the byte boundary", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild();
  let releaseSpawned;
  const spawned = new Promise((resolve) => { releaseSpawned = resolve; });
  const manager = new ChromaRuntimeManager({
    spawn: () => {
      releaseSpawned();
      return child;
    },
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
  });

  const started = manager.start({ executablePath: "/runtime/chroma", dataPath });
  await spawned;
  child.stderr.write(`${Array.from({ length: 200 }, (_, index) => `line-${index}`).join("\n")}\nunfinished`);
  child.stderr.write("中".repeat(20_000));
  await started;
  const logTail = manager.getLogTail();

  assert.ok(logTail.split("\n").length <= 200);
  assert.ok(Buffer.byteLength(logTail, "utf8") <= 32 * 1024);
  assert.equal(logTail.includes("�"), false);
  assert.ok(logTail.endsWith("中"));
  await manager.stopOwnedProcess();
});

test("macOS stop escalates from SIGTERM to SIGKILL after five seconds", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild({ exitOnKill: false });
  let waited = 0;
  const manager = new ChromaRuntimeManager({
    platform: "darwin",
    spawn: () => child,
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
    waitMs: async (ms) => { waited += ms; },
  });
  await manager.start({ executablePath: "/runtime/chroma", dataPath });

  await manager.stopOwnedProcess();

  assert.deepEqual(child.killCalls, ["SIGTERM", "SIGKILL"]);
  assert.equal(waited, 5_000);
  assert.equal(manager.getState().ownership, "none");
});

test("Windows stop calls kill and verifies the exit event", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild();
  const manager = new ChromaRuntimeManager({
    platform: "win32",
    spawn: () => child,
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
  });
  await manager.start({ executablePath: "C:\\runtime\\chroma.exe", dataPath });

  await manager.stopOwnedProcess();

  assert.deepEqual(child.killCalls, [undefined]);
  assert.equal(manager.getState().ownership, "none");
});

test("expected-lease stop is an atomic no-op after a replacement process becomes current", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const children = [
    new FakeChild({ pid: 8101 }),
    new FakeChild({ pid: 8102 }),
  ];
  let now = 100;
  const manager = new ChromaRuntimeManager({
    now: () => ++now,
    spawn: () => children.shift(),
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
  });

  const obsoleteLease = await manager.start({ executablePath: "/runtime/chroma", dataPath });
  await manager.stopOwnedProcess(obsoleteLease);
  const replacementLease = await manager.start({ executablePath: "/runtime/chroma", dataPath });

  const result = await manager.stopOwnedProcess(obsoleteLease);

  assert.deepEqual(result, { stopped: false, reason: "lease-mismatch" });
  assert.deepEqual(manager.getState(), replacementLease);
  assert.deepEqual(children.length, 0);
  await manager.stopOwnedProcess(replacementLease);
});

test("an unconditional no-process stop does not poison the next managed start", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild({ pid: 8201 });
  const manager = new ChromaRuntimeManager({
    spawn: () => child,
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
  });

  assert.deepEqual(await manager.stopOwnedProcess(), { stopped: false, reason: "no-owned-process" });
  const state = await manager.start({ executablePath: "/runtime/chroma", dataPath });

  assert.equal(state.pid, 8201);
  await manager.stopOwnedProcess(state);
});

test("ChromaProcessManager facade preserves callers while delegating to the installed runtime", async (t) => {
  const { ChromaProcessManager } = facadeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild({ readyPort: 8001 });
  let spawnedExecutable;
  let legacyHealthCalls = 0;
  const facade = new ChromaProcessManager({
    executablePath: "/installed runtime/chroma",
    runtimeVersion: "cli-1.4.4",
    platform: "darwin",
    spawn(executable) {
      spawnedExecutable = executable;
      return child;
    },
    isPortAvailable: async (port) => port === 8001,
    probeHealth: compatibleProbe,
    isHealthy: async () => {
      legacyHealthCalls += 1;
      return legacyHealthCalls > 1;
    },
    isCompatible: async () => true,
  });

  assert.equal(await facade.start(dataPath, 8000), true);
  assert.equal(spawnedExecutable, "/installed runtime/chroma");
  assert.equal(await facade.isHealthy(), true);
  assert.equal(facade.getLastError(), "");
  assert.equal(facade.getPort(), 8001);
  assert.equal(facade.getDbPath(), dataPath);

  await facade.stop();
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
});

test("ChromaProcessManager facade reports a missing installed executable without spawning", async (t) => {
  const { ChromaProcessManager } = facadeModule();
  const dataPath = await temporaryDataPath(t);
  const facade = new ChromaProcessManager({
    isHealthy: async () => false,
    spawn: () => { throw new Error("legacy spawn must not run"); },
  });

  assert.equal(await facade.start(dataPath, 8000), false);
  assert.match(facade.getLastError(), /CHROMA_EXECUTABLE_INVALID/);
  assert.equal(facade.getPort(), 8000);
  assert.equal(facade.getDbPath(), dataPath);
});

test("ChromaProcessManager facade keeps the active getters when a changed start is rejected", async (t) => {
  const { ChromaProcessManager } = facadeModule();
  const firstDataPath = await temporaryDataPath(t);
  const secondDataPath = `${firstDataPath}-changed`;
  const child = new FakeChild();
  const executablePath = path.resolve(firstDataPath, process.platform === "win32" ? "chroma.exe" : "chroma");
  const facade = new ChromaProcessManager({
    executablePath,
    spawn: () => child,
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
  });

  assert.equal(await facade.start(firstDataPath, 8000), true);
  assert.equal(await facade.start(secondDataPath, 8001), false);
  assert.match(facade.getLastError(), /CHROMA_ALREADY_RUNNING/);
  assert.equal(facade.getDbPath(), firstDataPath);
  assert.equal(facade.getPort(), 8000);
  await facade.stop();
});

test("a nonexistent executable settles spawn error and close without hanging", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const manager = new ChromaRuntimeManager({
    isPortAvailable: async (port) => port === 8001,
    probeHealth: async () => ({ healthy: false, compatible: false, version: null }),
  });

  await assert.rejects(
    deadline(manager.start({ executablePath: path.join(dataPath, "missing-chroma"), dataPath }), 600),
    (error) => error.code === "CHROMA_EXECUTABLE_NOT_FOUND",
  );
  assert.equal(manager.getState().ownership, "none");
});

test("error followed by close-only settles once and clears child listeners", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild({ pid: undefined, exitOnKill: false, exitOnSigkill: false });
  const manager = new ChromaRuntimeManager({
    spawn: () => {
      queueMicrotask(() => {
        const error = new Error("spawn ENOENT");
        error.code = "ENOENT";
        child.emit("error", error);
        child.emit("close", -2, null);
      });
      return child;
    },
    isPortAvailable: async () => true,
    probeHealth: async () => ({ healthy: false, compatible: false, version: null }),
  });

  await assert.rejects(
    deadline(manager.start({ executablePath: "/missing/chroma", dataPath }), 500),
    (error) => error.code === "CHROMA_EXECUTABLE_NOT_FOUND",
  );
  assert.equal(manager.getState().ownership, "none");
  for (const event of ["error", "exit", "close"]) assert.equal(child.listenerCount(event), 0);
});

test("a pre-spawn error stays terminal when a child already has a PID and external health looks ready", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild({ autoSpawn: false, autoReady: false, exitOnKill: false });
  t.after(() => child.emit("exit", 1, null));
  const manager = new ChromaRuntimeManager({
    spawn: () => {
      queueMicrotask(() => {
        child.stdout.write("Frontend server listening on address, addr: 127.0.0.1:8000\n");
        const error = new Error("spawn EACCES");
        error.code = "EACCES";
        child.emit("error", error);
      });
      return child;
    },
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
  });

  await assert.rejects(
    deadline(manager.start({ executablePath: "/runtime/chroma", dataPath }), 500),
    (error) => error.code === "CHROMA_EXITED" && /spawn EACCES/.test(error.message),
  );
  assert.equal(manager.getState().ownership, "none");
});

test("SIGKILL without an exit event fails within the bounded stop deadline", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild({ exitOnKill: false, exitOnSigkill: false });
  let now = 0;
  let exists = true;
  const manager = new ChromaRuntimeManager({
    platform: "darwin",
    now: () => now,
    waitMs: async (ms) => { now += ms; },
    spawn: () => child,
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
    processExists: () => exists,
  });
  await manager.start({ executablePath: "/runtime/chroma", dataPath });

  await assert.rejects(
    deadline(manager.stopOwnedProcess(), 500),
    (error) => error.code === "CHROMA_STOP_FAILED",
  );
  assert.equal(now, 5_000);
  assert.equal(manager.getState().ownership, "analogy");
  assert.equal(manager.getState().pid, child.pid);

  child.exitOnKill = true;
  child.exitOnSigkill = true;
  exists = false;
  await manager.stopOwnedProcess();
  assert.deepEqual(child.killCalls, ["SIGTERM", "SIGKILL", "SIGTERM"]);
  assert.equal(manager.getState().ownership, "none");
});

test("a spawned child kill EPERM is not terminal and remains owned until a retry stops it", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild({ errorOnKill: true, exitOnKill: false, exitOnSigkill: false });
  let exists = true;
  let now = 0;
  const manager = new ChromaRuntimeManager({
    platform: "darwin",
    now: () => now,
    waitMs: async (ms) => { now += ms; },
    spawn: () => child,
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
    processExists: () => exists,
  });
  await manager.start({ executablePath: "/runtime/chroma", dataPath });

  await assert.rejects(
    manager.stopOwnedProcess(),
    (error) => error.code === "CHROMA_STOP_FAILED" && /EPERM/.test(manager.getLastError()),
  );
  assert.equal(manager.getState().ownership, "analogy");
  assert.equal(manager.getState().pid, child.pid);

  child.errorOnKill = false;
  child.exitOnKill = true;
  exists = false;
  await manager.stopOwnedProcess();
  assert.equal(manager.getState().ownership, "none");
});

test("startup timeout propagates cleanup failure and retains the owned child for retry", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild({ exitOnKill: false, exitOnSigkill: false });
  let exists = true;
  const manager = new ChromaRuntimeManager({
    platform: "darwin",
    startTimeoutMs: 80,
    stopTimeoutMs: 20,
    spawn: () => child,
    isPortAvailable: async () => true,
    probeHealth: async () => new Promise(() => undefined),
    processExists: () => exists,
  });

  await assert.rejects(
    deadline(manager.start({ executablePath: "/runtime/chroma", dataPath }), 250),
    (error) => error.code === "CHROMA_STOP_FAILED",
  );
  assert.equal(manager.getState().ownership, "analogy");
  assert.equal(manager.getState().pid, child.pid);

  child.exitOnKill = true;
  child.exitOnSigkill = true;
  exists = false;
  await manager.stopOwnedProcess();
  assert.equal(manager.getState().ownership, "none");
});

test("startup cleanup kill EPERM propagates stop failure and retains ownership", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild({ errorOnKill: true, exitOnKill: false, exitOnSigkill: false });
  let exists = true;
  const manager = new ChromaRuntimeManager({
    platform: "darwin",
    startTimeoutMs: 80,
    stopTimeoutMs: 20,
    spawn: () => child,
    isPortAvailable: async () => true,
    probeHealth: async () => new Promise(() => undefined),
    processExists: () => exists,
  });

  await assert.rejects(
    deadline(manager.start({ executablePath: "/runtime/chroma", dataPath }), 250),
    (error) => error.code === "CHROMA_STOP_FAILED" && /EPERM/.test(manager.getLastError()),
  );
  assert.equal(manager.getState().ownership, "analogy");
  assert.equal(manager.getState().pid, child.pid);

  child.errorOnKill = false;
  child.exitOnKill = true;
  exists = false;
  await manager.stopOwnedProcess();
  assert.equal(manager.getState().ownership, "none");
});

test("a retained owned child clears itself if its terminal event arrives after stop failed", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild({ exitOnKill: false, exitOnSigkill: false });
  let now = 0;
  const manager = new ChromaRuntimeManager({
    platform: "darwin",
    now: () => now,
    waitMs: async (ms) => { now += ms; },
    spawn: () => child,
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
    processExists: () => true,
  });
  await manager.start({ executablePath: "/runtime/chroma", dataPath });
  await assert.rejects(manager.stopOwnedProcess(), (error) => error.code === "CHROMA_STOP_FAILED");
  assert.equal(manager.getState().ownership, "analogy");

  child.emit("exit", 0, null);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(manager.getState().ownership, "none");
});

test("sequential identical starts are healthy-idempotent and leave one stoppable child", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const children = [];
  const options = { executablePath: "/runtime/chroma", dataPath, preferredPort: 8000 };
  const manager = new ChromaRuntimeManager({
    spawn: () => {
      const child = new FakeChild({ pid: 5000 + children.length });
      children.push(child);
      return child;
    },
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
  });

  const first = await manager.start(options);
  const second = await manager.start(options);
  await manager.stopOwnedProcess();

  assert.equal(children.length, 1);
  assert.equal(second.pid, first.pid);
  assert.deepEqual(children[0].killCalls, ["SIGTERM"]);
});

test("concurrent identical starts serialize to one owned process", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const children = [];
  const options = { executablePath: "/runtime/chroma", dataPath, preferredPort: 8000 };
  const manager = new ChromaRuntimeManager({
    spawn: () => {
      const child = new FakeChild({ pid: 6000 + children.length });
      children.push(child);
      return child;
    },
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
  });

  const [first, second] = await Promise.all([manager.start(options), manager.start(options)]);
  await manager.stopOwnedProcess();

  assert.equal(children.length, 1);
  assert.equal(second.pid, first.pid);
  assert.deepEqual(children[0].killCalls, ["SIGTERM"]);
});

test("an owned process cannot be overwritten by a changed external start", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild();
  const manager = new ChromaRuntimeManager({
    spawn: () => child,
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
  });
  const owned = await manager.start({ executablePath: "/runtime/chroma", dataPath, preferredPort: 8000 });

  await assert.rejects(
    manager.start({ executablePath: "/unused", dataPath: "/unused", preferredPort: 8123, external: true }),
    (error) => error.code === "CHROMA_ALREADY_RUNNING",
  );
  assert.equal(manager.getState().ownership, "analogy");
  assert.equal(manager.getState().pid, owned.pid);
  await manager.stopOwnedProcess();
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
});

test("a port stolen after availability check causes an early child exit and scans the next port", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const children = [];
  const spawnedPorts = [];
  const manager = new ChromaRuntimeManager({
    platform: "darwin",
    spawn(_executable, args) {
      const port = Number(args.at(-1));
      const child = new FakeChild({ pid: 7000 + children.length, readyPort: port });
      children.push(child);
      spawnedPorts.push(port);
      if (children.length === 1) queueMicrotask(() => child.emit("close", 1, null));
      return child;
    },
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
    waitMs: async () => undefined,
  });

  const state = await manager.start({ executablePath: "/runtime/chroma", dataPath, preferredPort: 8000 });

  assert.equal(state.port, 8001);
  assert.deepEqual(spawnedPorts, [8000, 8001]);
  assert.equal(children[0].killCalls.length, 0);
  await manager.stopOwnedProcess();
  assert.deepEqual(children[1].killCalls, ["SIGTERM"]);
});

test("external health cannot make a child that never emitted its ready signal owned", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild({ pid: 7100, exitOnKill: false, autoReady: false });
  let availabilityCalls = 0;
  let exited = false;
  const manager = new ChromaRuntimeManager({
    platform: "darwin",
    startTimeoutMs: 250,
    stopTimeoutMs: 50,
    startStableMs: 5,
    spawn: () => {
      setTimeout(() => {
        exited = true;
        child.emit("exit", 1, null);
      }, 25);
      return child;
    },
    isPortAvailable: async () => {
      availabilityCalls += 1;
      return true;
    },
    probeHealth: async () => exited
      ? ({ healthy: false, compatible: false, version: null })
      : ({ healthy: true, compatible: true, version: "1.0.0" }),
    processExists: () => false,
  });

  await assert.rejects(
    manager.start({ executablePath: "/runtime/chroma", dataPath, preferredPort: 8000 }),
    (error) => error.code === "CHROMA_EXITED",
  );
  assert.equal(availabilityCalls >= 2, true);
  assert.equal(manager.getState().ownership, "none");
});

test("the pinned child ready log is required before compatible health becomes owned", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild({ pid: 7150 });
  const manager = new ChromaRuntimeManager({
    spawn: () => {
      queueMicrotask(() => {
        child.stdout.write("Frontend server listening on address, ");
        child.stdout.write("addr: 127.0.0.1:8000\n");
      });
      return child;
    },
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
  });

  const state = await manager.start({ executablePath: "/runtime/chroma", dataPath, preferredPort: 8000 });
  assert.equal(state.ownership, "analogy");
  assert.equal(state.pid, 7150);
  await manager.stopOwnedProcess();
});

test("ANSI-colored pinned child ready log becomes owned after compatible health", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild({ pid: 7160, autoReady: false });
  let now = 0;
  const manager = new ChromaRuntimeManager({
    startTimeoutMs: 250,
    stopTimeoutMs: 50,
    now: () => now,
    waitMs: async (ms) => { now += ms; },
    spawn: () => {
      queueMicrotask(() => {
        child.stdout.write("Frontend server listening on address, \u001b[1;32m");
        child.stdout.write("addr\u001b[0m\u001b[32m: 127.0.0.1:8000\u001b[0m\n");
      });
      return child;
    },
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
  });

  const state = await manager.start({ executablePath: "/runtime/chroma", dataPath, preferredPort: 8000 });
  assert.equal(state.ownership, "analogy");
  assert.equal(state.pid, 7160);
  await manager.stopOwnedProcess();
});

test("a child argument or data-directory exit is CHROMA_EXITED instead of a port conflict", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  let spawnCalls = 0;
  const manager = new ChromaRuntimeManager({
    spawn: () => {
      spawnCalls += 1;
      const child = new FakeChild({ pid: 7200 + spawnCalls, exitOnKill: false });
      queueMicrotask(() => {
        child.stderr.write("invalid --path: permission denied\n");
        child.emit("exit", 2, null);
      });
      return child;
    },
    isPortAvailable: async () => true,
    probeHealth: async () => ({ healthy: false, compatible: false, version: null }),
    processExists: () => false,
  });

  await assert.rejects(
    deadline(manager.start({ executablePath: "/runtime/chroma", dataPath }), 500),
    (error) => error.code === "CHROMA_EXITED" && /code 2/.test(error.message) && /permission denied/.test(error.message),
  );
  assert.equal(spawnCalls, 1);
  assert.equal(manager.getState().ownership, "none");
});

test("stop immediately cancels a hanging health recheck after ordinary child exit", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  let probeCalls = 0;
  let releaseExitProbe;
  const exitProbeStarted = new Promise((resolve) => { releaseExitProbe = resolve; });
  const manager = new ChromaRuntimeManager({
    platform: "darwin",
    startTimeoutMs: 5_000,
    stopTimeoutMs: 50,
    spawn: () => {
      const child = new FakeChild({ autoReady: false, exitOnKill: false });
      queueMicrotask(() => child.emit("exit", 2, null));
      return child;
    },
    isPortAvailable: async () => true,
    probeHealth: async () => {
      probeCalls += 1;
      if (probeCalls === 2) releaseExitProbe();
      return new Promise(() => undefined);
    },
    processExists: () => false,
  });
  const startPromise = manager.start({ executablePath: "/runtime/chroma", dataPath });
  await deadline(exitProbeStarted, 250);
  const stoppedAt = Date.now();
  const stopPromise = manager.stopOwnedProcess();

  await assert.rejects(deadline(startPromise, 300), (error) => error.code === "CHROMA_START_CANCELLED");
  await deadline(stopPromise, 300);
  assert.ok(Date.now() - stoppedAt < 250);
  assert.equal(manager.getState().ownership, "none");
});

test("stop immediately cancels a hanging availability recheck after ordinary child exit", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  let availabilityCalls = 0;
  let releaseExitAvailability;
  const exitAvailabilityStarted = new Promise((resolve) => { releaseExitAvailability = resolve; });
  const manager = new ChromaRuntimeManager({
    platform: "darwin",
    startTimeoutMs: 5_000,
    stopTimeoutMs: 50,
    spawn: () => {
      const child = new FakeChild({ autoReady: false, exitOnKill: false });
      queueMicrotask(() => child.emit("exit", 2, null));
      return child;
    },
    isPortAvailable: async () => {
      availabilityCalls += 1;
      if (availabilityCalls === 1) return true;
      releaseExitAvailability();
      return new Promise(() => undefined);
    },
    probeHealth: async () => ({ healthy: false, compatible: false, version: null }),
    processExists: () => false,
  });
  const startPromise = manager.start({ executablePath: "/runtime/chroma", dataPath });
  await deadline(exitAvailabilityStarted, 250);
  const stoppedAt = Date.now();
  const stopPromise = manager.stopOwnedProcess();

  await assert.rejects(deadline(startPromise, 300), (error) => error.code === "CHROMA_START_CANCELLED");
  await deadline(stopPromise, 300);
  assert.ok(Date.now() - stoppedAt < 250);
  assert.equal(manager.getState().ownership, "none");
});

test("split UTF-8 and interleaved stdout/stderr never share decoder remainder", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild();
  let releaseSpawned;
  const spawned = new Promise((resolve) => { releaseSpawned = resolve; });
  const manager = new ChromaRuntimeManager({
    spawn: () => { releaseSpawned(); return child; },
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
  });

  const started = manager.start({ executablePath: "/runtime/chroma", dataPath });
  await spawned;
  const stdout = Buffer.from("输出中文\n", "utf8");
  child.stdout.write(stdout.subarray(0, 4));
  child.stderr.write(Buffer.from("错误流\n", "utf8"));
  child.stdout.write(stdout.subarray(4));
  await started;
  const lines = manager.getLogTail().split("\n");

  assert.ok(lines.includes("错误流"));
  assert.ok(lines.includes("输出中文"));
  assert.equal(manager.getLogTail().includes("�"), false);
  await manager.stopOwnedProcess();
});

test("a hung health probe obeys the total startup deadline and cleans the child", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild();
  const manager = new ChromaRuntimeManager({
    platform: "darwin",
    startTimeoutMs: 80,
    stopTimeoutMs: 20,
    spawn: () => child,
    isPortAvailable: async () => true,
    probeHealth: async () => new Promise(() => undefined),
  });
  const startedAt = Date.now();

  await assert.rejects(
    deadline(manager.start({ executablePath: "/runtime/chroma", dataPath }), 300),
    (error) => error.code === "CHROMA_START_TIMEOUT",
  );
  assert.ok(Date.now() - startedAt < 250);
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
  assert.equal(manager.getState().ownership, "none");
});

test("stop during a hung start wakes readiness and leaves no owned child", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild();
  let releaseSpawned;
  const spawned = new Promise((resolve) => { releaseSpawned = resolve; });
  const manager = new ChromaRuntimeManager({
    platform: "darwin",
    startTimeoutMs: 5_000,
    stopTimeoutMs: 50,
    spawn: () => { releaseSpawned(); return child; },
    isPortAvailable: async () => true,
    probeHealth: async () => new Promise(() => undefined),
  });
  const startPromise = manager.start({ executablePath: "/runtime/chroma", dataPath });
  await spawned;
  const startedAt = Date.now();
  const stopPromise = manager.stopOwnedProcess();

  await assert.rejects(
    deadline(startPromise, 300),
    (error) => error.code === "CHROMA_START_CANCELLED",
  );
  await deadline(stopPromise, 300);
  assert.ok(Date.now() - startedAt < 250);
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
  assert.equal(manager.getState().ownership, "none");
});

test("a hanging HTTP response is destroyed at the configured health timeout", async (t) => {
  const net = require("node:net");
  const { ChromaRuntimeManager } = runtimeModule();
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  }));
  const port = server.address().port;
  const manager = new ChromaRuntimeManager({ healthRequestTimeoutMs: 30 });
  const startedAt = Date.now();

  assert.equal(await manager.health(port), false);
  assert.ok(Date.now() - startedAt < 250);
});

test("a drip-fed HTTP response is destroyed at the absolute health deadline", async (t) => {
  const net = require("node:net");
  const { ChromaRuntimeManager } = runtimeModule();
  const sockets = new Set();
  const intervals = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n");
    const interval = setInterval(() => socket.write("1\r\nx\r\n"), 5);
    intervals.add(interval);
    socket.once("close", () => {
      sockets.delete(socket);
      clearInterval(interval);
      intervals.delete(interval);
    });
  });
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise((resolve) => {
    for (const interval of intervals) clearInterval(interval);
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  }));
  const port = server.address().port;
  const manager = new ChromaRuntimeManager({ healthRequestTimeoutMs: 35 });
  const startedAt = Date.now();

  assert.equal(await deadline(manager.health(port), 250), false);
  assert.ok(Date.now() - startedAt < 200);
  await deadline(new Promise((resolve) => {
    const check = () => sockets.size === 0 ? resolve() : setTimeout(check, 5);
    check();
  }), 200);
});

test("a hanging data-directory creation is bounded by the total startup deadline", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const originalMkdir = fs.promises.mkdir;
  fs.promises.mkdir = async () => new Promise(() => undefined);
  t.after(() => { fs.promises.mkdir = originalMkdir; });
  const manager = new ChromaRuntimeManager({
    now: () => 0,
    startTimeoutMs: 45,
    stopTimeoutMs: 15,
    isPortAvailable: async () => true,
  });
  const startedAt = Date.now();

  await assert.rejects(
    deadline(manager.start({ executablePath: "/runtime/chroma", dataPath }), 200),
    (error) => error.code === "CHROMA_START_TIMEOUT",
  );
  assert.ok(Date.now() - startedAt < 160);
  assert.equal(manager.getState().ownership, "none");
});

test("readiness stability grace cannot exceed the total startup deadline", async (t) => {
  const { ChromaRuntimeManager } = runtimeModule();
  const dataPath = await temporaryDataPath(t);
  const child = new FakeChild();
  const manager = new ChromaRuntimeManager({
    platform: "darwin",
    startTimeoutMs: 55,
    stopTimeoutMs: 15,
    startStableMs: 1_000,
    spawn: () => child,
    isPortAvailable: async () => true,
    probeHealth: compatibleProbe,
  });
  const startedAt = Date.now();

  await assert.rejects(
    deadline(manager.start({ executablePath: "/runtime/chroma", dataPath }), 250),
    (error) => error.code === "CHROMA_START_TIMEOUT",
  );
  assert.ok(Date.now() - startedAt < 200);
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
});

test("an early child exit clears the five-second stop timer so Node can exit", async () => {
  const source = `
    const { EventEmitter } = require("node:events");
    const { PassThrough } = require("node:stream");
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const ts = require("typescript");
    const filename = path.join(process.cwd(), "src/runtime/chroma-runtime-manager.ts");
    const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
      fileName: filename,
    }).outputText;
    const box = { exports: {} };
    Function("exports", "require", "module", "__filename", "__dirname", output)(box.exports, require, box, filename, path.dirname(filename));
    class Child extends EventEmitter {
      constructor() {
        super();
        this.pid = 9001;
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        this.exitCode = null;
        this.signalCode = null;
        const announceSpawn = (event) => {
          if (event !== "spawn") return;
          this.removeListener("newListener", announceSpawn);
          queueMicrotask(() => this.emit("spawn"));
        };
        this.on("newListener", announceSpawn);
        queueMicrotask(() => this.stdout.write("Frontend server listening on address, addr: 127.0.0.1:8000\\n"));
      }
      kill(signal) { setTimeout(() => { this.signalCode = signal || "SIGTERM"; this.emit("exit", null, this.signalCode); }, 10); return true; }
    }
    (async () => {
      const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-timer-"));
      const manager = new box.exports.ChromaRuntimeManager({ platform: "darwin", spawn: () => new Child(), isPortAvailable: async () => true, probeHealth: async () => ({ healthy: true, compatible: true, version: "1.0.0" }) });
      await manager.start({ executablePath: "/runtime/chroma", dataPath });
      await manager.stopOwnedProcess();
      fs.rmSync(dataPath, { recursive: true, force: true });
      process.stdout.write("done");
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;

  const result = await runNodeScript(source, 5_000);
  assert.equal(result.stdout, "done");
});

for (const preferredPort of [7999, 8100, 8000.5]) {
  test(`managed preferred port ${preferredPort} is rejected with a stable code`, async () => {
    const { ChromaRuntimeManager } = runtimeModule();
    const manager = new ChromaRuntimeManager();
    await assert.rejects(
      manager.start({ executablePath: "/runtime/chroma", dataPath: "/data", preferredPort }),
      (error) => error.code === "CHROMA_PORT_INVALID",
    );
  });
}

for (const preferredPort of [0, 65536, 1.5]) {
  test(`external port ${preferredPort} is rejected with a stable code`, async () => {
    const { ChromaRuntimeManager } = runtimeModule();
    const manager = new ChromaRuntimeManager({ probeHealth: compatibleProbe });
    await assert.rejects(
      manager.start({ executablePath: "/unused", dataPath: "/unused", preferredPort, external: true }),
      (error) => error.code === "CHROMA_EXTERNAL_PORT_INVALID",
    );
  });
}
