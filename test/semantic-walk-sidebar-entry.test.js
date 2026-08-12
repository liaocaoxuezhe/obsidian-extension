const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");
const React = require("../node_modules/react");
const { renderToStaticMarkup } = require("../node_modules/react-dom/server");
const esbuild = require("../node_modules/esbuild");

async function loadSmartConnectionModule() {
  const extensionRoot = path.join(__dirname, "..");
  const source = path.join(extensionRoot, "src", "SmartConnection.tsx");
  const stubs = {
    "search-instance": `
      export const searchInstance = { state: { status: "ready", embeddingStatus: "ready", summarySearchEnabled: false } };
      export const subscribeServiceState = () => () => {};
      export const onboardingInstance = { state: { stage: "ready" } };
      export const subscribeOnboardingState = () => () => {};
    `,
    "app-context": "export const useApp = () => undefined;",
    i18n: `
      const messages = {
        "semanticWalk.sidebar.open": "在语义画布中探索",
        "semanticWalk.sidebar.legacyReindex": "此结果来自旧索引，请重新索引后在语义画布中探索",
        "semanticWalk.sidebar.unavailable": "本地搜索不可用",
        "semanticWalk.sidebar.pluginUnavailable": "无法打开语义画布，请重新加载 Analogy 插件。",
        "semanticWalk.sidebar.openFailed": "无法打开语义画布：{message}",
        "semanticWalk.sidebar.unknownError": "未知错误",
      };
      export const onLocaleChange = () => () => {};
      export const t = (key, params) => {
        globalThis.__semanticWalkSidebarI18nKeys = [...(globalThis.__semanticWalkSidebarI18nKeys || []), key];
        return (messages[key] || key).replace(/\\{(\\w+)\\}/g, (_, name) => String(params?.[name] ?? ""));
      };
    `,
    obsidian: "export class Notice { constructor(message) { this.message = message; } }",
  };
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    external: ["react", "react/jsx-runtime", "lucide-react"],
    plugins: [{
      name: "smart-connection-test-stubs",
      setup(build) {
        build.onResolve({ filter: /^\.\/local-vector\/search-instance$/ }, () => ({ path: "search-instance", namespace: "test-stub" }));
        build.onResolve({ filter: /^\.\/model\/AppContext$/ }, () => ({ path: "app-context", namespace: "test-stub" }));
        build.onResolve({ filter: /^\.\/util\/i18n$/ }, () => ({ path: "i18n", namespace: "test-stub" }));
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "test-stub" }));
        build.onLoad({ filter: /.*/, namespace: "test-stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
      },
    }],
  });
  const module = { exports: {} };
  const extensionRequire = (name) => {
    if (name === "react") return React;
    if (name === "react/jsx-runtime") return require("../node_modules/react/jsx-runtime");
    if (name === "lucide-react") return require("../node_modules/lucide-react");
    return require(name);
  };
  const fn = new Function("module", "exports", "require", result.outputFiles[0].text);
  fn(module, module.exports, extensionRequire);
  return module.exports;
}

async function exerciseLegacySvgEventsInChrome() {
  const chromePath = [
    process.env.ANALOGY_TEST_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean).find((candidate) => fs.existsSync(candidate));
  assert.ok(chromePath, "需要可用的 Chrome/Chromium 验证禁用入口事件边界");

  const extensionRoot = path.join(__dirname, "..");
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-sidebar-entry-"));
  const stubs = {
    "search-instance": `
      export const searchInstance = { state: { status: "ready", embeddingStatus: "ready", summarySearchEnabled: false } };
      export const subscribeServiceState = () => () => {};
      export const onboardingInstance = { state: { stage: "ready" } };
      export const subscribeOnboardingState = () => () => {};
    `,
    "app-context": "export const useApp = () => undefined;",
    i18n: `
      const messages = {
        "semanticWalk.sidebar.open": "在语义画布中探索",
        "semanticWalk.sidebar.legacyReindex": "此结果来自旧索引，请重新索引后在语义画布中探索",
        "semanticWalk.sidebar.unavailable": "本地搜索不可用"
      };
      export const onLocaleChange = () => () => {};
      export const t = (key) => messages[key] || key;
    `,
    obsidian: "export class Notice {}",
  };

  try {
    const bundlePath = path.join(temporaryDirectory, "sidebar-entry-browser.js");
    await esbuild.build({
      stdin: {
        contents: `
          import React from "react";
          import { createRoot } from "react-dom/client";
          import { flushSync } from "react-dom";
          import { SearchResultCard } from ${JSON.stringify(path.join(extensionRoot, "src", "SmartConnection.tsx"))};

          const counters = { cardClicks: 0, wrapperClicks: 0, wrapperMouseDowns: 0, wrapperPointerDowns: 0, semanticRequests: 0 };
          const legacyResult = {
            chunkId: undefined, docId: "Notes/Legacy.md", path: "Notes/Legacy.md", title: "Legacy",
            content: "legacy result", chunkIndex: 0, chunkCount: 1, sectionLabel: "", distance: 0.2,
            source: "local", score: 0.8,
          };
          const root = createRoot(document.getElementById("root"));
          flushSync(() => root.render(
            <div
              onClick={() => counters.wrapperClicks += 1}
              onMouseDown={() => counters.wrapperMouseDowns += 1}
              onPointerDown={() => counters.wrapperPointerDowns += 1}
            >
              <SearchResultCard
                result={legacyResult}
                serviceReady={true}
                onOpen={() => counters.cardClicks += 1}
                onExplore={() => {}}
                onSemanticWalk={() => counters.semanticRequests += 1}
              />
            </div>
          ));
          const button = document.querySelector('[aria-label="在语义画布中探索"]');
          const svg = button.querySelector("svg");
          svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
          svg.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
          svg.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
          document.body.dataset.sidebarEntryResult = btoa(JSON.stringify({
            counters,
            ariaDisabled: button.getAttribute("aria-disabled"),
            nativeDisabled: button.hasAttribute("disabled"),
          }));
        `,
        loader: "tsx",
        resolveDir: extensionRoot,
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      outfile: bundlePath,
      logLevel: "silent",
      plugins: [{
        name: "sidebar-browser-test-stubs",
        setup(build) {
          build.onResolve({ filter: /^\.\/local-vector\/search-instance$/ }, () => ({ path: "search-instance", namespace: "test-stub" }));
          build.onResolve({ filter: /^\.\/model\/AppContext$/ }, () => ({ path: "app-context", namespace: "test-stub" }));
          build.onResolve({ filter: /^\.\/util\/i18n$/ }, () => ({ path: "i18n", namespace: "test-stub" }));
          build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "test-stub" }));
          build.onLoad({ filter: /.*/, namespace: "test-stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
        },
      }],
    });
    const htmlPath = path.join(temporaryDirectory, "index.html");
    fs.writeFileSync(htmlPath, `<!doctype html><html><body><div id="root"></div><script src="sidebar-entry-browser.js"></script></body></html>`, "utf8");
    const chrome = spawnSync(chromePath, [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-background-networking",
      "--disable-extensions", "--no-first-run", "--virtual-time-budget=1000",
      `--user-data-dir=${path.join(temporaryDirectory, "profile")}`,
      "--dump-dom", pathToFileURL(htmlPath).href,
    ], { encoding: "utf8", timeout: 15000 });
    assert.strictEqual(chrome.status, 0, `Chrome sidebar harness 启动失败：${chrome.stderr}`);
    const encoded = chrome.stdout.match(/data-sidebar-entry-result="([^"]+)"/)?.[1];
    assert.ok(encoded, `Chrome sidebar harness 未返回结果：${chrome.stdout.slice(-1000)}`);
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function result(overrides = {}) {
  return {
    chunkId: "Notes/Idea.md::2",
    docId: "Notes/Idea.md",
    path: "Notes/Idea.md",
    title: "Idea",
    content: "A semantic search result",
    chunkIndex: 2,
    chunkCount: 4,
    sectionLabel: "Details",
    distance: 0.2,
    source: "local",
    score: 0.8,
    ...overrides,
  };
}

(async () => {
  const {
    SearchResultCard,
    activateSemanticWalkForResult,
    getSearchResultKey,
    openSemanticWalkFromResult,
  } = await loadSmartConnectionModule();

  assert.strictEqual(
    getSearchResultKey(result(), 7),
    "Notes/Idea.md::2",
    "结果列表应优先使用稳定 chunkId 作为 React key"
  );

  const markup = renderToStaticMarkup(React.createElement(SearchResultCard, {
    result: result(),
    serviceReady: true,
    onOpen: () => {},
    onExplore: () => {},
    onSemanticWalk: () => {},
  }));
  assert.match(markup, /aria-label="在语义画布中探索"/);
  assert.match(markup, /aria-label="在语义画布中探索"[^>]*aria-disabled="false"/);
  assert.doesNotMatch(markup, /aria-label="在语义画布中探索"[^>]*\sdisabled(?:=|\s|>)/);
  assert.match(markup, /aria-label="继续探索"/, "新增入口不能移除原有继续探索动作");

  const legacyMarkup = renderToStaticMarkup(React.createElement(SearchResultCard, {
    result: result({ chunkId: undefined }),
    serviceReady: true,
    onOpen: () => {},
    onExplore: () => {},
    onSemanticWalk: () => {},
  }));
  assert.match(legacyMarkup, /aria-label="在语义画布中探索"[^>]*aria-disabled="true"/);
  assert.doesNotMatch(legacyMarkup, /aria-label="在语义画布中探索"[^>]*\sdisabled(?:=|\s|>)/);
  assert.match(legacyMarkup, /重新索引/, "旧索引结果应明确提示重新索引");

  let stopped = 0;
  let request = null;
  const opened = openSemanticWalkFromResult(
    { stopPropagation: () => { stopped += 1; } },
    result(),
    (nextRequest) => { request = nextRequest; }
  );
  assert.strictEqual(opened, true);
  assert.strictEqual(stopped, 1, "画布按钮必须阻止卡片主点击冒泡");
  assert.deepStrictEqual(request, { type: "chunk", chunkId: "Notes/Idea.md::2" });

  const requests = [];
  const app = {
    plugins: {
      getPlugin(id) {
        assert.strictEqual(id, "analogy-rag-in-your-vault");
        return { activateSemanticWalk: (nextRequest) => requests.push(nextRequest) };
      },
    },
  };
  assert.strictEqual(await activateSemanticWalkForResult(app, result()), true);
  assert.deepStrictEqual(requests, [{ type: "chunk", chunkId: "Notes/Idea.md::2" }]);
  assert.strictEqual(await activateSemanticWalkForResult(app, result({ chunkId: undefined })), false);
  const unavailableFeedback = [];
  assert.strictEqual(await activateSemanticWalkForResult({}, result(), (message) => unavailableFeedback.push(message)), false);
  assert.deepStrictEqual(unavailableFeedback, ["无法打开语义画布，请重新加载 Analogy 插件。"]);

  const unhandledRejections = [];
  const rejectionListener = (reason) => unhandledRejections.push(reason);
  process.on("unhandledRejection", rejectionListener);
  try {
    const asyncFeedback = [];
    const rejected = await activateSemanticWalkForResult({
      plugins: { getPlugin: () => ({ activateSemanticWalk: () => Promise.reject(new Error("view rejected")) }) },
    }, result(), (message) => asyncFeedback.push(message));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(unhandledRejections, [], "插件 Promise rejection 不得成为未处理 rejection");
    assert.strictEqual(rejected, false);
    assert.deepStrictEqual(asyncFeedback, ["无法打开语义画布：view rejected"]);

    const syncFeedback = [];
    const threw = await activateSemanticWalkForResult({
      plugins: { getPlugin: () => ({ activateSemanticWalk: () => { throw new Error("view threw"); } }) },
    }, result(), (message) => syncFeedback.push(message));
    assert.strictEqual(threw, false);
    assert.deepStrictEqual(syncFeedback, ["无法打开语义画布：view threw"]);
  } finally {
    process.removeListener("unhandledRejection", rejectionListener);
  }

  for (const key of [
    "semanticWalk.sidebar.open",
    "semanticWalk.sidebar.legacyReindex",
    "semanticWalk.sidebar.pluginUnavailable",
    "semanticWalk.sidebar.openFailed",
  ]) {
    assert.ok(globalThis.__semanticWalkSidebarI18nKeys?.includes(key), `SmartConnection semantic-walk string must use i18n key ${key}`);
  }

  const browserResult = await exerciseLegacySvgEventsInChrome();
  assert.deepStrictEqual(browserResult, {
    counters: {
      cardClicks: 0,
      wrapperClicks: 0,
      wrapperMouseDowns: 0,
      wrapperPointerDowns: 0,
      semanticRequests: 0,
    },
    ariaDisabled: "true",
    nativeDisabled: false,
  }, "旧索引入口的 SVG 子节点事件必须全部在按钮边界内被拒绝");

  console.log("Semantic walk sidebar entry tests passed");
})();
