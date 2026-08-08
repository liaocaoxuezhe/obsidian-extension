import React, { useState } from "react";
import { t } from "../../util/i18n";

export interface FreeTextStartDialogProps {
  open: boolean;
  busy?: boolean;
  onClose: () => void;
  onStart: (text: string) => void;
}

export function FreeTextStartDialog({
  open,
  busy = false,
  onClose,
  onStart,
}: FreeTextStartDialogProps): JSX.Element | null {
  const [text, setText] = useState(() => t("semanticWalk.freeText.default"));
  if (!open) return null;
  const trimmed = text.trim();

  return (
    <div
      className="semantic-walk-free-text-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="semantic-walk-free-text-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onClose();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed && !busy) onStart(trimmed);
        }}
      >
        <button
          type="button"
          className="semantic-walk-free-text-dialog__close"
          aria-label={t("semanticWalk.freeText.close")}
          disabled={busy}
          onClick={onClose}
        >
          ×
        </button>
        <h2 id="semantic-walk-free-text-title">{t("semanticWalk.freeText.title")}</h2>
        <textarea
          rows={6}
          value={text}
          disabled={busy}
          aria-label={t("semanticWalk.freeText.title")}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" disabled={busy || !trimmed}>
          {t("semanticWalk.freeText.start")}
        </button>
      </form>
    </div>
  );
}
