const assert = require("assert");
const path = require("path");
const esbuild = require("../node_modules/esbuild");

async function loadModule() {
  const source = path.join(__dirname, "..", "src", "search-tabs.ts");
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const module = { exports: {} };
  const fn = new Function("module", "exports", result.outputFiles[0].text);
  fn(module, module.exports);
  return module.exports;
}

(async () => {
  const {
    MAX_SEARCH_TABS,
    createDefaultSearchTab,
    createEmptySearchTab,
    createDerivedSearchTab,
    closeSearchTab,
    createTabTitle,
    canCreateSearchTab,
  } = await loadModule();

  assert.strictEqual(MAX_SEARCH_TABS, 5);
  assert.strictEqual(createTabTitle("  中文   标题 内容继续很长  ", "搜索"), "中文 标题 内容继续很长");
  assert.strictEqual(createTabTitle("abcdefghijklmnopq", "搜索"), "abcdefghijklmno");
  assert.strictEqual(createTabTitle("   ", "搜索"), "搜索");

  const defaultTab = createDefaultSearchTab("tab-1");
  assert.deepStrictEqual(defaultTab, {
    id: "tab-1",
    title: "搜索",
    query: "",
    results: [],
    documentQueryText: "",
    isLoading: false,
    excludedPaths: [],
    source: { type: "manual" },
  });

  assert.strictEqual(canCreateSearchTab(new Array(4).fill(null)), true);
  assert.strictEqual(canCreateSearchTab(new Array(5).fill(null)), false);

  const emptyTab = createEmptySearchTab("tab-2");
  assert.strictEqual(emptyTab.title, "搜索");
  assert.strictEqual(emptyTab.source.type, "manual");

  const parentTab = {
    ...defaultTab,
    id: "parent",
    excludedPaths: ["old.md", "duplicate.md"],
    results: [
      { title: "Result A", content: "A", source: "local", score: 0.9, path: "a.md" },
      { title: "Result B", content: "B", source: "local", score: 0.8, path: "duplicate.md" },
      { title: "No Path", content: "C", source: "local", score: 0.7 },
    ],
  };
  const derived = createDerivedSearchTab("child", parentTab, {
    title: "继续探索标题",
    content: "继续探索正文",
    source: "local",
    score: 0.8,
    path: "selected.md",
  });

  assert.strictEqual(derived.title, "继续探索标题");
  assert.strictEqual(derived.query, "继续探索标题\n\n继续探索正文");
  assert.deepStrictEqual(derived.excludedPaths, ["old.md", "duplicate.md", "a.md"]);
  assert.deepStrictEqual(derived.source, {
    type: "result-card",
    parentTabId: "parent",
    sourcePath: "selected.md",
  });

  const tabs = [
    { ...createDefaultSearchTab("tab-a"), title: "A" },
    { ...createDefaultSearchTab("tab-b"), title: "B" },
    { ...createDefaultSearchTab("tab-c"), title: "C" },
  ];
  const closedActive = closeSearchTab(tabs, "tab-b", "tab-b", (id) => createDefaultSearchTab(id), "fallback");
  assert.deepStrictEqual(closedActive.tabs.map((tab) => tab.id), ["tab-a", "tab-c"]);
  assert.strictEqual(closedActive.activeTabId, "tab-c");

  const closedInactive = closeSearchTab(tabs, "tab-a", "tab-c", (id) => createDefaultSearchTab(id), "fallback");
  assert.deepStrictEqual(closedInactive.tabs.map((tab) => tab.id), ["tab-b", "tab-c"]);
  assert.strictEqual(closedInactive.activeTabId, "tab-c");

  const closedLast = closeSearchTab(
    [createDefaultSearchTab("only")],
    "only",
    "only",
    (id) => createDefaultSearchTab(id),
    "fallback"
  );
  assert.deepStrictEqual(closedLast.tabs.map((tab) => tab.id), ["fallback"]);
  assert.strictEqual(closedLast.activeTabId, "fallback");

  console.log("Sidebar search tab tests passed");
})();
