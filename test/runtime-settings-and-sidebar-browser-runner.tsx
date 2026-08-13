import React from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  RuntimeSettingsPanel,
  RuntimeStatusCapsule,
  isLocalSearchRouteReady,
} from "../src/runtime/RuntimeControlPanel";
import type {
  RuntimeControlSnapshot,
  RuntimeControlSurfaceCapability,
  RuntimeHistoryItem,
} from "../src/runtime/runtime-control-surface";
import { updateOnboardingState, updateServiceState } from "../src/local-vector/search-instance";
import { setLocale } from "../src/util/i18n";

function snapshot(overrides: Partial<RuntimeControlSnapshot> = {}): RuntimeControlSnapshot {
  return {
    platform: "darwin-arm64",
    environment: {
      platform: "darwin-arm64", chroma: "installed", embeddingRuntime: "ready",
      embeddingModel: "ready", index: "ready", recommendedAction: "start-services",
    },
    chromaRuntimeId: "chroma-cli-1.4.4-darwin-arm64",
    embeddingRuntimeId: "embedding-runtime-node22-v1-darwin-arm64",
    chromaVersion: "cli-1.4.4",
    embeddingVersion: "Node 22.23.2 · Transformers 4.2.0 · ONNX Runtime 1.26.0",
    health: "healthy", ownership: "analogy", port: 8042,
    storage: "device-local", model: "ready", index: "ready", lastAction: null,
    busyAction: null, history: [], legacyDataDetected: true,
    legacyMigration: { status: "none", copiedRecords: null, totalRecords: null, sourceBytes: null, recoverable: false },
    ...overrides,
  };
}

class FakeControl implements RuntimeControlSurfaceCapability {
  value: RuntimeControlSnapshot;
  listeners = new Set<(value: RuntimeControlSnapshot) => void>();
  calls: string[] = [];
  constructor(value: RuntimeControlSnapshot) { this.value = value; }
  getSnapshot() { return this.value; }
  subscribe(listener: (value: RuntimeControlSnapshot) => void) {
    this.listeners.add(listener); listener(this.value); return () => this.listeners.delete(listener);
  }
  openOnboarding(mode: "setup" | "repair") { this.calls.push(`open:${mode}`); }
  verifyRuntimes() { this.calls.push("verify"); return Promise.resolve(this.value); }
  restartOwnedChroma() { this.calls.push("restart"); return Promise.resolve(); }
  redownloadRuntime(kind: "chroma" | "embedding-runtime") { this.calls.push(`redownload:${kind}`); return Promise.resolve(); }
  revealStorageDirectory() { this.calls.push("reveal"); return Promise.resolve(); }
  listRuntimeHistory() { this.calls.push("list"); return Promise.resolve(this.value.history); }
  listRuntimeCleanupRecoveries() { return Promise.resolve([]); }
  cleanRuntimeHistory(items: RuntimeHistoryItem[]) { this.calls.push(`clean:${items.length}`); return Promise.resolve({ removed: items.length, failed: 0, skipped: 0 }); }
  cleanLegacyChromaData(confirmation: string) { this.calls.push(`legacy:${confirmation}`); return Promise.reject(new Error("LEGACY_CLEANUP_UNAVAILABLE")); }
  listLegacyChromaRecoveries() { return Promise.resolve([]); }
  retryLegacyChromaRecovery() { return Promise.resolve({ removed: 0, failed: 0 }); }
  restoreLegacyChromaRecovery() { return Promise.resolve({ restored: 0, failed: 0 }); }
  resumeLegacyMigration() { this.calls.push("migration:resume"); return Promise.resolve(); }
  cancelLegacyMigration() { this.calls.push("migration:cancel"); return Promise.resolve(); }
  discardLegacyMigration() { this.calls.push("migration:discard"); return Promise.resolve(); }
  fallbackLegacyMigrationToRebuild() { this.calls.push("migration:rebuild"); return Promise.resolve(); }
  publish(value: RuntimeControlSnapshot) { this.value = value; for (const listener of this.listeners) listener(value); }
}

type Mounted = { container: HTMLDivElement; root: Root; control: FakeControl; detailCalls: string[] };
function mount(kind: "capsule" | "settings", value: RuntimeControlSnapshot): Mounted {
  const container = document.createElement("div");
  container.className = "scenario";
  document.body.appendChild(container);
  const root = createRoot(container);
  const control = new FakeControl(value);
  const detailCalls: string[] = [];
  root.render(kind === "capsule"
    ? <RuntimeStatusCapsule control={control} onOpenDetails={() => detailCalls.push("details")} />
    : <RuntimeSettingsPanel control={control} />);
  return { container, root, control, detailCalls };
}
async function settle() { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }
function button(container: ParentNode, text: string): HTMLButtonElement {
  const value = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === text);
  if (!value) throw new Error(`missing button ${text}`); return value as HTMLButtonElement;
}
function encode(value: unknown) { return btoa(unescape(encodeURIComponent(JSON.stringify(value)))); }

async function run() {
  const failures: string[] = [];
  const check = (condition: unknown, message: string) => { if (!condition) failures.push(message); };

  setLocale("zh");
  updateServiceState({ status: "idle" });
  updateOnboardingState({ environment: {
    platform: "darwin-arm64", chroma: "missing", embeddingRuntime: "missing", embeddingModel: "missing",
    index: "empty", recommendedAction: "setup",
  }, snapshot: {
    schemaVersion: 1, stage: "not-started", progress: null, completedBytes: null, totalBytes: null,
    currentItem: "", runtimePlatform: "darwin-arm64", chromaRuntimeId: null, embeddingRuntimeId: null,
    selectedIndexScope: null, legacyIndexChoice: null, legacyRecordsCopied: null, legacyRecordsTotal: null,
    legacySourceBytes: null, startedAt: null, updatedAt: 1, completedAt: null, dismissedAt: null, error: null,
  }, visible: false });
  const missing = mount("capsule", snapshot({ environment: null, health: "unknown", ownership: "none", port: null }));
  await settle();
  const versionBadge = document.createElement("span");
  versionBadge.className = "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold analogy-version-badge";
  versionBadge.textContent = "v1.0.0";
  document.body.appendChild(versionBadge);
  check(missing.container.textContent?.trim() === "未配置", "missing runtime must render one short neutral label");
  check(missing.container.querySelector('[data-runtime-state="unconfigured"]') !== null, "missing runtime must expose its state without relying on color");
  check(!missing.container.textContent?.includes("Local search not initialized yet"), "legacy dead-end text must be absent");
  button(missing.container, "未配置").click(); button(missing.container, "未配置").click();
  await settle();
  check(missing.control.calls.filter((call) => call === "open:setup").length === 1, "rapid setup clicks must be idempotent");

  updateOnboardingState({ snapshot: {
    ...(updateOnboardingState as any, {
      schemaVersion: 1, stage: "downloading-chroma", progress: 42, completedBytes: 42, totalBytes: 100,
      currentItem: "chroma.zip", runtimePlatform: "darwin-arm64", chromaRuntimeId: null, embeddingRuntimeId: null,
      selectedIndexScope: null, startedAt: 1, updatedAt: 2, completedAt: null, dismissedAt: null, error: null,
    }),
  } });
  await settle();
  check(missing.container.textContent?.trim() === "初始化中", "active setup must collapse into one short label");
  check(missing.container.querySelector('[data-runtime-state="preparing"]') !== null, "active setup must expose preparing state");
  check(getComputedStyle(button(missing.container, "初始化中")).backgroundColor === "rgb(234, 242, 255)", "preparing capsule must use a flat pale blue background");
  check(missing.container.querySelector('[role="progressbar"]') === null, "header capsule must not restore the full progress card");
  check(missing.container.querySelector("button")?.title.includes("正在下载本地搜索服务"), "active tooltip must retain the localized current stage");

  updateOnboardingState({ snapshot: {
    schemaVersion: 1, stage: "failed", progress: null, completedBytes: null, totalBytes: null, currentItem: "",
    runtimePlatform: "darwin-arm64", chromaRuntimeId: null, embeddingRuntimeId: null, selectedIndexScope: null,
    startedAt: 1, updatedAt: 3, completedAt: null, dismissedAt: null,
    error: { code: "DOWNLOAD_NETWORK_ERROR", stage: "downloading-chroma", userMessageKey: "onboarding.error.download_network_error", technicalMessage: "redacted", recoverable: true, action: "retry" },
  } });
  await settle();
  check(missing.container.textContent?.trim() === "需要处理", "failed setup must render the short attention label");
  check(getComputedStyle(button(missing.container, "需要处理")).backgroundColor === "rgb(255, 246, 218)", "attention capsule must use a flat pale yellow background");
  button(missing.container, "需要处理").click();
  await settle();
  check(missing.control.calls.includes("open:repair"), "attention capsule must open repair");

  updateServiceState({ status: "ready" });
  updateOnboardingState({ environment: snapshot().environment, snapshot: {
    schemaVersion: 1, stage: "ready", progress: 100, completedBytes: null, totalBytes: null, currentItem: "",
    runtimePlatform: "darwin-arm64", chromaRuntimeId: snapshot().chromaRuntimeId, embeddingRuntimeId: snapshot().embeddingRuntimeId,
    selectedIndexScope: { type: "recent", limit: 30 }, startedAt: 1, updatedAt: 4, completedAt: 4, dismissedAt: null, error: null,
  } });
  await settle();
  check(missing.container.querySelector('[data-runtime-state="ready"]') !== null, "ready is the only ready route state");
  check(missing.container.textContent?.trim() === "已就绪", "ready capsule must render one short label");
  const readyStyle = getComputedStyle(button(missing.container, "已就绪"));
  const versionStyle = getComputedStyle(versionBadge);
  check(readyStyle.backgroundColor === "rgb(232, 245, 236)", "ready capsule must use a flat pale green background");
  check(readyStyle.boxShadow === "none", "status capsule must not have an outer glow");
  check(readyStyle.borderColor === "rgba(0, 0, 0, 0)", "status capsule border must be transparent like the version badge");
  check(readyStyle.height === versionStyle.height, "status capsule height must match the version badge");
  check(readyStyle.borderRadius === versionStyle.borderRadius, "status capsule radius must match the version badge");
  button(missing.container, "已就绪").click();
  await settle();
  check(missing.detailCalls.length === 1, "ready capsule must open runtime details");
  check(isLocalSearchRouteReady({ status: "ready" } as any, {
    visible: false,
    environment: snapshot().environment,
    snapshot: { stage: "ready" } as any,
  }), "search must enable only when service, environment and onboarding are ready");
  check(!isLocalSearchRouteReady({ status: "ready" } as any, {
    visible: false,
    environment: snapshot().environment,
    snapshot: { stage: "failed" } as any,
  }), "failed onboarding must keep search disabled even if a stale service says ready");

  updateServiceState({ status: "degraded" });
  await settle();
  check(missing.container.textContent?.trim() === "部分可用", "degraded service must render an orange text state");
  check(getComputedStyle(button(missing.container, "部分可用")).backgroundColor === "rgb(255, 246, 218)", "degraded capsule must use a flat pale yellow background");
  button(missing.container, "部分可用").click();
  await settle();
  check(missing.detailCalls.length === 2, "degraded capsule must open runtime details");

  const history: RuntimeHistoryItem[] = [{ kind: "chroma", runtimeId: "chroma-old", installedAt: 1, identity: "safe-history-1" }];
  const settings = mount("settings", snapshot({ history }));
  await settle();
  const text = settings.container.textContent || "";
  check(text.includes("此设备") && text.includes("8042"), "settings must show storage label and bounded port");
  check(text.includes("chroma-cli-1.4.4-darwin-arm64"), "settings must show current runtime ID");
  check(!text.includes("/Users/") && !text.includes("npm install") && !text.includes("/bin/zsh"), "settings must not expose paths or legacy install commands");
  for (const label of ["验证运行时", "重启本地服务", "查看存储位置", "重新下载 Chroma", "重新下载嵌入运行时"]) {
    check(Boolean(Array.from(settings.container.querySelectorAll("button")).find((item) => item.textContent?.trim() === label)), `missing action ${label}`);
  }
  button(settings.container, "验证运行时").click(); button(settings.container, "验证运行时").click();
  await settle();
  check(settings.control.calls.filter((call) => call === "verify").length === 1, "settings verify must collapse rapid clicks");
  const actionHeights = Array.from(settings.container.querySelectorAll("button")).map((item) => getComputedStyle(item).minHeight);
  check(actionHeights.every((height) => parseFloat(height) >= 44), "runtime controls must keep 44px targets");
  check(settings.container.querySelector("details") !== null, "technical/history detail must stay collapsed");

  const migration = mount("settings", snapshot({
    legacyMigration: { status: "failed", copiedRecords: 40, totalRecords: 100, sourceBytes: 5000, recoverable: true },
  }));
  await settle();
  check(migration.container.textContent?.includes("原始索引未被修改"), "迁移失败应明确旧数据仍安全");
  for (const label of ["继续迁移", "改为重新建立索引", "丢弃迁移暂存数据"]) {
    check(Boolean(Array.from(migration.container.querySelectorAll("button")).find((item) => item.textContent?.trim() === label)), `missing migration action ${label}`);
  }
  button(migration.container, "继续迁移").click();
  await settle();
  check(migration.control.calls.includes("migration:resume"), "迁移恢复按钮必须调用控制面");

  setLocale("en");
  await settle();
  check(settings.container.textContent?.includes("Verify runtimes"), "English translation must be complete");
  check(settings.container.textContent?.includes("Legacy cleanup is unavailable until the verified migration is ready"), "Task 14 fail-closed boundary must be visible");

  document.body.setAttribute("data-task13-test-result", encode({ failures }));
}

run().catch((error) => document.body.setAttribute("data-task13-test-result", encode({ failures: [String(error?.stack || error)] })));
