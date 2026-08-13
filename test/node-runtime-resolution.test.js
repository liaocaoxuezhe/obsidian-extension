const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const esbuild = require("esbuild");

async function loadModule() {
  const source = path.join(__dirname, "..", "src", "local-vector", "embedding-worker-client.ts");
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    module,
    module.exports,
    require,
  );
  return module.exports;
}

(async () => {
  const { resolveNodeExecutable } = await loadModule();
  assert.strictEqual(
    typeof resolveNodeExecutable,
    "function",
    "worker client must expose its validated Node runtime resolver",
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-node-runtime-"));
  try {
    const fakeElectronHelper = path.join(tmpDir, "Obsidian Helper (Renderer)");
    fs.writeFileSync(
      fakeElectronHelper,
      "#!/bin/sh\necho 'not a Node runtime' >&2\nexit 133\n",
      { encoding: "utf-8", mode: 0o755 },
    );

    const resolved = resolveNodeExecutable({
      managedExecPath: process.execPath,
      env: {
        ...process.env,
        ANALOGY_NODE_PATH: fakeElectronHelper,
        npm_node_execpath: fakeElectronHelper,
        PATH: tmpDir,
      },
    });
    assert.strictEqual(
      resolved,
      process.execPath,
      "environment overrides must never replace the managed Node executable",
    );

    assert.throws(
      () => resolveNodeExecutable({
        env: { ANALOGY_NODE_PATH: process.execPath, PATH: process.env.PATH },
      }),
      /managed Node\.js runtime is required/i,
      "ANALOGY_NODE_PATH is inert unless developer override mode is explicit",
    );
    assert.strictEqual(
      resolveNodeExecutable({
        env: { ANALOGY_NODE_PATH: process.execPath, PATH: tmpDir },
        allowDeveloperOverride: true,
      }),
      process.execPath,
      "explicit developer override mode may use ANALOGY_NODE_PATH",
    );
    assert.throws(
      () => resolveNodeExecutable({
        managedExecPath: fakeElectronHelper,
        env: { ANALOGY_NODE_PATH: process.execPath, PATH: process.env.PATH },
        allowDeveloperOverride: true,
      }),
      /managed Node\.js runtime is invalid/i,
      "an invalid managed executable must fail closed instead of falling back",
    );

    const probe = spawnSync(resolved, ["--version"], {
      encoding: "utf-8",
      env: process.env,
    });
    assert.strictEqual(probe.status, 0);
    assert.match(probe.stdout.trim(), /^v\d+\./);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("Node runtime resolution tests passed");
})();
