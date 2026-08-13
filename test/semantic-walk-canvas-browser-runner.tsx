import { createCanvasHarnessState, mountSemanticWalkCanvasHarness } from "./semantic-walk-canvas-harness";
import type { WalkSessionState } from "../src/semantic-walk/types";

interface ReadCounts {
  edgeRelation: number;
  nodeStatus: number;
}

interface ListenerRecord {
  listener: EventListenerOrEventListenerObject;
  options?: boolean | AddEventListenerOptions;
}

function waitForFrame(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 100);
  });
}

async function settle(): Promise<void> {
  await waitForFrame();
  await waitForFrame();
}

function instrumentState(state: WalkSessionState, reads: ReadCounts): WalkSessionState {
  return {
    ...state,
    nodes: Object.fromEntries(Object.entries(state.nodes).map(([id, node]) => [id, new Proxy(node, {
      get(target, property, receiver) {
        if (property === "status") reads.nodeStatus += 1;
        return Reflect.get(target, property, receiver);
      },
    })])),
    edges: Object.fromEntries(Object.entries(state.edges).map(([id, edge]) => [id, new Proxy(edge, {
      get(target, property, receiver) {
        if (property === "relationBand") reads.edgeRelation += 1;
        return Reflect.get(target, property, receiver);
      },
    })])),
  };
}

function parseTransform(transform: string): { x: number; y: number; zoom: number } {
  const match = transform.match(/translate3d\(([-\d.]+)px, ([-\d.]+)px, 0(?:px)?\) scale\(([-\d.]+)\)/);
  if (!match) throw new Error(`无法解析 scene transform: ${transform}`);
  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
}

function encodeResult(value: unknown): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(value))));
}

async function run(): Promise<void> {
  const failures: string[] = [];
  const metrics: Record<string, number | string | boolean> = {};
  const check = (condition: unknown, message: string) => {
    if (!condition) failures.push(message);
  };

  const nativeWheelAdds: ListenerRecord[] = [];
  const nativeWheelRemoves: ListenerRecord[] = [];
  const originalAdd = EventTarget.prototype.addEventListener;
  const originalRemove = EventTarget.prototype.removeEventListener;
  const originalSetPointerCapture = HTMLElement.prototype.setPointerCapture;
  const originalHasPointerCapture = HTMLElement.prototype.hasPointerCapture;
  const originalReleasePointerCapture = HTMLElement.prototype.releasePointerCapture;
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;
  const scheduledFrameIds: number[] = [];
  const cancelledFrameIds: number[] = [];
  const executedFrameIds: number[] = [];
  const frameTimers = new Map<number, number>();
  let nextFrameId = 1;

  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    const frameId = nextFrameId;
    nextFrameId += 1;
    scheduledFrameIds.push(frameId);
    const timerId = window.setTimeout(() => {
      frameTimers.delete(frameId);
      executedFrameIds.push(frameId);
      callback(performance.now());
    }, 16);
    frameTimers.set(frameId, timerId);
    return frameId;
  };
  window.cancelAnimationFrame = (frameId: number) => {
    cancelledFrameIds.push(frameId);
    const timerId = frameTimers.get(frameId);
    if (timerId !== undefined) window.clearTimeout(timerId);
    frameTimers.delete(frameId);
  };

  EventTarget.prototype.addEventListener = function(type, listener, options) {
    if (type === "wheel" && this instanceof HTMLElement && this.dataset.semanticWalkCanvas === "true") {
      nativeWheelAdds.push({ listener, options: options as AddEventListenerOptions });
    }
    return originalAdd.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function(type, listener, options) {
    if (type === "wheel" && this instanceof HTMLElement && this.dataset.semanticWalkCanvas === "true") {
      nativeWheelRemoves.push({ listener, options: options as AddEventListenerOptions });
    }
    return originalRemove.call(this, type, listener, options);
  };

  // Untrusted PointerEvents do not own a browser pointer; keep React's real handlers and replace only capture bookkeeping.
  HTMLElement.prototype.setPointerCapture = function(pointerId) { this.dataset.testPointerCapture = String(pointerId); };
  HTMLElement.prototype.hasPointerCapture = function(pointerId) { return this.dataset.testPointerCapture === String(pointerId); };
  HTMLElement.prototype.releasePointerCapture = function() { delete this.dataset.testPointerCapture; };

  const reads: ReadCounts = { edgeRelation: 0, nodeStatus: 0 };
  const rootActivationState = createCanvasHarnessState(100, 200);
  const rootActivationId = rootActivationState.rootNodeId;
  const priorFocusId = Object.keys(rootActivationState.nodes)[1];
  if (!rootActivationId || !priorFocusId) throw new Error("起点自动激活场景缺少节点");
  rootActivationState.nodes = {
    ...rootActivationState.nodes,
    [rootActivationId]: {
      ...rootActivationState.nodes[rootActivationId],
      status: "candidate",
      expanded: false,
      collapsed: false,
    },
    [priorFocusId]: { ...rootActivationState.nodes[priorFocusId], status: "focus" },
  };
  rootActivationState.focusNodeId = priorFocusId;
  const initialState = instrumentState(rootActivationState, reads);
  const container = document.getElementById("root");
  if (!container) throw new Error("缺少 #root");
  const unmount = mountSemanticWalkCanvasHarness(container, initialState);

  try {
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 220));
    await settle();
    const canvas = document.querySelector<HTMLElement>("[data-semantic-walk-canvas]");
    const scene = document.querySelector<HTMLElement>("[data-semantic-walk-scene]");
    const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-semantic-walk-node]"));
    if (!canvas || !scene || cards.length < 3) throw new Error("画布未完成真实 DOM 挂载");
    const expandCount = document.querySelector<HTMLOutputElement>('[data-test-expand-count="true"]');
    if (!expandCount) throw new Error("缺少自动展开计数器");

    const focusCards = cards.filter((card) => card.getAttribute("aria-current") === "true");
    const cardStyle = getComputedStyle(cards[1]);
    const focusStyle = getComputedStyle(focusCards[0]);
    const cardContent = cards[1].querySelector<HTMLElement>(".semantic-walk-node__content");
    if (!cardContent) throw new Error("知识卡片缺少正文");
    const cardContentStyle = getComputedStyle(cardContent);
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--interactive-accent").trim();
    const canvasStyle = getComputedStyle(canvas);
    const atmosphere = document.querySelector<HTMLElement>(".semantic-walk-canvas__atmosphere");
    check(cardStyle.width === "414px" && cardStyle.height === "276px", `标准卡片必须真实渲染为 414×276，实际 ${cardStyle.width}×${cardStyle.height}`);
    check(cardStyle.borderTopStyle === "solid", "候选卡片必须真实渲染实体边框");
    check(cardStyle.textAlign === "left", "卡片内容必须真实渲染为左对齐");
    check(!cards[1].querySelector(".semantic-walk-node__section"), "知识卡片不得显示章节小标题");
    check(cardContentStyle.fontSize === "14px", `知识卡片正文必须比 12px 基准字号增大 2px，实际 ${cardContentStyle.fontSize}`);
    check(cardContentStyle.lineHeight === "21.6px", `知识卡片正文必须在放大字号的基础上增加 2px 行距，实际 ${cardContentStyle.lineHeight}`);
    check(cards.every((card) => card.scrollHeight <= card.clientHeight), "276px 标准卡片内部不得出现垂直内容溢出");
    check(focusCards.length === 1, `初始画布必须只有一张焦点卡片，实际 ${focusCards.length}`);
    check(cards[0].getAttribute("aria-current") === "true", "进入画布后起点必须自动成为当前焦点");
    check(expandCount.textContent === "1", "未展开起点进入画布后必须自动展开一次");
    const activatedRootViewport = parseTransform(scene.style.transform);
    check(
      Math.abs(activatedRootViewport.x - (canvas.clientWidth / 2 - 207 * activatedRootViewport.zoom)) < 0.01
        && Math.abs(activatedRootViewport.y - (canvas.clientHeight / 2 - 138 * activatedRootViewport.zoom)) < 0.01,
      "进入画布后起点必须自动居中",
    );
    check(focusStyle.borderTopColor === accent || focusStyle.borderTopColor === "rgb(124, 58, 237)", "焦点边框必须使用当前主题强调色");
    check(cardStyle.borderTopColor !== focusStyle.borderTopColor, "非焦点卡片不得复用焦点强调色边框");
    check(
      canvasStyle.borderTopStyle === "solid" && Boolean(atmosphere && getComputedStyle(atmosphere).backgroundImage.includes("radial-gradient")),
      "画布必须真实渲染外框和点阵网格",
    );

    const previewTrigger = Array.from(cards[0].querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "View" || button.textContent?.trim() === "查看");
    if (!previewTrigger) throw new Error("卡片未渲染全文查看按钮");
    const fullChunkText = initialState.nodes[cards[0].getAttribute("data-node-id") ?? initialState.rootNodeId ?? ""]?.chunk.content
      ?? Object.values(initialState.nodes)[0].chunk.content;
    previewTrigger.click();
    await settle();
    let previewDialog = canvas.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
    check(Boolean(previewDialog), "查看必须打开画布内对话框");
    check(previewDialog?.textContent?.includes(fullChunkText), "对话框必须显示未截断全文");
    if (!previewDialog) throw new Error("全文对话框未完成挂载");
    const previewBounds = previewDialog.getBoundingClientRect();
    const previewCanvasBounds = canvas.getBoundingClientRect();
    check(
      Math.abs(previewBounds.left + previewBounds.width / 2 - (previewCanvasBounds.left + previewCanvasBounds.width / 2)) <= 2
        && Math.abs(previewBounds.top + previewBounds.height / 2 - (previewCanvasBounds.top + previewCanvasBounds.height / 2)) <= 2,
      "全文对话框必须在画布可视区域居中",
    );
    const closePreviewButton = previewDialog.querySelector<HTMLButtonElement>('.semantic-walk-preview__close');
    check(document.activeElement === closePreviewButton, "打开全文后焦点必须进入关闭按钮");
    const beforePreviewWheel = scene.style.transform;
    previewDialog.querySelector<HTMLElement>(".semantic-walk-preview__content")?.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 80,
    }));
    await settle();
    check(scene.style.transform === beforePreviewWheel, "阅读全文时滚动不得改变画布 viewport");
    closePreviewButton?.click();
    await settle();
    check(!canvas.querySelector('[role="dialog"]'), "关闭按钮必须关闭全文对话框");
    check(document.activeElement === previewTrigger, "关闭全文后焦点必须返回查看按钮");

    previewTrigger.click();
    await settle();
    const previewBackdrop = canvas.querySelector<HTMLElement>(".semantic-walk-preview");
    previewBackdrop?.click();
    await settle();
    check(!canvas.querySelector('[role="dialog"]'), "点击遮罩必须关闭全文对话框");

    previewTrigger.click();
    await settle();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle();
    check(!canvas.querySelector('[role="dialog"]'), "Esc 必须关闭全文对话框");

    const toolbar = document.querySelector<HTMLElement>('[data-semantic-walk-toolbar="true"]');
    const toolbarGroups = Array.from(document.querySelectorAll<HTMLElement>(".semantic-walk-toolbar__group"));
    if (!toolbar) throw new Error("画布未渲染工具栏");
    const toolbarBounds = toolbar.getBoundingClientRect();
    const canvasBounds = canvas.getBoundingClientRect();
    check(toolbarBounds.right <= canvasBounds.right && toolbarBounds.bottom <= canvasBounds.bottom, "窄窗口工具栏必须保持在画布边界内");
    for (let index = 1; index < toolbarGroups.length; index += 1) {
      const previous = toolbarGroups[index - 1].getBoundingClientRect();
      const current = toolbarGroups[index].getBoundingClientRect();
      check(previous.right <= current.left || previous.bottom <= current.top, "窄窗口工具组不得互相重叠");
    }

    const lightCardBackground = cardStyle.backgroundColor;
    document.documentElement.style.setProperty("--background-primary", "#17171a");
    document.documentElement.style.setProperty("--background-primary-alt", "#111114");
    document.documentElement.style.setProperty("--text-normal", "#f4f4f5");
    await settle();
    const darkCardBackground = getComputedStyle(cards[1]).backgroundColor;
    check(darkCardBackground !== lightCardBackground && darkCardBackground !== "rgba(0, 0, 0, 0)", "深色主题下卡片必须使用不透明主题背景");
    document.documentElement.style.setProperty("--background-primary", "#ffffff");
    document.documentElement.style.setProperty("--background-primary-alt", "#f7f7f8");
    document.documentElement.style.setProperty("--text-normal", "#202024");
    await settle();

    const listenerOptions = nativeWheelAdds[0]?.options;
    const passive = typeof listenerOptions === "object" ? listenerOptions?.passive : undefined;
    check(nativeWheelAdds.length === 1 && passive === false, "canvas 必须注册一个 passive:false 的原生 wheel listener");

    const styleMutations: MutationRecord[] = [];
    const sceneObserver = new MutationObserver((records) => styleMutations.push(...records));
    sceneObserver.observe(scene, { attributes: true, attributeFilter: ["style"] });
    const beforePan = scene.style.transform;
    const edgeReadsBeforePan = reads.edgeRelation;
    const nodeReadsBeforePan = reads.nodeStatus;
    const panEvents = Array.from({ length: 6 }, () => new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX: 3,
      deltaY: 5,
    }));
    for (const event of panEvents) canvas.dispatchEvent(event);
    await settle();

    metrics.panStyleMutations = styleMutations.length;
    metrics.edgeReadsBeforePan = edgeReadsBeforePan;
    metrics.edgeReadsAfterPan = reads.edgeRelation;
    metrics.nodeReadsBeforePan = nodeReadsBeforePan;
    metrics.nodeReadsAfterPan = reads.nodeStatus;
    check(panEvents.every((event) => event.defaultPrevented), "wheel 必须实际 preventDefault，不能落入 passive delegated listener");
    check(scene.style.transform !== beforePan, "wheel 平移必须更新 viewport transform");
    check(styleMutations.length === 1, `同一帧 6 次 wheel 应合并为 1 次 DOM transform 更新，实际 ${styleMutations.length}`);
    check(reads.edgeRelation === edgeReadsBeforePan, "compact 阈值不变的 viewport 帧不得重新渲染 200 条边");
    check(reads.nodeStatus === nodeReadsBeforePan, "仅 viewport 变化时 memo 节点不得因 harness 回调引用变化而重渲染");
    check(expandCount.textContent === "1", "viewport 更新不得重复展开起点");

    styleMutations.length = 0;
    const beforeZoom = parseTransform(scene.style.transform);
    const zoomAnchor = { x: 320, y: 240 };
    const zoomEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      clientX: zoomAnchor.x,
      clientY: zoomAnchor.y,
      deltaY: -40,
    });
    canvas.dispatchEvent(zoomEvent);
    await settle();
    const afterZoom = parseTransform(scene.style.transform);
    metrics.beforeZoom = `${beforeZoom.x},${beforeZoom.y},${beforeZoom.zoom}`;
    metrics.afterZoom = `${afterZoom.x},${afterZoom.y},${afterZoom.zoom}`;
    const beforeWorldX = (zoomAnchor.x - beforeZoom.x) / beforeZoom.zoom;
    const beforeWorldY = (zoomAnchor.y - beforeZoom.y) / beforeZoom.zoom;
    const afterWorldX = (zoomAnchor.x - afterZoom.x) / afterZoom.zoom;
    const afterWorldY = (zoomAnchor.y - afterZoom.y) / afterZoom.zoom;
    check(zoomEvent.defaultPrevented, "Ctrl/Cmd + wheel 缩放必须实际 preventDefault");
    check(afterZoom.zoom > beforeZoom.zoom, "Ctrl + 向上滚轮应放大 viewport");
    check(Math.abs(beforeWorldX - afterWorldX) < 0.001 && Math.abs(beforeWorldY - afterWorldY) < 0.001, "缩放必须保持鼠标锚点的世界坐标");

    const dragCard = cards[1];
    const dragBefore = dragCard.style.transform;
    const dragMutations: MutationRecord[] = [];
    const dragObserver = new MutationObserver((records) => dragMutations.push(...records));
    dragObserver.observe(dragCard, { attributes: true, attributeFilter: ["style", "data-position-mode"] });
    dragCard.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 7, clientX: 100, clientY: 100 }));
    for (let index = 1; index <= 5; index += 1) {
      dragCard.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, button: 0, pointerId: 7, clientX: 100 + index * 8, clientY: 100 + index * 4 }));
    }
    await settle();
    dragCard.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 7, clientX: 140, clientY: 120 }));
    await settle();
    check(dragCard.style.transform !== dragBefore, "pointer drag 必须移动真实节点 DOM");
    check(dragCard.dataset.positionMode === "manual", "pointer drag 必须把节点标记为 manual");
    check(dragMutations.filter((record) => record.attributeName === "style").length === 1, "同一帧多次 pointermove 应合并为一次节点位置 DOM 更新");
    dragObserver.disconnect();

    const keyboardCard = cards[22];
    const beforeEnter = scene.style.transform;
    const enterEvent = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    keyboardCard.dispatchEvent(enterEvent);
    await settle();
    metrics.beforeEnter = beforeEnter;
    metrics.afterEnter = scene.style.transform;
    check(enterEvent.defaultPrevented && scene.style.transform !== beforeEnter, "Enter 必须设焦点并居中节点");
    check(expandCount.textContent === "2", "Enter 聚焦未展开节点时必须自动展开一次");
    keyboardCard.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    check(expandCount.textContent === "2", "已展开节点再次聚焦不得重复查询或折叠");

    const pointerFocusCard = cards[23];
    pointerFocusCard.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 9, clientX: 180, clientY: 160 }));
    pointerFocusCard.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 9, clientX: 180, clientY: 160 }));
    await settle();
    check(pointerFocusCard.getAttribute("aria-current") === "true", "单击卡片必须将其设为唯一当前焦点");
    check(document.querySelectorAll('[data-semantic-walk-node][aria-current="true"]').length === 1, "同一时刻只能有一张焦点卡片");
    check(expandCount.textContent === "3", "单击未展开卡片必须自动展开一次");
    pointerFocusCard.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 10, clientX: 180, clientY: 160 }));
    pointerFocusCard.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 10, clientX: 180, clientY: 160 }));
    await settle();
    check(expandCount.textContent === "3", "再次单击已展开卡片不得重复展开");

    const spaceEvent = new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true });
    keyboardCard.dispatchEvent(spaceEvent);
    check(spaceEvent.defaultPrevented, "Space 必须触发展开键盘行为并阻止页面滚动");

    const beforePendingFocus = parseTransform(scene.style.transform);
    canvas.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      clientX: 280,
      clientY: 210,
      deltaY: -80,
    }));
    keyboardCard.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    const afterPendingFocus = parseTransform(scene.style.transform);
    check(afterPendingFocus.zoom > beforePendingFocus.zoom, "居中/聚焦计算必须基于尚未提交的 pending viewport，不能丢失同帧缩放");

    canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 15, deltaY: 25 }));
    const supersededFrameId = scheduledFrameIds[scheduledFrameIds.length - 1];
    const controlledButton = document.querySelector<HTMLButtonElement>('[data-test-controlled-viewport="true"]');
    if (!controlledButton) throw new Error("缺少 controlled viewport 测试入口");
    controlledButton.click();
    await settle();
    const controlledTransform = parseTransform(scene.style.transform);
    check(cancelledFrameIds.includes(supersededFrameId), "controlled viewport 同步必须取消旧 pending rAF");
    check(
      controlledTransform.x === 321 && controlledTransform.y === 123 && controlledTransform.zoom === 1.2,
      `controlled viewport 不得被旧 rAF 覆盖，实际 ${scene.style.transform}`,
    );

    sceneObserver.disconnect();
    canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 20 }));
    const pendingViewportFrameId = scheduledFrameIds[scheduledFrameIds.length - 1];
    check(!executedFrameIds.includes(pendingViewportFrameId), "卸载前测试必须捕获一个尚未执行的 viewport rAF ID");
    unmount();
    await settle();
    metrics.pendingViewportFrameId = pendingViewportFrameId;
    metrics.cancelledPendingFrame = cancelledFrameIds.includes(pendingViewportFrameId);
    metrics.executedPendingFrame = executedFrameIds.includes(pendingViewportFrameId);
    check(cancelledFrameIds.includes(pendingViewportFrameId), `unmount cleanup 必须 cancel pending viewport rAF #${pendingViewportFrameId}`);
    check(!executedFrameIds.includes(pendingViewportFrameId), `unmount 后 pending viewport rAF #${pendingViewportFrameId} 的回调不得执行`);
    check(nativeWheelRemoves.length === 1 && nativeWheelRemoves[0].listener === nativeWheelAdds[0]?.listener, "unmount 必须移除同一个原生 wheel listener");
    const detachedWheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 10 });
    canvas.dispatchEvent(detachedWheel);
    check(!detachedWheel.defaultPrevented, "卸载后旧 canvas 不得继续处理 wheel");

    const collapsedState = createCanvasHarnessState(1, 0);
    const collapsedRootId = collapsedState.rootNodeId;
    if (!collapsedRootId) throw new Error("收起保护场景缺少起点");
    collapsedState.nodes = {
      ...collapsedState.nodes,
      [collapsedRootId]: {
        ...collapsedState.nodes[collapsedRootId],
        expanded: false,
        collapsed: true,
      },
    };
    const unmountCollapsed = mountSemanticWalkCanvasHarness(container, collapsedState);
    await settle();
    const collapsedExpandCount = container.querySelector<HTMLOutputElement>('[data-test-expand-count="true"]');
    check(collapsedExpandCount?.textContent === "0", "重新进入画布时手动收起的起点必须保持收起");
    unmountCollapsed();
    await settle();
  } finally {
    EventTarget.prototype.addEventListener = originalAdd;
    EventTarget.prototype.removeEventListener = originalRemove;
    HTMLElement.prototype.setPointerCapture = originalSetPointerCapture;
    HTMLElement.prototype.hasPointerCapture = originalHasPointerCapture;
    HTMLElement.prototype.releasePointerCapture = originalReleasePointerCapture;
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
  }

  document.body.setAttribute("data-semantic-walk-test-result", encodeResult({ failures, metrics }));
}

run().catch((error) => {
  document.body.setAttribute("data-semantic-walk-test-result", encodeResult({
    failures: [error instanceof Error ? `${error.name}: ${error.message}` : String(error)],
    metrics: {},
  }));
});
