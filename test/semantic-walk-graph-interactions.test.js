const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");

async function loadModule(relativeSource) {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, "..", "src", relativeSource)],
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
  const docId = chunkId.split("::")[0];
  return {
    chunkId,
    docId,
    path: `${docId}.md`,
    title: docId,
    content: chunkId,
    chunkIndex: 0,
    chunkCount: 1,
    sectionLabel: docId,
    mtime: 1,
    distance,
  };
}

function expand(reducer, state, sourceId, candidates, createdAt = 1) {
  return reducer(state, {
    type: "expand-candidates",
    sourceId,
    candidates,
    placements: candidates.map((candidate, index) => ({ chunkId: candidate.chunkId, x: 440, y: index * 220 })),
    relationBands: candidates.map(() => "related"),
    createdAt,
  });
}

(async () => {
  const { createWalkSessionState, semanticWalkReducer, selectVisibleGraph } = await loadModule("semantic-walk/graph-reducer.ts");
  const { SemanticWalkController } = await loadModule("semantic-walk/walk-controller.ts");
  const root = result("Root::0", 0);
  const left = result("Left::0");
  const right = result("Right::0");
  const shared = result("Shared::0");

  let state = semanticWalkReducer(createWalkSessionState(), { type: "add-root", chunk: root });
  state = expand(semanticWalkReducer, state, root.chunkId, [left, right], 1);
  state = expand(semanticWalkReducer, state, left.chunkId, [shared], 2);
  state = expand(semanticWalkReducer, state, right.chunkId, [shared], 3);
  state = semanticWalkReducer(state, { type: "collapse-node", nodeId: left.chunkId });
  let visible = selectVisibleGraph(state);
  assert.ok(visible.nodes[shared.chunkId], "共享子节点仍可经未折叠的另一父节点到达");
  state = semanticWalkReducer(state, { type: "collapse-node", nodeId: right.chunkId });
  visible = selectVisibleGraph(state);
  assert.strictEqual(visible.nodes[shared.chunkId], undefined, "所有可达父分支折叠后后代必须隐藏");
  assert.strictEqual(visible.edges[`${left.chunkId}->${shared.chunkId}`], undefined);

  const child = result("Child::0");
  const grandchild = result("Grandchild::0");
  let hiddenBranch = semanticWalkReducer(createWalkSessionState(), { type: "add-root", chunk: root });
  hiddenBranch = expand(semanticWalkReducer, hiddenBranch, root.chunkId, [left, right], 10);
  hiddenBranch = expand(semanticWalkReducer, hiddenBranch, left.chunkId, [child], 11);
  hiddenBranch = expand(semanticWalkReducer, hiddenBranch, child.chunkId, [grandchild], 12);
  hiddenBranch = expand(semanticWalkReducer, hiddenBranch, right.chunkId, [grandchild], 13);
  hiddenBranch = semanticWalkReducer(hiddenBranch, { type: "hide-node", nodeId: left.chunkId });
  assert.strictEqual(hiddenBranch.nodes[child.chunkId], undefined, "隐藏父节点后必须清理失去全部根路径的后代");
  assert.ok(hiddenBranch.nodes[grandchild.chunkId], "仍可经其他父路径到达的共享后代必须保留");
  assert.ok(hiddenBranch.edges[`${right.chunkId}->${grandchild.chunkId}`]);
  assert.strictEqual(hiddenBranch.edges[`${child.chunkId}->${grandchild.chunkId}`], undefined);
  assert.strictEqual(Object.keys(hiddenBranch.nodes).length, Object.keys(selectVisibleGraph(hiddenBranch).nodes).length, "状态节点计数不得包含不可见 orphan");

  hiddenBranch = semanticWalkReducer(hiddenBranch, { type: "hide-node", nodeId: root.chunkId });
  assert.deepStrictEqual(hiddenBranch.nodes, {}, "隐藏根节点必须清空整张图");
  assert.deepStrictEqual(hiddenBranch.edges, {});
  assert.strictEqual(hiddenBranch.rootNodeId, null);
  assert.strictEqual(hiddenBranch.focusNodeId, null);

  const chunks = new Map([[root.chunkId, { ...root, embedding: [0.1] }], [left.chunkId, left]]);
  let relationCalls = 0;
  const controller = new SemanticWalkController({
    repository: { async getChunk(chunkId) { return chunks.get(chunkId) ?? null; } },
    relationService: { async findRelatedChunks() { relationCalls += 1; return [left]; } },
  });
  await controller.setStart(root.chunkId);
  await controller.toggleNodeExpansion(root.chunkId);
  assert.strictEqual(relationCalls, 1);
  assert.strictEqual(controller.getState().nodes[root.chunkId].collapsed, false);
  await controller.toggleNodeExpansion(root.chunkId);
  assert.strictEqual(controller.getState().nodes[root.chunkId].collapsed, true, "已展开节点再次点击应折叠");
  await controller.toggleNodeExpansion(root.chunkId);
  assert.strictEqual(controller.getState().nodes[root.chunkId].collapsed, false, "折叠节点再次点击应仅恢复可见性");
  assert.strictEqual(relationCalls, 1, "展开/折叠已有候选不得重复查询");

  const branchRoot = result("BranchRoot::0", 0);
  const branchA = result("BranchA::0");
  const branchB = result("BranchB::0");
  const branchAChildren = [result("BranchAChild1::0"), result("BranchAChild2::0"), result("BranchAChild3::0")];
  const branchBChild = result("BranchBChild::0");
  const branchChunks = new Map(
    [branchRoot, branchA, branchB, ...branchAChildren, branchBChild]
      .map((chunk) => [chunk.chunkId, { ...chunk, embedding: [0.1] }]),
  );
  const branchCandidates = new Map([
    [branchRoot.chunkId, [branchA, branchB]],
    [branchA.chunkId, branchAChildren],
    [branchB.chunkId, [branchBChild]],
  ]);
  const branchController = new SemanticWalkController({
    repository: { async getChunk(chunkId) { return branchChunks.get(chunkId) ?? null; } },
    relationService: {
      async findRelatedChunks(source) { return branchCandidates.get(source.chunkId) ?? []; },
    },
  });
  await branchController.setStart(branchRoot.chunkId);
  await branchController.expand(branchRoot.chunkId);
  await branchController.expand(branchA.chunkId);
  await branchController.toggleNodeExpansion(branchA.chunkId);
  const collapsedBranchState = branchController.getState();
  assert.strictEqual(collapsedBranchState.nodes[branchA.chunkId].collapsed, true);
  assert.strictEqual(
    selectVisibleGraph(collapsedBranchState).nodes[branchAChildren[0].chunkId],
    undefined,
    "收起分支的后代必须不可见",
  );
  await branchController.expand(branchB.chunkId);
  const expandedSiblingState = branchController.getState();
  assert.strictEqual(
    expandedSiblingState.nodes[branchBChild.chunkId].y,
    expandedSiblingState.nodes[branchB.chunkId].y,
    "同层兄弟分支展开时，已收起分支的隐藏后代不得继续占用布局槽位",
  );
  const stableSiblingY = expandedSiblingState.nodes[branchBChild.chunkId].y;
  await branchController.toggleNodeExpansion(branchA.chunkId);
  const restoredBranchState = branchController.getState();
  const restoredVisibleNodes = Object.values(selectVisibleGraph(restoredBranchState).nodes);
  for (let leftIndex = 0; leftIndex < restoredVisibleNodes.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < restoredVisibleNodes.length; rightIndex++) {
      const leftNode = restoredVisibleNodes[leftIndex];
      const rightNode = restoredVisibleNodes[rightIndex];
      if (leftNode.x !== rightNode.x) continue;
      assert.ok(
        Math.abs(leftNode.y - rightNode.y) >= 312,
        `恢复旧分支后，同列节点 ${leftNode.id} 与 ${rightNode.id} 不得重叠`,
      );
    }
  }
  assert.strictEqual(
    restoredBranchState.nodes[branchBChild.chunkId].y,
    stableSiblingY,
    "恢复旧分支时不得挪动当前可见的兄弟分支",
  );

  controller.focus(left.chunkId);
  let confirmations = 0;
  const cancelledHide = await controller.hideNode(left.chunkId, async () => {
    confirmations += 1;
    return false;
  });
  assert.strictEqual(cancelledHide.status, "cancelled");
  assert.ok(controller.getState().nodes[left.chunkId], "已访问主路径取消确认后必须保留");
  const confirmedHide = await controller.hideNode(left.chunkId, async () => {
    confirmations += 1;
    return true;
  });
  assert.strictEqual(confirmedHide.status, "success");
  assert.strictEqual(confirmations, 2, "已访问主路径隐藏必须经过确认");

  const staleController = new SemanticWalkController({
    repository: { async getChunk() { return root; } },
    relationService: { async findRelatedChunks() { throw new Error("失效节点不得查询"); } },
    validateSource: () => "stale",
  });
  await staleController.setStart(root.chunkId);
  staleController.refreshFileValidity();
  assert.strictEqual(staleController.getState().nodes[root.chunkId].validity, "stale");
  const staleExpand = await staleController.expand(root.chunkId);
  assert.strictEqual(staleExpand.status, "invalid", "stale 节点必须禁止继续展开");

  let edgeCapped = semanticWalkReducer(createWalkSessionState(), { type: "add-root", chunk: root });
  edgeCapped.edges = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [
    `edge-${index}`,
    { id: `edge-${index}`, source: root.chunkId, target: root.chunkId, distance: 0, relationBand: "related", createdAt: index },
  ]));
  edgeCapped = expand(semanticWalkReducer, edgeCapped, root.chunkId, [left], 201);
  assert.strictEqual(edgeCapped.nodes[left.chunkId], undefined, "边预算不足时不得先加入孤儿节点");
  assert.strictEqual(edgeCapped.limitWarning, "edges", "达到边限制必须暴露可见反馈");

  let nodeCapped = semanticWalkReducer(createWalkSessionState(), { type: "add-root", chunk: root });
  const ninetyNine = Array.from({ length: 99 }, (_, index) => result(`Visible${index}::0`));
  nodeCapped = expand(semanticWalkReducer, nodeCapped, root.chunkId, ninetyNine, 300);
  nodeCapped = expand(semanticWalkReducer, nodeCapped, root.chunkId, [left], 301);
  assert.strictEqual(nodeCapped.nodes[left.chunkId], undefined);
  assert.strictEqual(nodeCapped.limitWarning, "nodes", "达到可见节点限制必须暴露可见反馈");

  controller.dispose();
  branchController.dispose();
  staleController.dispose();
  console.log("Semantic walk graph interaction tests passed");
})().catch((error) => {
  console.error("Semantic walk graph interaction tests FAILED:", error);
  process.exit(1);
});
