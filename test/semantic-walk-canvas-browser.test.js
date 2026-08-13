const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");
const esbuild = require("esbuild");

const CHROME_PATHS = [
  process.env.ANALOGY_TEST_CHROME,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean);

(async () => {
  const chromePath = CHROME_PATHS.find((candidate) => fs.existsSync(candidate));
  assert.ok(chromePath, "需要可用的 Chrome/Chromium 执行真实 DOM canvas harness");

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-semantic-walk-"));
  try {
    const bundlePath = path.join(temporaryDirectory, "canvas-browser-test.js");
    await esbuild.build({
      entryPoints: [path.join(__dirname, "semantic-walk-canvas-browser-runner.tsx")],
      bundle: true,
      platform: "browser",
      format: "iife",
      outfile: bundlePath,
      logLevel: "silent",
    });
    const htmlPath = path.join(temporaryDirectory, "index.html");
    const productionStyles = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
    fs.writeFileSync(htmlPath, `<!doctype html>
<html><head><meta charset="utf-8"><style>
${productionStyles}
:root {
  --background-primary: #ffffff;
  --background-primary-alt: #f7f7f8;
  --background-secondary: #f1f1f2;
  --background-secondary-alt: #ececee;
  --background-modifier-border: #d8d8dc;
  --background-modifier-border-hover: #b8b8c0;
  --background-modifier-hover: #e9e9ed;
  --background-modifier-active-hover: #eee8ff;
  --background-modifier-error: #fff0f0;
  --background-modifier-error-hover: #d85c5c;
  --interactive-accent: #7c3aed;
  --interactive-accent-hover: #6d28d9;
  --text-normal: #202024;
  --text-muted: #666672;
  --text-faint: #8b8b96;
  --text-error: #b42318;
  --radius-s: 4px;
  --radius-m: 8px;
  --radius-l: 12px;
  --shadow-s: 0 1px 3px #0000001f;
  --shadow-l: 0 8px 24px #00000026;
  --font-interface: sans-serif;
  --font-text: sans-serif;
  --font-ui-smaller: 11px;
  --font-ui-small: 12px;
  --font-ui-medium: 14px;
  --font-semibold: 600;
  --font-medium: 500;
}
html, body, #root { width: 100%; height: 100%; margin: 0; }
.semantic-walk-canvas { position: relative; width: 100%; height: 700px; overflow: hidden; }
.semantic-walk-scene, .semantic-walk-nodes, .semantic-walk-node { position: absolute; }
</style></head><body><div id="root"></div><script src="${path.basename(bundlePath)}"></script></body></html>`, "utf8");

    const chrome = spawnSync(chromePath, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--window-size=480,700",
      "--run-all-compositor-stages-before-draw",
      "--virtual-time-budget=5000",
      `--user-data-dir=${path.join(temporaryDirectory, "profile")}`,
      "--dump-dom",
      pathToFileURL(htmlPath).href,
    ], { encoding: "utf8", timeout: 15000 });
    assert.strictEqual(chrome.status, 0, `Chrome harness 启动失败：${chrome.stderr}`);
    const encodedResult = chrome.stdout.match(/data-semantic-walk-test-result="([^"]+)"/)?.[1];
    assert.ok(encodedResult, `Chrome harness 未返回结果：${chrome.stdout.slice(-1000)}`);
    const result = JSON.parse(Buffer.from(encodedResult, "base64").toString("utf8"));
    assert.deepStrictEqual(result.failures, [], `真实 DOM canvas harness 失败：\n- ${result.failures.join("\n- ")}\nmetrics=${JSON.stringify(result.metrics)}`);
    console.log(`Semantic walk browser harness passed: ${JSON.stringify(result.metrics)}`);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error("Semantic walk browser harness FAILED:", error);
  process.exit(1);
});
