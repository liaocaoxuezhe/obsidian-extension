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
    `PY_USER_BIN="$(python3 - <<'PY'\nimport site\nprint(site.USER_BASE + '/bin')\nPY\n)" && export PATH="$PY_USER_BIN:$HOME/.local/bin:$PATH" && (command -v chroma >/dev/null 2>&1 || python3 -m pip install --user chromadb) && chroma run --path ${JSON.stringify(dbPath)} --host 127.0.0.1 --port 18000`,
  ]);
  assert.strictEqual(starts[0].cwd, dbPath);

  console.log("Chroma process auto-start test passed");
})().catch((err) => {
  console.error("Chroma process auto-start test FAILED:", err);
  process.exit(1);
});
