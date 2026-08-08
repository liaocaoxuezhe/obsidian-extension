import React, { memo, useEffect, useRef } from "react";
import type { WalkEdge, WalkNode } from "../types";
import { t } from "../../util/i18n";

export interface ChunkNodeCardProps {
  node: WalkNode;
  compact: boolean;
  relationBand?: WalkEdge["relationBand"];
  onFocus: (nodeId: string) => void;
  onExpand: (nodeId: string) => void;
  onView: (nodeId: string, trigger: HTMLButtonElement) => void;
  onMove: (nodeId: string, x: number, y: number) => void;
  onOpenDocument?: (nodeId: string) => void;
  onOpenDocumentChunks?: (nodeId: string) => void;
  onHide: (nodeId: string) => void;
}

const statusLabel = (status: WalkNode["status"]): string => t(`semanticWalk.status.${status}`);
const relationLabel = (band: WalkEdge["relationBand"]): string => t(`semanticWalk.relation.${band}`);

interface DragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startNodeX: number;
  startNodeY: number;
  zoom: number;
  moved: boolean;
}

export const ChunkNodeCard = memo(function ChunkNodeCard({
  node,
  compact,
  relationBand,
  onFocus,
  onExpand,
  onView,
  onMove,
  onOpenDocument,
  onOpenDocumentChunks,
  onHide,
}: ChunkNodeCardProps): JSX.Element {
  const hasSourceDocument = Boolean(node.chunk.path);
  const dragRef = useRef<DragState | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingPositionRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  const flushMove = () => {
    frameRef.current = null;
    const pending = pendingPositionRef.current;
    pendingPositionRef.current = null;
    if (pending) onMove(node.id, pending.x, pending.y);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const scene = event.currentTarget.closest<HTMLElement>("[data-semantic-walk-scene]");
    const transform = scene?.dataset.viewportZoom;
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startNodeX: node.x,
      startNodeY: node.y,
      zoom: Math.max(Number(transform) || 1, 0.01),
      moved: false,
    };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const deltaX = event.clientX - drag.startClientX;
    const deltaY = event.clientY - drag.startClientY;
    if (Math.hypot(deltaX, deltaY) > 4) drag.moved = true;
    if (!drag.moved) return;
    pendingPositionRef.current = {
      x: drag.startNodeX + deltaX / drag.zoom,
      y: drag.startNodeY + deltaY / drag.zoom,
    };
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(flushMove);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      flushMove();
    }
    dragRef.current = null;
    if (!drag.moved) onFocus(node.id);
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      flushMove();
    }
    dragRef.current = null;
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter") {
      event.preventDefault();
      onFocus(node.id);
    } else if (event.key === " " || event.code === "Space") {
      event.preventDefault();
      onExpand(node.id);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      onHide(node.id);
    }
  };

  const cardClassName = [
    "semantic-walk-node",
    `is-${node.status}`,
    node.loading ? "is-loading" : "",
    node.validity !== "valid" ? `is-${node.validity}` : "",
    compact ? "is-compact" : "",
  ].filter(Boolean).join(" ");
  return (
    <article
      className={cardClassName}
      data-semantic-walk-node="true"
      data-position-mode={node.positionMode}
      data-file-validity={node.validity}
      tabIndex={0}
      role="group"
      aria-current={node.status === "focus" ? "true" : undefined}
      aria-label={t("semanticWalk.nodeLabel")
        .replace("{title}", node.chunk.title)
        .replace("{status}", statusLabel(node.status))}
      style={{ transform: `translate3d(${node.x}px, ${node.y}px, 0)` }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onKeyDown={handleKeyDown}
    >
      <header className="semantic-walk-node__header">
        {hasSourceDocument ? (
          <button
            type="button"
            className="semantic-walk-node__source"
            title={t("semanticWalk.viewDocumentChunks").replace("{title}", node.chunk.title)}
            onClick={(event) => {
              event.stopPropagation();
              onOpenDocumentChunks?.(node.id);
            }}
            disabled={!onOpenDocumentChunks}
          >
            <span className="semantic-walk-node__source-mark" aria-hidden="true" />
            <span>{node.chunk.title}</span>
          </button>
        ) : (
          <div className="semantic-walk-node__source semantic-walk-node__source--virtual">
            <span className="semantic-walk-node__source-mark" aria-hidden="true" />
            <span>{node.chunk.title}</span>
          </div>
        )}
      </header>

      <div className="semantic-walk-node__meta">
        <span className="semantic-walk-node__status" data-status={node.status}>{statusLabel(node.status)}</span>
        {relationBand ? <span title={t("semanticWalk.relationHint")}>{relationLabel(relationBand)}</span> : null}
        {node.positionMode === "manual" ? <span>{t("semanticWalk.manualPosition")}</span> : null}
      </div>

      <div
        className="semantic-walk-node__content"
        onDoubleClick={() => {
          if (node.validity === "valid") onOpenDocument?.(node.id);
        }}
      >
        {node.chunk.content}
      </div>

      {node.loading ? (
        <div className="semantic-walk-node__notice" role="status">
          <span className="semantic-walk-node__spinner" aria-hidden="true" />
          {t("semanticWalk.findingRelated")}
        </div>
      ) : null}
      {node.error ? <div className="semantic-walk-node__notice is-error" role="alert">{node.error}</div> : null}
      {node.validity !== "valid" ? (
        <div className="semantic-walk-node__notice is-error" role="status">
          {t(node.validity === "missing" ? "semanticWalk.fileMissing" : "semanticWalk.fileStale")}
        </div>
      ) : null}

      <footer className="semantic-walk-node__actions">
        <button type="button" onClick={() => onExpand(node.id)} disabled={node.loading || node.validity !== "valid"}>
          {node.error
            ? t("semanticWalk.retry")
            : node.expanded
              ? t(node.collapsed ? "semanticWalk.restore" : "semanticWalk.collapse")
              : t("semanticWalk.expand")}
        </button>
        <button type="button" onClick={(event) => onView(node.id, event.currentTarget)}>
          {t("semanticWalk.viewChunk")}
        </button>
        {hasSourceDocument ? (
          <button className="semantic-walk-node__open-source" type="button" onClick={() => onOpenDocument?.(node.id)} disabled={!onOpenDocument || node.validity !== "valid"}>
            {t("semanticWalk.openSource")}
          </button>
        ) : null}
        {hasSourceDocument && node.validity !== "valid" ? (
          <button type="button" onClick={() => onOpenDocumentChunks?.(node.id)} disabled={!onOpenDocumentChunks}>
            {t("semanticWalk.viewNewChunks")}
          </button>
        ) : null}
        <button type="button" onClick={() => onHide(node.id)}>
          {t("semanticWalk.hideNode")}
        </button>
      </footer>
    </article>
  );
});
