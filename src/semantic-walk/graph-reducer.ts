import type { ChunkSearchResult } from "../local-vector/search";
import type { CandidateMode, WalkAction, WalkEdge, WalkNode, WalkSessionState } from "./types";

const MAX_VISIBLE_NODES = 100;
const MAX_EDGES = 200;

export function createWalkSessionState(): WalkSessionState {
  return {
    nodes: {},
    edges: {},
    focusNodeId: null,
    rootNodeId: null,
    visitedOrder: [],
    hiddenChunkIds: [],
    expansionCache: {},
    expansionCriteria: {},
    viewport: { x: 0, y: 0, zoom: 1 },
    candidateMode: "balanced",
    excludeSameDocument: false,
    limitWarning: null,
  };
}

export function candidateCriteriaKey(mode: CandidateMode, excludeSameDocument: boolean): string {
  return `${mode}:${excludeSameDocument ? "exclude-source" : "include-source"}`;
}

function createNode(
  chunk: ChunkSearchResult,
  x: number,
  y: number,
  depth: number,
  status: WalkNode["status"],
): WalkNode {
  return {
    id: chunk.chunkId,
    chunk,
    x,
    y,
    depth,
    status,
    positionMode: "auto",
    expanded: false,
    collapsed: false,
    loading: false,
    validity: "valid",
  };
}

function resetWithRoot(state: WalkSessionState, chunk: ChunkSearchResult): WalkSessionState {
  const root = createNode(chunk, 0, 0, 0, "focus");
  return {
    ...createWalkSessionState(),
    viewport: state.viewport,
    candidateMode: state.candidateMode,
    excludeSameDocument: state.excludeSameDocument,
    nodes: { [root.id]: root },
    rootNodeId: root.id,
    focusNodeId: root.id,
    visitedOrder: [root.id],
  };
}

function addCandidates(state: WalkSessionState, action: Extract<WalkAction, { type: "expand-candidates" }>): WalkSessionState {
  const source = state.nodes[action.sourceId];
  if (!source) return state;

  const nodes = { ...state.nodes, [source.id]: { ...source, expanded: true, collapsed: false } };
  const edges = { ...state.edges };
  const hidden = new Set(state.hiddenChunkIds);
  const placements = new Map(action.placements.map((placement) => [placement.chunkId, placement]));
  const cachedIds: string[] = [];
  const createdAt = action.createdAt;
  let limitWarning: WalkSessionState["limitWarning"] = null;

  for (let index = 0; index < action.candidates.length; index++) {
    const candidate = action.candidates[index];
    if (hidden.has(candidate.chunkId) || candidate.chunkId === source.id) continue;
    const edgeId = `${source.id}->${candidate.chunkId}`;
    if (edges[edgeId]) {
      cachedIds.push(candidate.chunkId);
      continue;
    }
    if (Object.keys(edges).length >= MAX_EDGES) {
      limitWarning = "edges";
      continue;
    }

    let createdNode = false;
    if (!nodes[candidate.chunkId]) {
      const placement = placements.get(candidate.chunkId);
      if (!placement) continue;
      nodes[candidate.chunkId] = createNode(candidate, placement.x, placement.y, source.depth + 1, "candidate");
      createdNode = true;
    }

    const edge: WalkEdge = {
      id: edgeId,
      source: source.id,
      target: candidate.chunkId,
      distance: candidate.distance,
      relationBand: action.relationBands?.[index] ?? "related",
      createdAt,
    };
    edges[edgeId] = edge;
    const visibleCount = Object.keys(selectVisibleGraph({ ...state, nodes, edges }).nodes).length;
    if (visibleCount > MAX_VISIBLE_NODES) {
      delete edges[edgeId];
      if (createdNode) delete nodes[candidate.chunkId];
      limitWarning = "nodes";
      continue;
    }
    cachedIds.push(candidate.chunkId);
  }

  return {
    ...state,
    nodes,
    edges,
    expansionCache: { ...state.expansionCache, [source.id]: cachedIds },
    expansionCriteria: { ...state.expansionCriteria, [source.id]: action.criteria },
    limitWarning,
  };
}

export function selectVisibleGraph(
  state: Pick<WalkSessionState, "nodes" | "edges" | "rootNodeId">,
): Pick<WalkSessionState, "nodes" | "edges"> {
  const nodes: WalkSessionState["nodes"] = {};
  const edges: WalkSessionState["edges"] = {};
  const rootId = state.rootNodeId;
  if (!rootId || !state.nodes[rootId]) return { nodes, edges };
  const queue = [rootId];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    const node = state.nodes[nodeId];
    if (!node) continue;
    visited.add(nodeId);
    nodes[nodeId] = node;
    if (node.collapsed) continue;
    for (const edge of Object.values(state.edges)) {
      if (edge.source !== nodeId || !state.nodes[edge.target]) continue;
      edges[edge.id] = edge;
      if (!visited.has(edge.target)) queue.push(edge.target);
    }
  }
  return { nodes, edges };
}

function focusNode(state: WalkSessionState, nodeId: string): WalkSessionState {
  const nextFocus = state.nodes[nodeId];
  if (!nextFocus) return state;
  const nodes = { ...state.nodes };
  if (state.focusNodeId && nodes[state.focusNodeId] && state.focusNodeId !== nodeId) {
    nodes[state.focusNodeId] = { ...nodes[state.focusNodeId], status: "visited" };
  }
  nodes[nodeId] = { ...nextFocus, status: "focus" };
  return {
    ...state,
    nodes,
    focusNodeId: nodeId,
    visitedOrder: state.visitedOrder.includes(nodeId) ? state.visitedOrder : [...state.visitedOrder, nodeId],
  };
}

function addLinkedNode(
  state: WalkSessionState,
  action: Extract<WalkAction, { type: "add-linked-node" }>,
): WalkSessionState {
  if (!state.nodes[action.sourceId] || state.hiddenChunkIds.includes(action.chunk.chunkId)) return state;
  const edgeId = `${action.sourceId}->${action.chunk.chunkId}`;
  if (state.edges[edgeId] || state.nodes[action.chunk.chunkId]) return state;
  if (Object.keys(state.edges).length >= MAX_EDGES) return { ...state, limitWarning: "edges" };
  const node = createNode(
    action.chunk,
    action.placement.x,
    action.placement.y,
    state.nodes[action.sourceId].depth + 1,
    "candidate",
  );
  const edge: WalkEdge = {
    id: edgeId,
    source: action.sourceId,
    target: node.id,
    distance: action.chunk.distance,
    relationBand: "related",
    createdAt: action.createdAt,
  };
  const nodes = { ...state.nodes, [node.id]: node };
  const edges = { ...state.edges, [edge.id]: edge };
  if (Object.keys(selectVisibleGraph({ ...state, nodes, edges }).nodes).length > MAX_VISIBLE_NODES) {
    return { ...state, limitWarning: "nodes" };
  }
  return { ...state, nodes, edges, limitWarning: null };
}

function reachableNodeIds(
  nodes: WalkSessionState["nodes"],
  edges: WalkSessionState["edges"],
  rootNodeId: string | null,
): Set<string> {
  const reachable = new Set<string>();
  if (!rootNodeId || !nodes[rootNodeId]) return reachable;
  const queue = [rootNodeId];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (reachable.has(currentId) || !nodes[currentId]) continue;
    reachable.add(currentId);
    for (const edge of Object.values(edges)) {
      if (edge.source === currentId && nodes[edge.target] && !reachable.has(edge.target)) {
        queue.push(edge.target);
      }
    }
  }
  return reachable;
}

function retainReachableState(
  state: WalkSessionState,
  candidateNodes: WalkSessionState["nodes"],
  candidateEdges: WalkSessionState["edges"],
): WalkSessionState {
  const reachable = reachableNodeIds(candidateNodes, candidateEdges, state.rootNodeId);
  const nodes = Object.fromEntries(Object.entries(candidateNodes).filter(([id]) => reachable.has(id)));
  const edges = Object.fromEntries(
    Object.entries(candidateEdges).filter(([, edge]) => reachable.has(edge.source) && reachable.has(edge.target)),
  );
  const expansionCache = Object.fromEntries(
    Object.entries(state.expansionCache)
      .filter(([sourceId]) => reachable.has(sourceId))
      .map(([sourceId, candidateIds]) => [sourceId, candidateIds.filter((candidateId) => reachable.has(candidateId))]),
  );
  const expansionCriteria = Object.fromEntries(
    Object.entries(state.expansionCriteria).filter(([sourceId]) => reachable.has(sourceId)),
  );
  return {
    ...state,
    nodes,
    edges,
    visitedOrder: state.visitedOrder.filter((id) => reachable.has(id)),
    expansionCache,
    expansionCriteria,
    focusNodeId: state.focusNodeId && reachable.has(state.focusNodeId) ? state.focusNodeId : state.rootNodeId,
  };
}

export function prepareCandidateReplacement(state: WalkSessionState, sourceId: string): WalkSessionState {
  if (!state.nodes[sourceId]) return state;
  const protectedTargets = new Set(state.visitedOrder);
  const nodesWithChildren = new Set(Object.values(state.edges).map((edge) => edge.source));
  for (const edge of Object.values(state.edges)) {
    const target = state.nodes[edge.target];
    if (target?.expanded || nodesWithChildren.has(edge.target)) {
      protectedTargets.add(edge.target);
    }
  }
  const edges = Object.fromEntries(Object.entries(state.edges).filter(([, edge]) =>
    edge.source !== sourceId || protectedTargets.has(edge.target)
  ));
  return retainReachableState(state, state.nodes, edges);
}

function hideNode(state: WalkSessionState, nodeId: string): WalkSessionState {
  if (!state.nodes[nodeId]) return state;
  const hiddenChunkIds = state.hiddenChunkIds.includes(nodeId) ? state.hiddenChunkIds : [...state.hiddenChunkIds, nodeId];
  if (state.rootNodeId === nodeId) {
    return {
      ...state,
      nodes: {},
      edges: {},
      hiddenChunkIds,
      visitedOrder: [],
      expansionCache: {},
      expansionCriteria: {},
      focusNodeId: null,
      rootNodeId: null,
    };
  }

  const { [nodeId]: _removed, ...remainingNodes } = state.nodes;
  const remainingEdges = Object.fromEntries(
    Object.entries(state.edges).filter(([, edge]) => edge.source !== nodeId && edge.target !== nodeId),
  );
  const retained = retainReachableState(state, remainingNodes, remainingEdges);
  const { nodes } = retained;
  let focusNodeId = retained.focusNodeId;
  if (focusNodeId && nodes[focusNodeId] && nodes[focusNodeId].status !== "focus") {
    nodes[focusNodeId] = { ...nodes[focusNodeId], status: "focus" };
  }
  const visitedOrder = retained.visitedOrder;
  if (focusNodeId && !visitedOrder.includes(focusNodeId)) visitedOrder.push(focusNodeId);
  return {
    ...retained,
    nodes,
    hiddenChunkIds,
    visitedOrder,
    focusNodeId,
  };
}

export function semanticWalkReducer(state: WalkSessionState, action: WalkAction): WalkSessionState {
  switch (action.type) {
    case "add-root":
      return resetWithRoot(state, action.chunk);
    case "expand-candidates":
      return addCandidates(state, action);
    case "focus-node":
      return focusNode(state, action.nodeId);
    case "add-linked-node":
      return addLinkedNode(state, action);
    case "collapse-node": {
      const node = state.nodes[action.nodeId];
      return node ? { ...state, nodes: { ...state.nodes, [node.id]: { ...node, collapsed: true } }, limitWarning: null } : state;
    }
    case "expand-node": {
      const node = state.nodes[action.nodeId];
      return node ? { ...state, nodes: { ...state.nodes, [node.id]: { ...node, collapsed: false } }, limitWarning: null } : state;
    }
    case "hide-node":
      return { ...hideNode(state, action.nodeId), limitWarning: null };
    case "set-candidate-mode":
      return action.mode === state.candidateMode
        ? state
        : { ...state, candidateMode: action.mode };
    case "set-exclude-same-document":
      return action.exclude === state.excludeSameDocument
        ? state
        : { ...state, excludeSameDocument: action.exclude };
    case "reset":
      return createWalkSessionState();
  }
}
