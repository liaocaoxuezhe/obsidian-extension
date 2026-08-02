import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ChunkRepository } from "./types";
import type { ChunkRelationService } from "./relation-service";
import { SemanticWalkController, type ConfirmHide, type ConfirmRestart, type WalkOperationResult } from "./walk-controller";
import { SemanticWalkCanvas } from "./components/SemanticWalkCanvas";
import {
  ChunkPicker,
  pickDifferentRandomChunk,
  pickRandomChunk,
  type ChunkSearchProvider,
  type ChunkSelectionAction,
} from "./components/ChunkPicker";
import { WalkEmptyState } from "./components/WalkEmptyState";
import type { SemanticWalkOpenEvent } from "./SemanticWalkItemView";
import { t } from "../util/i18n";
import type { SemanticWalkDiagnosticRecorder } from "../diagnostics/diagnostic-types";
import type { CurrentMarkdownDocument, SemanticWalkFileBridge } from "./file-bridge";

export interface SemanticWalkViewProps {
  repository: ChunkRepository;
  relationService: Pick<ChunkRelationService, "findRelatedChunks">;
  search?: ChunkSearchProvider | null;
  currentDocumentPath?: string | null;
  currentDocumentMtime?: number | null;
  fileBridge?: SemanticWalkFileBridge | null;
  onOpenDocument?: (path: string, chunkId: string) => void;
  confirmRestart?: ConfirmRestart;
  confirmHide?: ConfirmHide;
  openEvent?: SemanticWalkOpenEvent;
  serviceUnavailableReason?: string | null;
  diagnosticRecorder?: SemanticWalkDiagnosticRecorder | null;
  model?: string;
  className?: string;
}

interface PickerState {
  mode: "documents" | "current" | "search";
  documentId?: string;
  highlightedChunkId?: string;
}

export function SemanticWalkView({
  repository,
  relationService,
  search,
  currentDocumentPath,
  currentDocumentMtime,
  fileBridge,
  onOpenDocument,
  confirmRestart,
  confirmHide,
  openEvent,
  serviceUnavailableReason,
  diagnosticRecorder,
  model,
  className = "",
}: SemanticWalkViewProps): JSX.Element {
  const controller = useMemo(
    () => new SemanticWalkController({
      repository,
      relationService,
      diagnosticRecorder,
      model,
      getIndexRevision: fileBridge ? () => fileBridge.getIndexRevision() : undefined,
      validateSource: fileBridge ? (chunk) => fileBridge.getFileValidity(chunk.path, chunk.mtime) : undefined,
    }),
    [repository, relationService, diagnosticRecorder, model, fileBridge],
  );
  const [walkState, setWalkState] = useState(controller.getState());
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newBatchBusy, setNewBatchBusy] = useState(false);
  const [fileRevision, setFileRevision] = useState(0);
  const [currentDocumentSnapshot, setCurrentDocumentSnapshot] = useState<CurrentMarkdownDocument | null>(
    () => fileBridge?.getCurrentDocument() ?? null,
  );
  const mountedRef = useRef(false);
  const actionGenerationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      actionGenerationRef.current++;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setWalkState);
    return unsubscribe;
  }, [controller]);

  useEffect(() => {
    if (!fileBridge) {
      setCurrentDocumentSnapshot(null);
      return;
    }
    return fileBridge.subscribe(() => {
      setCurrentDocumentSnapshot(fileBridge.getCurrentDocument());
      setFileRevision((revision) => revision + 1);
    });
  }, [fileBridge]);

  useEffect(() => {
    controller.refreshFileValidity();
  }, [controller, fileRevision]);

  const isCurrentAction = (generation: number) => mountedRef.current && actionGenerationRef.current === generation;
  const liveCurrentDocumentPath = fileBridge ? currentDocumentSnapshot?.path ?? null : currentDocumentPath;
  const liveCurrentDocumentMtime = fileBridge ? currentDocumentSnapshot?.mtime ?? null : currentDocumentMtime;

  const applyOperationResult = (result: WalkOperationResult, action: ChunkSelectionAction): boolean => {
    switch (result.status) {
      case "success":
        setFeedback(null);
        if (action === "start") setPicker(null);
        return true;
      case "missing":
        setFeedback(t("semanticWalk.missingChunk"));
        return false;
      case "expand-error":
        setFeedback(t("semanticWalk.expandFailed").replace("{message}", result.error));
        return false;
      case "confirmation-required":
        setFeedback(t("semanticWalk.restartConfirmation"));
        return false;
      case "cancelled":
        return false;
      case "invalid":
        setFeedback(t("semanticWalk.fileInvalid"));
        return false;
    }
  };

  const handleSelection = async (chunkId: string, action: ChunkSelectionAction) => {
    if (serviceUnavailableReason) {
      setFeedback(serviceUnavailableReason);
      return;
    }
    const actionGeneration = ++actionGenerationRef.current;
    setBusy(true);
    setFeedback(null);
    try {
      const result = action === "start"
        ? await controller.setStart(chunkId, confirmRestart)
        : action === "add"
          ? await controller.addChunk(chunkId)
          : await controller.addAndExpand(chunkId);
      if (!isCurrentAction(actionGeneration)) return;
      applyOperationResult(result, action);
    } catch (error) {
      if (!isCurrentAction(actionGeneration)) return;
      setFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrentAction(actionGeneration)) setBusy(false);
    }
  };

  const handleRandom = async () => {
    if (serviceUnavailableReason) {
      setFeedback(serviceUnavailableReason);
      return;
    }
    const actionGeneration = ++actionGenerationRef.current;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await pickRandomChunk(repository);
      if (!isCurrentAction(actionGeneration)) return;
      if (result.status === "empty") {
        setFeedback(t("semanticWalk.randomEmpty"));
        return;
      }
      const operation = await controller.setStart(result.chunk.chunkId, confirmRestart);
      if (!isCurrentAction(actionGeneration)) return;
      applyOperationResult(operation, "start");
    } catch (error) {
      if (!isCurrentAction(actionGeneration)) return;
      setFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrentAction(actionGeneration)) setBusy(false);
    }
  };

  const handleNewBatch = async () => {
    if (serviceUnavailableReason) {
      setFeedback(serviceUnavailableReason);
      return;
    }
    const previousRootChunkId = controller.getState().rootNodeId;
    const actionGeneration = ++actionGenerationRef.current;
    setBusy(true);
    setNewBatchBusy(true);
    setFeedback(null);
    setPicker(null);
    controller.reset();
    try {
      const result = await pickDifferentRandomChunk(repository, previousRootChunkId);
      if (!isCurrentAction(actionGeneration)) return;
      if (result.status === "empty") {
        setFeedback(t("semanticWalk.randomEmpty"));
        return;
      }
      if (result.status === "unchanged") {
        setFeedback(t("semanticWalk.newBatchUnchanged"));
        return;
      }
      const operation = await controller.setStart(result.chunk.chunkId);
      if (!isCurrentAction(actionGeneration)) return;
      if (!applyOperationResult(operation, "start")) return;
      const expansion = await controller.expand(result.chunk.chunkId);
      if (!isCurrentAction(actionGeneration)) return;
      applyOperationResult(expansion, "add-expand");
    } catch (error) {
      if (!isCurrentAction(actionGeneration)) return;
      setFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrentAction(actionGeneration)) {
        setBusy(false);
        setNewBatchBusy(false);
      }
    }
  };

  useEffect(() => {
    if (!openEvent) return;
    const { request } = openEvent;
    if (serviceUnavailableReason && request.type !== "empty") {
      setPicker(null);
      setFeedback(serviceUnavailableReason);
      return;
    }
    if (request.type === "empty") {
      actionGenerationRef.current++;
      controller.reset();
      setBusy(false);
      setNewBatchBusy(false);
      setPicker(null);
      setFeedback(null);
    } else if (request.type === "current-document") {
      setPicker({ mode: "current" });
    } else if (request.type === "chunk") {
      void handleSelection(request.chunkId, "start");
    } else {
      void handleRandom();
    }
  }, [openEvent?.id, serviceUnavailableReason]);

  const openDocument = (nodeId: string) => {
    const node = walkState.nodes[nodeId];
    if (!node) return;
    if (fileBridge) {
      void fileBridge.openDocument(node.chunk.path).then((opened) => {
        if (!opened) setFeedback(t("semanticWalk.fileMissing"));
      });
      return;
    }
    onOpenDocument?.(node.chunk.path, node.chunk.chunkId);
  };

  const openDocumentChunks = (nodeId: string) => {
    const node = walkState.nodes[nodeId];
    if (!node) return;
    setPicker({
      mode: "documents",
      documentId: node.chunk.docId,
      highlightedChunkId: node.chunk.chunkId,
    });
  };

  const hasNodes = Object.keys(walkState.nodes).length > 0;
  const viewClassName = `semantic-walk-view ${className}`.trim();

  return (
    <section className={viewClassName} aria-label={t("semanticWalk.viewName")}>
      {hasNodes || newBatchBusy ? (
        <header className="semantic-walk-view__header">
          <div className="semantic-walk-view__summary">
            <h2>{t("semanticWalk.mapName")}</h2>
            <span>{t("semanticWalk.chunkCount").replace("{count}", String(Object.keys(walkState.nodes).length))}</span>
          </div>
          <div className="semantic-walk-view__actions">
            <button type="button" onClick={() => setPicker({ mode: "documents" })}>{t("semanticWalk.chooseChunk")}</button>
            <button type="button" disabled={newBatchBusy} onClick={() => { void handleNewBatch(); }}>{t("semanticWalk.newBatch")}</button>
            <button type="button" disabled={busy} onClick={() => {
              actionGenerationRef.current++;
              controller.reset();
              setPicker(null);
              setFeedback(null);
            }}>{t("semanticWalk.clearCanvas")}</button>
          </div>
        </header>
      ) : null}

      <div className="semantic-walk-view__canvas">
        <SemanticWalkCanvas
          nodes={walkState.nodes}
          edges={walkState.edges}
          focusNodeId={walkState.focusNodeId}
          rootNodeId={walkState.rootNodeId}
          viewport={walkState.viewport}
          onViewportChange={(viewport) => controller.setViewport(viewport)}
          onFocusNode={(nodeId) => controller.focus(nodeId)}
          onExpandNode={(nodeId) => {
            if (serviceUnavailableReason) {
              setFeedback(serviceUnavailableReason);
              return;
            }
            void controller.toggleNodeExpansion(nodeId);
          }}
          onMoveNode={(nodeId, x, y) => controller.move(nodeId, x, y)}
          onOpenDocument={onOpenDocument ? openDocument : undefined}
          onOpenDocumentChunks={openDocumentChunks}
          onHideNode={(nodeId) => {
            void controller.hideNode(nodeId, confirmHide).then((result) => {
              if (result.status === "confirmation-required") setFeedback(t("semanticWalk.hideConfirmation"));
            });
          }}
          candidateMode={walkState.candidateMode}
          excludeSameDocument={walkState.excludeSameDocument}
          onCandidateModeChange={(mode) => {
            void controller.setCandidateMode(mode).then((result) => {
              if (result.status === "expand-error") {
                setFeedback(t("semanticWalk.expandFailed").replace("{message}", result.error));
              }
            });
          }}
          onExcludeSameDocumentChange={(exclude) => {
            void controller.setExcludeSameDocument(exclude).then((result) => {
              if (result.status === "expand-error") {
                setFeedback(t("semanticWalk.expandFailed").replace("{message}", result.error));
              }
            });
          }}
        />

        {!hasNodes ? (
          <WalkEmptyState
            currentDocumentPath={liveCurrentDocumentPath}
            onOpenCurrentDocument={() => setPicker({ mode: "current" })}
            onOpenSearch={() => setPicker({ mode: "search" })}
            onPickRandom={() => { void handleRandom(); }}
            feedback={feedback || serviceUnavailableReason}
            busy={busy}
            disabledReason={serviceUnavailableReason}
          />
        ) : null}
      </div>

      {hasNodes && feedback ? <p className="semantic-walk-view__feedback" role="status">{feedback}</p> : null}
      {hasNodes && walkState.limitWarning ? (
        <p className="semantic-walk-view__feedback" role="status">
          {t(walkState.limitWarning === "nodes" ? "semanticWalk.limit.nodes" : "semanticWalk.limit.edges")}
        </p>
      ) : null}

      {picker ? (
        <ChunkPicker
          key={`${picker.mode}:${picker.documentId ?? ""}:${picker.highlightedChunkId ?? ""}`}
          repository={repository}
          search={search}
          currentDocumentPath={liveCurrentDocumentPath}
          currentDocumentMtime={liveCurrentDocumentMtime}
          fileBridge={fileBridge}
          initialMode={picker.mode}
          initialDocumentId={picker.documentId}
          highlightedChunkId={picker.highlightedChunkId}
          busy={busy || Boolean(serviceUnavailableReason)}
          onSelect={(chunkId, action) => { void handleSelection(chunkId, action); }}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </section>
  );
}
