import React, { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChunkPicker } from "../src/semantic-walk/components/ChunkPicker";
import { SemanticWalkView } from "../src/semantic-walk/SemanticWalkView";
import { ChunkRelationService } from "../src/semantic-walk/relation-service";
import type { IndexedChunk, IndexedDocumentEntry } from "../src/semantic-walk/types";
import type { ChunkSearchResult } from "../src/local-vector/search";
import { setLocale } from "../src/util/i18n";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function chunk(chunkId: string, docId: string, content = `${chunkId} content`): IndexedChunk {
  return {
    chunkId,
    docId,
    path: `${docId}.md`,
    title: docId,
    content,
    chunkIndex: 0,
    chunkCount: 1,
    sectionLabel: "Section",
    mtime: 100,
  };
}

function searchChunk(chunkId: string, content: string): ChunkSearchResult {
  const value = chunk(chunkId, chunkId.split("::")[0], content);
  return { ...value, distance: 0.1 };
}

function encodeResult(value: unknown): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(value))));
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`找不到按钮：${text}`);
  return button as HTMLButtonElement;
}

function headerNewBatchButton(container: ParentNode): HTMLButtonElement {
  const actions = container.querySelector(".semantic-walk-view__actions");
  if (!actions) throw new Error("找不到 Semantic Walk 顶部起点操作区");
  const buttons = Array.from(actions.querySelectorAll<HTMLButtonElement>("button"))
    .filter((button) => button.textContent?.trim() === "换一批");
  if (buttons.length !== 1) throw new Error(`顶部起点操作区中换一批按钮数量应为 1，实际为 ${buttons.length}`);
  return buttons[0];
}

function changeSelect(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function changeInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function changeTextarea(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function newMount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  container.className = "scenario";
  document.body.appendChild(container);
  return { container, root: createRoot(container) };
}

async function run(): Promise<void> {
  setLocale("zh");
  const failures: string[] = [];
  const metrics: Record<string, number | boolean | string> = {};
  const check = (condition: unknown, message: string) => {
    if (!condition) failures.push(message);
  };
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  let highlightedScrollCalls = 0;
  HTMLElement.prototype.scrollIntoView = function() { highlightedScrollCalls += 1; };

  const sizingRootChunk = chunk("SizingRoot::0", "SizingRoot", "sizing root");
  const sizingMount = newMount();
  sizingMount.root.render(
    <div className="semantic-walk-workspace">
      <SemanticWalkView
        repository={{
          getChunk: async (chunkId: string) => chunkId === sizingRootChunk.chunkId ? sizingRootChunk : null,
          listChunksByDocument: async () => [],
          listIndexedDocuments: async () => [],
          getRandomChunk: async () => sizingRootChunk,
        }}
        relationService={{ findRelatedChunks: async () => [] }}
        openEvent={{ id: 1, request: { type: "chunk", chunkId: sizingRootChunk.chunkId } }}
      />
    </div>,
  );
  await settle();
  await settle();
  const sizingWorkspace = sizingMount.container.querySelector<HTMLElement>(".semantic-walk-workspace");
  const sizingCanvasRegion = sizingMount.container.querySelector<HTMLElement>(".semantic-walk-view__canvas");
  const sizingCanvas = sizingMount.container.querySelector<HTMLElement>(".semantic-walk-canvas");
  if (!sizingWorkspace || !sizingCanvasRegion || !sizingCanvas) throw new Error("缺少 Obsidian 挂载高度回归场景");
  check(sizingWorkspace.clientHeight === sizingMount.container.clientHeight, "真实 workspace 必须填满 Obsidian view-content 高度");
  check(sizingCanvas.clientHeight === sizingCanvasRegion.clientHeight, "真实 canvas 必须填满 flex 画布区域，不能退化为 0 高度");
  check(sizingCanvas.clientHeight > 0, "存在节点时真实 canvas 高度必须大于 0");
  const sizingTitle = sizingMount.container
    .querySelector(".semantic-walk-view__summary h2, .semantic-walk-view__eyebrow")
    ?.textContent?.trim();
  check(sizingTitle === "语义漫游", `语义漫游非空画布标题必须显示“语义漫游”，实际为“${sizingTitle ?? ""}”`);
  metrics.workspaceHeight = sizingWorkspace.clientHeight;
  metrics.canvasRegionHeight = sizingCanvasRegion.clientHeight;
  metrics.canvasHeight = sizingCanvas.clientHeight;
  metrics.canvasTitle = sizingTitle ?? "";
  sizingMount.root.unmount();
  sizingMount.container.remove();

  const rootChunk = chunk("Root::0", "Root", "StrictMode root");

  const entryMount = newMount();
  entryMount.root.render(
    <SemanticWalkView
      repository={{
        getChunk: async () => null,
        listChunksByDocument: async () => [],
        listIndexedDocuments: async () => [
          { docId: "EntryNote", path: "EntryNote.md", mtime: 1, chunkCount: 1 },
        ],
        getRandomChunk: async () => null,
      }}
      relationService={{ findRelatedChunks: async () => [] }}
    />,
  );
  await settle();
  const entryButtons = Array.from(entryMount.container.querySelectorAll<HTMLButtonElement>(
    ".semantic-walk-empty__entries button",
  ));
  check(
    entryButtons.map((button) => button.querySelector("strong")?.textContent?.trim()).join("|")
      === "选择笔记|自由探索|随机漫游",
    "空状态应显示选择笔记、自由探索、随机漫游三个入口",
  );
  check(entryMount.container.textContent?.includes("从已索引的笔记中选择"), "选择笔记副标题必须可见");
  check(entryMount.container.textContent?.includes("输入文本，开始漫游"), "自由探索副标题必须可见");
  buttonByText(entryMount.container, "选择笔记").click();
  await settle();
  check(
    entryMount.container.querySelector<HTMLButtonElement>(".semantic-walk-picker__tabs button[aria-pressed='true']")
      ?.textContent?.trim() === "已索引文档",
    "选择笔记应默认打开已索引文档",
  );
  metrics.entryOptionsUpdated = entryButtons.length === 3;
  metrics.chooseNoteOpensDocuments = true;
  entryMount.root.unmount();
  entryMount.container.remove();

  const freeTextRelated = searchChunk("FreeTextRelated::0", "related indexed note");
  let freeTextRepositoryCalls = 0;
  let freeTextRelationCalls = 0;
  const freeTextMount = newMount();
  freeTextMount.root.render(
    <SemanticWalkView
      repository={{
        getChunk: async (chunkId: string) => {
          freeTextRepositoryCalls += 1;
          return chunkId === freeTextRelated.chunkId ? freeTextRelated : null;
        },
        listChunksByDocument: async () => [],
        listIndexedDocuments: async () => [],
        getRandomChunk: async () => null,
      }}
      relationService={{
        findRelatedChunks: async (source: IndexedChunk) => {
          freeTextRelationCalls += 1;
          check(source.content === "连接产品直觉与用户反馈", "relation service 必须收到自由文本原文");
          return [freeTextRelated];
        },
      }}
    />,
  );
  await settle();
  buttonByText(freeTextMount.container, "自由探索").click();
  await settle();
  const freeTextDialog = freeTextMount.container.querySelector<HTMLElement>(".semantic-walk-free-text-dialog");
  const freeTextTextarea = freeTextDialog?.querySelector<HTMLTextAreaElement>("textarea");
  const freeTextSubmit = freeTextDialog ? buttonByText(freeTextDialog, "开始漫游") : null;
  check(freeTextDialog?.querySelector("h2")?.textContent?.trim() === "漫游起点", "自由探索弹窗标题必须为漫游起点");
  check(freeTextTextarea?.rows === 6, "自由探索文本框必须显示 6 行");
  check(freeTextTextarea?.value === "输入一个想法", "自由探索文本框必须带默认文本");
  if (!freeTextTextarea || !freeTextSubmit) throw new Error("自由探索弹窗结构不完整");
  changeTextarea(freeTextTextarea, "   ");
  await settle();
  check(freeTextSubmit.disabled, "纯空白文本不得启动漫游");
  freeTextSubmit.click();
  await settle();
  check(freeTextRepositoryCalls === 0 && freeTextRelationCalls === 0, "纯空白文本不得调用 repository 或 relation service");
  changeTextarea(freeTextTextarea, "连接产品直觉与用户反馈");
  await settle();
  freeTextSubmit.click();
  await settle();
  await settle();
  const freeTextRoot = Array.from(freeTextMount.container.querySelectorAll<HTMLElement>("[data-semantic-walk-node='true']"))
    .find((node) => node.querySelector(".semantic-walk-node__content")?.textContent?.includes("连接产品直觉与用户反馈"));
  check(Boolean(freeTextRoot), "输入文本必须直接成为根节点正文");
  check(freeTextRoot?.querySelector(".semantic-walk-node__source")?.textContent?.trim() === "漫游起点", "虚拟根节点标题必须为漫游起点");
  check(freeTextRelationCalls === 1, "自由文本根节点创建后必须立即展开一次");
  check(freeTextMount.container.textContent?.includes("related indexed note"), "自动展开必须显示真实索引候选");
  check(!freeTextRoot?.querySelector("button.semantic-walk-node__source"), "虚拟根节点不得提供文档 chunks 按钮");
  check(!freeTextRoot?.querySelector(".semantic-walk-node__open-source"), "虚拟根节点不得提供打开原文按钮");
  metrics.freeTextDialog = Boolean(freeTextDialog);
  metrics.freeTextRoot = Boolean(freeTextRoot);
  metrics.freeTextExpanded = freeTextRelationCalls === 1;
  metrics.virtualSourceHidden = !freeTextRoot?.querySelector(".semantic-walk-node__open-source");
  freeTextMount.root.unmount();
  freeTextMount.container.remove();

  let unavailableRepositoryCalls = 0;
  const unavailableMount = newMount();
  const ServiceAwareSemanticWalkView = SemanticWalkView as React.ComponentType<any>;
  unavailableMount.root.render(
    <ServiceAwareSemanticWalkView
      repository={{
        getChunk: async () => { unavailableRepositoryCalls++; return rootChunk; },
        listChunksByDocument: async () => { unavailableRepositoryCalls++; return []; },
        listIndexedDocuments: async () => { unavailableRepositoryCalls++; return []; },
        getRandomChunk: async () => { unavailableRepositoryCalls++; return rootChunk; },
      }}
      relationService={{ findRelatedChunks: async () => [] }}
      serviceUnavailableReason="安全模式已启用，请打开设置恢复。"
      openEvent={{ id: 1, request: { type: "random" } }}
    />,
  );
  await settle();
  const unavailableEntries = Array.from(unavailableMount.container.querySelectorAll<HTMLButtonElement>(".semantic-walk-empty__entries button"));
  check(unavailableEntries.length === 3 && unavailableEntries.every((button) => button.disabled), "服务 error/safe-mode 时三个真实 React 起点入口必须全部禁用");
  check(unavailableMount.container.textContent?.includes("安全模式已启用，请打开设置恢复。"), "服务不可用原因必须在真实 React 边界可见");
  check(unavailableRepositoryCalls === 0, "服务不可用时 random open request 不得触碰 repository");
  unavailableMount.root.unmount();
  unavailableMount.container.remove();

  const strictMount = newMount();
  const strictRepository = {
    getChunk: async (chunkId: string) => chunkId === rootChunk.chunkId ? rootChunk : null,
    listChunksByDocument: async () => [],
    listIndexedDocuments: async () => [],
    getRandomChunk: async () => rootChunk,
  };
  strictMount.root.render(
    <StrictMode>
      <SemanticWalkView
        repository={strictRepository}
        relationService={{ findRelatedChunks: async () => [] }}
      />
    </StrictMode>,
  );
  await settle();
  buttonByText(strictMount.container, "随机漫游").click();
  await settle();
  await settle();
  check(Boolean(strictMount.container.querySelector('[data-semantic-walk-node="true"]')), "React18 StrictMode effect 重放后 controller 必须仍可加入起点");
  strictMount.root.unmount();
  strictMount.container.remove();

  const oldBatchRoot = chunk("OldBatch::0", "OldBatch", "old batch root");
  const newBatchRoot = chunk("NewBatch::0", "NewBatch", "new batch root");
  const newBatchRelated = searchChunk("NewBatchRelated::0", "new batch expanded candidate");
  const pendingNewBatchRandom = deferred<IndexedChunk>();
  let newBatchRandomCalls = 0;
  const newBatchMount = newMount();
  newBatchMount.root.render(
    <SemanticWalkView
      repository={{
        getChunk: async (chunkId: string) => chunkId === oldBatchRoot.chunkId
          ? oldBatchRoot
          : chunkId === newBatchRoot.chunkId
            ? { ...newBatchRoot, embedding: [0.7] }
            : chunkId === newBatchRelated.chunkId ? newBatchRelated : null,
        listChunksByDocument: async () => [],
        listIndexedDocuments: async () => [
          { docId: "OldBatch", path: "OldBatch.md", mtime: 1, chunkCount: 1 },
          { docId: "NewBatch", path: "NewBatch.md", mtime: 2, chunkCount: 1 },
        ],
        getRandomChunk: async () => {
          newBatchRandomCalls += 1;
          if (newBatchRandomCalls === 1) return oldBatchRoot;
          if (newBatchRandomCalls === 2) return pendingNewBatchRandom.promise;
          return newBatchRoot;
        },
      }}
      relationService={{ findRelatedChunks: async (source: IndexedChunk) => source.chunkId === newBatchRoot.chunkId ? [newBatchRelated] : [] }}
    />,
  );
  await settle();
  buttonByText(newBatchMount.container, "随机漫游").click();
  await settle();
  await settle();
  check(newBatchMount.container.textContent?.includes("old batch root"), "换一批场景必须先建立旧随机根");
  headerNewBatchButton(newBatchMount.container).click();
  await settle();
  const busyNewBatchButton = headerNewBatchButton(newBatchMount.container);
  check(busyNewBatchButton.disabled, "newBatchBusy 期间真实 toolbar 换一批按钮必须 disabled");
  busyNewBatchButton.click();
  await settle();
  check(newBatchRandomCalls === 2, "disabled 的真实 toolbar 换一批按钮不得触发第二次 repository 调用");
  pendingNewBatchRandom.resolve(oldBatchRoot);
  await settle();
  await settle();
  check(newBatchRandomCalls >= 3, "换一批必须有界重抽，跳过旧 root");
  check(newBatchMount.container.textContent?.includes("new batch root"), "点击真实工具栏换一批后必须显示新随机根");
  check(!newBatchMount.container.textContent?.includes("old batch root"), "换一批后旧 root 与路径必须消失");
  check(newBatchMount.container.textContent?.includes("new batch expanded candidate"), "换一批设置新随机根后必须立即展开第一批关联");
  const clearCanvasButton = buttonByText(newBatchMount.container, "清空画布");
  clearCanvasButton.click();
  await settle();
  check(!newBatchMount.container.querySelector('[data-semantic-walk-node="true"]'), "header 清空画布必须回到空起始页");
  metrics.newBatchRandomCalls = newBatchRandomCalls;
  metrics.newBatchBusyPreventedDuplicate = newBatchRandomCalls === 3;
  newBatchMount.root.unmount();
  newBatchMount.container.remove();

  const emptyBatchMount = newMount();
  emptyBatchMount.root.render(
    <SemanticWalkView
      repository={{
        getChunk: async (chunkId: string) => chunkId === oldBatchRoot.chunkId ? oldBatchRoot : null,
        listChunksByDocument: async () => [],
        listIndexedDocuments: async () => [],
        getRandomChunk: async () => oldBatchRoot,
      }}
      relationService={{ findRelatedChunks: async () => [] }}
    />,
  );
  await settle();
  buttonByText(emptyBatchMount.container, "随机漫游").click();
  await settle();
  await settle();
  headerNewBatchButton(emptyBatchMount.container).click();
  await settle();
  check(emptyBatchMount.container.textContent?.includes("本地索引为空"), "空索引点击真实 toolbar 换一批必须显示可恢复反馈");
  check(!emptyBatchMount.container.querySelector('[data-semantic-walk-node="true"]'), "空索引换一批必须保持已重置的空画布");
  metrics.newBatchEmptyFeedback = emptyBatchMount.container.textContent?.includes("本地索引为空") ?? false;
  emptyBatchMount.root.unmount();
  emptyBatchMount.container.remove();

  const interactionRoot = chunk("InteractionRoot::0", "InteractionRoot", "interaction root");
  const interactionCandidate = searchChunk("InteractionCandidate::0", "interaction candidate");
  let interactionRelationCalls = 0;
  const interactionMount = newMount();
  interactionMount.root.render(
    <SemanticWalkView
      repository={{
        getChunk: async (chunkId: string) => chunkId === interactionRoot.chunkId
          ? { ...interactionRoot, embedding: [0.5] }
          : chunkId === interactionCandidate.chunkId ? interactionCandidate : null,
        listChunksByDocument: async () => [],
        listIndexedDocuments: async () => [{ docId: "InteractionRoot", path: "InteractionRoot.md", mtime: 100, chunkCount: 1 }],
        getRandomChunk: async () => interactionRoot,
      }}
      relationService={{ findRelatedChunks: async () => { interactionRelationCalls += 1; return [interactionCandidate]; } }}
    />,
  );
  await settle();
  buttonByText(interactionMount.container, "随机漫游").click();
  await settle();
  await settle();
  check(interactionMount.container.textContent?.includes("interaction candidate"), "起点自动展开必须显示真实候选卡片");
  buttonByText(interactionMount.container, "收起分支").click();
  await settle();
  check(!interactionMount.container.textContent?.includes("interaction candidate"), "收起分支按钮必须折叠后代");
  buttonByText(interactionMount.container, "恢复分支").click();
  await settle();
  check(interactionMount.container.textContent?.includes("interaction candidate"), "折叠后再次点击必须恢复已有候选");
  check(interactionRelationCalls === 1, "折叠/恢复不得重复查询 relation service");
  const candidateCard = Array.from(interactionMount.container.querySelectorAll<HTMLElement>('[data-semantic-walk-node="true"]'))
    .find((card) => card.textContent?.includes("interaction candidate"));
  if (!candidateCard) throw new Error("找不到待隐藏候选卡片");
  candidateCard.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
  await settle();
  check(!interactionMount.container.textContent?.includes("interaction candidate"), "候选卡片 Delete 必须从当前画布隐藏");
  interactionMount.root.unmount();
  interactionMount.container.remove();

  const failingBatchMount = newMount();
  failingBatchMount.root.render(
    <SemanticWalkView
      repository={{
        getChunk: async (chunkId: string) => chunkId === oldBatchRoot.chunkId ? oldBatchRoot : null,
        listChunksByDocument: async () => [],
        listIndexedDocuments: async () => { throw new Error("索引读取故障"); },
        getRandomChunk: async () => oldBatchRoot,
      }}
      relationService={{ findRelatedChunks: async () => [] }}
    />,
  );
  await settle();
  buttonByText(failingBatchMount.container, "随机漫游").click();
  await settle();
  await settle();
  headerNewBatchButton(failingBatchMount.container).click();
  await settle();
  check(failingBatchMount.container.textContent?.includes("索引读取故障"), "repository 异常必须作为换一批可恢复反馈显示");
  check(!failingBatchMount.container.querySelector('[data-semantic-walk-node="true"]'), "repository 异常后不得恢复已重置的旧图");
  metrics.newBatchRepositoryErrorFeedback = failingBatchMount.container.textContent?.includes("索引读取故障") ?? false;
  failingBatchMount.root.unmount();
  failingBatchMount.container.remove();

  const currentEntryChunk = chunk("CurrentEntry::0", "CurrentEntry", "current document production entry");
  const currentEntryMount = newMount();
  currentEntryMount.root.render(
    <SemanticWalkView
      repository={{
        getChunk: async (chunkId: string) => chunkId === currentEntryChunk.chunkId ? currentEntryChunk : null,
        listChunksByDocument: async () => [currentEntryChunk],
        listIndexedDocuments: async () => [{ docId: "CurrentEntry", path: "CurrentEntry.md", mtime: 1, chunkCount: 1 }],
        getRandomChunk: async () => currentEntryChunk,
      }}
      relationService={{ findRelatedChunks: async () => [] }}
      currentDocumentPath="CurrentEntry.md"
      openEvent={{ id: 1, request: { type: "current-document", path: "CurrentEntry.md" } }}
    />,
  );
  await settle();
  await settle();
  const currentEntryRow = Array.from(currentEntryMount.container.querySelectorAll("li"))
    .find((row) => row.textContent?.includes("current document production entry"));
  if (!currentEntryRow) throw new Error("当前文档生产入口未显示真实 chunk row");
  buttonByText(currentEntryRow, "设为起点").click();
  await settle();
  await settle();
  check(Boolean(currentEntryMount.container.querySelector('[data-semantic-walk-node="true"]')), "当前文档 open request + picker handler 必须建立根节点");
  currentEntryMount.root.unmount();
  currentEntryMount.container.remove();

  const liveOldChunk = chunk("LiveOld::0", "LiveOld", "old active document chunk");
  const liveNewChunk = chunk("LiveNew::0", "LiveNew", "new active document chunk");
  let activeDocument = { path: "LiveOld.md", mtime: 100 };
  let notifyActiveDocument = () => {};
  const liveDocumentMount = newMount();
  liveDocumentMount.root.render(
    <SemanticWalkView
      repository={{
        getChunk: async () => null,
        listChunksByDocument: async (docId: string) => docId === "LiveNew" ? [liveNewChunk] : [liveOldChunk],
        listIndexedDocuments: async () => [
          { docId: "LiveOld", path: "LiveOld.md", mtime: 100, chunkCount: 1 },
          { docId: "LiveNew", path: "LiveNew.md", mtime: 100, chunkCount: 1 },
        ],
        getRandomChunk: async () => null,
      }}
      relationService={{ findRelatedChunks: async () => [] }}
      currentDocumentPath="LiveOld.md"
      currentDocumentMtime={100}
      fileBridge={{
        getCurrentDocument: () => activeDocument,
        getFileValidity: () => "valid",
        getIndexRevision: () => 1,
        subscribe: (listener: () => void) => {
          notifyActiveDocument = listener;
          listener();
          return () => { notifyActiveDocument = () => {}; };
        },
        openDocument: async () => true,
      }}
    />,
  );
  await settle();
  const liveDocumentEntries = liveDocumentMount.container.querySelector(".semantic-walk-empty__entries");
  if (!liveDocumentEntries) throw new Error("当前文档活动文件场景缺少空状态入口区");
  buttonByText(liveDocumentEntries, "选择笔记").click();
  await settle();
  buttonByText(liveDocumentMount.container.querySelector(".semantic-walk-picker__tabs")!, "当前文档").click();
  await settle();
  check(liveDocumentMount.container.textContent?.includes("old active document chunk"), "当前文档 picker 初次应读取 active Markdown 文件");
  activeDocument = { path: "LiveNew.md", mtime: 100 };
  notifyActiveDocument();
  await settle();
  await settle();
  check(liveDocumentMount.container.textContent?.includes("new active document chunk"), "active-file 事件后当前文档 picker 必须切换到新文件");
  check(!liveDocumentMount.container.textContent?.includes("old active document chunk"), "active-file 事件后不得继续显示旧文件 chunks");
  liveDocumentMount.root.unmount();
  liveDocumentMount.container.remove();

  const searchEntryChunk = searchChunk("SearchEntry::0", "search production entry");
  const searchEntryMount = newMount();
  searchEntryMount.root.render(
    <SemanticWalkView
      repository={{
        getChunk: async (chunkId: string) => chunkId === searchEntryChunk.chunkId ? searchEntryChunk : null,
        listChunksByDocument: async () => [],
        listIndexedDocuments: async () => [],
        getRandomChunk: async () => null,
      }}
      relationService={{ findRelatedChunks: async () => [] }}
      search={{ searchByQuery: async () => [searchEntryChunk] }}
    />,
  );
  await settle();
  buttonByText(searchEntryMount.container, "选择笔记").click();
  await settle();
  buttonByText(searchEntryMount.container.querySelector(".semantic-walk-picker__tabs")!, "语义搜索").click();
  await settle();
  const searchEntryInput = searchEntryMount.container.querySelector<HTMLInputElement>('input[aria-label="搜索 chunk"]');
  const searchEntryForm = searchEntryMount.container.querySelector("form");
  if (!searchEntryInput || !searchEntryForm) throw new Error("搜索生产入口缺少 form");
  changeInput(searchEntryInput, "production search");
  await settle();
  searchEntryForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  const searchEntryRow = Array.from(searchEntryMount.container.querySelectorAll("li"))
    .find((row) => row.textContent?.includes("search production entry"));
  if (!searchEntryRow) throw new Error("搜索生产入口未显示真实 result row");
  buttonByText(searchEntryRow, "设为起点").click();
  await settle();
  await settle();
  check(Boolean(searchEntryMount.container.querySelector('[data-semantic-walk-node="true"]')), "搜索 form + selection handler 必须建立根节点");
  searchEntryMount.root.unmount();
  searchEntryMount.container.remove();

  const chainRoot = chunk("RecorderChain::0", "RecorderChain", "recorder chain root");
  const chainRelated = searchChunk("RecorderRelated::0", "recorder chain related");
  const chainEvents: Array<Record<string, unknown>> = [];
  const chainRecorder = { recordSemanticWalkExpand(event: Record<string, unknown>) { chainEvents.push(event); } };
  const chainRelationService = new ChunkRelationService({
    search: { async searchByEmbedding() { return [chainRelated]; } },
    embedding: { async embedDocument() { return [0.2, 0.8]; } },
    diagnosticRecorder: chainRecorder,
    model: "chain-model",
  });
  const chainMount = newMount();
  chainMount.root.render(
    <SemanticWalkView
      repository={{
        getChunk: async (chunkId: string) => chunkId === chainRoot.chunkId ? chainRoot : null,
        listChunksByDocument: async () => [],
        listIndexedDocuments: async () => [{ docId: "RecorderChain", path: "RecorderChain.md", mtime: 1, chunkCount: 1 }],
        getRandomChunk: async () => chainRoot,
      }}
      relationService={chainRelationService}
      diagnosticRecorder={chainRecorder}
      model="chain-model"
    />,
  );
  await settle();
  buttonByText(chainMount.container, "随机漫游").click();
  await settle();
  await settle();
  buttonByText(chainMount.container, "展开关联").click();
  await settle();
  await settle();
  check(chainEvents.some((event) => event.stage === "start"), "View 必须把同一 recorder 传给 controller 记录 start");
  check(chainEvents.some((event) => event.stage === "fallback"), "ItemView 构造的 relation 链必须用同一 recorder 记录 fallback");
  check(chainEvents.some((event) => event.stage === "success"), "View→controller→relation recorder 链必须记录 success");
  check(chainEvents.every((event) => event.model === "chain-model"), "recorder 链必须保留 ItemView 注入的 model");
  metrics.recorderChainEvents = chainEvents.length;
  chainMount.root.unmount();
  chainMount.container.remove();

  const documents: IndexedDocumentEntry[] = [
    { docId: "A", path: "A.md", mtime: 1, chunkCount: 1 },
    { docId: "B", path: "B.md", mtime: 2, chunkCount: 1 },
  ];
  const documentA = deferred<IndexedChunk[]>();
  const documentB = deferred<IndexedChunk[]>();
  const documentMount = newMount();
  documentMount.root.render(
    <ChunkPicker
      repository={{
        getChunk: async () => null,
        listIndexedDocuments: async () => documents,
        listChunksByDocument: async (docId) => docId === "A" ? documentA.promise : documentB.promise,
        getRandomChunk: async () => null,
      }}
      onSelect={() => {}}
    />,
  );
  await settle();
  const documentSearch = documentMount.container.querySelector<HTMLInputElement>('input[aria-label="搜索已索引文档"]');
  if (!documentSearch) throw new Error("已索引文档 picker 缺少文档搜索输入框");
  changeInput(documentSearch, "B.md");
  await settle();
  const filteredOptions = Array.from(documentMount.container.querySelectorAll("select option")).map((option) => option.textContent);
  check(filteredOptions.includes("B.md") && !filteredOptions.includes("A.md"), "文档搜索必须过滤已索引文档列表");
  changeInput(documentSearch, "");
  await settle();
  const documentSelect = documentMount.container.querySelector("select");
  if (!documentSelect) throw new Error("文档场景缺少 select");
  changeSelect(documentSelect, "A");
  changeSelect(documentSelect, "B");
  documentB.resolve([chunk("B::0", "B", "newer document B")]);
  await settle();
  documentA.resolve([chunk("A::0", "A", "stale document A")]);
  await settle();
  metrics.documentRaceText = documentMount.container.textContent ?? "";
  check(documentMount.container.textContent?.includes("newer document B"), "后选择的文档 B 应保留在抽屉中");
  check(!documentMount.container.textContent?.includes("stale document A"), "较晚返回的文档 A 不得覆盖 B");
  documentMount.root.unmount();
  documentMount.container.remove();

  const highlightedChunk = chunk("Highlight::0", "Highlight", "highlighted indexed chunk");
  const openedOriginals: string[] = [];
  const highlightedMount = newMount();
  highlightedMount.root.render(
    <ChunkPicker
      repository={{
        getChunk: async () => highlightedChunk,
        listIndexedDocuments: async () => [{ docId: "Highlight", path: "Highlight.md", mtime: 100, chunkCount: 1 }],
        listChunksByDocument: async () => [highlightedChunk],
        getRandomChunk: async () => highlightedChunk,
      }}
      initialDocumentId="Highlight"
      highlightedChunkId={highlightedChunk.chunkId}
      fileBridge={{
        getCurrentDocument: () => ({ path: "Highlight.md", mtime: 100 }),
        getFileValidity: () => "valid",
        getIndexRevision: () => 1,
        subscribe: () => () => {},
        openDocument: async (filePath: string) => { openedOriginals.push(filePath); return true; },
      }}
      onSelect={() => {}}
    />,
  );
  await settle();
  await settle();
  check(highlightedScrollCalls > 0, "打开文档 chunks 时必须把 highlighted chunk 滚入可见区域");
  const highlightedRowActions = Array.from(
    highlightedMount.container.querySelectorAll<HTMLButtonElement>(".semantic-walk-picker__chunk button"),
  ).map((button) => button.textContent?.trim());
  check(
    JSON.stringify(highlightedRowActions) === JSON.stringify(["设为起点"]),
    `picker chunk 卡片必须只保留“设为起点”，实际为：${highlightedRowActions.join("、")}`,
  );
  check(openedOriginals.length === 0, "picker chunk 卡片不得再提供打开原文入口");
  highlightedMount.root.unmount();
  highlightedMount.container.remove();

  const staleMount = newMount();
  staleMount.root.render(
    <ChunkPicker
      repository={{
        getChunk: async () => highlightedChunk,
        listIndexedDocuments: async () => [{ docId: "Highlight", path: "Highlight.md", mtime: 100, chunkCount: 1 }],
        listChunksByDocument: async () => [highlightedChunk],
        getRandomChunk: async () => highlightedChunk,
      }}
      initialMode="current"
      currentDocumentPath="Highlight.md"
      currentDocumentMtime={200}
      fileBridge={{
        getCurrentDocument: () => ({ path: "Highlight.md", mtime: 200 }),
        getFileValidity: () => "stale",
        getIndexRevision: () => 2,
        subscribe: () => () => {},
        openDocument: async () => false,
      }}
      onSelect={() => {}}
    />,
  );
  await settle();
  await settle();
  check(staleMount.container.textContent?.includes("当前文档在索引后已修改"), "当前文件 mtime 与索引不符时 picker 必须显示 stale 提示");
  const staleRow = staleMount.container.querySelector(".semantic-walk-picker__chunk.is-stale");
  check(Boolean(staleRow), "stale picker chunk 必须显示失效状态");
  check(Array.from(staleRow?.querySelectorAll("button") ?? []).every((button) => button.disabled), "stale picker chunk 必须禁用选择与打开原文");
  staleMount.root.unmount();
  staleMount.container.remove();

  const noPathPending = deferred<IndexedChunk[]>();
  const noPathMount = newMount();
  noPathMount.root.render(
    <ChunkPicker
      repository={{
        getChunk: async () => null,
        listIndexedDocuments: async () => [
          { docId: "Ready", path: "Ready.md", mtime: 1, chunkCount: 1 },
          { docId: "Pending", path: "Pending.md", mtime: 2, chunkCount: 1 },
        ],
        listChunksByDocument: async (docId) => docId === "Ready"
          ? [chunk("Ready::0", "Ready", "previous ready document")]
          : noPathPending.promise,
        getRandomChunk: async () => null,
      }}
      currentDocumentPath={null}
      onSelect={() => {}}
    />,
  );
  await settle();
  const noPathSelect = noPathMount.container.querySelector("select");
  if (!noPathSelect) throw new Error("无 current path 场景缺少 select");
  changeSelect(noPathSelect, "Ready");
  await settle();
  changeSelect(noPathSelect, "Pending");
  await settle();
  buttonByText(noPathMount.container, "当前文档").click();
  await settle();
  check(!noPathMount.container.textContent?.includes("previous ready document"), "无 current path 时必须清空旧 documentResult");
  check(!noPathMount.container.textContent?.includes("正在读取索引"), "无 current path 时必须清除 documentLoading");
  check(noPathMount.container.textContent?.includes("没有可用的 Markdown 文档"), "无 current path 应保留明确说明");
  noPathPending.resolve([chunk("Pending::0", "Pending", "late pending document")]);
  await settle();
  check(!noPathMount.container.textContent?.includes("late pending document"), "无 current path 后迟到文档不得恢复旧 result");
  noPathMount.root.unmount();
  noPathMount.container.remove();

  const crossDocument = deferred<IndexedChunk[]>();
  const crossModeMount = newMount();
  crossModeMount.root.render(
    <ChunkPicker
      repository={{
        getChunk: async () => null,
        listIndexedDocuments: async () => [{ docId: "Cross", path: "Cross.md", mtime: 1, chunkCount: 1 }],
        listChunksByDocument: async () => crossDocument.promise,
        getRandomChunk: async () => null,
      }}
      search={{ searchByQuery: async () => [] }}
      onSelect={() => {}}
    />,
  );
  await settle();
  const crossDocumentSelect = crossModeMount.container.querySelector("select");
  if (!crossDocumentSelect) throw new Error("跨模式文档场景缺少 select");
  changeSelect(crossDocumentSelect, "Cross");
  await settle();
  buttonByText(crossModeMount.container, "语义搜索").click();
  await settle();
  const crossSearchInput = crossModeMount.container.querySelector<HTMLInputElement>('input[aria-label="搜索 chunk"]');
  const crossSearchForm = crossModeMount.container.querySelector("form");
  if (!crossSearchInput || !crossSearchForm) throw new Error("跨模式场景缺少 search form");
  changeInput(crossSearchInput, "cross");
  await settle();
  crossSearchForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  check(crossModeMount.container.textContent?.includes("没有找到匹配的 chunk"), "切到搜索后应显示当前搜索消息");
  check(!crossModeMount.container.textContent?.includes("正在读取索引"), "切到搜索后隐藏文档 loading 不得继续占用全局状态");
  crossDocument.resolve([]);
  await settle();
  check(crossModeMount.container.textContent?.includes("没有找到匹配的 chunk"), "隐藏文档迟到响应不得覆盖当前搜索 message");
  check(!crossModeMount.container.textContent?.includes("该索引文档没有 chunk"), "隐藏文档迟到 empty 不得污染搜索模式");
  crossModeMount.root.unmount();
  crossModeMount.container.remove();

  const crossSearch = deferred<ChunkSearchResult[]>();
  const reverseModeMount = newMount();
  reverseModeMount.root.render(
    <ChunkPicker
      repository={{
        getChunk: async () => null,
        listIndexedDocuments: async () => [{ docId: "Doc", path: "Doc.md", mtime: 1, chunkCount: 1 }],
        listChunksByDocument: async () => [],
        getRandomChunk: async () => null,
      }}
      search={{ searchByQuery: () => crossSearch.promise }}
      initialMode="search"
      onSelect={() => {}}
    />,
  );
  await settle();
  const reverseInput = reverseModeMount.container.querySelector<HTMLInputElement>('input[aria-label="搜索 chunk"]');
  const reverseForm = reverseModeMount.container.querySelector("form");
  if (!reverseInput || !reverseForm) throw new Error("反向跨模式场景缺少 search form");
  changeInput(reverseInput, "late search");
  await settle();
  reverseForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  buttonByText(reverseModeMount.container, "已索引文档").click();
  await settle();
  const reverseSelect = reverseModeMount.container.querySelector("select");
  if (!reverseSelect) throw new Error("反向跨模式场景缺少 select");
  changeSelect(reverseSelect, "Doc");
  await settle();
  check(reverseModeMount.container.textContent?.includes("该索引文档没有 chunk"), "切到文档后应显示当前文档消息");
  check(!reverseModeMount.container.textContent?.includes("正在读取索引"), "切到文档后隐藏搜索 loading 不得继续占用全局状态");
  crossSearch.resolve([]);
  await settle();
  check(reverseModeMount.container.textContent?.includes("该索引文档没有 chunk"), "隐藏搜索迟到响应不得覆盖当前文档 message");
  check(!reverseModeMount.container.textContent?.includes("没有找到匹配的 chunk"), "隐藏搜索迟到 empty 不得污染文档模式");
  reverseModeMount.root.unmount();
  reverseModeMount.container.remove();

  const firstSearch = deferred<ChunkSearchResult[]>();
  const secondSearch = deferred<ChunkSearchResult[]>();
  const unmountedSearch = deferred<ChunkSearchResult[]>();
  const searchMount = newMount();
  const searchProvider = {
    searchByQuery: (query: string) => query === "first"
      ? firstSearch.promise
      : query === "second" ? secondSearch.promise : unmountedSearch.promise,
  };
  searchMount.root.render(
    <ChunkPicker
      repository={{
        getChunk: async () => null,
        listIndexedDocuments: async () => [],
        listChunksByDocument: async () => [],
        getRandomChunk: async () => null,
      }}
      search={searchProvider}
      initialMode="search"
      onSelect={() => {}}
    />,
  );
  await settle();
  const searchInput = searchMount.container.querySelector<HTMLInputElement>('input[aria-label="搜索 chunk"]');
  const searchForm = searchMount.container.querySelector("form");
  if (!searchInput || !searchForm) throw new Error("搜索场景缺少输入框或 form");
  changeInput(searchInput, "first");
  await settle();
  searchForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  changeInput(searchInput, "second");
  await settle();
  searchForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  secondSearch.resolve([searchChunk("Second::0", "newer search second")]);
  await settle();
  firstSearch.resolve([searchChunk("First::0", "stale search first")]);
  await settle();
  check(searchMount.container.textContent?.includes("newer search second"), "后提交的搜索结果应保留");
  check(!searchMount.container.textContent?.includes("stale search first"), "旧搜索响应不得覆盖新搜索结果");

  changeInput(searchInput, "unmount");
  await settle();
  searchForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  searchMount.root.unmount();
  searchMount.container.remove();
  let unmountedLengthReads = 0;
  const unmountedResults = new Proxy([searchChunk("Unmounted::0", "unmounted result")], {
    get(target, property, receiver) {
      if (property === "length") unmountedLengthReads++;
      return Reflect.get(target, property, receiver);
    },
  });
  unmountedSearch.resolve(unmountedResults);
  await settle();
  metrics.unmountedLengthReads = unmountedLengthReads;
  check(unmountedLengthReads === 0, "ChunkPicker 卸载后不得读取或提交旧搜索响应");

  const addedChunk = chunk("Added::0", "Added", "added chunk content");
  const missingChunk = chunk("Missing::0", "Missing", "missing chunk content");
  let viewRelationCalls = 0;
  const viewMount = newMount();
  const viewRepository = {
    getChunk: async (chunkId: string, includeEmbedding = false) => {
      const value = chunkId === rootChunk.chunkId ? rootChunk : chunkId === addedChunk.chunkId ? addedChunk : null;
      return value ? { ...value, ...(includeEmbedding ? { embedding: [0.1] } : {}) } : null;
    },
    listIndexedDocuments: async () => [
      { docId: "Added", path: "Added.md", mtime: 2, chunkCount: 1 },
      { docId: "Missing", path: "Missing.md", mtime: 3, chunkCount: 1 },
    ],
    listChunksByDocument: async (docId: string) => docId === "Added" ? [addedChunk] : [missingChunk],
    getRandomChunk: async () => rootChunk,
  };
  viewMount.root.render(
    <SemanticWalkView
      repository={viewRepository}
      relationService={{
        findRelatedChunks: () => {
          viewRelationCalls++;
          return Promise.resolve([]);
        },
      }}
      confirmRestart={async () => true}
    />,
  );
  await settle();
  buttonByText(viewMount.container, "随机漫游").click();
  await settle();
  await settle();
  buttonByText(viewMount.container, "选择 chunk").click();
  await settle();
  const viewSelect = viewMount.container.querySelector("select");
  if (!viewSelect) throw new Error("View picker 缺少 select");
  changeSelect(viewSelect, "Added");
  await settle();
  const addedRow = Array.from(viewMount.container.querySelectorAll("li")).find((row) => row.textContent?.includes("added chunk content"));
  if (!addedRow) throw new Error("View picker 未显示 Added chunk");
  const addedRowActions = Array.from(addedRow.querySelectorAll("button")).map((button) => button.textContent?.trim());
  check(JSON.stringify(addedRowActions) === JSON.stringify(["设为起点"]), "非空 picker 的 chunk 卡片也必须只保留设为起点");
  buttonByText(addedRow, "设为起点").click();
  await settle();
  await settle();
  check(viewMount.container.querySelectorAll('[data-semantic-walk-node="true"]').length === 1, "确认后设为起点必须替换当前画布根节点");
  check(viewMount.container.textContent?.includes("added chunk content"), "设为起点后必须显示所选 chunk");

  buttonByText(viewMount.container, "选择 chunk").click();
  await settle();
  const actionSelect = viewMount.container.querySelector("select");
  if (!actionSelect) throw new Error("已有节点动作场景缺少 select");
  changeSelect(actionSelect, "Added");
  await settle();
  const actionRow = Array.from(viewMount.container.querySelectorAll("li")).find((row) => row.textContent?.includes("added chunk content"));
  if (!actionRow) throw new Error("已有节点动作场景缺少 Added row");
  const relationCallsBeforeExistingStart = viewRelationCalls;
  buttonByText(actionRow, "设为起点").click();
  await settle();
  check(viewMount.container.querySelectorAll('[data-semantic-walk-node="true"]').length === 1, "已有节点设为起点应只聚焦且不得重复建点");
  check(viewRelationCalls === relationCallsBeforeExistingStart, "已有节点设为起点不得新增关系查询");

  buttonByText(viewMount.container, "选择 chunk").click();
  await settle();
  const missingSelect = viewMount.container.querySelector("select");
  if (!missingSelect) throw new Error("missing feedback 场景缺少 select");
  changeSelect(missingSelect, "Missing");
  await settle();
  const missingRow = Array.from(viewMount.container.querySelectorAll("li")).find((row) => row.textContent?.includes("missing chunk content"));
  if (!missingRow) throw new Error("missing feedback 场景缺少 Missing row");
  buttonByText(missingRow, "设为起点").click();
  await settle();
  const missingFeedback = viewMount.container.querySelector(".semantic-walk-view__feedback")?.textContent ?? "";
  check(missingFeedback.includes("不在索引"), "非空 View 的 missing start 必须显示 missing 反馈");
  viewMount.root.unmount();
  viewMount.container.remove();

  const lateChunk = chunk("Late::0", "Late", "late action chunk");
  const lifecycleNewRoot = chunk("LifecycleNew::0", "LifecycleNew", "lifecycle new root");
  const staleActionChunk = deferred<IndexedChunk>();
  const unmountedActionChunk = deferred<IndexedChunk>();
  let lateChunkRequestCount = 0;
  let lifecycleRandomCalls = 0;
  const lifecycleMount = newMount();
  lifecycleMount.root.render(
    <SemanticWalkView
      repository={{
        getChunk: async (chunkId: string) => {
          if (chunkId === rootChunk.chunkId) return rootChunk;
          if (chunkId === lifecycleNewRoot.chunkId) return lifecycleNewRoot;
          lateChunkRequestCount++;
          return lateChunkRequestCount === 1 ? staleActionChunk.promise : unmountedActionChunk.promise;
        },
        listIndexedDocuments: async () => [
          { docId: "Late", path: "Late.md", mtime: 1, chunkCount: 1 },
          { docId: "LifecycleNew", path: "LifecycleNew.md", mtime: 2, chunkCount: 1 },
        ],
        listChunksByDocument: async () => [lateChunk],
        getRandomChunk: async () => ++lifecycleRandomCalls === 1 ? rootChunk : lifecycleNewRoot,
      }}
      relationService={{ findRelatedChunks: async () => [] }}
      confirmRestart={async () => true}
    />,
  );
  await settle();
  buttonByText(lifecycleMount.container, "随机漫游").click();
  await settle();
  buttonByText(lifecycleMount.container, "选择 chunk").click();
  await settle();
  const lifecycleSelect = lifecycleMount.container.querySelector("select");
  if (!lifecycleSelect) throw new Error("View lifecycle 场景缺少 select");
  changeSelect(lifecycleSelect, "Late");
  await settle();
  const lifecycleRow = Array.from(lifecycleMount.container.querySelectorAll("li")).find((row) => row.textContent?.includes("late action chunk"));
  if (!lifecycleRow) throw new Error("View lifecycle 场景缺少 Late row");
  buttonByText(lifecycleRow, "设为起点").click();
  await settle();
  headerNewBatchButton(lifecycleMount.container).click();
  await settle();
  await settle();
  check(lifecycleMount.container.textContent?.includes("lifecycle new root"), "旧 action 在途时点击真实 toolbar 必须显示新 root");
  check(!lifecycleMount.container.textContent?.includes("StrictMode root"), "旧 action 在途时换一批必须清除旧 root");
  let staleActionReads = 0;
  staleActionChunk.resolve(new Proxy(lateChunk, {
    get(target, property, receiver) {
      if (property === "chunkId" || property === "content") staleActionReads++;
      return Reflect.get(target, property, receiver);
    },
  }));
  await settle();
  check(staleActionReads === 0, "reset 后过期 View action 不得读取或提交迟到 chunk");
  check(!lifecycleMount.container.textContent?.includes("late action chunk"), "换一批后过期 View action 不得恢复旧节点");
  check(!lifecycleMount.container.textContent?.includes("不在索引"), "过期 View action 不得写入 stale missing 反馈");

  buttonByText(lifecycleMount.container, "选择 chunk").click();
  await settle();
  const unmountSelect = lifecycleMount.container.querySelector("select");
  if (!unmountSelect) throw new Error("View unmount 场景缺少 select");
  changeSelect(unmountSelect, "Late");
  await settle();
  const unmountRow = Array.from(lifecycleMount.container.querySelectorAll("li")).find((row) => row.textContent?.includes("late action chunk"));
  if (!unmountRow) throw new Error("View unmount 场景缺少 Late row");
  buttonByText(unmountRow, "设为起点").click();
  await settle();
  lifecycleMount.root.unmount();
  lifecycleMount.container.remove();
  let unmountedActionReads = 0;
  unmountedActionChunk.resolve(new Proxy(lateChunk, {
    get(target, property, receiver) {
      if (property === "chunkId" || property === "content") unmountedActionReads++;
      return Reflect.get(target, property, receiver);
    },
  }));
  await settle();
  metrics.staleActionReads = staleActionReads;
  metrics.unmountedActionReads = unmountedActionReads;
  metrics.staleActionNewRootVisible = lifecycleRandomCalls === 2;
  check(unmountedActionReads === 0, "View 卸载后 action generation 必须丢弃迟到 chunk");

  setLocale("en");
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  document.body.setAttribute("data-semantic-walk-test-result", encodeResult({ failures, metrics }));
}

run().catch((error) => {
  setLocale("en");
  document.body.setAttribute("data-semantic-walk-test-result", encodeResult({
    failures: [error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)],
    metrics: {},
  }));
});
