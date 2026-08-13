"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const esbuild = require("esbuild");

const noop = new Proxy(function noop() {}, {
  get: () => noop,
  apply: () => undefined,
});

function loadRuntimeVersions() {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/SettingView.tsx"),
    "utf8",
  );
  const output = ts.transpileModule(`${source}\nexport { RUNTIME_VERSIONS };`, {
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  const uiStub = new Proxy({ PluginSettingTab: class PluginSettingTab {} }, {
    get: (target, property) => property in target ? target[property] : noop,
  });
  const stubRequire = (specifier) => {
    if (specifier === "fs" || specifier === "path") return require(specifier);
    if (specifier === "obsidian") return uiStub;
    return noop;
  };
  Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports,
    stubRequire,
    module,
    "SettingView.tsx",
    process.cwd(),
  );
  return module.exports.RUNTIME_VERSIONS;
}

test("settings diagnostics report pinned managed versions without a plugin-local package.json", () => {
  assert.deepEqual(loadRuntimeVersions(), {
    transformers: "4.2.0",
    onnxruntime: "1.26.0",
    chroma: "cli-1.4.4",
  });
});

test("sidebar displays the version loaded from the installed plugin manifest", async () => {
  const extensionRoot = process.cwd();
  const result = await esbuild.build({
    stdin: {
      contents: `
        import React from "react";
        import { renderToStaticMarkup } from "react-dom/server";
        import { HomeView } from "../src/HomeView";

        const main = {
          app: { workspace: { getActiveFile: () => null, on: () => ({}) } },
          registerEvent: () => {},
        };

        export const html = renderToStaticMarkup(
          <HomeView main={main} pluginVersion="1.2.1" />
        );
      `,
      resolveDir: path.join(process.cwd(), "test"),
      sourcefile: "sidebar-installed-version-runner.tsx",
      loader: "tsx",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    nodePaths: [path.join(extensionRoot, "node_modules")],
    logLevel: "silent",
    plugins: [{
      name: "sidebar-version-dependency-stubs",
      setup(build) {
        build.onResolve({ filter: /model\/Consts$/ }, () => ({ path: "consts", namespace: "sidebar-version" }));
        build.onResolve({ filter: /SmartConnection$/ }, () => ({ path: "smart-connection", namespace: "sidebar-version" }));
        build.onResolve({ filter: /runtime\/RuntimeControlPanel$/ }, () => ({ path: "runtime-control", namespace: "sidebar-version" }));
        build.onLoad({ filter: /.*/, namespace: "sidebar-version" }, (args) => {
          if (args.path === "consts") {
            return { loader: "js", contents: `export const appVersion = "1.0.0"; export const icon = "";` };
          }
          if (args.path === "smart-connection") {
            return { loader: "js", contents: `export const SmartConnection = () => null;` };
          }
          return { loader: "js", contents: `export const RuntimeStatusCapsule = () => null;` };
        });
      },
    }],
  });

  const module = { exports: {} };
  Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, require);
  assert.match(module.exports.html, />v1\.2\.1<\//);
  assert.doesNotMatch(module.exports.html, />v1\.0\.0<\//);
});
