const assert = require("assert");
const esbuild = require("esbuild");
const path = require("path");
const { renderToStaticMarkup } = require("react-dom/server");

const extensionRoot = path.join(__dirname, "..");

class TFile {
  constructor(filePath = "") {
    this.path = filePath;
    this.extension = filePath.split(".").pop() || "";
  }
}

class ItemView {
  constructor(leaf) {
    this.leaf = leaf;
    this.app = leaf.app;
    this.containerEl = { children: [{}, {}] };
  }
}

class Plugin {
  constructor(app, manifest = { id: "analogy", version: "test", dir: ".obsidian/plugins/analogy" }) {
    this.app = app;
    this.manifest = manifest;
    this.views = new Map();
    this.commands = [];
    this.ribbons = [];
  }

  registerView(type, factory) { this.views.set(type, factory); }
  addCommand(command) { this.commands.push(command); }
  addRibbonIcon(icon, title, callback) { this.ribbons.push({ icon, title, callback }); }
  addSettingTab() {}
  registerInterval() {}
  registerEvent() {}
  async loadData() { return {}; }
  async saveData() {}
}

const inertClass = class {
  constructor(...args) { Object.assign(this, { args }); }
  open() {}
  close() {}
};

const obsidianValues = {
  Plugin,
  ItemView,
  TFile,
  PluginSettingTab: inertClass,
  Modal: inertClass,
  Component: inertClass,
  Notice: inertClass,
  Setting: inertClass,
  TextComponent: inertClass,
  ButtonComponent: inertClass,
  DropdownComponent: inertClass,
  ToggleComponent: inertClass,
  SliderComponent: inertClass,
  ExtraButtonComponent: inertClass,
  addIcon() {},
  setIcon() {},
  normalizePath(value) { return value; },
  requestUrl: async () => ({ status: 200, json: {}, text: "" }),
};
const obsidian = new Proxy(obsidianValues, {
  get(target, property) {
    if (!(property in target)) target[property] = inertClass;
    return target[property];
  },
});

const roots = [];
const reactDomClient = {
  createRoot(container) {
    const root = {
      container,
      renders: [],
      unmountCount: 0,
      render(element) { this.renders.push(element); },
      unmount() { this.unmountCount += 1; },
    };
    roots.push(root);
    return root;
  },
};

async function loadTaskBoundary() {
  const result = await esbuild.build({
    stdin: {
      contents: [
        'import Analogy from "./main";',
        'export { Analogy };',
        'export { VIEW_TYPE_SEMANTIC_WALK, SemanticWalkItemView, isSemanticWalkServiceAvailable } from "./src/semantic-walk/SemanticWalkItemView";',
        'export { searchInstance, updateServiceState } from "./src/local-vector/search-instance";',
        'export { getLocale, setLocale } from "./src/util/i18n";',
      ].join("\n"),
      resolveDir: extensionRoot,
      sourcefile: "semantic-walk-registration-boundary.ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    packages: "external",
    external: ["obsidian", "react-dom/client", "electron", "@huggingface/transformers", "onnxruntime-node"],
    define: {
      __ANALOGY_BUILD_ID__: JSON.stringify("test-build"),
      __ANALOGY_EMBEDDING_WORKER_SOURCE__: JSON.stringify(""),
    },
    plugins: [{
      name: "semantic-walk-view-props-spy",
      setup(build) {
        build.onResolve({ filter: /^\.\/SemanticWalkView$/ }, () => ({
          path: "semantic-walk-view-props-spy",
          namespace: "semantic-walk-test",
        }));
        build.onLoad({ filter: /.*/, namespace: "semantic-walk-test" }, () => ({
          loader: "js",
          contents: [
            "exports.SemanticWalkView = function SemanticWalkView(props) {",
            "  globalThis.__semanticWalkViewProps = props;",
            "  return null;",
            "};",
          ].join("\n"),
        }));
      },
    }],
  });
  const module = { exports: {} };
  const taskRequire = (id) => {
    if (id === "obsidian") return obsidian;
    if (id === "react-dom/client") return reactDomClient;
    return require(id);
  };
  new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, taskRequire);
  return module.exports;
}

function createWorkspace(options = {}) {
  const leaves = [];
  const calls = { getLeaf: [], getRightLeaf: 0, revealLeaf: [], states: [] };
  const workspace = {
    activeFile: null,
    getLeavesOfType(type) { return leaves.filter((leaf) => leaf.type === type); },
    getLeaf(kind) {
      calls.getLeaf.push(kind);
      const leaf = {
        app,
        type: "empty",
        view: null,
        async setViewState(state) {
          if (options.beforeSetViewState) await options.beforeSetViewState;
          calls.states.push(state);
          this.type = state.type;
          this.view = plugin.views.get(state.type)(this);
          await this.view.onOpen?.();
        },
      };
      leaves.push(leaf);
      return leaf;
    },
    getRightLeaf() { calls.getRightLeaf += 1; throw new Error("semantic walk must not use the right leaf"); },
    revealLeaf(leaf) { calls.revealLeaf.push(leaf); },
    getActiveFile() { return this.activeFile; },
    onLayoutReady() {},
    openLinkText: async () => {},
  };
  const app = {
    version: "test",
    workspace,
    vault: {
      adapter: { basePath: process.cwd() },
      configDir: ".obsidian",
      getAbstractFileByPath: () => null,
    },
    plugins: { enabledPlugins: new Set(), manifests: [] },
  };
  let plugin = null;
  return { app, workspace, leaves, calls, setPlugin(value) { plugin = value; } };
}

(async () => {
  global.window = { setInterval: () => 1 };
  global.localStorage = {
    getItem: () => null,
    setItem() {},
    removeItem() {},
  };

  const boundary = await loadTaskBoundary();
  assert.strictEqual(boundary.VIEW_TYPE_SEMANTIC_WALK, "analogy-semantic-walk", "view type must be stable and independent");
  assert.strictEqual(boundary.getLocale(), "en", "production i18n default must remain English");
  boundary.setLocale("zh");

  const fakeVectorStore = {};
  const fakeSearch = {};
  const fakeEmbedding = {};
  boundary.searchInstance.vectorStore = fakeVectorStore;
  boundary.searchInstance.localSearch = fakeSearch;
  boundary.searchInstance.embeddingService = fakeEmbedding;
  for (const status of ["ready", "degraded"]) {
    boundary.updateServiceState({ status });
    assert.strictEqual(boundary.isSemanticWalkServiceAvailable(), true, `${status} with all dependencies must be available`);
  }
  boundary.updateServiceState({ status: "error", lastError: "Safe mode is active" });
  assert.strictEqual(boundary.isSemanticWalkServiceAvailable(), false, "error/safe-mode must stay unavailable even when stale dependencies exist");
  boundary.updateServiceState({ status: "ready", lastError: "" });
  boundary.searchInstance.localSearch = null;
  assert.strictEqual(boundary.isSemanticWalkServiceAvailable(), false, "ready status without every required dependency must be unavailable");
  boundary.searchInstance.vectorStore = null;
  boundary.searchInstance.embeddingService = null;

  const harness = createWorkspace();
  const plugin = new boundary.Analogy(harness.app, { id: "analogy", version: "test", dir: ".obsidian/plugins/analogy" });
  harness.setPlugin(plugin);
  plugin.settings = { uiLanguage: "en" };
  const semanticRecorder = { recordSemanticWalkExpand() {} };
  plugin.diagnosticRecorder = semanticRecorder;

  boundary.searchInstance.vectorStore = fakeVectorStore;
  boundary.searchInstance.localSearch = fakeSearch;
  boundary.searchInstance.embeddingService = fakeEmbedding;
  boundary.updateServiceState({ status: "ready", activeModel: "identity-model", lastError: "" });

  assert.strictEqual(typeof plugin.registerSemanticWalkFeatures, "function", "plugin must expose its semantic-walk registration boundary");
  plugin.registerSemanticWalkFeatures();

  assert(plugin.views.has(boundary.VIEW_TYPE_SEMANTIC_WALK), "semantic walk ItemView must be registered");
  const commandIds = plugin.commands.map((command) => command.id).sort();
  assert.deepStrictEqual(commandIds, [
    "semantic-walk-current-document",
    "semantic-walk-open",
    "semantic-walk-random",
  ]);
  for (const command of plugin.commands) {
    assert.match(command.name, /[A-Za-z]/, `${command.id} must retain an English label after locale changes`);
    assert.match(command.name, /[\u3400-\u9fff]/, `${command.id} must retain a Chinese label after locale changes`);
  }

  assert.strictEqual(plugin.ribbons.length, 1, "semantic walk registration must add exactly one ribbon entry");
  const semanticWalkRibbon = plugin.ribbons[0];
  assert.strictEqual(semanticWalkRibbon.icon, "waypoints", "semantic walk ribbon must use the view's waypoints icon");
  assert.strictEqual(semanticWalkRibbon.title, "语义漫游", "semantic walk ribbon must expose the localized view name");

  const ribbonHarness = createWorkspace();
  const ribbonPlugin = new boundary.Analogy(ribbonHarness.app, { id: "analogy", version: "test", dir: ".obsidian/plugins/analogy" });
  ribbonHarness.setPlugin(ribbonPlugin);
  ribbonPlugin.registerSemanticWalkFeatures();
  await ribbonPlugin.ribbons[0].callback();
  assert.deepStrictEqual(ribbonHarness.calls.getLeaf, ["tab"], "semantic walk ribbon must open a main workspace tab");
  assert.deepStrictEqual(ribbonHarness.leaves[0].view.getOpenRequest().request, { type: "empty" });
  assert.strictEqual(ribbonHarness.calls.revealLeaf.length, 1, "semantic walk ribbon must reveal the canvas");

  await plugin.activateSemanticWalk({ type: "empty" });
  assert.deepStrictEqual(harness.calls.getLeaf, ["tab"], "new semantic walk must use a main workspace tab leaf");
  assert.strictEqual(harness.calls.getRightLeaf, 0, "semantic walk must never request a right leaf");
  assert.strictEqual(harness.calls.states[0].type, boundary.VIEW_TYPE_SEMANTIC_WALK);
  assert.deepStrictEqual(harness.leaves[0].view.getOpenRequest().request, { type: "empty" });
  assert.strictEqual(
    harness.leaves[0].view.diagnosticRecorder,
    semanticRecorder,
    "main ItemView factory 必须原样注入同一个 semantic-walk recorder 对象",
  );
  renderToStaticMarkup(roots.at(-1).renders.at(-1));
  const semanticWalkViewProps = globalThis.__semanticWalkViewProps;
  assert(semanticWalkViewProps, "ItemView 的生产 workspace 必须渲染 SemanticWalkView");
  assert.strictEqual(
    semanticWalkViewProps.diagnosticRecorder,
    semanticRecorder,
    "ItemView→SemanticWalkView 必须保持 recorder 对象身份",
  );
  assert.strictEqual(
    semanticWalkViewProps.relationService.diagnosticRecorder,
    semanticRecorder,
    "ItemView→ChunkRelationService 必须保持 recorder 对象身份",
  );
  assert.strictEqual(semanticWalkViewProps.model, "identity-model");
  assert.strictEqual(semanticWalkViewProps.relationService.model, "identity-model");
  assert.strictEqual(typeof semanticWalkViewProps.confirmRestart, "function", "production ItemView 必须注入非空画布重新开始确认");
  assert.strictEqual(typeof semanticWalkViewProps.confirmHide, "function", "production ItemView 必须注入已访问路径隐藏确认");
  assert.strictEqual(typeof semanticWalkViewProps.fileBridge?.subscribe, "function", "ItemView 必须通过 props 注入文件生命周期 bridge");
  assert.strictEqual(typeof semanticWalkViewProps.fileBridge?.getFileValidity, "function");
  delete globalThis.__semanticWalkViewProps;
  assert.strictEqual(harness.calls.revealLeaf.length, 1);

  const reusedView = harness.leaves[0].view;
  const dispatched = [];
  const originalDispatch = reusedView.dispatchOpenRequest.bind(reusedView);
  reusedView.dispatchOpenRequest = (request) => { dispatched.push(request); return originalDispatch(request); };
  await plugin.activateSemanticWalk({ type: "chunk", chunkId: "chunk-7" });
  await plugin.activateSemanticWalk({ type: "random" });
  assert.strictEqual(harness.calls.getLeaf.length, 1, "existing semantic walk leaf must be reused");
  assert.deepStrictEqual(dispatched, [
    { type: "chunk", chunkId: "chunk-7" },
    { type: "random" },
  ], "every reuse must dispatch the new open request");
  assert.strictEqual(harness.calls.revealLeaf.length, 3, "every activation must reveal the reused leaf");

  reusedView.dispatchOpenRequest({ type: "chunk", chunkId: "replayed-chunk" });
  const replayed = [];
  const unsubscribeReplay = reusedView.subscribeOpenRequests((event) => replayed.push(event));
  assert.deepStrictEqual(
    replayed.map((event) => event.request),
    [{ type: "chunk", chunkId: "replayed-chunk" }],
    "subscribing after dispatch must synchronously replay the latest request",
  );
  unsubscribeReplay();

  const hotReloadRequests = [];
  harness.leaves[0].view = {
    getViewType: () => boundary.VIEW_TYPE_SEMANTIC_WALK,
    dispatchOpenRequest: (request) => hotReloadRequests.push(request),
  };
  await plugin.activateSemanticWalk({ type: "chunk", chunkId: "hot-reload" });
  assert.deepStrictEqual(hotReloadRequests, [{ type: "chunk", chunkId: "hot-reload" }], "hot-reloaded views must dispatch by capability, not instanceof identity");

  harness.leaves[0].view = {};
  harness.leaves[0].setViewState = async () => {};
  await assert.rejects(
    () => plugin.activateSemanticWalk({ type: "empty" }),
    /semantic walk view/i,
    "an invalid view must fail explicitly instead of silently losing the request",
  );
  harness.leaves[0].view = reusedView;

  let releaseConcurrentView;
  const concurrentGate = new Promise((resolve) => { releaseConcurrentView = resolve; });
  const concurrentHarness = createWorkspace({ beforeSetViewState: concurrentGate });
  const concurrentPlugin = new boundary.Analogy(concurrentHarness.app, { id: "analogy", version: "test", dir: ".obsidian/plugins/analogy" });
  concurrentHarness.setPlugin(concurrentPlugin);
  concurrentPlugin.registerSemanticWalkFeatures();
  const concurrentFirst = concurrentPlugin.activateSemanticWalk({ type: "empty" });
  const concurrentSecond = concurrentPlugin.activateSemanticWalk({ type: "random" });
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(concurrentHarness.calls.getLeaf.length, 1, "concurrent activations must share one in-flight tab leaf");
  releaseConcurrentView();
  await Promise.all([concurrentFirst, concurrentSecond]);
  assert.strictEqual(concurrentHarness.leaves.length, 1, "concurrent activations must create exactly one leaf");
  assert.deepStrictEqual(concurrentHarness.leaves[0].view.getOpenRequest().request, { type: "random" }, "queued requests must preserve activation order");

  const emptyCommand = plugin.commands.find((command) => command.id === "semantic-walk-open");
  const currentCommand = plugin.commands.find((command) => command.id === "semantic-walk-current-document");
  const randomCommand = plugin.commands.find((command) => command.id === "semantic-walk-random");
  await emptyCommand.callback();
  harness.workspace.activeFile = new TFile("notes/current.md");
  await currentCommand.callback();
  await randomCommand.callback();
  harness.workspace.activeFile = new TFile("attachments/image.png");
  await currentCommand.callback();
  assert.deepStrictEqual(dispatched.slice(-4), [
    { type: "empty" },
    { type: "current-document", path: "notes/current.md" },
    { type: "random" },
    { type: "current-document", path: "" },
  ], "commands must dispatch their exact request, including a recoverable missing-Markdown request");

  const localeHarness = createWorkspace();
  const localePlugin = new boundary.Analogy(localeHarness.app, { id: "analogy", version: "test", dir: ".obsidian/plugins/analogy" });
  localeHarness.setPlugin(localePlugin);
  localePlugin.registerSemanticWalkFeatures();
  await localePlugin.activateSemanticWalk({ type: "empty" });
  const itemView = localeHarness.leaves[0].view;
  const root = roots[roots.length - 1];
  const renderCountBeforeLocaleChange = root.renders.length;
  boundary.setLocale("en");
  assert.strictEqual(root.renders.length, renderCountBeforeLocaleChange + 1, "an open ItemView must rerender immediately when locale changes");
  const renderCountBeforeClose = root.renders.length;
  let requestNotifications = 0;
  itemView.subscribeOpenRequests(() => { requestNotifications += 1; });
  assert.strictEqual(requestNotifications, 1, "request subscriptions must replay once at subscription time");
  requestNotifications = 0;
  await itemView.onClose();
  boundary.updateServiceState({ status: "degraded" });
  boundary.setLocale("zh");
  itemView.dispatchOpenRequest({ type: "empty" });
  assert.strictEqual(root.unmountCount, 1, "onClose must unmount the React root exactly once");
  assert.strictEqual(root.renders.length, renderCountBeforeClose, "onClose must unsubscribe from service-state events");
  assert.strictEqual(requestNotifications, 0, "onClose must cancel open-request subscriptions");

  console.log("Semantic walk view registration tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
