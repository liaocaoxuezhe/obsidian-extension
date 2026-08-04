import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  onboardingInstance,
  searchInstance,
  subscribeOnboardingState,
  subscribeServiceState,
  type OnboardingState,
  type ServiceState,
} from "../local-vector/search-instance";
import type { RuntimeAssetKind } from "./runtime-types";
import type {
  RuntimeCleanupResult,
  RuntimeControlSnapshot,
  RuntimeControlSurfaceCapability,
  RuntimeHistoryItem,
} from "./runtime-control-surface";
import { onLocaleChange, t } from "../util/i18n";

const ACTIVE_STAGES = new Set([
  "checking", "downloading-chroma", "verifying-chroma", "installing-chroma",
  "downloading-embedding-runtime", "verifying-embedding-runtime", "installing-embedding-runtime",
  "starting-chroma", "downloading-embedding-model", "warming-up-model",
  "selecting-legacy-index-action", "preparing-legacy-snapshot", "migrating-legacy-index",
  "reconciling-legacy-index", "verifying-legacy-index", "selecting-index-scope", "building-quick-index",
]);

export function isLocalSearchRouteReady(service: ServiceState, onboarding: OnboardingState): boolean {
  return service.status === "ready" && onboarding.snapshot?.stage === "ready";
}

export type RuntimeCapsuleState = "ready" | "preparing" | "degraded" | "attention" | "unconfigured";

export function getRuntimeCapsuleState(service: ServiceState, onboarding: OnboardingState): RuntimeCapsuleState {
  const stage = onboarding.snapshot?.stage ?? "not-started";
  if (stage === "failed" || onboarding.environment?.recommendedAction === "repair" || service.status === "error") {
    return "attention";
  }
  if (ACTIVE_STAGES.has(stage) || service.status === "initializing" || service.status === "stopping"
    || service.embeddingStatus === "downloading") {
    return "preparing";
  }
  if (isLocalSearchRouteReady(service, onboarding)) return "ready";
  if (service.status === "degraded") return "degraded";
  return "unconfigured";
}

function useLocaleVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const unsubscribe = onLocaleChange(() => setVersion((value) => value + 1));
    return () => { unsubscribe(); };
  }, []);
  return version;
}

function useControl(control: RuntimeControlSurfaceCapability | null): RuntimeControlSnapshot | null {
  const [snapshot, setSnapshot] = useState<RuntimeControlSnapshot | null>(() => control?.getSnapshot() ?? null);
  useEffect(() => {
    if (!control) {
      setSnapshot(null);
      return;
    }
    setSnapshot(control.getSnapshot());
    return control.subscribe(setSnapshot);
  }, [control]);
  return snapshot;
}

function statusLabel(value: string): string {
  const key = `runtimeControl.status.${value}`;
  return t(key);
}

function cleanupMessage(result: RuntimeCleanupResult): string {
  return t("runtimeControl.cleanup.result", {
    removed: result.removed,
    failed: result.failed,
    skipped: result.skipped,
  });
}

export function RuntimeStatusCapsule({
  control,
  onOpenDetails,
}: {
  control: RuntimeControlSurfaceCapability | null;
  onOpenDetails: () => void;
}) {
  useLocaleVersion();
  const [onboarding, setOnboarding] = useState<OnboardingState>(() => ({ ...onboardingInstance.state }));
  const [service, setService] = useState<ServiceState>(() => ({ ...searchInstance.state }));
  const clickGuard = useRef(false);
  useEffect(() => subscribeOnboardingState(setOnboarding), []);
  useEffect(() => subscribeServiceState(setService), []);

  const stage = onboarding.snapshot?.stage ?? "not-started";
  const state = getRuntimeCapsuleState(service, onboarding);
  const label = t(`runtimeControl.capsule.${state}`);
  const title = state === "preparing"
    ? t("runtimeControl.capsule.preparingTitle", { stage: t(`onboarding.stage.${stage}`) })
    : t(`runtimeControl.capsule.${state}Title`);
  const open = () => {
    if (clickGuard.current) return;
    clickGuard.current = true;
    try {
      if (state === "ready" || state === "degraded") {
        onOpenDetails();
      } else if (state === "attention") {
        control?.openOnboarding("repair");
      } else {
        control?.openOnboarding("setup");
      }
    } finally {
      queueMicrotask(() => { clickGuard.current = false; });
    }
  };

  return (
    <button
      type="button"
      className="analogy-runtime-capsule"
      data-runtime-state={state}
      aria-label={`${t("runtimeControl.sidebar.label")}: ${label}`}
      title={title}
      onClick={open}
      disabled={!control && state !== "ready" && state !== "degraded"}
    >
      <span className="analogy-runtime-capsule__dot" aria-hidden="true" />
      <span className="analogy-runtime-capsule__label" aria-live="polite">{label}</span>
    </button>
  );
}

export function RuntimeSettingsPanel({ control }: { control: RuntimeControlSurfaceCapability | null }) {
  const localeVersion = useLocaleVersion();
  const snapshot = useControl(control);
  const [onboarding, setOnboarding] = useState<OnboardingState>(() => ({ ...onboardingInstance.state }));
  const [message, setMessage] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const pending = useRef<Promise<unknown> | null>(null);
  const setupActive = ACTIVE_STAGES.has(onboarding.snapshot?.stage ?? "not-started");
  const busy = !control || setupActive || snapshot?.busyAction != null || actionPending;
  const history = snapshot?.history ?? [];
  const migration = snapshot?.legacyMigration;

  useEffect(() => {
    if (!control) return;
    void control.listRuntimeHistory().catch(() => undefined);
  }, [control]);
  useEffect(() => subscribeOnboardingState(setOnboarding), []);

  const run = (operation: () => Promise<unknown>, success?: string) => {
    if (pending.current) return pending.current;
    const promise = operation();
    pending.current = promise;
    setActionPending(true);
    setMessage("");
    void promise.then(
      (value) => {
        if (value && typeof value === "object" && "removed" in value) setMessage(cleanupMessage(value as RuntimeCleanupResult));
        else if (success) setMessage(success);
      },
      (error) => {
        const code = error instanceof Error ? error.message.split(":", 1)[0] : "RUNTIME_ACTION_FAILED";
        setMessage(code === "LEGACY_CLEANUP_UNAVAILABLE"
          ? t("runtimeControl.legacy.unavailable")
          : t("runtimeControl.action.failed"));
      },
    ).finally(() => {
      if (pending.current === promise) {
        pending.current = null;
        setActionPending(false);
      }
    });
    return promise;
  };

  const redownloadAvailable = (kind: RuntimeAssetKind) => kind === "chroma"
    ? snapshot?.environment?.chroma === "missing" || snapshot?.environment?.chroma === "corrupt" || snapshot?.environment?.chroma === "incompatible"
    : snapshot?.environment?.embeddingRuntime === "missing" || snapshot?.environment?.embeddingRuntime === "corrupt";

  const rows = useMemo(() => [
    [t("runtimeControl.platform"), snapshot?.platform ?? t("common.unknown")],
    [t("runtimeControl.chromaRuntime"), snapshot?.chromaRuntimeId ?? t("runtimeControl.notInstalled")],
    [t("runtimeControl.embeddingRuntime"), snapshot?.embeddingRuntimeId ?? t("runtimeControl.notInstalled")],
    [t("runtimeControl.health"), statusLabel(snapshot?.health ?? "unknown")],
    [t("runtimeControl.ownership"), statusLabel(snapshot?.ownership ?? "none")],
    [t("runtimeControl.port"), snapshot?.port == null ? t("common.unknown") : String(snapshot.port)],
    [t("runtimeControl.storage"), t("runtimeControl.storage.deviceLocal")],
    [t("runtimeControl.model"), statusLabel(snapshot?.model ?? "unknown")],
    [t("runtimeControl.index"), statusLabel(snapshot?.index ?? "unknown")],
    [t("runtimeControl.lastAction"), snapshot?.lastAction
      ? t(`runtimeControl.action.${snapshot.lastAction}`)
      : statusLabel("none")],
  ], [snapshot, localeVersion]);

  return (
    <section className="analogy-runtime-panel" aria-labelledby="analogy-runtime-panel-title">
      <header className="analogy-runtime-panel__header">
        <div>
          <div className="analogy-runtime-panel__kicker">{t("runtimeControl.kicker")}</div>
          <h3 id="analogy-runtime-panel-title">{t("runtimeControl.title")}</h3>
        </div>
        <span className="analogy-runtime-panel__state" data-state={snapshot?.health ?? "unknown"}>
          <span aria-hidden="true" />{statusLabel(snapshot?.health ?? "unknown")}
        </span>
      </header>
      <p className="analogy-runtime-panel__intro">{t("runtimeControl.description")}</p>
      <dl className="analogy-runtime-panel__telemetry">
        {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>

      <div className="analogy-runtime-panel__actions" aria-label={t("runtimeControl.actions")}>
        <button type="button" className="analogy-runtime-action analogy-runtime-action--primary" disabled={!control || snapshot?.busyAction != null} onClick={() => control?.openOnboarding(snapshot?.environment?.recommendedAction === "repair" ? "repair" : "setup")}>
          {t("runtimeControl.openSetup")}
        </button>
        <button type="button" className="analogy-runtime-action" disabled={busy} onClick={() => run(() => control!.verifyRuntimes(), t("runtimeControl.verify.done"))}>{t("runtimeControl.verify")}</button>
        <button type="button" className="analogy-runtime-action" disabled={busy || snapshot?.ownership !== "analogy"} onClick={() => run(() => control!.restartOwnedChroma(), t("runtimeControl.restart.done"))}>{t("runtimeControl.restart")}</button>
        <button type="button" className="analogy-runtime-action" disabled={busy} onClick={() => run(() => control!.revealStorageDirectory())}>{t("runtimeControl.reveal")}</button>
        <button type="button" className="analogy-runtime-action" disabled={busy || !redownloadAvailable("chroma")} onClick={() => run(() => control!.redownloadRuntime("chroma"))}>{t("runtimeControl.redownload.chroma")}</button>
        <button type="button" className="analogy-runtime-action" disabled={busy || !redownloadAvailable("embedding-runtime")} onClick={() => run(() => control!.redownloadRuntime("embedding-runtime"))}>{t("runtimeControl.redownload.embedding")}</button>
      </div>
      {message && <p className="analogy-runtime-panel__message" role="status">{message}</p>}

      {migration && migration.status !== "none" ? <section className="analogy-runtime-panel__migration" aria-labelledby="analogy-runtime-migration-title">
        <h4 id="analogy-runtime-migration-title">{t("runtimeControl.migration.title")}</h4>
        <p>{t(`runtimeControl.migration.status.${migration.status}`)}</p>
        {migration.totalRecords !== null ? <p className="analogy-runtime-panel__migration-progress">
          {t("runtimeControl.migration.progress", {
            copied: migration.copiedRecords ?? 0,
            total: migration.totalRecords,
          })}
        </p> : null}
        <div className="analogy-runtime-panel__actions">
          {["preparing", "copying", "reconciling", "verifying"].includes(migration.status)
            ? <button type="button" className="analogy-runtime-action" disabled={busy} onClick={() => run(() => control!.cancelLegacyMigration())}>{t("runtimeControl.migration.cancel")}</button>
            : null}
          {["failed", "cancelled"].includes(migration.status) ? <>
            <button type="button" className="analogy-runtime-action analogy-runtime-action--primary" disabled={busy} onClick={() => run(() => control!.resumeLegacyMigration())}>{t("runtimeControl.migration.resume")}</button>
            <button type="button" className="analogy-runtime-action" disabled={busy} onClick={() => run(() => control!.fallbackLegacyMigrationToRebuild())}>{t("runtimeControl.migration.rebuild")}</button>
            <button type="button" className="analogy-runtime-action" disabled={busy} onClick={() => run(() => control!.discardLegacyMigration())}>{t("runtimeControl.migration.discard")}</button>
          </> : null}
        </div>
      </section> : null}

      <details className="analogy-runtime-panel__details">
        <summary>{t("runtimeControl.history.title", { count: history.length })}</summary>
        <p>{t("runtimeControl.history.description")}</p>
        {history.length > 0 ? (
          <ul>{history.map((item) => <li key={`${item.kind}:${item.runtimeId}`}><span>{item.runtimeId}</span><small>{item.kind === "chroma" ? t("runtimeControl.chromaLabel") : t("runtimeControl.embeddingLabel")}</small></li>)}</ul>
        ) : <p>{t("runtimeControl.history.empty")}</p>}
        <button type="button" className="analogy-runtime-action" disabled={busy || history.length === 0} onClick={() => run(() => control!.cleanRuntimeHistory(history))}>{t("runtimeControl.history.clean")}</button>
      </details>

      <details className="analogy-runtime-panel__details analogy-runtime-panel__details--danger">
        <summary>{t("runtimeControl.legacy.title")}</summary>
        <p>{t(migration?.status === "completed" ? "runtimeControl.legacy.ready" : "runtimeControl.legacy.unavailable")}</p>
        <label htmlFor="analogy-legacy-confirmation">{t("runtimeControl.legacy.confirm", { token: "DELETE LEGACY DATA" })}</label>
        <input id="analogy-legacy-confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} />
        <button type="button" className="analogy-runtime-action analogy-runtime-action--danger" disabled={busy || migration?.status !== "completed" || confirmation !== "DELETE LEGACY DATA"} onClick={() => run(() => control!.cleanLegacyChromaData(confirmation))}>{t("runtimeControl.legacy.clean")}</button>
      </details>
    </section>
  );
}
