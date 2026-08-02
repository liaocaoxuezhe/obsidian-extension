import React from "react";
import { t } from "../../util/i18n";

export interface WalkEmptyStateProps {
  currentDocumentPath?: string | null;
  onOpenCurrentDocument: () => void;
  onOpenSearch: () => void;
  onPickRandom: () => void;
  feedback?: string | null;
  busy?: boolean;
  disabledReason?: string | null;
}

export function getDocumentName(documentPath: string): string {
  const fileName = documentPath.split(/[\\/]/).pop() || documentPath;
  return fileName.replace(/\.md$/i, "");
}

export function WalkEmptyState({
  currentDocumentPath,
  onOpenCurrentDocument,
  onOpenSearch,
  onPickRandom,
  feedback,
  busy = false,
  disabledReason,
}: WalkEmptyStateProps): JSX.Element {
  const hasMarkdownDocument = Boolean(currentDocumentPath?.toLowerCase().endsWith(".md"));
  const currentDocumentName = hasMarkdownDocument ? getDocumentName(currentDocumentPath || "") : "";

  return (
    <section className="semantic-walk-empty" aria-labelledby="semantic-walk-empty-title">
      <span className="semantic-walk-empty__beacon" aria-hidden="true" />
      <p className="semantic-walk-empty__eyebrow">{t("semanticWalk.mapName")}</p>
      <h2 id="semantic-walk-empty-title">{t("semanticWalk.startTitle")}</h2>
      <p className="semantic-walk-empty__description">{t("semanticWalk.startDescription")}</p>
      <div className="semantic-walk-empty__entries">
        <button
          type="button"
          onClick={onOpenCurrentDocument}
          disabled={!hasMarkdownDocument || busy || Boolean(disabledReason)}
          title={disabledReason || (hasMarkdownDocument ? t("semanticWalk.currentDocumentTitle").replace("{path}", currentDocumentName) : t("semanticWalk.noMarkdownDocument"))}
        >
          <strong>{t("semanticWalk.currentDocument")}</strong>
          <span>{hasMarkdownDocument ? currentDocumentName : t("semanticWalk.noMarkdownDocument")}</span>
        </button>
        <button type="button" onClick={onOpenSearch} disabled={busy || Boolean(disabledReason)}>
          <strong>{t("semanticWalk.searchChunks")}</strong>
          <span>{t("semanticWalk.searchDescription")}</span>
        </button>
        <button type="button" onClick={onPickRandom} disabled={busy || Boolean(disabledReason)}>
          <strong>{t("semanticWalk.random")}</strong>
          <span>{t("semanticWalk.randomDescription")}</span>
        </button>
      </div>
      {feedback ? <p className="semantic-walk-empty__feedback" role="status">{feedback}</p> : null}
    </section>
  );
}
