import React, { useState } from "react";
import type { OnboardingError, OnboardingSnapshot } from "../onboarding-types";
import { t } from "../../util/i18n";

const MAX_DIAGNOSTIC_EVENTS = 20;
export const SAFE_ONBOARDING_DIAGNOSTIC_EVENT_CODES = [
  "STAGE_STARTED",
  "RUNTIME_VERIFIED",
  "RUNTIME_INSTALLED",
  "CHROMA_READY",
  "EMBEDDING_READY",
  "QUICK_INDEX_COMPLETED",
  "OPERATION_CANCELLED",
] as const;
export type SafeOnboardingDiagnosticEventCode = typeof SAFE_ONBOARDING_DIAGNOSTIC_EVENT_CODES[number];
const SAFE_ONBOARDING_DIAGNOSTIC_EVENT_CODE_SET: ReadonlySet<string> = new Set(SAFE_ONBOARDING_DIAGNOSTIC_EVENT_CODES);

const SAFE_ONBOARDING_DIAGNOSTIC_ASSETS = ["chroma", "embedding-runtime", "embedding-model", "quick-index"] as const;
type SafeOnboardingDiagnosticAsset = typeof SAFE_ONBOARDING_DIAGNOSTIC_ASSETS[number];
const SAFE_ONBOARDING_DIAGNOSTIC_ASSET_SET: ReadonlySet<string> = new Set(SAFE_ONBOARDING_DIAGNOSTIC_ASSETS);

const SAFE_ONBOARDING_DIAGNOSTIC_OUTCOMES = ["started", "retrying", "failed", "cancelled", "complete"] as const;
type SafeOnboardingDiagnosticOutcome = typeof SAFE_ONBOARDING_DIAGNOSTIC_OUTCOMES[number];
const SAFE_ONBOARDING_DIAGNOSTIC_OUTCOME_SET: ReadonlySet<string> = new Set(SAFE_ONBOARDING_DIAGNOSTIC_OUTCOMES);

export interface OnboardingDiagnosticEvent {
  code: SafeOnboardingDiagnosticEventCode;
  asset?: SafeOnboardingDiagnosticAsset;
  outcome?: SafeOnboardingDiagnosticOutcome;
  attempt?: number;
}

function safeIdentifier(value: string | null): string | null {
  if (!value) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,159}$/.test(value) ? value : null;
}

function safeDiagnosticEvent(value: unknown): OnboardingDiagnosticEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.code !== "string" || !SAFE_ONBOARDING_DIAGNOSTIC_EVENT_CODE_SET.has(candidate.code)) return null;
  const event: OnboardingDiagnosticEvent = { code: candidate.code as SafeOnboardingDiagnosticEventCode };
  if (typeof candidate.asset === "string" && SAFE_ONBOARDING_DIAGNOSTIC_ASSET_SET.has(candidate.asset)) {
    event.asset = candidate.asset as OnboardingDiagnosticEvent["asset"];
  }
  if (typeof candidate.outcome === "string" && SAFE_ONBOARDING_DIAGNOSTIC_OUTCOME_SET.has(candidate.outcome)) {
    event.outcome = candidate.outcome as OnboardingDiagnosticEvent["outcome"];
  }
  if (typeof candidate.attempt === "number" && Number.isSafeInteger(candidate.attempt)
    && candidate.attempt >= 0 && candidate.attempt <= 100) {
    event.attempt = candidate.attempt;
  }
  return event;
}

export function createOnboardingDiagnosticText(
  snapshot: Readonly<OnboardingSnapshot>,
  pluginBuildId: string,
  diagnosticEvents: readonly unknown[],
): string {
  const error = snapshot.error;
  const log = diagnosticEvents.slice(-MAX_DIAGNOSTIC_EVENTS)
    .map(safeDiagnosticEvent)
    .filter((event): event is OnboardingDiagnosticEvent => event !== null);
  const diagnostic: Record<string, unknown> = {
    code: error?.code ?? null,
    stage: error?.stage ?? snapshot.stage,
    platform: snapshot.runtimePlatform,
    chromaRuntimeId: safeIdentifier(snapshot.chromaRuntimeId),
    embeddingRuntimeId: safeIdentifier(snapshot.embeddingRuntimeId),
    pluginBuildId: safeIdentifier(pluginBuildId),
  };
  if (log.length > 0) diagnostic.log = log;
  return JSON.stringify(diagnostic, null, 2);
}

export interface SetupErrorProps {
  error: OnboardingError;
  snapshot: Readonly<OnboardingSnapshot>;
  pluginBuildId: string;
  diagnosticEvents: readonly OnboardingDiagnosticEvent[];
  onRetry(): void;
  onChangePort(): void;
  onOpenHelp(): void;
  onClose(): void;
}

export function SetupError(props: SetupErrorProps): React.ReactElement {
  const { error } = props;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const action = () => {
    if (error.action === "retry" || error.action === "redownload") props.onRetry();
    else if (error.action === "change-port") props.onChangePort();
    else if (error.action === "open-help") props.onOpenHelp();
    else props.onClose();
  };
  const actionKey = `onboarding.errorAction.${error.action}`;
  const copyDiagnostics = () => {
    const text = createOnboardingDiagnosticText(props.snapshot, props.pluginBuildId, props.diagnosticEvents);
    void navigator.clipboard.writeText(text).then(() => setCopyState("copied"), () => setCopyState("failed"));
  };

  return <section className="analogy-onboarding-error" aria-labelledby="analogy-onboarding-error-title">
    <div className="analogy-onboarding-error__mark" aria-hidden="true">!</div>
    <div>
      <h2 id="analogy-onboarding-error-title">{t("onboarding.failed.heading")}</h2>
      <p role="alert">{t(error.userMessageKey)}</p>
    </div>
    <button type="button" className="mod-cta analogy-onboarding__primary" data-primary-action="true" onClick={action}>{t(actionKey)}</button>
    <details className="analogy-onboarding-error__details">
      <summary>{t("onboarding.diagnostics.summary")}</summary>
      <dl>
        <div><dt>{t("onboarding.diagnostics.code")}</dt><dd><code>{error.code}</code></dd></div>
        <div><dt>{t("onboarding.diagnostics.stage")}</dt><dd>{t(`onboarding.stage.${error.stage}`)}</dd></div>
      </dl>
      <button type="button" onClick={copyDiagnostics}>{t("onboarding.diagnostics.copy")}</button>
      <span className="analogy-onboarding-error__copy-state" aria-live="polite">
        {copyState === "copied" ? t("onboarding.diagnostics.copied") : copyState === "failed" ? t("onboarding.diagnostics.copyFailed") : ""}
      </span>
    </details>
  </section>;
}
