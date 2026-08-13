const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");

class TFile {
  constructor(filePath, mtime) {
    this.path = filePath;
    this.extension = filePath.split(".").pop() || "";
    this.stat = { mtime };
  }
}

async function loadBridge() {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, "..", "src", "semantic-walk", "file-bridge.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["obsidian"],
    write: false,
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    module,
    module.exports,
    (id) => id === "obsidian" ? { TFile } : require(id),
  );
  return module.exports;
}

function eventSource() {
  const listeners = new Map();
  return {
    on(type, listener) {
      const ref = { type, listener };
      const values = listeners.get(type) ?? [];
      values.push(ref);
      listeners.set(type, values);
      return ref;
    },
    offref(ref) {
      listeners.set(ref.type, (listeners.get(ref.type) ?? []).filter((entry) => entry !== ref));
    },
    emit(type, ...args) {
      for (const ref of listeners.get(type) ?? []) ref.listener(...args);
    },
    count() {
      return Array.from(listeners.values()).reduce((total, values) => total + values.length, 0);
    },
  };
}

(async () => {
  const { ObsidianSemanticWalkFileBridge, isMarkdownPath } = await loadBridge();
  assert.strictEqual(isMarkdownPath("Notes/主题.MD"), true);
  assert.strictEqual(isMarkdownPath("assets/image.png"), false);

  const workspaceEvents = eventSource();
  const vaultEvents = eventSource();
  const files = new Map();
  const note = new TFile("Notes/current.md", 100);
  files.set(note.path, note);
  let activeFile = note;
  const opened = [];
  const bridge = new ObsidianSemanticWalkFileBridge({
    workspace: {
      ...workspaceEvents,
      getActiveFile: () => activeFile,
      openLinkText: async (filePath) => { opened.push(filePath); },
    },
    vault: {
      ...vaultEvents,
      getAbstractFileByPath: (filePath) => files.get(filePath) ?? null,
    },
  });

  let notifications = 0;
  const unsubscribe = bridge.subscribe(() => { notifications += 1; });
  assert.strictEqual(workspaceEvents.count(), 2, "bridge 必须订阅 file-open 与 active-leaf-change");
  assert.strictEqual(vaultEvents.count(), 3, "bridge 必须订阅 modify、rename、delete");
  assert.deepStrictEqual(bridge.getCurrentDocument(), { path: note.path, mtime: 100 });
  assert.strictEqual(bridge.getFileValidity(note.path, 100), "valid");

  const firstRevision = bridge.getIndexRevision();
  note.stat.mtime = 200;
  vaultEvents.emit("modify", note);
  assert.ok(bridge.getIndexRevision() > firstRevision, "Markdown modify 必须推进单调 index revision");
  assert.strictEqual(bridge.getFileValidity(note.path, 100), "stale", "mtime 变化后旧 chunk 必须失效");

  const renamed = new TFile("Notes/renamed.md", 200);
  files.delete(note.path);
  files.set(renamed.path, renamed);
  activeFile = renamed;
  vaultEvents.emit("rename", renamed, note.path);
  assert.deepStrictEqual(bridge.getCurrentDocument(), { path: renamed.path, mtime: 200 });
  assert.strictEqual(bridge.getFileValidity(note.path, 100), "missing");

  files.delete(renamed.path);
  vaultEvents.emit("delete", renamed);
  assert.strictEqual(await bridge.openDocument(renamed.path), false, "open 前必须重新检查已删除文件");
  assert.deepStrictEqual(opened, []);
  files.set(renamed.path, renamed);
  assert.strictEqual(await bridge.openDocument(renamed.path), true);
  assert.deepStrictEqual(opened, [renamed.path]);

  activeFile = new TFile("assets/image.png", 300);
  workspaceEvents.emit("file-open", activeFile);
  assert.strictEqual(bridge.getCurrentDocument(), null, "非 Markdown active file 必须复用同一 guard");
  assert.ok(notifications >= 4, "文件与 active-file 变化必须通知 React 消费方");

  unsubscribe();
  assert.strictEqual(workspaceEvents.count(), 0);
  assert.strictEqual(vaultEvents.count(), 0);
  bridge.dispose();
  console.log("Semantic walk file bridge tests passed");
})().catch((error) => {
  console.error("Semantic walk file bridge tests FAILED:", error);
  process.exit(1);
});
