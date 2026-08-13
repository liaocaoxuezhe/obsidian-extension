import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { OnboardingView, type OnboardingViewCoordinator } from "../src/onboarding/OnboardingView";
import { OnboardingModal } from "../src/onboarding/OnboardingModal";
import { OnboardingCoordinator } from "../src/onboarding/onboarding-coordinator";
import { createOnboardingDiagnosticText } from "../src/onboarding/components/SetupError";
import type { LegacyIndexChoice, OnboardingSnapshot, QuickIndexScope } from "../src/onboarding/onboarding-types";
import { setLocale } from "../src/util/i18n";

function snapshot(overrides: Partial<OnboardingSnapshot> = {}): OnboardingSnapshot {
  return {
    schemaVersion: 1, stage: "not-started", progress: null, completedBytes: null, totalBytes: null,
    currentItem: "", runtimePlatform: "darwin-arm64", chromaRuntimeId: "chroma-cli-1.4.4-darwin-arm64",
    embeddingRuntimeId: "embedding-runtime-node22-v1-darwin-arm64", selectedIndexScope: null,
    legacyIndexChoice: null, legacyRecordsCopied: null, legacyRecordsTotal: null, legacySourceBytes: null,
    startedAt: 1, updatedAt: 1000, completedAt: null, dismissedAt: null, error: null, ...overrides,
  };
}

class FakeCoordinator implements OnboardingViewCoordinator {
  value: Readonly<OnboardingSnapshot>;
  listeners = new Set<(value: Readonly<OnboardingSnapshot>) => void>();
  calls: Array<string | QuickIndexScope | LegacyIndexChoice> = [];
  constructor(value: OnboardingSnapshot) { this.value = value; }
  getSnapshot() { return this.value; }
  subscribe(listener: (value: Readonly<OnboardingSnapshot>) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  provideConsent(accepted: boolean) { this.calls.push(accepted ? "consent" : "later"); return Promise.resolve(true); }
  selectIndexScope(scope: QuickIndexScope) { this.calls.push(scope); return Promise.resolve(true); }
  selectLegacyIndexAction(choice: LegacyIndexChoice) { this.calls.push(choice); return Promise.resolve(true); }
  retry() { this.calls.push("retry"); return Promise.resolve(this.value); }
  start() { this.calls.push("start"); return Promise.resolve(this.value); }
  resume() { this.calls.push("resume"); return Promise.resolve(this.value); }
  cancel() { this.calls.push("cancel"); return Promise.resolve(); }
  publish(value: OnboardingSnapshot) {
    this.value = value;
    for (const listener of [...this.listeners]) listener(value);
  }
}

type Mounted = { container: HTMLDivElement; root: Root; coordinator: FakeCoordinator; calls: string[] };

function mount(value: OnboardingSnapshot, options: { narrow?: boolean; dark?: boolean; mode?: "setup" | "repair" } = {}): Mounted {
  const container = document.createElement("div");
  container.className = `scenario${options.narrow ? " narrow" : ""}${options.dark ? " theme-dark" : ""}`;
  document.body.appendChild(container);
  const root = createRoot(container);
  const coordinator = new FakeCoordinator(value);
  const calls: string[] = [];
  root.render(<OnboardingView
    coordinator={coordinator}
    mode={options.mode ?? "setup"}
    onClose={() => calls.push("close")}
    onStartSearching={() => calls.push("search")}
    onOpenOllama={() => calls.push("ollama")}
    onOpenHelp={() => calls.push("help")}
    onChangePort={() => calls.push("port")}
    pluginBuildId="1.1.9+task12"
    diagnosticEvents={[{ code: "DOWNLOAD.RETRY", asset: "chroma", outcome: "failed", path: "/Users/private/Vault/note.md?token=secret" } as any]}
  />);
  return { container, root, coordinator, calls };
}

async function settle() {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function button(container: ParentNode, text: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === text);
  if (!result) throw new Error(`找不到按钮：${text}`);
  return result as HTMLButtonElement;
}

function inputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function encode(value: unknown) { return btoa(unescape(encodeURIComponent(JSON.stringify(value)))); }

async function run(): Promise<void> {
  const failures: string[] = [];
  const metrics: Record<string, unknown> = {};
  const check = (condition: unknown, message: string) => { if (!condition) failures.push(message); };
  let clipboard = "";
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { clipboard = value; } } });

  setLocale("zh");
  const welcome = mount(snapshot({ stage: "awaiting-consent" }));
  await settle();
  check(welcome.container.querySelector("h1")?.textContent === "建立本地语义环境", "欢迎页应有本地化 h1");
  check(document.activeElement === welcome.container.querySelector("h1"), "打开状态后焦点应进入主标题");
  button(welcome.container, "同意并开始").click();
  await settle();
  check(welcome.coordinator.calls[0] === "consent", "同意按钮必须调用 coordinator consent");
  const later = mount(snapshot({ stage: "awaiting-consent" }));
  await settle();
  button(later.container, "稍后再说").click();
  button(later.container, "关闭").click();
  await settle();
  check(later.coordinator.calls.includes("later"), "稍后必须由 coordinator/store 持久化");
  check(later.calls.includes("close") && !later.coordinator.calls.includes("cancel"), "关闭只能隐藏 UI，不能取消后台流程");

  const progress = mount(snapshot({ stage: "downloading-chroma", progress: 42, completedBytes: 42_000_000, totalBytes: 100_000_000, currentItem: "/private/cache/chroma.zip?token=secret" }));
  await settle();
  const progressbar = progress.container.querySelector<HTMLElement>('[role="progressbar"]');
  check(progressbar?.getAttribute("aria-valuenow") === "42", "确定进度应提供 aria-valuenow");
  check(!progressbar?.closest('[aria-live]'), "连续 progress 更新不得放入 aria-live 区域");
  check(progress.container.textContent?.includes("42.0 MB / 100.0 MB"), "大小应使用十进制 MB");
  check(progress.container.textContent?.includes("chroma.zip") && !progress.container.textContent?.includes("private/cache"), "当前项只显示 basename");
  check(!progress.container.textContent?.includes("downloading-chroma"), "不得显示内部 stage 名");
  button(progress.container, "取消下载").click();
  await settle();
  check(progress.coordinator.calls.includes("cancel"), "只有显式取消按钮调用 coordinator.cancel");
  const indeterminate = mount(snapshot({ stage: "warming-up-model", progress: null }));
  await settle();
  const unknownBar = indeterminate.container.querySelector<HTMLElement>('[role="progressbar"]');
  check(!unknownBar?.hasAttribute("aria-valuenow") && unknownBar?.getAttribute("aria-label") === "正在准备模型，进度未知", "未知进度必须是有标签的 indeterminate progressbar");

  const actions = [
    ["retry", "重试", "retry"], ["redownload", "重新下载", "retry"],
    ["change-port", "更换端口", "port"], ["open-help", "查看帮助", "help"], ["none", "关闭", "close"],
  ] as const;
  for (const [action, label, expected] of actions) {
    const failed = mount(snapshot({ stage: "failed", error: {
      code: action === "change-port" ? "CHROMA_PORT_CONFLICT" : action === "redownload" ? "DOWNLOAD_HASH_MISMATCH" : action === "open-help" ? "UNSUPPORTED_PLATFORM" : "CHROMA_START_TIMEOUT",
      stage: "starting-chroma", userMessageKey: action === "change-port" ? "onboarding.error.chroma_port_conflict" : "onboarding.error.chroma_start_timeout",
      technicalMessage: "bounded", recoverable: action !== "none", action,
    } }));
    await settle();
    check(failed.container.querySelectorAll('[data-primary-action="true"]').length === 1, `${action} 错误必须只有一个主动作`);
    button(failed.container, label).click();
    await settle();
    check(expected === "retry" ? failed.coordinator.calls.includes("retry") : failed.calls.includes(expected), `${action} 主动作映射错误`);
    const details = failed.container.querySelector("details");
    check(Boolean(details) && !details?.hasAttribute("open"), "技术信息默认折叠");
    (details?.querySelector("summary") as HTMLElement | null)?.click();
    await settle();
    const copy = Array.from(failed.container.querySelectorAll("button")).find((item) => item.textContent?.trim() === "复制诊断") as HTMLButtonElement | undefined;
    copy?.click();
    await settle();
  }
  check(clipboard.includes("CHROMA_START_TIMEOUT") && clipboard.includes("darwin-arm64"), "复制诊断应包含 allowlist 字段");
  check(clipboard.includes("1.1.9+task12"), "复制诊断应保留安全的插件 build ID");
  check(!/\/Users\/|\/opt\/|9123|8000|secret|token=/i.test(clipboard), "复制诊断不得包含路径、PID、端口或令牌");

  const structuredDiagnostic = JSON.parse(createOnboardingDiagnosticText(
    snapshot({ stage: "failed", error: {
      code: "DOWNLOAD_NETWORK_ERROR", stage: "downloading-chroma",
      userMessageKey: "onboarding.error.download_network_error", technicalMessage: "bounded",
      recoverable: true, action: "retry",
    } }),
    "1.1.9+safe-build",
    [
      { code: "STAGE_STARTED", asset: "chroma", outcome: "started", attempt: 2, path: "/Users/张三/Vault/秘密.md", replace: () => "legacy path /Users/张三/Vault/秘密.md" },
      { code: "RUNTIME_VERIFIED", asset: "embedding-runtime", outcome: "complete", windowsPath: "C:\\Users\\Alice\\Vault\\秘密.md", replace: () => "legacy windows" },
      { code: "RUNTIME_INSTALLED", asset: "embedding-runtime", outcome: "complete", relativePath: "../Vault/秘密.md", replace: () => "legacy relative ../Vault/秘密.md" },
      { code: "CHROMA_READY", asset: "chroma", outcome: "complete", url: "https://example.test/model?token=secret", replace: () => "legacy url" },
      { code: "EMBEDDING_READY", asset: "embedding-model", outcome: "complete", encoded: "%2FUsers%2FAlice%2FVault%2Fsecret.md%3Ftoken%3Dsecret", replace: () => "legacy encoded %2FUsers%2FAlice%2FVault%2Fsecret.md" },
      { code: "QUICK_INDEX_COMPLETED", asset: "quick-index", outcome: "complete", pid: 9123, port: 8000, modelInput: "private prompt content", stack: "workerFn (/app/main.js:10:2)", replace: () => "legacy stack" },
    ] as any,
  ));
  check(JSON.stringify(structuredDiagnostic) === JSON.stringify({
    code: "DOWNLOAD_NETWORK_ERROR",
    stage: "downloading-chroma",
    platform: "darwin-arm64",
    chromaRuntimeId: "chroma-cli-1.4.4-darwin-arm64",
    embeddingRuntimeId: "embedding-runtime-node22-v1-darwin-arm64",
    pluginBuildId: "1.1.9+safe-build",
    log: [
      { code: "STAGE_STARTED", asset: "chroma", outcome: "started", attempt: 2 },
      { code: "RUNTIME_VERIFIED", asset: "embedding-runtime", outcome: "complete" },
      { code: "RUNTIME_INSTALLED", asset: "embedding-runtime", outcome: "complete" },
      { code: "CHROMA_READY", asset: "chroma", outcome: "complete" },
      { code: "EMBEDDING_READY", asset: "embedding-model", outcome: "complete" },
      { code: "QUICK_INDEX_COMPLETED", asset: "quick-index", outcome: "complete" },
    ],
  }), "结构化诊断必须只保留固定顶层字段和预定义 event allowlist");
  const structuredText = JSON.stringify(structuredDiagnostic);
  check(!/秘密|Users|Alice|\.\.\/|https|%2F|secret|9123|8000|prompt|content|workerFn|main\.js/i.test(structuredText), "结构化诊断不得保留六类恶意 payload 或编码路径");
  const noSafeEvents = JSON.parse(createOnboardingDiagnosticText(snapshot({ stage: "failed" }), "safe-build", [
    "RAW FREE TEXT", { code: "lowercase.event", message: "secret", replace: () => "legacy lowercase" }, { code: "UPPER OK", attempt: -1, replace: () => "legacy uppercase" },
  ] as any));
  check(!Object.prototype.hasOwnProperty.call(noSafeEvents, "log"), "没有完全安全的结构化 event 时必须省略 log");
  const eventCodePrivacy = JSON.parse(createOnboardingDiagnosticText(snapshot({ stage: "failed" }), "safe-build", [
    { code: "STAGE_STARTED", asset: "chroma", outcome: "started", attempt: 1 },
    { code: "PID.9123.PORT.8000", asset: "chroma", outcome: "failed" },
    { code: "TOKEN.SECRET_ABC123", asset: "embedding-model", outcome: "failed" },
    { code: "MODEL_INPUT.PRIVATE_PROMPT_CONTENT", asset: "embedding-model", outcome: "failed" },
    { code: "C_USERS_ALICE_VAULT_SECRET_MD", asset: "quick-index", outcome: "failed" },
    { code: "ЅTAGE_STARTED", asset: "chroma", outcome: "started" },
    { code: `STAGE_${"A".repeat(80)}`, asset: "chroma", outcome: "started" },
  ]));
  check(JSON.stringify(eventCodePrivacy.log) === JSON.stringify([
    { code: "STAGE_STARTED", asset: "chroma", outcome: "started", attempt: 1 },
  ]), "格式合法但不在固定 event code 集合中的敏感编码必须整条丢弃");
  const onlyPrivateCodes = JSON.parse(createOnboardingDiagnosticText(snapshot({ stage: "failed" }), "safe-build", [
    { code: "PID.9123.PORT.8000" }, { code: "TOKEN.SECRET_ABC123" },
    { code: "MODEL_INPUT.PRIVATE_PROMPT_CONTENT" }, { code: "C_USERS_ALICE_VAULT_SECRET_MD" },
    { code: "ЅTAGE_STARTED" }, { code: `STAGE_${"A".repeat(80)}` },
  ]));
  check(!Object.prototype.hasOwnProperty.call(onlyPrivateCodes, "log"), "仅含未知或隐私编码时必须省略 log");

  const invalidFolder = mount(snapshot({ stage: "selecting-index-scope" }));
  await settle();
  (invalidFolder.container.querySelector('input[value="folder"]') as HTMLInputElement).click();
  const folderInput = invalidFolder.container.querySelector<HTMLInputElement>('input[name="onboarding-folder"]')!;
  inputValue(folderInput, "../秘密/笔记");
  button(invalidFolder.container, "开始建立索引").click();
  await settle();
  check(invalidFolder.container.querySelector('[role="alert"]')?.textContent?.includes("仓库内的相对路径"), "非法 folder 路径必须有本地化 announce");
  check(!invalidFolder.coordinator.calls.some((entry) => typeof entry === "object"), "非法 folder 不得继续 coordinator");
  inputValue(folderInput, "项目/中文 笔记");
  button(invalidFolder.container, "开始建立索引").click();
  await settle();
  check(JSON.stringify(invalidFolder.coordinator.calls).includes("项目/中文 笔记"), "合法 folder 必须继续一次");

  for (const [scopeValue, expected] of [["recent", "recent"], ["vault", "vault"]] as const) {
    const scoped = mount(snapshot({ stage: "selecting-index-scope" }));
    await settle();
    (scoped.container.querySelector(`input[value="${scopeValue}"]`) as HTMLInputElement).click();
    button(scoped.container, "开始建立索引").click();
    button(scoped.container, "开始建立索引").click();
    await settle();
    const scopeCalls = scoped.coordinator.calls.filter((entry) => typeof entry === "object") as QuickIndexScope[];
    check(scopeCalls.length === 1 && scopeCalls[0].type === expected, `${scopeValue} 选择必须且只能继续一次`);
  }
  check(invalidFolder.container.textContent?.includes("最近 30 篇"), "recent 应说明 30 篇上限");
  check(invalidFolder.container.textContent?.includes("许可证容量"), "vault 应说明许可证容量");

  const legacyReuse = mount(snapshot({
    stage: "selecting-legacy-index-action", legacyRecordsTotal: 1_200, legacySourceBytes: 800_000_000,
  }));
  await settle();
  check(legacyReuse.container.textContent?.includes("复用旧索引（推荐）"), "旧索引用户应看到推荐的零重算迁移入口");
  check(legacyReuse.container.textContent?.includes("1,200") && legacyReuse.container.textContent?.includes("800.0 MB"), "旧索引选择页应显示预计记录数和快照空间");
  button(legacyReuse.container, "复用旧索引（推荐）").click();
  button(legacyReuse.container, "复用旧索引（推荐）").click();
  await settle();
  check(legacyReuse.coordinator.calls.filter((entry) => entry === "reuse").length === 1, "复用旧索引只能提交一次");

  const legacyRebuild = mount(snapshot({ stage: "selecting-legacy-index-action" }));
  await settle();
  button(legacyRebuild.container, "重新建立索引").click();
  await settle();
  check(legacyRebuild.coordinator.calls.includes("rebuild"), "重建动作必须显式交给 coordinator");

  const legacyLater = mount(snapshot({ stage: "selecting-legacy-index-action" }));
  await settle();
  button(legacyLater.container, "稍后处理").click();
  await settle();
  check(legacyLater.coordinator.calls.includes("later"), "稍后处理必须持久化选择，不能静默重建");

  const complete = mount(snapshot({ stage: "ready", progress: 100, completedAt: 2000 }));
  await settle();
  button(complete.container, "开始搜索").click();
  button(complete.container, "设置 Ollama 摘要增强").click();
  await settle();
  check(complete.calls.includes("search") && complete.calls.includes("ollama"), "完成页动作必须显式触发且不自动导航");

  const opener = document.createElement("button");
  document.body.appendChild(opener);
  opener.focus();
  const modalCoordinator = new FakeCoordinator(snapshot({ stage: "downloading-embedding-runtime", progress: 12 }));
  let modalClosed = 0;
  const modal = new OnboardingModal({} as any, {
    coordinator: modalCoordinator as any, mode: "setup", pluginBuildId: "task12-build",
    onStartSearching() {}, onOpenOllama() {}, onOpenHelp() {}, onChangePort() {}, onDidClose() { modalClosed += 1; },
  });
  modal.open();
  await settle();
  check(modalCoordinator.listeners.size === 1, "Modal 打开后应只有一个 coordinator 订阅");
  modal.close();
  await settle();
  check(!modalCoordinator.calls.includes("cancel"), "Modal close/unmount 不得取消后台安装");
  check(modalCoordinator.listeners.size === 0 && modalClosed === 1, "Modal close 必须退订且只完成一次关闭生命周期");
  check(document.activeElement === opener, "Modal 关闭后焦点必须返回 opener");

  const ollamaModalCoordinator = new FakeCoordinator(snapshot({ stage: "ready", progress: 100, completedAt: 2000 }));
  let ollamaModalClosed = 0;
  let ollamaNavigationSawClosedModal = false;
  const ollamaModal = new OnboardingModal({} as any, {
    coordinator: ollamaModalCoordinator as any, mode: "setup", pluginBuildId: "task12-ollama-navigation",
    onStartSearching() {},
    onOpenOllama() { ollamaNavigationSawClosedModal = !document.body.contains(ollamaModal.modalEl); },
    onOpenHelp() {}, onChangePort() {}, onDidClose() { ollamaModalClosed += 1; },
  });
  ollamaModal.open();
  await settle();
  button(ollamaModal.contentEl, "设置 Ollama 摘要增强").click();
  await settle();
  check(ollamaNavigationSawClosedModal, "Ollama 导航回调执行前必须关闭 onboarding modal，避免设置页被遮挡");
  check(ollamaModalClosed === 1 && ollamaModalCoordinator.listeners.size === 0, "Ollama 导航必须完成 modal 清理且只关闭一次");

  const persistedFailure = snapshot({ stage: "failed", error: {
    code: "UNSUPPORTED_PLATFORM", stage: "checking", userMessageKey: "onboarding.error.unsupported_platform",
    technicalMessage: "UNSUPPORTED_PLATFORM", recoverable: false, action: "open-help",
  } });
  let unexpectedDetectCalls = 0;
  const persistedCoordinator = new OnboardingCoordinator({
    detectEnvironment: async () => { unexpectedDetectCalls += 1; throw new Error("must fail closed"); },
    store: { load: async () => ({ snapshot: persistedFailure }), save: async () => { throw new Error("must not save"); } },
    runtimes: { chroma: {} as any, embedding: {} as any },
    chromaManager: {} as any, chromaStartOptions: () => ({} as any), embeddingRuntimeManager: {} as any,
    embeddingModel: { download: async () => {}, warmUp: async () => {}, cancel: async () => {} },
    quickIndex: { run: async () => ({ requested: 0, indexed: 0, skipped: 0, failed: 0, chunkCount: 0 }) },
  });
  const persistedModal = new OnboardingModal({} as any, {
    coordinator: persistedCoordinator, mode: "repair", pluginBuildId: "task12-fail-closed",
    onStartSearching() {}, onOpenOllama() {}, onOpenHelp() {}, onChangePort() {}, onDidClose() {},
  });
  persistedModal.open();
  await settle();
  await settle();
  check(Boolean(persistedModal.contentEl.querySelector(".analogy-onboarding-error")), "首次打开必须显示持久化不可恢复失败页");
  check(persistedModal.contentEl.querySelector('[data-primary-action="true"]')?.textContent === "查看帮助", "持久化不可恢复失败必须显示帮助动作");
  check(!persistedModal.contentEl.querySelector(".analogy-onboarding-welcome")
    && !/同意并开始|Agree and begin/.test(persistedModal.contentEl.textContent ?? ""), "持久化不可恢复失败不得回退到 welcome consent");
  check(unexpectedDetectCalls === 0, "持久化不可恢复失败必须在 detect 前 fail closed");
  persistedModal.close();
  await persistedCoordinator.dispose();

  const repair = mount(snapshot({ stage: "checking" }), { mode: "repair", dark: true });
  await settle();
  check(repair.container.querySelector("h1")?.textContent === "修复本地语义环境", "repair 模式标题错误");
  check(getComputedStyle(repair.container.querySelector(".analogy-onboarding")!).color !== "rgb(37, 35, 31)", "dark 主题必须继承 Obsidian 变量");

  const narrow = mount(snapshot({ stage: "selecting-index-scope" }), { narrow: true });
  await settle();
  const panel = narrow.container.querySelector<HTMLElement>(".analogy-onboarding")!;
  check(panel.scrollWidth <= narrow.container.clientWidth, "320px 窄宽不应横向溢出");
  const primary = narrow.container.querySelector<HTMLElement>('[data-primary-action="true"]')!;
  check(primary.getBoundingClientRect().height >= 44, "主动作触控高度至少 44px");
  check(narrow.container.querySelectorAll('input[type="radio"]').length === 3, "范围选择应使用三个原生 radio");

  setLocale("en");
  const english = mount(snapshot({ stage: "awaiting-consent" }));
  await settle();
  check(english.container.querySelector("h1")?.textContent === "Set up local semantic search", "英文欢迎标题缺失");
  check(button(english.container, "Agree and begin").textContent === "Agree and begin", "英文 CTA 应为 sentence case");

  const allStages: OnboardingSnapshot["stage"][] = [
    "not-started", "checking", "awaiting-consent", "downloading-chroma", "verifying-chroma", "installing-chroma",
    "downloading-embedding-runtime", "verifying-embedding-runtime", "installing-embedding-runtime", "starting-chroma",
    "downloading-embedding-model", "warming-up-model", "selecting-legacy-index-action", "preparing-legacy-snapshot",
    "migrating-legacy-index", "reconciling-legacy-index", "verifying-legacy-index", "selecting-index-scope",
    "building-quick-index", "ready", "failed", "cancelled",
  ];
  for (const stage of allStages) {
    const fixture = mount(snapshot({ stage, error: stage === "failed" ? {
      code: "CHROMA_START_TIMEOUT", stage: "starting-chroma", userMessageKey: "onboarding.error.chroma_start_timeout",
      technicalMessage: "bounded", recoverable: true, action: "retry",
    } : null }));
    await settle();
    check(Boolean(fixture.container.querySelector("h1")), `${stage} fixture 应保留一个 h1`);
    check(!fixture.container.textContent?.includes("onboarding."), `${stage} fixture 不得泄露缺失 i18n key`);
    if (stage.includes("-")) check(!fixture.container.textContent?.includes(stage), `${stage} fixture 不得显示内部 stage 名`);
    fixture.root.unmount();
  }

  metrics.scenarios = document.querySelectorAll(".scenario").length;
  metrics.clipboardBytes = clipboard.length;
  for (const mounted of [welcome, later, progress, indeterminate, invalidFolder, complete, repair, narrow, english]) {
    mounted.root.unmount();
    check(mounted.coordinator.listeners.size === 0, "unmount 必须退订 coordinator，重开不得累积订阅");
  }
  document.body.setAttribute("data-onboarding-test-result", encode({ failures, metrics }));
}

void run().catch((error) => {
  document.body.setAttribute("data-onboarding-test-result", encode({ failures: [String(error?.stack ?? error)], metrics: {} }));
});
