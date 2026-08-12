const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const fs = require("fs");

async function loadCard() {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, "..", "src", "semantic-walk", "components", "ChunkNodeCard.tsx")],
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
  const { ChunkNodeCard } = await loadCard();
  const renderCard = (node) => renderToStaticMarkup(React.createElement(ChunkNodeCard, {
    node,
    compact: false,
    onFocus: () => {},
    onExpand: () => {},
    onView: () => {},
    onMove: () => {},
    onHide: () => {},
    onOpenDocument: () => {},
    onOpenDocumentChunks: () => {},
  }));
  const markup = renderCard({
      id: "Stale::0",
      chunk: {
        chunkId: "Stale::0", docId: "Stale", path: "Stale.md", title: "Stale",
        content: "old chunk", chunkIndex: 0, chunkCount: 1, sectionLabel: "Old", mtime: 100, distance: 0,
      },
      x: 0, y: 0, depth: 0, status: "focus", positionMode: "auto",
      expanded: false, collapsed: false, loading: false, validity: "stale",
  });
  assert.match(markup, /semantic-walk-node[^\"]*is-stale/, "stale 卡片必须有灰态 class");
  assert.match(markup, /源文件.*修改|Source file.*changed/, "stale 卡片必须说明失效原因");
  assert.match(markup, /查看该文档的新 chunks|View new chunks/, "失效卡片必须提供重新选择入口");
  const disabledButtons = markup.match(/<button[^>]*disabled/g) ?? [];
  assert.ok(disabledButtons.length >= 2, "stale 卡片必须禁用展开与打开原文");

  const emptySectionMarkup = renderCard({
    id: "Legacy::57",
    chunk: {
      chunkId: "Legacy::57", docId: "Legacy", path: "Legacy.md", title: "完整标题应获得更多空间",
      content: "用于验证画布卡片信息层级的正文", chunkIndex: 57, chunkCount: 1, sectionLabel: "", mtime: 100, distance: 0,
    },
    x: 0, y: 0, depth: 0, status: "candidate", positionMode: "auto",
    expanded: false, collapsed: false, loading: false, validity: "valid",
  });
  assert.doesNotMatch(emptySectionMarkup, /58\/1/, "画布卡片不得展示可能失真的 chunk 序号");
  assert.doesNotMatch(emptySectionMarkup, /文档正文|Document body/, "空章节不得渲染占位行");
  assert.match(emptySectionMarkup, />查看<|>View</, "卡片必须提供全文查看按钮");
  const expandLabel = emptySectionMarkup.includes("展开关联") ? "展开关联" : "Expand related";
  const viewLabel = emptySectionMarkup.includes(">查看<") ? ">查看<" : ">View<";
  assert.ok(emptySectionMarkup.indexOf(expandLabel) < emptySectionMarkup.indexOf(viewLabel), "查看必须位于展开关联之后");

  const realSectionMarkup = renderCard({
    id: "Ending::0",
    chunk: {
      chunkId: "Ending::0", docId: "Ending", path: "Ending.md", title: "保留真实章节",
      content: "章节正文", chunkIndex: 0, chunkCount: 1, sectionLabel: "结语", mtime: 100, distance: 0,
    },
    x: 0, y: 0, depth: 0, status: "candidate", positionMode: "auto",
    expanded: false, collapsed: false, loading: false, validity: "valid",
  });
  assert.doesNotMatch(realSectionMarkup, /结语/, "画布知识卡片不得显示章节小标题");

  const css = fs.readFileSync(path.join(__dirname, "..", "tailwind.css"), "utf8");
  assert.match(css, /\.semantic-walk-node\.is-stale[\s\S]*?(?:opacity|filter):/, "stale 卡片必须有真实灰态样式");
  assert.match(css, /\.semantic-walk-node\.is-missing[\s\S]*?(?:opacity|filter):/, "missing 卡片必须有真实灰态样式");
  console.log("Semantic walk file-state UI test passed");
})().catch((error) => {
  console.error("Semantic walk file-state UI test FAILED:", error);
  process.exit(1);
});
