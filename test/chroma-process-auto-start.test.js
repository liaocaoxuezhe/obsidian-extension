const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");

async function loadModule() {
  const source = path.join(__dirname, "..", "src", "local-vector", "chroma-process.ts");
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const module = { exports: {} };
  const fn = new Function("module", "exports", "require", result.outputFiles[0].text);
  fn(module, module.exports, require);
  return module.exports;
}

(async () => {
  const { ChromaProcessManager } = await loadModule();
  const dbPath = path.join(__dirname, "tmp-chroma-db");
  let healthChecks = 0;
  const starts = [];
  const manager = new ChromaProcessManager({
    isHealthy: async () => {
      healthChecks += 1;
      return healthChecks > 1;
    },
    isCompatible: async () => true,
    spawn: (command, args, options) => {
      starts.push({ command, args, cwd: options.cwd });
      return {
        pid: 123,
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: () => {},
        kill: () => {},
      };
    },
    waitMs: async () => {},
  });

  const started = await manager.start(dbPath, 18000);

  assert.strictEqual(started, true);
  assert.strictEqual(healthChecks, 2);
  assert.strictEqual(starts.length, 1);
  assert.strictEqual(starts[0].command, "/bin/zsh");
  assert.deepStrictEqual(starts[0].args, [
    "-lc",
    `PYTHON_BIN="$(command -v python3.9 || command -v /opt/homebrew/bin/python3.9 || command -v /usr/local/bin/python3.9 || command -v python3 || command -v python)" && VENV_DIR=${JSON.stringify(path.join(__dirname, "..", "chroma-venv"))} && ([ -x "$VENV_DIR/bin/python" ] || "$PYTHON_BIN" -m venv "$VENV_DIR") && ("$VENV_DIR/bin/python" -c 'import importlib.metadata as m, sys; v=tuple(int(p) for p in m.version("chromadb").split(".")[:3]); sys.exit(0 if v >= (0, 5, 23) else 1)' || "$VENV_DIR/bin/python" -m pip install "chromadb>=0.5.23,<0.6") && "$VENV_DIR/bin/chroma" run --path ${JSON.stringify(dbPath)} --host 127.0.0.1 --port 18000`,
  ]);
  assert.strictEqual(starts[0].cwd, dbPath);

  console.log("Chroma process auto-start test passed");
})().catch((err) => {
  console.error("Chroma process auto-start test FAILED:", err);
  process.exit(1);
});
