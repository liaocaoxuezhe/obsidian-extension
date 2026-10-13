import React, { useState } from "react";
import type { OnboardingError, OnboardingSnapshot } from "../onboarding-types";
import { t } from "../../util/i18n";
import type { EnvironmentFacts } from "../../diagnostics/environment-facts";

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

/** Only "CODE token token" lines built from allowlisted tokens are shown or copied. */
function safeDetail(error: OnboardingError | null | undefined): string | null {
  const value = error?.technicalMessage;
  if (!error || typeof value !== "string" || !value.startsWith(`${error.code} `) || value.length > 160) return null;
  return /^[A-Z][A-Z0-9_]{2,80}(?: [A-Za-z0-9._:-]{1,60}){1,8}$/.test(value) ? value : null;
}

export function createOnboardingDiagnosticText(
  snapshot: Readonly<OnboardingSnapshot>,
  pluginBuildId: string,
  diagnosticEvents: readonly unknown[],
  environment?: EnvironmentFacts | null,
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
  if (error?.subStage) diagnostic.subStage = error.subStage;
  const detail = safeDetail(error);
  if (detail) diagnostic.detail = detail;
  if (environment) diagnostic.environment = environment;
  if (log.length > 0) diagnostic.log = log;
  return JSON.stringify(diagnostic, null, 2);
}

/** Renders https links inside a translated message as clickable anchors. */
function withLinks(text: string): React.ReactNode[] {
  return text.split(/(https:\/\/[^\s，。、；）)]+)/).map((part, index) => (index % 2 === 1
    ? <a key={index} href={part} target="_blank" rel="noopener noreferrer">{part}</a>
    : part));
}

export interface SetupErrorProps {
  error: OnboardingError;
  snapshot: Readonly<OnboardingSnapshot>;
  pluginBuildId: string;
  diagnosticEvents: readonly OnboardingDiagnosticEvent[];
  environmentFacts?: EnvironmentFacts | null;
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
    const text = createOnboardingDiagnosticText(
      props.snapshot, props.pluginBuildId, props.diagnosticEvents, props.environmentFacts,
    );
    void navigator.clipboard.writeText(text).then(() => setCopyState("copied"), () => setCopyState("failed"));
  };

  return <section className="analogy-onboarding-error" aria-labelledby="analogy-onboarding-error-title">
    <div className="analogy-onboarding-error__mark" aria-hidden="true">!</div>
    <div>
      <h2 id="analogy-onboarding-error-title">{t("onboarding.failed.heading")}</h2>
      <p role="alert">{withLinks(t(error.userMessageKey))}</p>
      {error.subStage ? <p className="analogy-onboarding-error__substage">
        {t("onboarding.diagnostics.failedAt", { step: t(`onboarding.subStage.${error.subStage}`) })}
      </p> : null}
    </div>
    <button type="button" className="mod-cta analogy-onboarding__primary" data-primary-action="true" onClick={action}>{t(actionKey)}</button>
    <details className="analogy-onboarding-error__details">
      <summary>{t("onboarding.diagnostics.summary")}</summary>
      <dl>
        <div><dt>{t("onboarding.diagnostics.code")}</dt><dd><code>{error.code}</code></dd></div>
        <div><dt>{t("onboarding.diagnostics.stage")}</dt><dd>{t(`onboarding.stage.${error.stage}`)}</dd></div>
        {error.subStage ? <div><dt>{t("onboarding.diagnostics.subStage")}</dt><dd>{t(`onboarding.subStage.${error.subStage}`)}</dd></div> : null}
        {safeDetail(error)
          ? <div><dt>{t("onboarding.diagnostics.detail")}</dt><dd><code>{safeDetail(error)}</code></dd></div>
          : null}
      </dl>
      <button type="button" onClick={copyDiagnostics}>{t("onboarding.diagnostics.copy")}</button>
      <span className="analogy-onboarding-error__copy-state" aria-live="polite">
        {copyState === "copied" ? t("onboarding.diagnostics.copied") : copyState === "failed" ? t("onboarding.diagnostics.copyFailed") : ""}
      </span>
    </details>
  </section>;
}
