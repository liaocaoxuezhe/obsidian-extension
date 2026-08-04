import React, { useEffect, useRef, useState } from "react";
import type { LegacyIndexChoice, OnboardingSnapshot, QuickIndexScope } from "./onboarding-types";
import { SetupSteps } from "./components/SetupSteps";
import { SetupError, type OnboardingDiagnosticEvent } from "./components/SetupError";
import { onLocaleChange, t } from "../util/i18n";

export type OnboardingMode = "setup" | "repair";

export interface OnboardingViewCoordinator {
  getSnapshot(): Readonly<OnboardingSnapshot>;
  subscribe(listener: (snapshot: Readonly<OnboardingSnapshot>) => void): () => void;
  provideConsent(accepted: boolean): Promise<boolean>;
  selectLegacyIndexAction(choice: LegacyIndexChoice): Promise<boolean>;
  selectIndexScope(scope: QuickIndexScope): Promise<boolean>;
  retry(): Promise<Readonly<OnboardingSnapshot>>;
  cancel(): Promise<void>;
}

export interface OnboardingViewProps {
  coordinator: OnboardingViewCoordinator;
  mode: OnboardingMode;
  onClose(): void;
  onStartSearching(): void;
  onOpenOllama(): void;
  onOpenHelp(): void;
  onChangePort(): void;
  pluginBuildId: string;
  diagnosticEvents?: readonly OnboardingDiagnosticEvent[];
}

const INSTALL_STAGES = new Set([
  "checking", "downloading-chroma", "verifying-chroma", "installing-chroma",
  "downloading-embedding-runtime", "verifying-embedding-runtime", "installing-embedding-runtime",
  "starting-chroma", "downloading-embedding-model", "warming-up-model", "building-quick-index",
  "preparing-legacy-snapshot", "migrating-legacy-index", "reconciling-legacy-index", "verifying-legacy-index",
]);

function validFolderPath(value: string): boolean {
  const path = value.trim().replace(/\\/g, "/");
  return Boolean(path) && path.length <= 1024 && !path.startsWith("/") && !/^[A-Za-z]:\//.test(path)
    && !path.includes("\0") && path.split("/").every((part) => Boolean(part) && part !== "." && part !== "..");
}

function useTransferSpeed(snapshot: Readonly<OnboardingSnapshot>): number | null {
  const previous = useRef<{ bytes: number; time: number; speed: number | null } | null>(null);
  const [speed, setSpeed] = useState<number | null>(null);
  useEffect(() => {
    if (snapshot.completedBytes === null) { previous.current = null; setSpeed(null); return; }
    const current = { bytes: snapshot.completedBytes, time: snapshot.updatedAt, speed: previous.current?.speed ?? null };
    const old = previous.current;
    if (old && current.time > old.time && current.bytes >= old.bytes) {
      const raw = Math.min(10_000_000_000, Math.max(0, (current.bytes - old.bytes) / ((current.time - old.time) / 1000)));
      current.speed = old.speed === null ? raw : old.speed * 0.7 + raw * 0.3;
      setSpeed(current.speed);
    }
    previous.current = current;
  }, [snapshot.completedBytes, snapshot.updatedAt, snapshot.stage]);
  return speed;
}

function ScopeSelection({ coordinator }: { coordinator: OnboardingViewCoordinator }): React.ReactElement {
  const [scope, setScope] = useState<"recent" | "folder" | "vault">("recent");
  const [folder, setFolder] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const locked = useRef(false);
  const submit = () => {
    if (locked.current) return;
    let selected: QuickIndexScope;
    if (scope === "folder") {
      if (!validFolderPath(folder)) { setError(t("onboarding.scope.folderError")); return; }
      selected = { type: "folder", path: folder.trim().replace(/\\/g, "/") };
    } else if (scope === "vault") selected = { type: "vault" };
    else selected = { type: "recent", limit: 30 };
    locked.current = true;
    setSubmitting(true);
    void coordinator.selectIndexScope(selected).then((accepted) => {
      if (!accepted) { locked.current = false; setSubmitting(false); setError(t("onboarding.scope.unavailable")); }
    }, () => { locked.current = false; setSubmitting(false); setError(t("onboarding.scope.unavailable")); });
  };
  const choose = (value: "recent" | "folder" | "vault") => { setScope(value); setError(""); };
  return <section className="analogy-onboarding-scope" aria-labelledby="analogy-onboarding-scope-title">
    <p className="analogy-onboarding__eyebrow">{t("onboarding.scope.eyebrow")}</p>
    <h2 id="analogy-onboarding-scope-title">{t("onboarding.scope.heading")}</h2>
    <p>{t("onboarding.scope.description")}</p>
    <fieldset>
      <legend>{t("onboarding.scope.legend")}</legend>
      {(["recent", "folder", "vault"] as const).map((value) => <label className="analogy-onboarding-scope__option" key={value}>
        <input type="radio" name="onboarding-scope" value={value} checked={scope === value} onChange={() => choose(value)} />
        <span><strong>{t(`onboarding.scope.${value}.title`)}</strong><small>{t(`onboarding.scope.${value}.description`)}</small></span>
      </label>)}
      {scope === "folder" ? <label className="analogy-onboarding-scope__folder">
        <span>{t("onboarding.scope.folder.label")}</span>
        <input name="onboarding-folder" value={folder} onChange={(event) => { setFolder(event.target.value); setError(""); }} placeholder={t("onboarding.scope.folder.placeholder")} aria-describedby="onboarding-folder-hint" />
        <small id="onboarding-folder-hint">{t("onboarding.scope.folder.hint")}</small>
      </label> : null}
    </fieldset>
    {error ? <p className="analogy-onboarding-scope__error" role="alert">{error}</p> : null}
    <button type="button" className="mod-cta analogy-onboarding__primary" data-primary-action="true" disabled={submitting} onClick={submit}>{submitting ? t("onboarding.scope.starting") : t("onboarding.scope.start")}</button>
  </section>;
}

function LegacyIndexSelection({ coordinator, snapshot }: {
  coordinator: OnboardingViewCoordinator;
  snapshot: Readonly<OnboardingSnapshot>;
}): React.ReactElement {
  const locked = useRef(false);
  const [submitting, setSubmitting] = useState<LegacyIndexChoice | null>(null);
  const [error, setError] = useState("");
  const choose = (choice: LegacyIndexChoice) => {
    if (locked.current) return;
    locked.current = true;
    setSubmitting(choice);
    setError("");
    void coordinator.selectLegacyIndexAction(choice).then((accepted) => {
      if (!accepted) {
        locked.current = false;
        setSubmitting(null);
        setError(t("onboarding.legacy.unavailable"));
      }
    }, () => {
      locked.current = false;
      setSubmitting(null);
      setError(t("onboarding.legacy.unavailable"));
    });
  };
  const records = snapshot.legacyRecordsTotal === null
    ? t("onboarding.legacy.recordsUnknown")
    : t("onboarding.legacy.records", { count: new Intl.NumberFormat().format(snapshot.legacyRecordsTotal) });
  const storage = snapshot.legacySourceBytes === null
    ? t("onboarding.legacy.storageUnknown")
    : t("onboarding.legacy.storage", { size: `${(snapshot.legacySourceBytes / 1_000_000).toFixed(1)} MB` });
  return <section className="analogy-onboarding-legacy" aria-labelledby="analogy-onboarding-legacy-title">
    <p className="analogy-onboarding__eyebrow">{t("onboarding.legacy.eyebrow")}</p>
    <h2 id="analogy-onboarding-legacy-title">{t("onboarding.legacy.heading")}</h2>
    <p>{t("onboarding.legacy.description")}</p>
    <p className="analogy-onboarding-legacy__estimate">{records}<span aria-hidden="true"> · </span>{storage}</p>
    <div className="analogy-onboarding-legacy__actions">
      <div className="analogy-onboarding-legacy__option">
        <button type="button" className="mod-cta analogy-onboarding-legacy__choice" data-primary-action="true" disabled={submitting !== null} onClick={() => choose("reuse")}>{t("onboarding.legacy.reuse.title")}</button>
        <small>{t("onboarding.legacy.reuse.description")}</small>
      </div>
      <div className="analogy-onboarding-legacy__option">
        <button type="button" className="analogy-onboarding-legacy__choice" disabled={submitting !== null} onClick={() => choose("rebuild")}>{t("onboarding.legacy.rebuild.title")}</button>
        <small>{t("onboarding.legacy.rebuild.description")}</small>
      </div>
      <button type="button" className="analogy-onboarding-legacy__later" disabled={submitting !== null} onClick={() => choose("later")}>{t("onboarding.legacy.later")}</button>
    </div>
    {error ? <p className="analogy-onboarding-scope__error" role="alert">{error}</p> : null}
  </section>;
}

export function OnboardingView(props: OnboardingViewProps): React.ReactElement {
  const [snapshot, setSnapshot] = useState(() => props.coordinator.getSnapshot());
  const [, renderLocale] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const speed = useTransferSpeed(snapshot);
  useEffect(() => {
    let mounted = true;
    const unsubscribe = props.coordinator.subscribe((value) => { if (mounted) setSnapshot(value); });
    setSnapshot(props.coordinator.getSnapshot());
    return () => { mounted = false; unsubscribe(); };
  }, [props.coordinator]);
  useEffect(() => onLocaleChange(() => renderLocale((value) => value + 1)), []);
  useEffect(() => { heading.current?.focus(); }, [snapshot.stage, props.mode]);
  const retry = () => { void props.coordinator.retry().catch(() => undefined); };
  const later = () => { void props.coordinator.provideConsent(false).then(() => props.onClose(), () => undefined); };
  const consent = () => { void props.coordinator.provideConsent(true).catch(() => undefined); };
  const cancel = () => { void props.coordinator.cancel().catch(() => undefined); };
  const isWelcome = snapshot.stage === "not-started" || snapshot.stage === "awaiting-consent" || snapshot.stage === "cancelled";
  const titleKey = props.mode === "repair" ? "onboarding.repair.title" : isWelcome ? "onboarding.welcome.title" : "onboarding.install.title";

  return <main className="analogy-onboarding" data-state={props.mode === "repair" ? "repair" : snapshot.stage}>
    <button type="button" className="analogy-onboarding__close" aria-label={t("onboarding.close")} onClick={props.onClose}>{t("onboarding.close")}</button>
    <header className="analogy-onboarding__header">
      <p className="analogy-onboarding__kicker">{t(props.mode === "repair" ? "onboarding.repair.kicker" : "onboarding.kicker")}</p>
      <h1 ref={heading} tabIndex={-1}>{t(titleKey)}</h1>
      <p className="analogy-onboarding__lede">{t(props.mode === "repair" ? "onboarding.repair.description" : isWelcome ? "onboarding.welcome.description" : "onboarding.install.description")}</p>
    </header>

    {isWelcome ? <section className="analogy-onboarding-welcome">
      <ul>
        <li>{t("onboarding.welcome.local")}</li>
        <li>{t("onboarding.welcome.download")}</li>
        <li>{t("onboarding.welcome.storage")}</li>
      </ul>
      <div className="analogy-onboarding__actions">
        <button type="button" className="mod-cta analogy-onboarding__primary" data-primary-action="true" onClick={consent}>{t("onboarding.welcome.accept")}</button>
        <button type="button" onClick={later}>{t("onboarding.welcome.later")}</button>
      </div>
    </section> : null}

    {INSTALL_STAGES.has(snapshot.stage) ? <section>
      <p className="analogy-onboarding__stage" aria-live="polite" aria-atomic="true">{t(`onboarding.stage.${snapshot.stage}`)}</p>
      <SetupSteps snapshot={snapshot} speedBytesPerSecond={speed} />
      <button type="button" className="analogy-onboarding__cancel" onClick={cancel}>{t("onboarding.install.cancel")}</button>
    </section> : null}

    {snapshot.stage === "selecting-index-scope" ? <ScopeSelection coordinator={props.coordinator} /> : null}
    {snapshot.stage === "selecting-legacy-index-action" ? <LegacyIndexSelection coordinator={props.coordinator} snapshot={snapshot} /> : null}

    {snapshot.stage === "failed" && snapshot.error ? <SetupError
      error={snapshot.error} snapshot={snapshot} pluginBuildId={props.pluginBuildId}
      diagnosticEvents={props.diagnosticEvents ?? []} onRetry={retry} onChangePort={props.onChangePort}
      onOpenHelp={props.onOpenHelp} onClose={props.onClose}
    /> : null}

    {snapshot.stage === "ready" ? <section className="analogy-onboarding-complete">
      <div className="analogy-onboarding-complete__mark" aria-hidden="true">✓</div>
      <h2>{t("onboarding.complete.heading")}</h2>
      <p>{t("onboarding.complete.description")}</p>
      <div className="analogy-onboarding__actions">
        <button type="button" className="mod-cta analogy-onboarding__primary" data-primary-action="true" onClick={props.onStartSearching}>{t("onboarding.complete.search")}</button>
        <button type="button" onClick={props.onOpenOllama}>{t("onboarding.complete.ollama")}</button>
      </div>
      <p className="analogy-onboarding-complete__optional">{t("onboarding.complete.ollamaHint")}</p>
    </section> : null}
  </main>;
}
