const assert = require("assert");
const path = require("path");
const esbuild = require("../node_modules/esbuild");

async function loadModule(relativePath) {
  const source = path.join(__dirname, "..", relativePath);
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const module = { exports: {} };
  const fn = new Function("module", "exports", "require", result.outputFiles[0].text);
  fn(module, module.exports, require);
  return module.exports;
}

(async () => {
  const { setLocale, t } = await loadModule("src/util/i18n.ts");

  setLocale("en");
  assert.strictEqual(t("search.articleContentButton"), "Search by article content");
  assert.strictEqual(t("search.articleSummaryButton"), "Search by article summary");

  setLocale("zh");
  assert.strictEqual(t("search.articleContentButton"), "基于文章内容搜索");
  assert.strictEqual(t("search.articleSummaryButton"), "基于文章摘要检索");

  console.log("Sidebar search i18n tests passed");
})();
