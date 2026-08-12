"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

async function loadModule(relativePath) {
  const source = path.join(__dirname, "..", "src", "local-vector", relativePath);
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const module = { exports: {} };
  Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

(async () => {
  const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-community-install-中文-"));
  try {
    for (const [name, body] of [["main.js", ""], ["manifest.json", "{}"], ["styles.css", ""]]) {
      fs.writeFileSync(path.join(pluginDir, name), body);
    }
    const maliciousMarker = path.join(pluginDir, "malicious-module-executed");
    const maliciousModule = path.join(pluginDir, "node_modules", "@huggingface", "transformers");
    fs.mkdirSync(maliciousModule, { recursive: true });
    fs.writeFileSync(
      path.join(maliciousModule, "package.json"),
      '{"name":"@huggingface/transformers","main":"index.js"}\n',
    );
    fs.writeFileSync(
      path.join(maliciousModule, "index.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(maliciousMarker)}, "executed");\n`,
    );
    const before = fs.readdirSync(pluginDir).sort();
    const runtime = await loadModule("runtime-dependencies.ts");
    const missing = runtime.getLocalRuntimeStatus(null);
    assert.deepEqual(missing.missing, ["managed-embedding-runtime"]);
    assert.equal(missing.ready, false);
    assert.match(missing.message, /managed embedding runtime/i);

    const managedRuntime = {
      runtimeId: "embedding-runtime-node22-v1-darwin-arm64",
      root: "/managed/runtime/embedding/current",
      nodeExecutable: "/managed/runtime/embedding/current/node/bin/node",
      moduleRoot: "/managed/runtime/embedding/current/node_modules",
      versions: { node: "22.23.2", transformers: "4.2.0", onnxruntime: "1.26.0" },
    };
    assert.deepEqual(runtime.getLocalRuntimeStatus(managedRuntime), {
      ready: true,
      missing: [],
      message: "",
    });

    await assert.rejects(
      runtime.installLocalRuntimeDependencies(pluginDir, () => {
        throw new Error("the compatibility helper must not stream npm logs");
      }),
      /managed runtime onboarding/i,
    );
    assert.deepEqual(fs.readdirSync(pluginDir).sort(), before, "compatibility install must not mutate the plugin folder");

    const embedding = await loadModule("embedding.ts");
    assert.throws(
      () => embedding.ensureEmbeddingRuntime(pluginDir),
      /managed embedding runtime/i,
      "an arbitrary plugin/Vault module must never be treated as managed runtime readiness",
    );
    assert.equal(
      fs.existsSync(maliciousMarker),
      false,
      "managed readiness checks must not execute top-level plugin/Vault module code",
    );
    let installCalls = 0;
    assert.throws(() => embedding.ensureEmbeddingRuntime(pluginDir, {
      canLoad: () => false,
      install: () => { installCalls += 1; },
    }), /managed embedding runtime/i);
    assert.equal(installCalls, 0, "ensureEmbeddingRuntime must never invoke an npm/install hook");
    assert.deepEqual(fs.readdirSync(pluginDir).sort(), before, "ensureEmbeddingRuntime must not create package.json or node_modules");
  } finally {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
  console.log("community install uses managed runtime readiness only");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
