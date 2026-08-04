import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { Modal, type App } from "obsidian";
import type { OnboardingCoordinator } from "./onboarding-coordinator";
import { OnboardingView, type OnboardingMode } from "./OnboardingView";
import type { OnboardingDiagnosticEvent } from "./components/SetupError";

export interface OnboardingModalOptions {
  coordinator: OnboardingCoordinator;
  mode: OnboardingMode;
  pluginBuildId: string;
  diagnosticEvents?: readonly OnboardingDiagnosticEvent[];
  onStartSearching(): void;
  onOpenOllama(): void;
  onOpenHelp(): void;
  onChangePort(): void;
  onDidClose(): void;
}

export class OnboardingModal extends Modal {
  private readonly options: OnboardingModalOptions;
  private root: Root | null = null;
  private opener: HTMLElement | null = null;

  constructor(app: App, options: OnboardingModalOptions) {
    super(app);
    this.options = options;
  }

  onOpen(): void {
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.contentEl.empty();
    this.modalEl.addClass("analogy-onboarding-modal");
    const snapshot = this.options.coordinator.getSnapshot();
    const operation = this.options.mode === "repair" || snapshot.stage === "failed"
      ? this.options.coordinator.retry()
      : snapshot.stage === "not-started" || snapshot.stage === "cancelled"
        ? this.options.coordinator.start()
        : this.options.coordinator.resume();
    void operation.catch(() => undefined);
    this.root = createRoot(this.contentEl);
    this.root.render(<OnboardingView
      coordinator={this.options.coordinator}
      mode={this.options.mode}
      onClose={() => this.close()}
      onStartSearching={() => { this.close(); this.options.onStartSearching(); }}
      onOpenOllama={() => { this.close(); this.options.onOpenOllama(); }}
      onOpenHelp={this.options.onOpenHelp}
      onChangePort={this.options.onChangePort}
      pluginBuildId={this.options.pluginBuildId}
      diagnosticEvents={this.options.diagnosticEvents}
    />);
  }

  onClose(): void {
    this.root?.unmount();
    this.root = null;
    this.contentEl.empty();
    this.options.onDidClose();
    this.opener?.focus();
    this.opener = null;
  }
}
