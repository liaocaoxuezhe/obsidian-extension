"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const esbuild = require("esbuild");

const chromeCandidates = [
  process.env.ANALOGY_TEST_CHROME,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean);

test("onboarding React UI supports real bilingual accessible setup interactions", async () => {
  const chromePath = chromeCandidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(chromePath, "需要 Chrome/Chromium 执行真实 onboarding DOM harness");
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-onboarding-"));
  try {
    const bundlePath = path.join(temporaryDirectory, "onboarding-browser-test.js");
    await esbuild.build({
      entryPoints: [path.join(__dirname, "onboarding-view-browser-runner.tsx")],
      bundle: true,
      platform: "browser",
      format: "iife",
      nodePaths: [path.join(__dirname, "..", "node_modules")],
      outfile: bundlePath,
      logLevel: "silent",
      plugins: [{
        name: "onboarding-obsidian-modal-stub",
        setup(build) {
          build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "task-12" }));
          build.onLoad({ filter: /.*/, namespace: "task-12" }, () => ({ loader: "js", contents: `
            export class Modal {
              constructor(app) {
                this.app = app;
                this.contentEl = document.createElement("div");
                this.contentEl.empty = function () { this.replaceChildren(); };
                this.modalEl = document.createElement("div");
                this.modalEl.addClass = function (value) { this.classList.add(value); };
                this.modalEl.appendChild(this.contentEl);
                document.body.appendChild(this.modalEl);
              }
              open() { this.onOpen?.(); }
              close() { this.onClose?.(); this.modalEl.remove(); }
            }
          ` }));
        },
      }],
    });
    const styles = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
    const htmlPath = path.join(temporaryDirectory, "index.html");
    fs.writeFileSync(htmlPath, `<!doctype html><html><head><meta charset="utf-8"><style>
:root {
  --background-primary: #f4f0e8; --background-primary-alt: #ebe4d8;
  --background-secondary: #e7dfd2; --background-modifier-border: #c9beae;
  --background-modifier-border-hover: #8d806e; --background-modifier-hover: #ded4c5;
  --background-modifier-active-hover: #d6cab8; --background-modifier-error: #f3d8d2;
  --text-normal: #25231f; --text-muted: #6c655b; --text-faint: #847b6f;
  --text-error: #a0392b; --text-on-accent: #fff; --interactive-accent: #45635b;
  --interactive-accent-hover: #365048; --font-interface: ui-sans-serif, sans-serif;
  --font-text: ui-serif, Georgia, serif; --radius-s: 4px; --radius-m: 8px; --radius-l: 12px;
  --shadow-s: 0 1px 3px rgb(25 22 18 / .12); --shadow-l: 0 18px 48px rgb(25 22 18 / .2);
}
* { box-sizing: border-box; } html, body { margin: 0; background: var(--background-primary); }
.scenario { width: 720px; margin: 16px auto; }
.scenario.narrow { width: 320px; }
.scenario.theme-dark { --background-primary:#1e201f; --background-primary-alt:#262927; --background-secondary:#2c302e; --background-modifier-border:#454b47; --background-modifier-border-hover:#677169; --background-modifier-hover:#343936; --background-modifier-active-hover:#3b4540; --text-normal:#ece9e2; --text-muted:#b8b3a9; --text-faint:#8f948e; --interactive-accent:#8fb5a6; --interactive-accent-hover:#a4c8ba; --text-on-accent:#15231e; }
${styles}
</style></head><body><script src="${path.basename(bundlePath)}"></script></body></html>`, "utf8");
    const chrome = spawnSync(chromePath, [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-background-networking",
      "--disable-component-update", "--disable-default-apps", "--disable-extensions",
      "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding", "--disable-sync", "--metrics-recording-only",
      "--no-first-run", "--run-all-compositor-stages-before-draw", "--virtual-time-budget=8000",
      `--user-data-dir=${path.join(temporaryDirectory, "profile")}`, "--dump-dom", pathToFileURL(htmlPath).href,
    ], { encoding: "utf8", timeout: 25000 });
    assert.equal(chrome.status, 0, `Chrome onboarding harness 启动失败：${chrome.stderr}`);
    const encoded = chrome.stdout.match(/data-onboarding-test-result="([^"]+)"/)?.[1];
    assert.ok(encoded, `Chrome onboarding harness 未返回结果：${chrome.stdout.slice(-1800)}`);
    const result = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    assert.deepEqual(result.failures, [], `真实 onboarding DOM harness 失败：\n- ${result.failures.join("\n- ")}\nmetrics=${JSON.stringify(result.metrics)}`);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
