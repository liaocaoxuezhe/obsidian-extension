import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChunkSearchResult } from "../../local-vector/search";
import type { ChunkRepository, IndexedChunk, IndexedDocumentEntry } from "../types";
import { t } from "../../util/i18n";
import type { SemanticWalkFileBridge } from "../file-bridge";
import { isMarkdownPath } from "../markdown-file";

export type ChunkSelectionAction = "start" | "add" | "add-expand";

export type PickerIndexResult =
  | { status: "ready"; documents: IndexedDocumentEntry[] }
  | { status: "empty"; documents: [] };

export type DocumentChunksResult =
  | { status: "ready"; document: IndexedDocumentEntry; chunks: IndexedChunk[] }
  | { status: "unindexed"; path: string }
  | { status: "empty"; document: IndexedDocumentEntry; chunks: [] };

export type RandomChunkResult =
  | { status: "ready"; chunk: IndexedChunk }
  | { status: "empty" };

export type DifferentRandomChunkResult = RandomChunkResult | { status: "unchanged" };

export interface ChunkSearchProvider {
  searchByQuery(query: string, limit?: number): Promise<ChunkSearchResult[]>;
}

export interface ChunkPickerProps {
  repository: ChunkRepository;
  search?: ChunkSearchProvider | null;
  currentDocumentPath?: string | null;
  currentDocumentMtime?: number | null;
  fileBridge?: SemanticWalkFileBridge | null;
  initialMode?: "documents" | "current" | "search";
  initialDocumentId?: string | null;
  highlightedChunkId?: string | null;
  busy?: boolean;
  onSelect: (chunkId: string, action: ChunkSelectionAction) => void;
  onClose?: () => void;
}

export function sortChunksByIndex<T extends Pick<IndexedChunk, "chunkIndex">>(chunks: T[]): T[] {
  return [...chunks].sort((left, right) => left.chunkIndex - right.chunkIndex);
}

export async function loadPickerIndex(
  repository: Pick<ChunkRepository, "listIndexedDocuments">,
): Promise<PickerIndexResult> {
  const documents = await repository.listIndexedDocuments();
  if (documents.length === 0) return { status: "empty", documents: [] };
  return { status: "ready", documents: [...documents].sort((left, right) => left.path.localeCompare(right.path)) };
}

export async function loadDocumentChunks(
  repository: Pick<ChunkRepository, "listChunksByDocument">,
  document: IndexedDocumentEntry,
): Promise<DocumentChunksResult> {
  const chunks = sortChunksByIndex(await repository.listChunksByDocument(document.docId));
  return chunks.length > 0
    ? { status: "ready", document, chunks }
    : { status: "empty", document, chunks: [] };
}

export async function loadChunksForPath(
  repository: Pick<ChunkRepository, "listIndexedDocuments" | "listChunksByDocument">,
  path: string,
): Promise<DocumentChunksResult> {
  const documents = await repository.listIndexedDocuments();
  const document = documents.find((entry) => entry.path === path);
  if (!document) return { status: "unindexed", path };
  return loadDocumentChunks(repository, document);
}

export async function pickRandomChunk(
  repository: Pick<ChunkRepository, "getRandomChunk">,
): Promise<RandomChunkResult> {
  const chunk = await repository.getRandomChunk();
  return chunk ? { status: "ready", chunk } : { status: "empty" };
}

export async function pickDifferentRandomChunk(
  repository: Pick<ChunkRepository, "getRandomChunk" | "listIndexedDocuments">,
  currentRootChunkId: string | null,
  maxAttempts = 8,
): Promise<DifferentRandomChunkResult> {
  const documents = await repository.listIndexedDocuments();
  const indexedChunkCount = documents.reduce(
    (total, document) => total + Math.max(0, document.chunkCount),
    0,
  );
  if (indexedChunkCount === 0) return { status: "empty" };

  const attempts = indexedChunkCount > 1 && currentRootChunkId
    ? Math.max(1, Math.floor(maxAttempts))
    : 1;
  let sawChunk = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const chunk = await repository.getRandomChunk();
    if (!chunk) continue;
    sawChunk = true;
    if (indexedChunkCount <= 1 || !currentRootChunkId || chunk.chunkId !== currentRootChunkId) {
      return { status: "ready", chunk };
    }
  }
  return sawChunk ? { status: "unchanged" } : { status: "empty" };
}

function ChunkActions({ chunkId, onSelect, disabled }: {
  chunkId: string;
  onSelect: ChunkPickerProps["onSelect"];
  disabled?: boolean;
}): JSX.Element {
  return (
    <div className="semantic-walk-picker__actions">
      <button type="button" disabled={disabled} onClick={() => onSelect(chunkId, "start")}>{t("semanticWalk.picker.setStart")}</button>
    </div>
  );
}

function ChunkRow({
  chunk,
  highlighted,
  disabled,
  onSelect,
  fileBridge,
}: {
  chunk: Pick<IndexedChunk, "chunkId" | "title" | "content" | "chunkIndex" | "chunkCount" | "sectionLabel" | "path" | "mtime">;
  highlighted: boolean;
  disabled?: boolean;
  onSelect: ChunkPickerProps["onSelect"];
  fileBridge?: SemanticWalkFileBridge | null;
}): JSX.Element {
  const rowRef = useRef<HTMLLIElement | null>(null);
  const validity = fileBridge?.getFileValidity(chunk.path, chunk.mtime) ?? "valid";
  const unavailable = disabled || validity !== "valid";
  useEffect(() => {
    if (highlighted) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);
  return (
    <li ref={rowRef} className={`semantic-walk-picker__chunk${highlighted ? " is-highlighted" : ""}${validity !== "valid" ? ` is-${validity}` : ""}`} aria-current={highlighted ? "true" : undefined}>
      <div className="semantic-walk-picker__chunk-meta">
        <strong>{chunk.sectionLabel || chunk.title}</strong>
        <span>{chunk.chunkIndex + 1}/{chunk.chunkCount}</span>
      </div>
      <p>{chunk.content}</p>
      {validity !== "valid" ? <p role="status">{t(validity === "missing" ? "semanticWalk.fileMissing" : "semanticWalk.fileStale")}</p> : null}
      <ChunkActions chunkId={chunk.chunkId} onSelect={onSelect} disabled={unavailable} />
    </li>
  );
}

export function ChunkPicker({
  repository,
  search,
  currentDocumentPath,
  currentDocumentMtime,
  fileBridge,
  initialMode = "documents",
  initialDocumentId,
  highlightedChunkId,
  busy = false,
  onSelect,
  onClose,
}: ChunkPickerProps): JSX.Element {
  const [mode, setMode] = useState(initialMode);
  const [documents, setDocuments] = useState<IndexedDocumentEntry[]>([]);
  const [documentResult, setDocumentResult] = useState<DocumentChunksResult | null>(null);
  const [query, setQuery] = useState("");
  const [documentQuery, setDocumentQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ChunkSearchResult[]>([]);
  const [indexLoading, setIndexLoading] = useState(true);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [indexMessage, setIndexMessage] = useState<string | null>(null);
  const [documentMessage, setDocumentMessage] = useState<string | null>(null);
  const [searchMessage, setSearchMessage] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const modeRef = useRef(mode);
  const indexRequestRef = useRef(0);
  const documentRequestRef = useRef(0);
  const searchRequestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      indexRequestRef.current++;
      documentRequestRef.current++;
      searchRequestRef.current++;
    };
  }, []);

  useEffect(() => {
    const requestId = ++indexRequestRef.current;
    setIndexLoading(true);
    loadPickerIndex(repository).then((result) => {
      if (!mountedRef.current || requestId !== indexRequestRef.current) return;
      setDocuments(result.documents);
      setIndexMessage(result.status === "empty" ? t("semanticWalk.picker.indexEmpty") : null);
    }).catch((error) => {
      if (!mountedRef.current || requestId !== indexRequestRef.current) return;
      setIndexMessage(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (mountedRef.current && requestId === indexRequestRef.current) setIndexLoading(false);
    });
    return () => { indexRequestRef.current++; };
  }, [repository]);

  const switchMode = useCallback((nextMode: "documents" | "current" | "search") => {
    const previousMode = modeRef.current;
    modeRef.current = nextMode;
    setMode(nextMode);
    if (nextMode === "search") {
      documentRequestRef.current++;
      setDocumentLoading(false);
      setDocumentResult(null);
      setDocumentMessage(null);
    } else {
      searchRequestRef.current++;
      setSearchLoading(false);
      setSearchResults([]);
      setSearchMessage(null);
      if (previousMode !== "search" && previousMode !== nextMode) {
        documentRequestRef.current++;
        setDocumentLoading(false);
        setDocumentResult(null);
        setDocumentMessage(null);
      }
    }
  }, []);

  const openDocument = useCallback(async (document: IndexedDocumentEntry) => {
    switchMode("documents");
    const requestId = ++documentRequestRef.current;
    setDocumentLoading(true);
    setDocumentMessage(null);
    try {
      const result = await loadDocumentChunks(repository, document);
      if (!mountedRef.current || requestId !== documentRequestRef.current || modeRef.current === "search") return;
      setDocumentResult(result);
      if (result.status === "empty") setDocumentMessage(t("semanticWalk.picker.documentEmpty"));
      if (result.status === "ready" && (result.document.needsReindex || result.chunks.some((chunk) => chunk.needsReindex))) {
        setDocumentMessage(t("semanticWalk.picker.reindexGuidance"));
      }
    } catch (error) {
      if (!mountedRef.current || requestId !== documentRequestRef.current || modeRef.current === "search") return;
      setDocumentMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current && requestId === documentRequestRef.current && modeRef.current !== "search") setDocumentLoading(false);
    }
  }, [repository, switchMode]);

  const openCurrent = useCallback(async () => {
    switchMode("current");
    const requestId = ++documentRequestRef.current;
    if (!currentDocumentPath || !isMarkdownPath(currentDocumentPath)) {
      setDocumentLoading(false);
      setDocumentResult(null);
      setDocumentMessage(t("semanticWalk.noMarkdownDocument"));
      return;
    }
    setDocumentLoading(true);
    setDocumentMessage(null);
    try {
      const result = await loadChunksForPath(repository, currentDocumentPath);
      if (!mountedRef.current || requestId !== documentRequestRef.current || modeRef.current !== "current") return;
      setDocumentResult(result);
      if (result.status === "unindexed") setDocumentMessage(t("semanticWalk.picker.currentUnindexed").replace("{path}", result.path));
      if (result.status === "empty") setDocumentMessage(t("semanticWalk.picker.documentEmpty"));
      if (result.status === "ready" && (result.document.needsReindex || result.chunks.some((chunk) => chunk.needsReindex))) {
        setDocumentMessage(t("semanticWalk.picker.reindexGuidance"));
      }
      if (result.status === "ready" && currentDocumentMtime != null && result.document.mtime !== currentDocumentMtime) {
        setDocumentMessage(t("semanticWalk.picker.currentStale"));
      }
    } catch (error) {
      if (!mountedRef.current || requestId !== documentRequestRef.current || modeRef.current !== "current") return;
      setDocumentMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current && requestId === documentRequestRef.current && modeRef.current === "current") setDocumentLoading(false);
    }
  }, [currentDocumentMtime, currentDocumentPath, repository, switchMode]);

  useEffect(() => {
    if (!initialDocumentId) return;
    const document = documents.find((entry) => entry.docId === initialDocumentId);
    if (document) void openDocument(document);
  }, [documents, initialDocumentId, openDocument]);

  useEffect(() => {
    if (mode !== "current") return;
    void openCurrent();
  }, [currentDocumentPath, mode, openCurrent]);

  const sortedSearchResults = useMemo(
    () => [...searchResults].sort((left, right) => left.distance - right.distance),
    [searchResults],
  );
  const filteredDocuments = useMemo(() => {
    const normalized = documentQuery.trim().toLocaleLowerCase();
    return normalized
      ? documents.filter((document) => document.path.toLocaleLowerCase().includes(normalized))
      : documents;
  }, [documentQuery, documents]);

  const submitSearch = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    if (!search) {
      setSearchMessage(t("semanticWalk.picker.searchUnavailable"));
      return;
    }
    const requestId = ++searchRequestRef.current;
    setSearchLoading(true);
    setSearchMessage(null);
    try {
      const results = await search.searchByQuery(trimmed, 12);
      if (!mountedRef.current || requestId !== searchRequestRef.current || modeRef.current !== "search") return;
      setSearchResults(results);
      if (results.length === 0) setSearchMessage(t("semanticWalk.picker.noResults"));
    } catch (error) {
      if (!mountedRef.current || requestId !== searchRequestRef.current || modeRef.current !== "search") return;
      setSearchMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current && requestId === searchRequestRef.current && modeRef.current === "search") setSearchLoading(false);
    }
  };

  const chunks = documentResult?.status === "ready" ? documentResult.chunks : [];
  const loading = mode === "search" ? searchLoading : indexLoading || documentLoading;
  const message = mode === "search" ? searchMessage : documentMessage ?? indexMessage;

  return (
    <aside className="semantic-walk-picker" aria-label={t("semanticWalk.picker.label")}>
      <header className="semantic-walk-picker__header">
        <div>
          <span>{t("semanticWalk.picker.eyebrow")}</span>
          <strong>{t("semanticWalk.picker.title")}</strong>
        </div>
        {onClose ? <button type="button" disabled={busy} aria-label={t("semanticWalk.picker.close")} title={t("semanticWalk.picker.close")} onClick={onClose}>×</button> : null}
      </header>
      <nav className="semantic-walk-picker__tabs" aria-label={t("semanticWalk.picker.sources")}>
        <button type="button" disabled={busy} aria-pressed={mode === "current"} onClick={() => void openCurrent()}>{t("semanticWalk.currentDocument")}</button>
        <button type="button" disabled={busy} aria-pressed={mode === "documents"} onClick={() => switchMode("documents")}>{t("semanticWalk.picker.indexedDocuments")}</button>
        <button type="button" disabled={busy} aria-pressed={mode === "search"} onClick={() => switchMode("search")}>{t("semanticWalk.picker.semanticSearch")}</button>
      </nav>

      {mode === "search" ? (
        <div className="semantic-walk-picker__search">
          <form onSubmit={submitSearch}>
            <div className="semantic-walk-picker__search-field">
              <input className="semantic-walk-picker__search-input" type="search" disabled={busy || searchLoading} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("semanticWalk.picker.searchPlaceholder")} aria-label={t("semanticWalk.searchChunks")} />
              <span className="semantic-walk-picker__search-shortcut" aria-hidden="true">Enter ↵</span>
            </div>
          </form>
          <p className="semantic-walk-picker__hint">{t("semanticWalk.picker.searchHint")}</p>
          <ol className="semantic-walk-picker__chunks">
            {sortedSearchResults.map((chunk) => (
              <ChunkRow key={chunk.chunkId} chunk={chunk} highlighted={chunk.chunkId === highlightedChunkId} disabled={busy} onSelect={onSelect} fileBridge={fileBridge} />
            ))}
          </ol>
        </div>
      ) : (
        <div className="semantic-walk-picker__browser">
          <input
            type="search"
            value={documentQuery}
            disabled={busy}
            onChange={(event) => setDocumentQuery(event.target.value)}
            aria-label={t("semanticWalk.picker.searchDocuments")}
            placeholder={t("semanticWalk.picker.searchDocuments")}
          />
          <label>
            <span>{t("semanticWalk.picker.indexedDocument")}</span>
            <select
              value={documentResult?.status !== "unindexed" ? documentResult?.document.docId ?? "" : ""}
              disabled={busy}
              onChange={(event) => {
                const document = documents.find((entry) => entry.docId === event.target.value);
                if (document) void openDocument(document);
              }}
            >
              <option value="">{t("semanticWalk.picker.chooseDocument")}</option>
              {filteredDocuments.map((document) => <option key={document.docId} value={document.docId}>{document.path}</option>)}
            </select>
          </label>
          <ol className="semantic-walk-picker__chunks">
            {chunks.map((chunk) => (
              <ChunkRow key={chunk.chunkId} chunk={chunk} highlighted={chunk.chunkId === highlightedChunkId} disabled={busy} onSelect={onSelect} fileBridge={fileBridge} />
            ))}
          </ol>
        </div>
      )}

      {loading ? <p className="semantic-walk-picker__status" role="status">{t("semanticWalk.picker.loading")}</p> : null}
      {message ? <p className="semantic-walk-picker__status" role="status">{message}</p> : null}
    </aside>
  );
}
