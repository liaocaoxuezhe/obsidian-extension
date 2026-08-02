import React, { useEffect, useId, useRef } from "react";
import { t } from "../../util/i18n";
import type { WalkNode } from "../types";

export interface ChunkPreviewDialogProps {
  node: WalkNode;
  trigger: HTMLButtonElement | null;
  onClose: () => void;
}

export function ChunkPreviewDialog({ node, trigger, onClose }: ChunkPreviewDialogProps): JSX.Element {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const sectionLabel = node.chunk.sectionLabel.trim();

  useEffect(() => {
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (trigger?.isConnected) trigger.focus();
    };
  }, [onClose, trigger]);

  return (
    <div
      className="semantic-walk-preview"
      data-semantic-walk-preview="true"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="semantic-walk-preview__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="semantic-walk-preview__header">
          <h2 id={titleId}>{node.chunk.title}</h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="semantic-walk-preview__close"
            aria-label={t("semanticWalk.preview.close")}
            title={t("semanticWalk.preview.close")}
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        {sectionLabel ? <div className="semantic-walk-preview__section">{sectionLabel}</div> : null}
        <div className="semantic-walk-preview__content">{node.chunk.content}</div>
      </section>
    </div>
  );
}
