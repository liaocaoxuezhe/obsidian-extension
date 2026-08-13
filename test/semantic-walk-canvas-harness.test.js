const assert = require("assert");
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

async function loadHarness() {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, "semantic-walk-canvas-harness.tsx")],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["react", "react-dom"],
    write: false,
    logLevel: "silent",
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

async function loadCanvasModule() {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, "..", "src", "semantic-walk", "components", "SemanticWalkCanvas.tsx")],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["react", "react-dom"],
    write: false,
    logLevel: "silent",
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

(async () => {
  const {
    SemanticWalkCanvasHarness,
    CANVAS_COMPACT_NODE_HEIGHT,
    CANVAS_NODE_HEIGHT,
    CANVAS_NODE_WIDTH,
    centerViewportOnNode,
    clampCanvasZoom,
    createCanvasHarnessState,
    createSemanticEdgePath,
    fitViewportToNodes,
    setLocale,
    zoomViewportAt,
  } = await loadHarness();
  const { shouldAutoExpandRoot } = await loadCanvasModule();
  setLocale("zh");

  assert.strictEqual(typeof shouldAutoExpandRoot, "function", "画布必须导出起点自动展开守卫供行为验证");
  const activationNode = (overrides = {}) => ({
    expanded: false,
    collapsed: false,
    loading: false,
    validity: "valid",
    ...overrides,
  });
  assert.strictEqual(shouldAutoExpandRoot(activationNode()), true, "仅从未展开的有效起点应自动展开");
  assert.strictEqual(shouldAutoExpandRoot(activationNode({ collapsed: true })), false, "手动收起的起点必须保持收起");
  assert.strictEqual(shouldAutoExpandRoot(activationNode({ expanded: true })), false, "已展开起点不得重复查询");
  assert.strictEqual(shouldAutoExpandRoot(activationNode({ loading: true })), false, "加载中起点不得重复查询");
  assert.strictEqual(shouldAutoExpandRoot(activationNode({ validity: "stale" })), false, "失效起点不得自动查询");

  assert.deepStrictEqual(
    { CANVAS_NODE_WIDTH, CANVAS_NODE_HEIGHT, CANVAS_COMPACT_NODE_HEIGHT },
    { CANVAS_NODE_WIDTH: 414, CANVAS_NODE_HEIGHT: 276, CANVAS_COMPACT_NODE_HEIGHT: 168 },
    "画布几何必须与 150% 放大后的卡片规格一致",
  );
  const geometryNode = { x: 100, y: 200 };
  assert.deepStrictEqual(
    centerViewportOnNode(geometryNode, { x: 0, y: 0, zoom: 1 }, { width: 1200, height: 720 }),
    { x: 293, y: 22, zoom: 1 },
    "聚焦居中必须使用 414×276 卡片中心",
  );
  assert.strictEqual(
    createSemanticEdgePath(geometryNode, { x: 670, y: 512 }),
    "M 514 338 C 584.2 338, 599.8 650, 670 650",
    "连线端点必须落在新卡片左右边缘的垂直中心",
  );

  const defaultState = createCanvasHarnessState();
  assert.strictEqual(Object.keys(defaultState.nodes).length, 100, "默认 harness 应注入 100 个节点");
  assert.strictEqual(Object.keys(defaultState.edges).length, 200, "默认 harness 应注入 200 条边");
  assert.ok(Object.values(defaultState.nodes).some((node) => node.loading), "harness 应覆盖 loading 状态");
  assert.ok(Object.values(defaultState.nodes).some((node) => node.status === "error"), "harness 应覆盖 error 状态");
  assert.strictEqual(defaultState.viewport.zoom, 0.6);

  const injectedState = createCanvasHarnessState(12, 24);
  assert.strictEqual(Object.keys(injectedState.nodes).length, 12, "harness 应支持手工注入节点规模");
  assert.strictEqual(Object.keys(injectedState.edges).length, 24, "harness 应支持手工注入边规模");

  assert.strictEqual(clampCanvasZoom(0.1), 0.4);
  assert.strictEqual(clampCanvasZoom(2.5), 1.8);
  const viewport = { x: 40, y: 80, zoom: 1 };
  const anchor = { x: 300, y: 220 };
  const zoomed = zoomViewportAt(viewport, 1.5, anchor);
  assert.strictEqual((anchor.x - viewport.x) / viewport.zoom, (anchor.x - zoomed.x) / zoomed.zoom, "鼠标锚点的世界坐标应保持不变");
  assert.strictEqual((anchor.y - viewport.y) / viewport.zoom, (anchor.y - zoomed.y) / zoomed.zoom, "鼠标锚点的世界坐标应保持不变");

  const nodes = Object.values(injectedState.nodes);
  const fitted = fitViewportToNodes(nodes, { width: 1200, height: 720 });
  assert.ok(fitted.zoom >= 0.4 && fitted.zoom <= 1.8, "适应内容也必须遵守缩放约束");
  assert.match(createSemanticEdgePath(nodes[0], nodes[1]), /^M .+ C .+$/, "连线应是三次贝塞尔路径");

  const startedAt = performance.now();
  const markup = renderToStaticMarkup(React.createElement(SemanticWalkCanvasHarness, { initialState: defaultState }));
  const renderDuration = performance.now() - startedAt;
  assert.strictEqual((markup.match(/<article/g) || []).length, 100, "静态 story 应渲染全部节点");
  assert.strictEqual((markup.match(/class=\"semantic-walk-edge is-/g) || []).length, 200, "静态 story 应渲染全部边");
  assert.match(markup, /aria-label=\"缩小画布\" title=\"缩小画布\"/, "icon button 应同时提供 aria-label 和 title");
  assert.doesNotMatch(markup, /% 关联度|相似度.*%/, "画布不得伪造关联百分比");

  const compactState = { ...injectedState, viewport: { ...injectedState.viewport, zoom: 0.59 } };
  const compactMarkup = renderToStaticMarkup(React.createElement(SemanticWalkCanvasHarness, { initialState: compactState }));
  assert.match(compactMarkup, /semantic-walk-node[^\"]*is-compact/, "低于 60% 缩放时节点应进入正文降级模式");

  const canvasSource = fs.readFileSync(path.join(__dirname, "..", "src", "semantic-walk", "components", "SemanticWalkCanvas.tsx"), "utf8");
  assert.match(canvasSource, /requestAnimationFrame/, "viewport 更新应由 requestAnimationFrame 合并");
  assert.match(canvasSource, /onMoveNode\(nodeId, x, y, \"manual\"\)/, "节点拖动回调必须标记 manual");

  const cssSource = fs.readFileSync(path.join(__dirname, "..", "tailwind.css"), "utf8");
  const semanticStart = cssSource.indexOf("\n\t.semantic-walk-canvas {");
  const semanticEnd = cssSource.indexOf("\n@layer components {\n\t.scroll-reveal", semanticStart);
  const semanticCss = cssSource.slice(semanticStart, semanticEnd);
  assert.ok(semanticStart >= 0 && semanticEnd > semanticStart, "应存在独立的 Semantic Walk 样式段");
  assert.doesNotMatch(semanticCss, /#[0-9a-f]{3,8}|rgba?\(|hsla?\(/i, "Semantic Walk 样式不得硬编码颜色");
  assert.match(semanticCss, /--semantic-walk-node-width:\s*414px/, "卡片 CSS 宽度必须为 414px");
  assert.match(semanticCss, /--semantic-walk-node-height:\s*276px/, "卡片 CSS 高度必须为 276px");
  assert.match(semanticCss, /\.semantic-walk-node__source\s*>\s*span:last-child\s*\{[^}]*-webkit-line-clamp:\s*2/s, "卡片标题最多显示两行");
  assert.match(semanticCss, /\.semantic-walk-node__content\s*\{[^}]*-webkit-line-clamp:\s*8/s, "卡片正文最多显示八行");
  assert.match(semanticCss, /\.semantic-walk-node\s*\{[^}]*text-align:\s*left/s, "卡片必须显式左对齐");
  assert.doesNotMatch(semanticCss, /border-style:\s*dashed/, "候选和加载卡片都必须保持实体边框");
  assert.match(semanticCss, /color-mix\([^)]*var\(--interactive-accent\)/, "焦点外圈必须由主题强调色混合生成");
  assert.match(semanticCss, /\.semantic-walk-canvas\s*\{[^}]*border:\s*1px solid var\(--background-modifier-border\)/s, "画布必须拥有主题边框");
  for (const stateClass of ["is-focus", "is-visited", "is-candidate", "is-loading", "is-error"]) {
    assert.ok(semanticCss.includes(stateClass), `样式应覆盖 ${stateClass} 状态`);
  }

  console.log(`Semantic walk canvas harness passed: 100 nodes / 200 edges rendered in ${renderDuration.toFixed(1)}ms`);
  setLocale("en");
})().catch((error) => {
  console.error("Semantic walk canvas harness FAILED:", error);
  process.exit(1);
});
