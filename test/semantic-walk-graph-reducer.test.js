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

function result(chunkId, distance = 0.1) {
  return {
    chunkId,
    docId: chunkId.split("::")[0],
    path: `${chunkId.split("::")[0]}.md`,
    title: chunkId,
    content: chunkId,
    chunkIndex: 0,
    chunkCount: 1,
    sectionLabel: "",
    mtime: 1,
    distance,
  };
}

(async () => {
  const {
    candidateCriteriaKey,
    createWalkSessionState,
    prepareCandidateReplacement,
    semanticWalkReducer,
  } = await loadModule("semantic-walk/graph-reducer.ts");
  let state = createWalkSessionState();
  const root = result("Root::chunk-0", 0);

  assert.strictEqual(state.excludeSameDocument, false);
  assert.deepStrictEqual(state.expansionCriteria, {});
  assert.strictEqual(candidateCriteriaKey("balanced", true), "balanced:exclude-source");

  state = semanticWalkReducer(state, { type: "add-root", chunk: root });
  assert.strictEqual(state.rootNodeId, root.chunkId);
  assert.strictEqual(state.focusNodeId, root.chunkId);
  assert.deepStrictEqual(
    { x: state.nodes[root.chunkId].x, y: state.nodes[root.chunkId].y, depth: state.nodes[root.chunkId].depth, status: state.nodes[root.chunkId].status },
    { x: 0, y: 0, depth: 0, status: "focus" },
  );

  const first = result("First::chunk-0", 0.05);
  const second = result("Second::chunk-0", 0.2);
  state = semanticWalkReducer(state, {
    type: "expand-candidates",
    sourceId: root.chunkId,
    candidates: [first, second],
    placements: [
      { chunkId: first.chunkId, x: 440, y: -106 },
      { chunkId: second.chunkId, x: 440, y: 106 },
    ],
    relationBands: ["strong", "exploratory"],
    createdAt: 10,
  });
  assert.strictEqual(state.nodes[root.chunkId].expanded, true);
  assert.strictEqual(state.nodes[first.chunkId].status, "candidate");
  assert.strictEqual(state.edges[`${root.chunkId}->${first.chunkId}`].relationBand, "strong");
  assert.deepStrictEqual(state.expansionCache[root.chunkId], [first.chunkId, second.chunkId]);

  state = semanticWalkReducer(state, { type: "focus-node", nodeId: first.chunkId });
  assert.strictEqual(state.focusNodeId, first.chunkId);
  assert.strictEqual(state.nodes[root.chunkId].status, "visited");
  assert.strictEqual(state.nodes[first.chunkId].status, "focus");
  assert.deepStrictEqual(state.visitedOrder, [root.chunkId, first.chunkId]);

  state = semanticWalkReducer(state, {
    type: "expand-candidates",
    sourceId: second.chunkId,
    candidates: [first],
    placements: [{ chunkId: first.chunkId, x: 880, y: 0 }],
    relationBands: ["related"],
    createdAt: 11,
  });
  assert.strictEqual(state.nodes[first.chunkId].x, 440, "已有节点不应重新定位");
  assert.ok(state.edges[`${second.chunkId}->${first.chunkId}`], "不同 source 可连接同一 target");

  const deterministicAction = {
    type: "expand-candidates",
    sourceId: root.chunkId,
    candidates: [result("Deterministic::chunk-0")],
    placements: [{ chunkId: "Deterministic::chunk-0", x: 440, y: 500 }],
    relationBands: ["related"],
    createdAt: 99,
  };
  const originalNow = Date.now;
  try {
    Date.now = () => 100;
    const firstResult = semanticWalkReducer(state, deterministicAction);
    Date.now = () => 200;
    const secondResult = semanticWalkReducer(state, deterministicAction);
    assert.deepStrictEqual(firstResult, secondResult, "同一 state/action 不能依赖系统时钟");
  } finally {
    Date.now = originalNow;
  }

  state = semanticWalkReducer(state, { type: "collapse-node", nodeId: root.chunkId });
  assert.strictEqual(state.nodes[root.chunkId].collapsed, true);
  state = semanticWalkReducer(state, { type: "hide-node", nodeId: second.chunkId });
  assert.deepStrictEqual(state.hiddenChunkIds, [second.chunkId]);
  assert.strictEqual(state.nodes[second.chunkId], undefined);
  assert.strictEqual(state.edges[`${root.chunkId}->${second.chunkId}`], undefined);

  const oldLeaf = result("OldLeaf::chunk-0");
  const visitedChild = result("Visited::chunk-0");
  const expandedChild = result("Expanded::chunk-0");
  const expandedGrandchild = result("Grandchild::chunk-0");
  const otherParent = result("OtherParent::chunk-0");
  const shared = result("Shared::chunk-0");
  let replacementState = semanticWalkReducer(createWalkSessionState(), { type: "add-root", chunk: root });
  replacementState = semanticWalkReducer(replacementState, {
    type: "expand-candidates",
    sourceId: root.chunkId,
    candidates: [oldLeaf, visitedChild, expandedChild, otherParent, shared],
    placements: [oldLeaf, visitedChild, expandedChild, otherParent, shared]
      .map((candidate, index) => ({ chunkId: candidate.chunkId, x: 440, y: index * 212 })),
    relationBands: ["related", "related", "related", "related", "related"],
    criteria: "balanced:include-source",
    createdAt: 20,
  });
  replacementState = semanticWalkReducer(replacementState, { type: "focus-node", nodeId: visitedChild.chunkId });
  replacementState = semanticWalkReducer(replacementState, { type: "focus-node", nodeId: root.chunkId });
  replacementState = semanticWalkReducer(replacementState, {
    type: "expand-candidates",
    sourceId: expandedChild.chunkId,
    candidates: [expandedGrandchild],
    placements: [{ chunkId: expandedGrandchild.chunkId, x: 880, y: 0 }],
    relationBands: ["related"],
    criteria: "balanced:include-source",
    createdAt: 21,
  });
  replacementState = semanticWalkReducer(replacementState, {
    type: "expand-candidates",
    sourceId: otherParent.chunkId,
    candidates: [shared],
    placements: [{ chunkId: shared.chunkId, x: 880, y: 212 }],
    relationBands: ["related"],
    criteria: "balanced:include-source",
    createdAt: 22,
  });

  const prepared = prepareCandidateReplacement(replacementState, root.chunkId);
  assert.strictEqual(prepared.edges[`${root.chunkId}->${oldLeaf.chunkId}`], undefined);
  assert.strictEqual(prepared.nodes[oldLeaf.chunkId], undefined, "失去根路径的未访问叶子应被清理");
  assert.ok(prepared.edges[`${root.chunkId}->${visitedChild.chunkId}`], "已访问路径必须保留");
  assert.ok(prepared.edges[`${root.chunkId}->${expandedChild.chunkId}`], "已展开路径必须保留");
  assert.strictEqual(prepared.edges[`${root.chunkId}->${shared.chunkId}`], undefined, "共享叶子的旧候选边应被替换");
  assert.ok(prepared.nodes[shared.chunkId], "仍有其他父路径的共享节点必须保留");
  assert.ok(prepared.edges[`${otherParent.chunkId}->${shared.chunkId}`]);

  const reset = semanticWalkReducer(state, { type: "reset" });
  assert.deepStrictEqual(reset.nodes, {});
  assert.deepStrictEqual(reset.edges, {});
  assert.strictEqual(reset.focusNodeId, null);
  assert.strictEqual(reset.rootNodeId, null);

  let capped = createWalkSessionState();
  capped = semanticWalkReducer(capped, { type: "add-root", chunk: root });
  const many = Array.from({ length: 101 }, (_, index) => result(`Limit::chunk-${index}`, index));
  capped = semanticWalkReducer(capped, {
    type: "expand-candidates",
    sourceId: root.chunkId,
    candidates: many,
    placements: many.map((chunk, index) => ({ chunkId: chunk.chunkId, x: 440, y: index * 212 })),
    relationBands: many.map(() => "related"),
    createdAt: 12,
  });
  assert.strictEqual(Object.keys(capped.nodes).length, 100, "最多保留 100 个可见节点");
  assert.strictEqual(Object.keys(capped.edges).length, 99, "节点限制应同时限制新增边");

  let edgeCapped = createWalkSessionState();
  edgeCapped = semanticWalkReducer(edgeCapped, { type: "add-root", chunk: root });
  edgeCapped.nodes[first.chunkId] = {
    ...edgeCapped.nodes[root.chunkId],
    id: first.chunkId,
    chunk: first,
    x: 440,
    depth: 1,
    status: "candidate",
  };
  edgeCapped.edges = Object.fromEntries(Array.from({ length: 199 }, (_, index) => [
    `existing-${index}`,
    { id: `existing-${index}`, source: root.chunkId, target: root.chunkId, distance: 0, relationBand: "related", createdAt: index },
  ]));
  edgeCapped = semanticWalkReducer(edgeCapped, {
    type: "expand-candidates",
    sourceId: root.chunkId,
    candidates: [first],
    placements: [{ chunkId: first.chunkId, x: 440, y: 0 }],
    relationBands: ["related"],
    createdAt: 201,
  });
  assert.strictEqual(Object.keys(edgeCapped.edges).length, 200, "最多保留 200 条边");
  edgeCapped = semanticWalkReducer(edgeCapped, {
    type: "expand-candidates",
    sourceId: root.chunkId,
    candidates: [second],
    placements: [{ chunkId: second.chunkId, x: 440, y: 0 }],
    relationBands: ["related"],
    createdAt: 202,
  });
  assert.strictEqual(edgeCapped.edges[`${root.chunkId}->${second.chunkId}`], undefined);

  console.log("Semantic walk graph reducer tests passed");
})().catch((error) => {
  console.error("Semantic walk graph reducer tests FAILED:", error);
  process.exit(1);
});
