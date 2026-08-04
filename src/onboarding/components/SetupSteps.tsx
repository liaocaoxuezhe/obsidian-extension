import React from "react";
import type { OnboardingSnapshot, OnboardingStage } from "../onboarding-types";
import { t } from "../../util/i18n";

const ROUTE_STAGES: ReadonlyArray<ReadonlyArray<OnboardingStage>> = [
  ["checking", "awaiting-consent"],
  ["downloading-chroma", "verifying-chroma", "installing-chroma", "downloading-embedding-runtime", "verifying-embedding-runtime", "installing-embedding-runtime"],
  ["starting-chroma", "downloading-embedding-model", "warming-up-model"],
  ["selecting-legacy-index-action", "preparing-legacy-snapshot", "migrating-legacy-index", "reconciling-legacy-index", "verifying-legacy-index", "selecting-index-scope", "building-quick-index"],
];

const ROUTE_LABEL_KEYS = [
  "onboarding.step.check", "onboarding.step.runtimes", "onboarding.step.services", "onboarding.step.index",
] as const;

function routePosition(stage: OnboardingStage): number {
  if (stage === "ready") return ROUTE_STAGES.length;
  if (stage === "failed" || stage === "cancelled" || stage === "not-started") return 0;
  return Math.max(0, ROUTE_STAGES.findIndex((stages) => stages.includes(stage)));
}

function visibleBasename(value: string): string {
  const withoutQuery = value.split(/[?#]/, 1)[0].replace(/\\/g, "/");
  const name = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1).trim();
  return name.slice(0, 160);
}

function decimalMegabytes(value: number): string {
  return t("onboarding.progress.megabytes", { value: (value / 1_000_000).toFixed(1) });
}

export interface SetupStepsProps {
  snapshot: Readonly<OnboardingSnapshot>;
  speedBytesPerSecond: number | null;
}

export function SetupSteps({ snapshot, speedBytesPerSecond }: SetupStepsProps): React.ReactElement {
  const position = routePosition(snapshot.stage);
  const determinate = snapshot.progress !== null && Number.isFinite(snapshot.progress);
  const progress = determinate ? Math.max(0, Math.min(100, snapshot.progress as number)) : null;
  const currentItem = visibleBasename(snapshot.currentItem);
  const hasBytes = snapshot.completedBytes !== null && snapshot.totalBytes !== null;

  return <section className="analogy-onboarding__route" aria-label={t("onboarding.steps.label")}>
    <ol className="analogy-onboarding-steps">
      {ROUTE_LABEL_KEYS.map((labelKey, index) => {
        const state = position > index || snapshot.stage === "ready" ? "complete" : position === index ? "current" : "pending";
        return <li className="analogy-onboarding-step" data-state={state} key={labelKey}>
          <span className="analogy-onboarding-step__lamp" aria-hidden="true">{state === "complete" ? "✓" : index + 1}</span>
          <span className="analogy-onboarding-step__copy">
            <span>{t(labelKey)}</span>
            <span className="analogy-onboarding-step__status">{t(`onboarding.stepStatus.${state}`)}</span>
          </span>
        </li>;
      })}
    </ol>
    <div className="analogy-onboarding-progress">
      <div
        className={`analogy-onboarding-progress__track${determinate ? "" : " is-indeterminate"}`}
        role="progressbar"
        aria-label={determinate ? t("onboarding.progress.label") : t("onboarding.progress.indeterminateLabel")}
        aria-valuemin={determinate ? 0 : undefined}
        aria-valuemax={determinate ? 100 : undefined}
        aria-valuenow={progress ?? undefined}
      >
        <span className="analogy-onboarding-progress__fill" style={determinate ? { width: `${progress}%` } : undefined} />
      </div>
      <div className="analogy-onboarding-progress__telemetry" aria-hidden="true">
        <span>{determinate ? t("onboarding.progress.percent", { percent: Math.round(progress as number) }) : t("onboarding.progress.unknown")}</span>
        <span>{hasBytes
          ? t("onboarding.progress.bytes", { completed: decimalMegabytes(snapshot.completedBytes as number), total: decimalMegabytes(snapshot.totalBytes as number) })
          : t("onboarding.progress.sizeUnknown")}</span>
        <span>{speedBytesPerSecond === null
          ? t("onboarding.progress.speedUnknown")
          : t("onboarding.progress.speed", { speed: decimalMegabytes(speedBytesPerSecond) })}</span>
      </div>
      {currentItem ? <p className="analogy-onboarding-progress__item">{t("onboarding.progress.currentItem", { item: currentItem })}</p> : null}
    </div>
  </section>;
}
