import React, { memo } from "react";
import { t } from "../../util/i18n";
import type { CandidateMode } from "../types";

export interface WalkToolbarProps {
  zoom: number;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onZoomIn: () => void;
  onCenterFocus: () => void;
  onFitContent: () => void;
  canCenterFocus?: boolean;
  hasContent?: boolean;
  candidateMode: CandidateMode;
  excludeSameDocument: boolean;
  onCandidateModeChange: (mode: CandidateMode) => void;
  onExcludeSameDocumentChange: (exclude: boolean) => void;
}

interface ToolbarButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
}

function ToolbarButton({ label, onClick, disabled, children, className = "" }: ToolbarButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={`semantic-walk-toolbar__button ${className}`.trim()}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export const WalkToolbar = memo(function WalkToolbar({
  zoom,
  onZoomOut,
  onResetZoom,
  onZoomIn,
  onCenterFocus,
  onFitContent,
  canCenterFocus = true,
  hasContent = true,
  candidateMode,
  excludeSameDocument,
  onCandidateModeChange,
  onExcludeSameDocumentChange,
}: WalkToolbarProps): JSX.Element {
  const modes: CandidateMode[] = ["balanced", "pure"];
  return (
    <div className="semantic-walk-toolbar" data-semantic-walk-toolbar="true" role="toolbar" aria-label={t("semanticWalk.toolbar")}>
      <div className="semantic-walk-toolbar__identity" aria-hidden="true">
        <span className="semantic-walk-toolbar__beacon" />
        <span>{t("semanticWalk.localMapName")}</span>
      </div>
      <div className="semantic-walk-toolbar__controls">
        <div className="semantic-walk-toolbar__group" role="group" aria-label={t("semanticWalk.mode.label")}>
          {modes.map((mode) => (
            <button
              key={mode}
              type="button"
              className="semantic-walk-toolbar__mode"
              data-candidate-mode={mode}
              aria-pressed={candidateMode === mode}
              onClick={() => onCandidateModeChange(mode)}
            >
              {t(`semanticWalk.mode.${mode}`)}
            </button>
          ))}
        </div>
        <div className="semantic-walk-toolbar__group" role="group" aria-label={t("semanticWalk.filter.label")}>
          <button
            type="button"
            className="semantic-walk-toolbar__mode"
            data-exclude-same-document={excludeSameDocument}
            aria-pressed={excludeSameDocument}
            onClick={() => onExcludeSameDocumentChange(!excludeSameDocument)}
          >
            {t("semanticWalk.excludeSameDocument")}
          </button>
        </div>
        <div className="semantic-walk-toolbar__group" aria-label={t("semanticWalk.zoom")}>
          <ToolbarButton label={t("semanticWalk.zoomOut")} onClick={onZoomOut} disabled={zoom <= 0.4}>
            <span aria-hidden="true">−</span>
          </ToolbarButton>
          <ToolbarButton label={t("semanticWalk.zoomReset")} onClick={onResetZoom} className="semantic-walk-toolbar__zoom">
            <span aria-hidden="true">{Math.round(zoom * 100)}%</span>
          </ToolbarButton>
          <ToolbarButton label={t("semanticWalk.zoomIn")} onClick={onZoomIn} disabled={zoom >= 1.8}>
            <span aria-hidden="true">+</span>
          </ToolbarButton>
        </div>
        <div className="semantic-walk-toolbar__group" aria-label={t("semanticWalk.positioning")}>
          <ToolbarButton label={t("semanticWalk.centerFocus")} onClick={onCenterFocus} disabled={!canCenterFocus}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.5" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2" /></svg>
          </ToolbarButton>
          <ToolbarButton label={t("semanticWalk.fitContent")} onClick={onFitContent} disabled={!hasContent}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" /></svg>
          </ToolbarButton>
        </div>
      </div>
    </div>
  );
});
