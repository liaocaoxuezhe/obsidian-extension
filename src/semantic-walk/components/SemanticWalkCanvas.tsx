import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../util/i18n";
import { ChunkNodeCard } from "./ChunkNodeCard";
import { ChunkPreviewDialog } from "./ChunkPreviewDialog";
import { WalkToolbar } from "./WalkToolbar";
import type { CandidateMode, WalkEdge, WalkNode } from "../types";
import { selectVisibleGraph } from "../graph-reducer";

export const MIN_CANVAS_ZOOM = 0.4;
export const MAX_CANVAS_ZOOM = 1.8;
export const COMPACT_NODE_ZOOM = 0.6;
export const CANVAS_NODE_WIDTH = 414;
export const CANVAS_NODE_HEIGHT = 276;
export const CANVAS_COMPACT_NODE_HEIGHT = 168;

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface SemanticWalkCanvasProps {
  nodes: Record<string, WalkNode>;
  edges: Record<string, WalkEdge>;
  focusNodeId: string | null;
  rootNodeId: string | null;
  viewport?: Viewport;
  onViewportChange?: (viewport: Viewport) => void;
  onFocusNode: (nodeId: string) => void;
  onExpandNode: (nodeId: string) => void;
  onMoveNode: (nodeId: string, x: number, y: number, positionMode: "manual") => void;
  onOpenDocument?: (nodeId: string) => void;
  onOpenDocumentChunks?: (nodeId: string) => void;
  onHideNode: (nodeId: string) => void;
  candidateMode: CandidateMode;
  excludeSameDocument: boolean;
  onCandidateModeChange: (mode: CandidateMode) => void;
  onExcludeSameDocumentChange: (exclude: boolean) => void;
  className?: string;
}

interface CanvasSize {
  width: number;
  height: number;
}

interface CanvasPoint {
  x: number;
  y: number;
}

interface PanState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startViewportX: number;
  startViewportY: number;
}

interface SemanticEdgePath {
  edge: WalkEdge;
  path: string;
}

const EdgeLayer = React.memo(function EdgeLayer({ paths }: { paths: SemanticEdgePath[] }): JSX.Element {
  return (
    <svg className="semantic-walk-edges" width="1" height="1" aria-hidden="true">
      {paths.map(({ edge, path }) => (
        <path
          key={edge.id}
          d={path}
          className={`semantic-walk-edge is-${edge.relationBand}`}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
});

export function clampCanvasZoom(zoom: number): number {
  return Math.min(MAX_CANVAS_ZOOM, Math.max(MIN_CANVAS_ZOOM, zoom));
}

export function zoomViewportAt(viewport: Viewport, nextZoomInput: number, anchor: CanvasPoint): Viewport {
  const nextZoom = clampCanvasZoom(nextZoomInput);
  const worldX = (anchor.x - viewport.x) / viewport.zoom;
  const worldY = (anchor.y - viewport.y) / viewport.zoom;
  return {
    x: anchor.x - worldX * nextZoom,
    y: anchor.y - worldY * nextZoom,
    zoom: nextZoom,
  };
}

export function centerViewportOnNode(
  node: WalkNode,
  viewport: Viewport,
  size: CanvasSize,
  nodeHeight = CANVAS_NODE_HEIGHT,
): Viewport {
  return {
    x: size.width / 2 - (node.x + CANVAS_NODE_WIDTH / 2) * viewport.zoom,
    y: size.height / 2 - (node.y + nodeHeight / 2) * viewport.zoom,
    zoom: viewport.zoom,
  };
}

export function fitViewportToNodes(nodes: WalkNode[], size: CanvasSize, padding = 72): Viewport {
  if (nodes.length === 0 || size.width <= 0 || size.height <= 0) return { x: 0, y: 0, zoom: 1 };
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + CANVAS_NODE_WIDTH));
  const maxY = Math.max(...nodes.map((node) => node.y + CANVAS_NODE_HEIGHT));
  const contentWidth = Math.max(1, maxX - minX);
  const contentHeight = Math.max(1, maxY - minY);
  const availableWidth = Math.max(1, size.width - padding * 2);
  const availableHeight = Math.max(1, size.height - padding * 2);
  const zoom = clampCanvasZoom(Math.min(availableWidth / contentWidth, availableHeight / contentHeight));
  return {
    x: (size.width - contentWidth * zoom) / 2 - minX * zoom,
    y: (size.height - contentHeight * zoom) / 2 - minY * zoom,
    zoom,
  };
}

export function createSemanticEdgePath(source: WalkNode, target: WalkNode, nodeHeight = CANVAS_NODE_HEIGHT): string {
  const sourceX = source.x + CANVAS_NODE_WIDTH;
  const sourceY = source.y + nodeHeight / 2;
  const targetX = target.x;
  const targetY = target.y + nodeHeight / 2;
  const horizontalDistance = Math.abs(targetX - sourceX);
  const direction = targetX >= sourceX ? 1 : -1;
  const controlOffset = Math.max(56, Math.min(180, horizontalDistance * 0.45));
  return `M ${sourceX} ${sourceY} C ${sourceX + controlOffset * direction} ${sourceY}, ${targetX - controlOffset * direction} ${targetY}, ${targetX} ${targetY}`;
}

export function shouldAutoExpandRoot(node: WalkNode): boolean {
  return !node.expanded
    && !node.collapsed
    && !node.loading
    && node.validity === "valid";
}

export function SemanticWalkCanvas({
  nodes,
  edges,
  focusNodeId,
  rootNodeId,
  viewport: controlledViewport,
  onViewportChange,
  onFocusNode,
  onExpandNode,
  onMoveNode,
  onOpenDocument,
  onOpenDocumentChunks,
  onHideNode,
  candidateMode,
  excludeSameDocument,
  onCandidateModeChange,
  onExcludeSameDocumentChange,
  className = "",
}: SemanticWalkCanvasProps): JSX.Element {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<Viewport>(() => controlledViewport
    ? { ...controlledViewport, zoom: clampCanvasZoom(controlledViewport.zoom) }
    : { x: 0, y: 0, zoom: 1 });
  const viewportRef = useRef(viewport);
  const pendingViewportRef = useRef<Viewport | null>(null);
  const viewportFrameRef = useRef<number | null>(null);
  const panRef = useRef<PanState | null>(null);
  const activatedRootNodeIdRef = useRef<string | null>(null);
  const [centering, setCentering] = useState(false);
  const [preview, setPreview] = useState<{ nodeId: string; trigger: HTMLButtonElement } | null>(null);
  const visibleGraph = useMemo(
    () => selectVisibleGraph({ nodes, edges, rootNodeId }),
    [edges, nodes, rootNodeId],
  );
  const nodeList = useMemo(() => Object.values(visibleGraph.nodes), [visibleGraph.nodes]);
  const previewNode = preview ? visibleGraph.nodes[preview.nodeId] : undefined;

  useEffect(() => {
    if (preview && !previewNode) setPreview(null);
  }, [preview, previewNode]);

  useEffect(() => {
    if (!controlledViewport) return;
    if (viewportFrameRef.current !== null) {
      cancelAnimationFrame(viewportFrameRef.current);
      viewportFrameRef.current = null;
    }
    pendingViewportRef.current = null;
    const next = { ...controlledViewport, zoom: clampCanvasZoom(controlledViewport.zoom) };
    viewportRef.current = next;
    setViewport(next);
  }, [controlledViewport?.x, controlledViewport?.y, controlledViewport?.zoom]);

  useEffect(() => () => {
    if (viewportFrameRef.current !== null) cancelAnimationFrame(viewportFrameRef.current);
  }, []);

  const commitViewport = useCallback((next: Viewport) => {
    viewportRef.current = next;
    setViewport(next);
    onViewportChange?.(next);
  }, [onViewportChange]);

  const scheduleViewport = useCallback((next: Viewport) => {
    pendingViewportRef.current = { ...next, zoom: clampCanvasZoom(next.zoom) };
    if (viewportFrameRef.current !== null) return;
    viewportFrameRef.current = requestAnimationFrame(() => {
      viewportFrameRef.current = null;
      const pending = pendingViewportRef.current;
      pendingViewportRef.current = null;
      if (pending) commitViewport(pending);
    });
  }, [commitViewport]);

  const getCanvasSize = useCallback((): CanvasSize => ({
    width: canvasRef.current?.clientWidth ?? 0,
    height: canvasRef.current?.clientHeight ?? 0,
  }), []);

  const handleWheel = useCallback((event: WheelEvent) => {
    if ((event.target as HTMLElement).closest?.("[data-semantic-walk-preview]")) return;
    event.preventDefault();
    setCentering(false);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const current = pendingViewportRef.current ?? viewportRef.current;
    if (event.ctrlKey || event.metaKey) {
      const bounds = canvas.getBoundingClientRect();
      const anchor = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      const zoomFactor = Math.exp(-event.deltaY * 0.002);
      scheduleViewport(zoomViewportAt(current, current.zoom * zoomFactor, anchor));
      return;
    }
    scheduleViewport({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY });
  }, [scheduleViewport]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  const zoomAtCanvasCenter = useCallback((nextZoom: number) => {
    const size = getCanvasSize();
    const current = pendingViewportRef.current ?? viewportRef.current;
    scheduleViewport(zoomViewportAt(current, nextZoom, { x: size.width / 2, y: size.height / 2 }));
  }, [getCanvasSize, scheduleViewport]);

  const centerFocus = useCallback(() => {
    const focusNode = focusNodeId ? nodes[focusNodeId] : undefined;
    const current = pendingViewportRef.current ?? viewportRef.current;
    const nodeHeight = current.zoom < COMPACT_NODE_ZOOM ? CANVAS_COMPACT_NODE_HEIGHT : CANVAS_NODE_HEIGHT;
    if (focusNode) {
      setCentering(true);
      scheduleViewport(centerViewportOnNode(focusNode, current, getCanvasSize(), nodeHeight));
    }
  }, [focusNodeId, getCanvasSize, nodes, scheduleViewport]);

  const fitContent = useCallback(() => {
    if (nodeList.length > 0) scheduleViewport(fitViewportToNodes(nodeList, getCanvasSize()));
  }, [getCanvasSize, nodeList, scheduleViewport]);

  const compact = viewport.zoom < COMPACT_NODE_ZOOM;
  const edgePaths = useMemo(() => Object.values(visibleGraph.edges).flatMap((edge) => {
    const source = visibleGraph.nodes[edge.source];
    const target = visibleGraph.nodes[edge.target];
    if (!source || !target) return [];
    const nodeHeight = compact ? CANVAS_COMPACT_NODE_HEIGHT : CANVAS_NODE_HEIGHT;
    return [{ edge, path: createSemanticEdgePath(source, target, nodeHeight) }];
  }), [compact, visibleGraph.edges, visibleGraph.nodes]);

  const relationByTarget = useMemo(() => {
    const relation = new Map<string, WalkEdge["relationBand"]>();
    for (const edge of Object.values(visibleGraph.edges)) {
      if (!relation.has(edge.target)) relation.set(edge.target, edge.relationBand);
    }
    return relation;
  }, [visibleGraph.edges]);

  const handleCanvasPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("[data-semantic-walk-node], [data-semantic-walk-toolbar]")) return;
    event.preventDefault();
    setCentering(false);
    event.currentTarget.setPointerCapture(event.pointerId);
    const current = pendingViewportRef.current ?? viewportRef.current;
    panRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startViewportX: current.x,
      startViewportY: current.y,
    };
  };

  const handleCanvasPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.preventDefault();
    scheduleViewport({
      ...viewportRef.current,
      x: pan.startViewportX + event.clientX - pan.startClientX,
      y: pan.startViewportY + event.clientY - pan.startClientY,
    });
  };

  const endCanvasPan = (event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    panRef.current = null;
  };

  const moveNode = useCallback((nodeId: string, x: number, y: number) => {
    onMoveNode(nodeId, x, y, "manual");
  }, [onMoveNode]);

  const viewNode = useCallback((nodeId: string, trigger: HTMLButtonElement) => {
    setPreview({ nodeId, trigger });
  }, []);

  const closePreview = useCallback(() => setPreview(null), []);

  const focusNode = useCallback((nodeId: string) => {
    const node = nodes[nodeId];
    onFocusNode(nodeId);
    const current = pendingViewportRef.current ?? viewportRef.current;
    const nodeHeight = current.zoom < COMPACT_NODE_ZOOM ? CANVAS_COMPACT_NODE_HEIGHT : CANVAS_NODE_HEIGHT;
    if (node) {
      setCentering(true);
      scheduleViewport(centerViewportOnNode(node, current, getCanvasSize(), nodeHeight));
      if (!node.expanded && !node.loading && node.validity === "valid") onExpandNode(nodeId);
    }
  }, [getCanvasSize, nodes, onExpandNode, onFocusNode, scheduleViewport]);

  useEffect(() => {
    if (!rootNodeId) {
      activatedRootNodeIdRef.current = null;
      return;
    }
    if (activatedRootNodeIdRef.current === rootNodeId) return;
    const rootNode = nodes[rootNodeId];
    if (!rootNode) return;
    activatedRootNodeIdRef.current = rootNodeId;

    onFocusNode(rootNodeId);
    const current = pendingViewportRef.current ?? viewportRef.current;
    setCentering(true);
    scheduleViewport(centerViewportOnNode(rootNode, current, getCanvasSize()));
    if (shouldAutoExpandRoot(rootNode)) onExpandNode(rootNodeId);
  }, [getCanvasSize, nodes, onExpandNode, onFocusNode, rootNodeId, scheduleViewport]);

  const canvasClassName = `semantic-walk-canvas ${className}`.trim();

  return (
    <div
      ref={canvasRef}
      className={canvasClassName}
      data-semantic-walk-canvas="true"
      onPointerDown={handleCanvasPointerDown}
      onPointerMove={handleCanvasPointerMove}
      onPointerUp={endCanvasPan}
      onPointerCancel={endCanvasPan}
    >
      <div className="semantic-walk-canvas__atmosphere" aria-hidden="true" />
      <div
        className={`semantic-walk-scene${centering ? " is-centering" : ""}`}
        data-semantic-walk-scene="true"
        data-viewport-zoom={viewport.zoom}
        style={{ transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.zoom})` }}
        onTransitionEnd={() => setCentering(false)}
      >
        <EdgeLayer paths={edgePaths} />
        <div className="semantic-walk-nodes">
          {nodeList.map((node) => (
            <ChunkNodeCard
              key={node.id}
              node={node}
              compact={compact}
              relationBand={relationByTarget.get(node.id)}
              onFocus={focusNode}
              onExpand={onExpandNode}
              onView={viewNode}
              onMove={moveNode}
              onOpenDocument={onOpenDocument}
              onOpenDocumentChunks={onOpenDocumentChunks}
              onHide={onHideNode}
            />
          ))}
        </div>
      </div>

      {preview && previewNode ? (
        <ChunkPreviewDialog node={previewNode} trigger={preview.trigger} onClose={closePreview} />
      ) : null}

      {nodeList.length === 0 ? (
        <div className="semantic-walk-canvas__empty" aria-live="polite">
          <span className="semantic-walk-canvas__empty-mark" aria-hidden="true" />
          <strong>{t("semanticWalk.canvasEmptyTitle")}</strong>
          <span>{t("semanticWalk.canvasEmptyDescription")}</span>
        </div>
      ) : null}

      <WalkToolbar
        zoom={viewport.zoom}
        onZoomOut={() => zoomAtCanvasCenter((pendingViewportRef.current ?? viewportRef.current).zoom - 0.1)}
        onResetZoom={() => zoomAtCanvasCenter(1)}
        onZoomIn={() => zoomAtCanvasCenter((pendingViewportRef.current ?? viewportRef.current).zoom + 0.1)}
        onCenterFocus={centerFocus}
        onFitContent={fitContent}
        canCenterFocus={Boolean(focusNodeId && nodes[focusNodeId])}
        hasContent={nodeList.length > 0}
        candidateMode={candidateMode}
        excludeSameDocument={excludeSameDocument}
        onCandidateModeChange={onCandidateModeChange}
        onExcludeSameDocumentChange={onExcludeSameDocumentChange}
      />

      <div className="semantic-walk-canvas__hint" aria-hidden="true">
        {t("semanticWalk.canvasHint")}
      </div>
    </div>
  );
}
