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
  assert.ok(chromePath, "需要可用的 Chrome/Chromium 执行真实 DOM picker harness");

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-semantic-walk-picker-"));
  try {
    const bundlePath = path.join(temporaryDirectory, "picker-browser-test.js");
    await esbuild.build({
      entryPoints: [path.join(__dirname, "semantic-walk-picker-browser-runner.tsx")],
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
html, body { margin: 0; }
.scenario { position: relative; width: 1000px; height: 700px; }
.semantic-walk-view, .semantic-walk-view__canvas, .semantic-walk-canvas { position: relative; width: 100%; height: 100%; }
.semantic-walk-scene, .semantic-walk-nodes, .semantic-walk-node { position: absolute; }
.semantic-walk-node { width: 276px; height: 184px; }
</style></head><body><script src="${path.basename(bundlePath)}"></script></body></html>`, "utf8");

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
      "--run-all-compositor-stages-before-draw",
      "--virtual-time-budget=6000",
      `--user-data-dir=${path.join(temporaryDirectory, "profile")}`,
      "--dump-dom",
      pathToFileURL(htmlPath).href,
    ], { encoding: "utf8", timeout: 20000 });
    assert.strictEqual(chrome.status, 0, `Chrome picker harness 启动失败：${chrome.stderr}`);
    const encodedResult = chrome.stdout.match(/data-semantic-walk-test-result="([^"]+)"/)?.[1];
    assert.ok(encodedResult, `Chrome picker harness 未返回结果：${chrome.stdout.slice(-1500)}`);
    const result = JSON.parse(Buffer.from(encodedResult, "base64").toString("utf8"));
    assert.deepStrictEqual(result.failures, [], `真实 DOM picker harness 失败：\n- ${result.failures.join("\n- ")}\nmetrics=${JSON.stringify(result.metrics)}`);
    console.log(`Semantic walk picker browser harness passed: ${JSON.stringify(result.metrics)}`);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error("Semantic walk picker browser harness FAILED:", error);
  process.exit(1);
});
