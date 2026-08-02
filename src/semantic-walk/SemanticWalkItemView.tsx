import React, { useEffect, useMemo, useState } from "react";
import { ItemView, Modal, TFile, type App, type WorkspaceLeaf } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import { searchInstance, subscribeServiceState } from "../local-vector/search-instance";
import { onLocaleChange, t } from "../util/i18n";
import { ChromaChunkRepository } from "./chunk-repository";
import { ChunkRelationService } from "./relation-service";
import { SemanticWalkView } from "./SemanticWalkView";
import type { ChunkRepository } from "./types";
import type { SemanticWalkDiagnosticRecorder } from "../diagnostics/diagnostic-types";
import { ObsidianSemanticWalkFileBridge } from "./file-bridge";

export const VIEW_TYPE_SEMANTIC_WALK = "analogy-semantic-walk";

class SemanticWalkConfirmModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly message: string,
    private readonly resolveChoice: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: t("semanticWalk.confirm.title") });
    this.contentEl.createEl("p", { text: this.message });
    const actions = this.contentEl.createDiv({ cls: "semantic-walk-confirm__actions" });
    actions.createEl("button", { text: t("semanticWalk.confirm.cancel") }).onclick = () => this.finish(false);
    actions.createEl("button", { text: t("semanticWalk.confirm.confirm"), cls: "mod-warning" }).onclick = () => this.finish(true);
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.resolveChoice(false);
    }
  }

  private finish(confirmed: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveChoice(confirmed);
    this.close();
  }
}

function confirmWithObsidianModal(app: App, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    new SemanticWalkConfirmModal(app, message, resolve).open();
  });
}

export type SemanticWalkOpenRequest =
  | { type: "empty" }
  | { type: "current-document"; path: string }
  | { type: "chunk"; chunkId: string }
  | { type: "random" };

export interface SemanticWalkOpenEvent {
  id: number;
  request: SemanticWalkOpenRequest;
}

const unavailableRepository: ChunkRepository = {
  async getChunk() { throw new Error(t("semanticWalk.serviceUnavailable")); },
  async listChunksByDocument() { throw new Error(t("semanticWalk.serviceUnavailable")); },
  async listIndexedDocuments() { throw new Error(t("semanticWalk.serviceUnavailable")); },
  async getRandomChunk() { throw new Error(t("semanticWalk.serviceUnavailable")); },
};

const unavailableRelationService = {
  async findRelatedChunks(): Promise<never> {
    throw new Error(t("semanticWalk.serviceUnavailable"));
  },
};

export function isSemanticWalkServiceAvailable(): boolean {
  const { status } = searchInstance.state;
  return (status === "ready" || status === "degraded")
    && Boolean(searchInstance.vectorStore)
    && Boolean(searchInstance.localSearch)
    && Boolean(searchInstance.embeddingService);
}

function markdownPath(file: TFile | null): string {
  return file instanceof TFile && file.extension.toLowerCase() === "md" ? file.path : "";
}

function SemanticWalkWorkspace({ itemView }: { itemView: SemanticWalkItemView }): JSX.Element {
  const [openEvent, setOpenEvent] = useState<SemanticWalkOpenEvent>(() => itemView.getOpenRequest());

  useEffect(() => itemView.subscribeOpenRequests(setOpenEvent), [itemView]);

  const vectorStore = searchInstance.vectorStore;
  const serviceAvailable = isSemanticWalkServiceAvailable();
  const repository = useMemo(
    () => serviceAvailable && vectorStore ? new ChromaChunkRepository(vectorStore) : unavailableRepository,
    [serviceAvailable, vectorStore],
  );
  const relationService = useMemo(
    () => serviceAvailable
      ? new ChunkRelationService({
          search: searchInstance.localSearch,
          embedding: searchInstance.embeddingService,
          diagnosticRecorder: itemView.diagnosticRecorder,
          model: searchInstance.state.activeModel || "unknown",
          validateCandidate: (candidate) => itemView.fileBridge.getFileValidity(candidate.path, candidate.mtime) === "valid",
        })
      : unavailableRelationService,
    [
      serviceAvailable,
      searchInstance.localSearch,
      searchInstance.embeddingService,
      searchInstance.state.activeModel,
      itemView.diagnosticRecorder,
    ],
  );
  const serviceUnavailableReason = serviceAvailable
    ? null
    : searchInstance.state.lastError || t("semanticWalk.serviceUnavailable");
  const currentDocument = itemView.fileBridge.getCurrentDocument();
  const requestPath = openEvent.request.type === "current-document" ? openEvent.request.path : "";
  const currentDocumentPath = requestPath || currentDocument?.path || "";

  return (
    <div className="semantic-walk-workspace">
      {serviceUnavailableReason ? (
        <aside className="semantic-walk-workspace__status" role="status">
          <strong>{t("semanticWalk.serviceUnavailableTitle")}</strong>
          <span>{serviceUnavailableReason}</span>
          <button type="button" onClick={() => itemView.openSettings()}>{t("semanticWalk.openSettings")}</button>
        </aside>
      ) : null}
      <SemanticWalkView
        repository={repository}
        relationService={relationService}
        search={serviceAvailable ? searchInstance.localSearch : null}
        currentDocumentPath={currentDocumentPath}
        currentDocumentMtime={currentDocument?.path === currentDocumentPath ? currentDocument.mtime : null}
        fileBridge={itemView.fileBridge}
        openEvent={openEvent}
        serviceUnavailableReason={serviceUnavailableReason}
        onOpenDocument={(path) => itemView.openDocument(path)}
        confirmRestart={() => confirmWithObsidianModal(itemView.app, t("semanticWalk.confirm.restart"))}
        confirmHide={() => confirmWithObsidianModal(itemView.app, t("semanticWalk.confirm.hide"))}
        diagnosticRecorder={itemView.diagnosticRecorder}
        model={searchInstance.state.activeModel || "unknown"}
      />
    </div>
  );
}

export class SemanticWalkItemView extends ItemView {
  private root: Root | null = null;
  private unsubscribeServiceState: (() => void) | null = null;
  private unsubscribeLocaleChange: (() => void) | null = null;
  private readonly openRequestListeners = new Set<(event: SemanticWalkOpenEvent) => void>();
  private openEvent: SemanticWalkOpenEvent = { id: 0, request: { type: "empty" } };
  private lifecycleGeneration = 0;
  private closed = true;
  readonly fileBridge: ObsidianSemanticWalkFileBridge;

  constructor(
    leaf: WorkspaceLeaf,
    readonly diagnosticRecorder: SemanticWalkDiagnosticRecorder | null = null,
  ) {
    super(leaf);
    this.fileBridge = new ObsidianSemanticWalkFileBridge(this.app);
  }

  getViewType(): string {
    return VIEW_TYPE_SEMANTIC_WALK;
  }

  getDisplayText(): string {
    return t("semanticWalk.viewName");
  }

  getIcon(): string {
    return "waypoints";
  }

  getOpenRequest(): SemanticWalkOpenEvent {
    return this.openEvent;
  }

  subscribeOpenRequests(listener: (event: SemanticWalkOpenEvent) => void): () => void {
    if (!this.closed) {
      this.openRequestListeners.add(listener);
      listener(this.openEvent);
    }
    return () => this.openRequestListeners.delete(listener);
  }

  dispatchOpenRequest(request: SemanticWalkOpenRequest): void {
    this.openEvent = { id: this.openEvent.id + 1, request };
    if (this.closed) return;
    for (const listener of this.openRequestListeners) listener(this.openEvent);
  }

  async onOpen(): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    this.closed = false;
    this.root = createRoot(this.containerEl.children[1]);
    this.unsubscribeServiceState = subscribeServiceState(() => {
      if (this.closed || generation !== this.lifecycleGeneration) return;
      this.root?.render(<SemanticWalkWorkspace itemView={this} />);
    });
    this.unsubscribeLocaleChange = onLocaleChange(() => {
      if (this.closed || generation !== this.lifecycleGeneration) return;
      this.root?.render(<SemanticWalkWorkspace itemView={this} />);
    });
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.lifecycleGeneration++;
    this.unsubscribeServiceState?.();
    this.unsubscribeServiceState = null;
    this.unsubscribeLocaleChange?.();
    this.unsubscribeLocaleChange = null;
    this.openRequestListeners.clear();
    this.fileBridge.dispose();
    this.root?.unmount();
    this.root = null;
  }

  openSettings(): void {
    (this.app as any).setting?.openTabById?.("analogy-rag-in-your-vault");
  }

  openDocument(path: string): void {
    const generation = this.lifecycleGeneration;
    void this.fileBridge.openDocument(path).catch((error) => {
      if (!this.closed && generation === this.lifecycleGeneration) {
        console.error("[Analogy] Failed to open semantic walk source", error);
      }
    });
  }
}
