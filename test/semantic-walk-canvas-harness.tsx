import React, { useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { SemanticWalkCanvas, type Viewport } from "../src/semantic-walk/components/SemanticWalkCanvas";
import type { WalkEdge, WalkNode, WalkSessionState } from "../src/semantic-walk/types";
export { setLocale } from "../src/util/i18n";

export {
  CANVAS_COMPACT_NODE_HEIGHT,
  CANVAS_NODE_HEIGHT,
  CANVAS_NODE_WIDTH,
  centerViewportOnNode,
  clampCanvasZoom,
  createSemanticEdgePath,
  fitViewportToNodes,
  zoomViewportAt,
} from "../src/semantic-walk/components/SemanticWalkCanvas";

export interface CanvasHarnessProps {
  initialState?: WalkSessionState;
}

function createNode(index: number): WalkNode {
  const column = index % 10;
  const row = Math.floor(index / 10);
  const id = `harness-note-${index % 18}::chunk-${index}`;
  const isError = index > 0 && index % 29 === 0;

  return {
    id,
    chunk: {
      chunkId: id,
      docId: `harness-note-${index % 18}`,
      path: `Harness/来源笔记 ${index % 18}.md`,
      title: `来源笔记 ${index % 18}`,
      content: `这是用于静态画布校验的第 ${index + 1} 个 chunk。内容只存在于 harness，不连接 Chroma，可用于观察密集节点下的平移、缩放和状态层级。`,
      chunkIndex: index,
      chunkCount: 100,
      sectionLabel: `语义航图 / 分支 ${column + 1}`,
      distance: (index % 20) / 20,
    },
    x: column * 570,
    y: row * 312 + (column % 2) * 96,
    depth: column,
    status: isError ? "error" : index === 0 ? "focus" : index < 15 ? "visited" : "candidate",
    positionMode: "auto",
    expanded: index < 20,
    collapsed: false,
    loading: !isError && index > 0 && index % 17 === 0,
    error: isError ? "静态错误状态：来源 chunk 已失效" : undefined,
    validity: "valid",
  };
}

function createEdge(source: WalkNode, target: WalkNode, index: number): WalkEdge {
  return {
    id: `${source.id}->${target.id}#${index}`,
    source: source.id,
    target: target.id,
    distance: (index % 20) / 20,
    relationBand: index % 4 === 0 ? "strong" : index % 4 === 3 ? "exploratory" : "related",
    createdAt: index,
  };
}

export function createCanvasHarnessState(nodeCount = 100, edgeCount = 200): WalkSessionState {
  const safeNodeCount = Math.max(1, nodeCount);
  const nodes = Array.from({ length: safeNodeCount }, (_, index) => createNode(index));
  const edges = Array.from({ length: Math.max(0, edgeCount) }, (_, index) => {
    const source = nodes[index % nodes.length];
    const targetOffset = 1 + Math.floor(index / nodes.length);
    const target = nodes[(index + targetOffset) % nodes.length];
    return createEdge(source, target, index);
  });

  return {
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    edges: Object.fromEntries(edges.map((edge) => [edge.id, edge])),
    focusNodeId: nodes[0].id,
    rootNodeId: nodes[0].id,
    visitedOrder: nodes.slice(0, Math.min(15, nodes.length)).map((node) => node.id),
    hiddenChunkIds: [],
    expansionCache: {},
    expansionCriteria: {},
    viewport: { x: 80, y: 80, zoom: 0.6 },
    candidateMode: "balanced",
    excludeSameDocument: false,
    limitWarning: null,
  };
}

/**
 * 手工 story：可从浏览器入口渲染本组件，也可通过 initialState 注入任意纯静态图。
 * 默认数据固定为 100 节点 / 200 边，不会实例化 repository 或 Chroma 客户端。
 */
export function SemanticWalkCanvasHarness({ initialState = createCanvasHarnessState() }: CanvasHarnessProps): JSX.Element {
  const [nodes, setNodes] = useState(initialState.nodes);
  const [focusNodeId, setFocusNodeId] = useState(initialState.focusNodeId);
  const [viewport, setViewport] = useState<Viewport>(initialState.viewport);
  const [expandCount, setExpandCount] = useState(0);
  const edges = useMemo(() => initialState.edges, [initialState.edges]);
  const handleExpandNode = useCallback((nodeId: string) => {
    setExpandCount((count) => count + 1);
    setNodes((current) => ({
      ...current,
      [nodeId]: { ...current[nodeId], expanded: true, collapsed: false },
    }));
  }, []);
  const handleFocusNode = useCallback((nodeId: string) => {
    setFocusNodeId(nodeId);
    setNodes((current) => Object.fromEntries(Object.entries(current).map(([id, node]) => [
      id,
      id === nodeId
        ? { ...node, status: "focus" }
        : node.status === "focus"
          ? { ...node, status: "visited" }
          : node,
    ])));
  }, []);
  const handleHideNode = useCallback(() => undefined, []);
  const handleCandidateModeChange = useCallback(() => undefined, []);
  const handleExcludeSameDocumentChange = useCallback(() => undefined, []);
  const handleMoveNode = useCallback((nodeId: string, x: number, y: number) => {
    setNodes((current) => ({
      ...current,
      [nodeId]: { ...current[nodeId], x, y, positionMode: "manual" },
    }));
  }, []);

  return (
    <div style={{ width: "100%", height: "720px" }}>
      <button
        type="button"
        data-test-controlled-viewport="true"
        style={{ position: "absolute", zIndex: 1000 }}
        onClick={() => setViewport({ x: 321, y: 123, zoom: 1.2 })}
      >
        controlled viewport
      </button>
      <output data-test-expand-count="true" style={{ position: "absolute" }}>{expandCount}</output>
      <SemanticWalkCanvas
        nodes={nodes}
        edges={edges}
        focusNodeId={focusNodeId}
        rootNodeId={initialState.rootNodeId}
        viewport={viewport}
        onViewportChange={setViewport}
        onFocusNode={handleFocusNode}
        onExpandNode={handleExpandNode}
        onMoveNode={handleMoveNode}
        onHideNode={handleHideNode}
        candidateMode={initialState.candidateMode}
        excludeSameDocument={initialState.excludeSameDocument}
        onCandidateModeChange={handleCandidateModeChange}
        onExcludeSameDocumentChange={handleExcludeSameDocumentChange}
      />
    </div>
  );
}

export function mountSemanticWalkCanvasHarness(container: HTMLElement, initialState?: WalkSessionState): () => void {
  const root = createRoot(container);
  root.render(<SemanticWalkCanvasHarness initialState={initialState} />);
  return () => root.unmount();
}
