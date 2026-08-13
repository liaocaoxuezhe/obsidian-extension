"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const esbuild = require("esbuild");

let modulePromise;

function loadModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const source = path.join(
        process.cwd(),
        "src/local-vector/vault-folder-selection.ts",
      );
      const result = await esbuild.build({
        entryPoints: [source],
        bundle: true,
        platform: "node",
        format: "cjs",
        write: false,
        logLevel: "silent",
      });
      const loadedModule = { exports: {} };
      Function("module", "exports", "require", result.outputFiles[0].text)(
        loadedModule,
        loadedModule.exports,
        require,
      );
      return loadedModule.exports;
    })();
  }
  return modulePromise;
}

test("macOS vault 子文件夹会转换为 vault 相对路径", async () => {
  const { toVaultRelativeFolderPath } = await loadModule();

  assert.deepEqual(
    toVaultRelativeFolderPath(
      "/Users/example/Notes Vault",
      "/Users/example/Notes Vault/Archive/2025",
      "darwin",
    ),
    { ok: true, path: "Archive/2025" },
  );
});

test("Windows 本地及网络 vault 路径会转换为正斜杠相对路径", async () => {
  const { toVaultRelativeFolderPath } = await loadModule();

  assert.deepEqual(
    toVaultRelativeFolderPath(
      "C:\\Users\\Example\\Notes",
      "c:\\users\\example\\notes\\Projects\\Analogy",
      "win32",
    ),
    { ok: true, path: "Projects/Analogy" },
  );
  assert.deepEqual(
    toVaultRelativeFolderPath(
      "\\\\server\\share\\Notes",
      "\\\\server\\share\\Notes\\Archive",
      "win32",
    ),
    { ok: true, path: "Archive" },
  );
  assert.deepEqual(
    toVaultRelativeFolderPath(
      "\\\\?\\C:\\Notes",
      "\\\\?\\C:\\Notes\\Archive",
      "win32",
    ),
    { ok: true, path: "Archive" },
  );
});

test("vault 外部、Windows 跨盘符及跨网络共享文件夹会被拒绝", async () => {
  const { toVaultRelativeFolderPath } = await loadModule();

  assert.deepEqual(
    toVaultRelativeFolderPath(
      "/Users/example/Notes",
      "/Users/example/Notes Backup",
      "darwin",
    ),
    { ok: false, reason: "outside-vault" },
  );
  assert.deepEqual(
    toVaultRelativeFolderPath(
      "C:\\Users\\Example\\Notes",
      "D:\\Archive",
      "win32",
    ),
    { ok: false, reason: "outside-vault" },
  );
  assert.deepEqual(
    toVaultRelativeFolderPath(
      "\\\\server\\share\\Notes",
      "\\\\server\\other\\Notes\\Archive",
      "win32",
    ),
    { ok: false, reason: "outside-vault" },
  );
});

test("vault 根目录会被拒绝以避免排除整个 vault", async () => {
  const { toVaultRelativeFolderPath } = await loadModule();

  assert.deepEqual(
    toVaultRelativeFolderPath(
      "/Users/example/Notes/",
      "/Users/example/Notes",
      "darwin",
    ),
    { ok: false, reason: "vault-root" },
  );
});

test("原生选择器不绑定 Obsidian 主窗口并返回 vault 相对路径", async () => {
  const { openVaultFolderDialog } = await loadModule();
  const calls = [];
  const dialog = {
    async showOpenDialog(...args) {
      calls.push(args);
      return {
        canceled: false,
        filePaths: ["/Users/example/Notes/Projects"],
      };
    },
  };

  const result = await openVaultFolderDialog({
    dialog,
    vaultBasePath: "/Users/example/Notes",
    platform: "darwin",
    title: "Choose folder",
  });

  assert.deepEqual(result, { ok: true, path: "Projects" });
  assert.deepEqual(calls, [[{
      title: "Choose folder",
      defaultPath: "/Users/example/Notes",
      properties: ["openDirectory", "createDirectory"],
  }]]);
});

test("取消原生文件夹选择时不改变输入", async () => {
  const { openVaultFolderDialog } = await loadModule();
  const dialog = {
    async showOpenDialog() {
      return { canceled: true, filePaths: [] };
    },
  };

  assert.equal(await openVaultFolderDialog({
    dialog,
    vaultBasePath: "C:\\Users\\Example\\Notes",
    platform: "win32",
    title: "Choose folder",
  }), null);
});
