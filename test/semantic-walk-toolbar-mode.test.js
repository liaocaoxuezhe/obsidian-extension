const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

async function loadToolbar() {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, "..", "src", "semantic-walk", "components", "WalkToolbar.tsx")],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["obsidian", "react", "react-dom"],
    write: false,
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    module,
    module.exports,
    (id) => id === "obsidian" ? {} : require(id),
  );
  return module.exports;
}

(async () => {
  const { WalkToolbar } = await loadToolbar();
  const markup = renderToStaticMarkup(React.createElement(WalkToolbar, {
    zoom: 1,
    candidateMode: "pure",
    excludeSameDocument: true,
    onCandidateModeChange: () => {},
    onExcludeSameDocumentChange: () => {},
    onZoomOut: () => {},
    onResetZoom: () => {},
    onZoomIn: () => {},
    onCenterFocus: () => {},
    onFitContent: () => {},
  }));
  for (const mode of ["balanced", "pure"]) {
    assert.match(markup, new RegExp(`data-candidate-mode="${mode}"`), `toolbar 缺少 ${mode} 结果分布入口`);
  }
  assert.doesNotMatch(markup, /data-candidate-mode="cross-document"/, "跨文档不应继续作为互斥候选模式");
  assert.match(markup, /data-candidate-mode="pure"[^>]*aria-pressed="true"/, "当前候选模式必须有可访问状态");
  assert.match(
    markup,
    /data-exclude-same-document="true"[^>]*aria-pressed="true"/,
    "排除当前文档必须是独立且可访问的开关",
  );
  console.log("Semantic walk toolbar mode test passed");
})().catch((error) => {
  console.error("Semantic walk toolbar mode test FAILED:", error);
  process.exit(1);
});
