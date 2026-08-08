import React from "react";
import { t } from "../../util/i18n";

export interface WalkEmptyStateProps {
  onChooseNote: () => void;
  onOpenFreeText: () => void;
  onPickRandom: () => void;
  feedback?: string | null;
  busy?: boolean;
  disabledReason?: string | null;
}

export function WalkEmptyState({
  onChooseNote,
  onOpenFreeText,
  onPickRandom,
  feedback,
  busy = false,
  disabledReason,
}: WalkEmptyStateProps): JSX.Element {
  const disabled = busy || Boolean(disabledReason);

  return (
    <section className="semantic-walk-empty" aria-labelledby="semantic-walk-empty-title">
      <span className="semantic-walk-empty__beacon" aria-hidden="true" />
      <p className="semantic-walk-empty__eyebrow">{t("semanticWalk.mapName")}</p>
      <h2 id="semantic-walk-empty-title">{t("semanticWalk.startTitle")}</h2>
      <p className="semantic-walk-empty__description">{t("semanticWalk.startDescription")}</p>
      <div className="semantic-walk-empty__entries">
        <button
          type="button"
          onClick={onChooseNote}
          disabled={disabled}
          title={disabledReason || undefined}
        >
          <strong>{t("semanticWalk.chooseNote")}</strong>
          <span>{t("semanticWalk.chooseNoteDescription")}</span>
        </button>
        <button type="button" onClick={onOpenFreeText} disabled={disabled} title={disabledReason || undefined}>
          <strong>{t("semanticWalk.freeExplore")}</strong>
          <span>{t("semanticWalk.freeExploreDescription")}</span>
        </button>
        <button type="button" onClick={onPickRandom} disabled={disabled} title={disabledReason || undefined}>
          <strong>{t("semanticWalk.random")}</strong>
          <span>{t("semanticWalk.randomDescription")}</span>
        </button>
      </div>
      {feedback ? <p className="semantic-walk-empty__feedback" role="status">{feedback}</p> : null}
    </section>
  );
}
