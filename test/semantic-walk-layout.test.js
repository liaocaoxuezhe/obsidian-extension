const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");

async function loadModule(relativeSource) {
  const source = path.join(__dirname, "..", "src", relativeSource);
  const result = await esbuild.build({
    entryPoints: [source],
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
    (id) => id === "obsidian" ? {} : require(id),
  );
  return module.exports;
}

function result(chunkId) {
  return {
    chunkId,
    docId: "Doc",
    path: "Doc.md",
    title: chunkId,
    content: chunkId,
    chunkIndex: 0,
    chunkCount: 1,
    sectionLabel: "",
    mtime: 1,
    distance: 0.1,
  };
}

function node(chunkId, x, y, positionMode = "auto") {
  return {
    id: chunkId,
    chunk: result(chunkId),
    x,
    y,
    depth: 1,
    status: "candidate",
    positionMode,
    expanded: false,
    collapsed: false,
    loading: false,
  };
}

(async () => {
  const { COLUMN_GAP, NODE_MIN_HEIGHT, NODE_WIDTH, ROW_GAP, layoutChildren } = await loadModule("semantic-walk/incremental-layout.ts");
  assert.deepStrictEqual(
    { NODE_WIDTH, NODE_MIN_HEIGHT, COLUMN_GAP, ROW_GAP },
    { NODE_WIDTH: 414, NODE_MIN_HEIGHT: 276, COLUMN_GAP: 156, ROW_GAP: 36 },
  );

  const parent = node("Parent::chunk-0", 100, 200);
  const three = [result("A::chunk-0"), result("B::chunk-0"), result("C::chunk-0")];
  const symmetric = layoutChildren(parent, three, {});
  assert.deepStrictEqual(symmetric, [
    { chunkId: "A::chunk-0", x: 670, y: -112 },
    { chunkId: "B::chunk-0", x: 670, y: 200 },
    { chunkId: "C::chunk-0", x: 670, y: 512 },
  ]);

  const six = Array.from({ length: 6 }, (_, index) => result(`Six-${index}::chunk-0`));
  assert.deepStrictEqual(
    layoutChildren(parent, six, {}),
    [-580, -268, 44, 356, 668, 980].map((y, index) => ({
      chunkId: `Six-${index}::chunk-0`,
      x: 670,
      y,
    })),
    "6 张子卡片必须以 312px 纵向步长围绕父节点居中",
  );

  const alreadyPlaced = node("Existing::chunk-0", 100, 200);
  const onlyNew = layoutChildren(
    parent,
    [result(alreadyPlaced.id), result("Centered::chunk-0")],
    { [alreadyPlaced.id]: alreadyPlaced },
  );
  assert.deepStrictEqual(onlyNew, [{ chunkId: "Centered::chunk-0", x: 670, y: 200 }]);

  const occupied = { "Taken::chunk-0": node("Taken::chunk-0", 670, 200) };
  const collisionFree = layoutChildren(parent, [result("D::chunk-0"), result("E::chunk-0")], occupied);
  assert.ok(collisionFree.every((placement) => Math.abs(placement.y - 200) >= NODE_MIN_HEIGHT + ROW_GAP));
  assert.ok(Math.abs(collisionFree[0].y - collisionFree[1].y) >= NODE_MIN_HEIGHT + ROW_GAP);

  const manual = node("Manual::chunk-0", 670, 356, "manual");
  const existing = { [manual.id]: manual };
  const before = JSON.stringify(existing);
  const aroundManual = layoutChildren(parent, [result(manual.id), result("Fresh::chunk-0")], existing);
  assert.strictEqual(aroundManual.some((placement) => placement.chunkId === manual.id), false, "已有手动节点不应被重新布局");
  assert.strictEqual(JSON.stringify(existing), before, "布局不能移动手动节点");
  assert.ok(Math.abs(aroundManual[0].y - manual.y) >= NODE_MIN_HEIGHT + ROW_GAP, "手动节点仍占用碰撞空间");

  const input = [result("Stable-A::chunk-0"), result("Stable-B::chunk-0")];
  assert.deepStrictEqual(layoutChildren(parent, input, occupied), layoutChildren(parent, input, occupied), "相同输入必须产生确定坐标");

  console.log("Semantic walk layout tests passed");
})().catch((error) => {
  console.error("Semantic walk layout tests FAILED:", error);
  process.exit(1);
});
