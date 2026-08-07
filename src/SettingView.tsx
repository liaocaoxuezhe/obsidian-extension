import {App, FileSystemAdapter, Notice, PluginSettingTab, Setting, TFile} from "obsidian";
import Analogy from "../main";
import {createRoot, Root} from "react-dom/client";
import {StrictMode, useCallback, useEffect, useMemo, useRef, useState} from "react";
import {AppContext} from "./model/AppContext";
import * as React from "react";
import {Button} from "./components/button";
import {Badge} from "./components/badge";
import {Card, CardContent, CardHeader, CardTitle} from "./components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/dialog";
import { Textarea } from "./components/textarea";
import { searchInstance, updateServiceState } from "./local-vector/search-instance";
import { getDiagnosticRecorder } from "./diagnostics/diagnostic-instance";
import { AnalogyErrorBoundary } from "./diagnostics/AnalogyErrorBoundary";
import type { DiagnosticReport } from "./diagnostics/diagnostic-types";
import { generateReportFileName, sendDiagnosticReport } from "./diagnostics/diagnostic-report";
import { DiagnosticReportSnapshot } from "./diagnostics/diagnostic-report-snapshot";
import type { FileIndexStatus, IndexState, RebuildProgress } from "./local-vector/document-indexer";
import {normalizeExcludedIndexPaths} from "./local-vector/excluded-paths";
import {openVaultFolderDialog} from "./local-vector/vault-folder-selection";
import {EMBEDDING_MODELS, DEFAULT_MODEL_KEY} from "./local-vector/embedding";
import {OllamaClient} from "./local-vector/ollama-client";
import {DEFAULT_SUMMARY_PROMPT, DocumentSummarizer} from "./local-vector/document-summarizer";
import {DEFAULT_SUMMARY_MODEL_KEY, formatModelBytes, SUMMARY_MODELS} from "./local-vector/summary-models";
import {setLocale, onLocaleChange, t, type Locale, SUPPORTED_LOCALES} from "./util/i18n";
import {
  deactivateLicense,
  refreshCachedLicense,
  validateLicense,
  DEFAULT_BUY_LICENSE_URL,
  DEFAULT_LICENSE_SERVER_URL,
  DEFAULT_MANAGE_LICENSE_URL,
} from "./license/license-api";
import {clearLicenseState, getFreeLicenseState, loadLicenseState, saveLicenseState} from "./license/license-store";
import {
  FREE_PAGE_LIMIT,
  getCurrentPageLimit,
  getIndexCapacityPlan,
  getPageLimitUpgradePrompt,
  type PageLimitUpgradePrompt,
} from "./license/license-limits";
import type {LicenseState} from "./license/license-types";
import {getOrCreateDeviceId, getVaultId} from "./license/license-device";
import {appVersion} from "./model/Consts";
import type {
  OnboardingError,
  OnboardingSnapshot,
  OnboardingStage,
  QuickIndexScope,
} from "./onboarding/onboarding-types";
import type {SupportedPlatformKey} from "./runtime/runtime-types";
import {RuntimeSettingsPanel} from "./runtime/RuntimeControlPanel";

const SUPPORT_EMAIL = "analogypkm@gmail.com";
const PINNED_CHROMA_RUNTIME_VERSION = "cli-1.4.4";

declare const __ANALOGY_BUILD_ID__: string | undefined;

export interface AnalogySettings {
  /** @deprecated Migration-only input; active port is device-local runtime state. */
  chromaPort?: number;
  embeddingModelHost: string;
  excludedIndexPaths: string[];
  embeddingModel: string;
  licenseServerUrl: string;
  buyLicenseUrl: string;
  manageLicenseUrl: string;
  /** @deprecated Migration-only input; active states are device-local and generation-scoped. */
  indexStates?: Record<string, IndexState>;
  /** UI language; only affects the React views. */
  uiLanguage: Locale;
  summarizeBeforeEmbedding: boolean;
  summaryModel: string;
  summaryOllamaHost: string;
  summaryAutoPullModel: boolean;
  summaryTimeoutMs: number;
  summaryMaxInputChars: number;
  summaryFallbackToOriginal: boolean;
  summaryPrompt: string;
  /** @deprecated Task 8 migrates this device-local value to onboarding-state.json. */
  onboardingState?: Partial<OnboardingSnapshot>;
  /** @deprecated Task 8 migration-only data.json field. */
  onboardingStage?: OnboardingStage;
  /** @deprecated Task 8 migration-only data.json field. */
  onboardingProgress?: number | null;
  /** @deprecated Task 8 migration-only data.json field. */
  onboardingCompletedBytes?: number | null;
  /** @deprecated Task 8 migration-only data.json field. */
  onboardingTotalBytes?: number | null;
  /** @deprecated Task 8 migration-only data.json field. */
  onboardingCurrentItem?: string;
  /** @deprecated Task 8 migration-only data.json field. */
  onboardingRuntimePlatform?: SupportedPlatformKey | null;
  /** @deprecated Task 8 migration-only data.json field. */
  onboardingChromaRuntimeId?: string | null;
  /** @deprecated Task 8 migration-only data.json field. */
  onboardingEmbeddingRuntimeId?: string | null;
  /** @deprecated Task 8 migration-only data.json field. */
  onboardingSelectedIndexScope?: QuickIndexScope | null;
  /** @deprecated Task 8 migration-only data.json field. */
  onboardingStartedAt?: number | null;
  /** @deprecated Task 8 migration-only data.json field. */
  onboardingUpdatedAt?: number;
  /** @deprecated Task 8 migration-only data.json field. */
  onboardingCompletedAt?: number | null;
  /** @deprecated Task 8 migration-only data.json field. */
  onboardingDismissedAt?: number | null;
  /** @deprecated Task 8 migration-only data.json field. */
  onboardingError?: OnboardingError | null;
}

export const DEFAULT_SETTINGS: AnalogySettings = {
  embeddingModelHost: "https://hf-mirror.com/",
  excludedIndexPaths: [],
  embeddingModel: DEFAULT_MODEL_KEY,
  licenseServerUrl: DEFAULT_LICENSE_SERVER_URL,
  buyLicenseUrl: DEFAULT_BUY_LICENSE_URL,
  manageLicenseUrl: DEFAULT_MANAGE_LICENSE_URL,
  uiLanguage: "en",
  summarizeBeforeEmbedding: false,
  summaryModel: DEFAULT_SUMMARY_MODEL_KEY,
  summaryOllamaHost: "http://127.0.0.1:11434",
  summaryAutoPullModel: false,
  summaryTimeoutMs: 120_000,
  summaryMaxInputChars: 12_000,
  summaryFallbackToOriginal: true,
  summaryPrompt: DEFAULT_SUMMARY_PROMPT,
}

export class AnalogySettingTab extends PluginSettingTab {
  plugin: Analogy;
  root: Root | null = null;

  constructor(app: App, plugin: Analogy) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const recorder = getDiagnosticRecorder();
    this.root = createRoot(this.containerEl);
    this.root.render(
      <StrictMode>
        <AnalogyErrorBoundary
          recorder={recorder || ({ captureException: () => {} } as any)}
          viewName="SettingView"
          onCopyReport={() => {
            const snapshot = recorder?.getSnapshot();
            if (!snapshot) return;
            navigator.clipboard
              .writeText(JSON.stringify(snapshot, null, 2))
              .catch((error) => console.error("[Analogy] Failed to copy diagnostics", error));
          }}
          onReload={() => {
            this.root?.unmount();
            this.display();
          }}
          onOpenSettings={() => {
            // @ts-ignore Obsidian exposes the setting manager at runtime.
            this.app.setting?.openTabById?.("analogy-rag-in-your-vault");
          }}
          onSendReport={() => {
            this.root?.unmount();
            this.display();
          }}
        >
          <AppContext.Provider value={this.app}>
            <SettingDetail plugin={this.plugin} setting={this}/>
          </AppContext.Provider>
        </AnalogyErrorBoundary>
      </StrictMode>
    );
  }

  hide() {
    this.root?.unmount();
    super.hide();
  }
}

type StatusFilter = "all" | "indexed" | "outdated" | "unindexed";

function formatPageLimit(limit: number): string {
  return limit >= Number.MAX_SAFE_INTEGER ? t("settings.license.unlimited") : String(limit);
}

function formatLicensePlan(plan: LicenseState["plan"] | undefined): string {
  switch (plan) {
    case "personal_lifetime":
      return t("settings.license.planPersonalLifetime");
    case "team":
      return t("settings.license.planTeam");
    case "pro":
      return t("settings.license.planPro");
    case "free":
    default:
      return t("settings.license.planFree");
  }
}

function formatServiceStatus(status: string): string {
  switch (status) {
    case "ready":
      return t("settings.service.ready");
    case "degraded":
      return t("settings.service.degraded");
    case "error":
      return t("settings.service.error");
    case "initializing":
    default:
      return t("settings.service.initializing");
  }
}

function formatOllamaStatus(status: "idle" | "ready" | "error"): string {
  switch (status) {
    case "ready":
      return t("settings.service.ready");
    case "error":
      return t("settings.service.error");
    case "idle":
    default:
      return t("common.idle");
  }
}

function formatSafeModeReason(reason: string): string {
  const recentExitPrefix = "Recent unclean exits in embedding stages: ";
  if (reason.startsWith(recentExitPrefix)) {
    return t("settings.diagnostics.safeModeRecentUncleanExits", {
      stages: reason.slice(recentExitPrefix.length),
    });
  }
  if (reason === "Worker exited unexpectedly multiple times") {
    return t("settings.diagnostics.safeModeWorkerExited");
  }
  return reason;
}

function formatDiagnosticLocale(locale: string): string {
  if (locale === "zh") return t("settings.language.chinese");
  if (locale === "en") return t("settings.language.english");
  return locale;
}

function formatDiagnosticValue(value: string): string {
  return value === "unknown" ? t("common.unknown") : value;
}

const RUNTIME_VERSIONS = {
  transformers: "4.2.0",
  onnxruntime: "1.26.0",
  chroma: PINNED_CHROMA_RUNTIME_VERSION,
} as const;

function getBuildId(): string {
  if (typeof __ANALOGY_BUILD_ID__ !== "undefined") {
    return __ANALOGY_BUILD_ID__;
  }
  return "";
}

function SettingsSectionHeader({id, title, description}: {id: string; title: string; description: string}) {
  return (
    <header className="analogy-settings__section-header">
      <h2 id={id} className="analogy-settings__section-title">{title}</h2>
      <p className="analogy-settings__section-description">{description}</p>
    </header>
  );
}

function SettingDetail({plugin, setting}:{plugin:Analogy, setting:AnalogySettingTab}) {
  const [chromaHealthy, setChromaHealthy] = useState(false);
  const [docCount, setDocCount] = useState(0);
  const [modelReady, setModelReady] = useState(false);
  const [modelProgress, setModelProgress] = useState(0);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [isStoppingIndex, setIsStoppingIndex] = useState(false);
  const [rebuildProgress, setRebuildProgress] = useState<RebuildProgress | null>(null);
  const [lastError, setLastError] = useState("");
  const [serviceStatus, setServiceStatus] = useState(searchInstance.state.status);
  const [diagnosticPreviewOpen, setDiagnosticPreviewOpen] = useState(false);
  const [diagnosticUserNote, setDiagnosticUserNote] = useState("");
  const [diagnosticSending, setDiagnosticSending] = useState(false);
  const [diagnosticLastReportId, setDiagnosticLastReportId] = useState<string | null>(null);
  const [diagnosticPreviewReport, setDiagnosticPreviewReport] = useState<DiagnosticReport | null>(null);
  const diagnosticSnapshot = useMemo(() => new DiagnosticReportSnapshot(), []);
  const [safeModeState, setSafeModeState] = useState(() => plugin.getSafeModeState());
  const [isRecoveringSafeMode, setIsRecoveringSafeMode] = useState(false);
  const recorder = useMemo(() => getDiagnosticRecorder(), []);
  const runtimeVersions = RUNTIME_VERSIONS;
  const [modelHostInput, setModelHostInput] = useState(plugin.settings.embeddingModelHost || DEFAULT_SETTINGS.embeddingModelHost);
  const [selectedModel, setSelectedModel] = useState(plugin.settings.embeddingModel || DEFAULT_MODEL_KEY);
  const [selectedSummaryModel, setSelectedSummaryModel] = useState(plugin.settings.summaryModel || DEFAULT_SUMMARY_MODEL_KEY);
  const [summaryHostInput, setSummaryHostInput] = useState(plugin.settings.summaryOllamaHost || DEFAULT_SETTINGS.summaryOllamaHost);
  const [summaryTimeoutInput, setSummaryTimeoutInput] = useState(String(plugin.settings.summaryTimeoutMs || DEFAULT_SETTINGS.summaryTimeoutMs));
  const [summaryMaxInputChars, setSummaryMaxInputChars] = useState(String(plugin.settings.summaryMaxInputChars || DEFAULT_SETTINGS.summaryMaxInputChars));
  const [summaryPromptInput, setSummaryPromptInput] = useState(plugin.settings.summaryPrompt || DEFAULT_SETTINGS.summaryPrompt);
  const [ollamaStatus, setOllamaStatus] = useState<"idle" | "ready" | "error">("idle");
  const [ollamaAvailable, setOllamaAvailable] = useState<boolean | null>(null);
  const [ollamaMessage, setOllamaMessage] = useState("");
  const [installedSummarySizes, setInstalledSummarySizes] = useState<Record<string, string>>({});
  const [isCheckingOllama, setIsCheckingOllama] = useState(false);
  const [isPullingSummaryModel, setIsPullingSummaryModel] = useState(false);
  const [summaryPullProgress, setSummaryPullProgress] = useState("");
  const [licenseServerInput, setLicenseServerInput] = useState(plugin.settings.licenseServerUrl || DEFAULT_LICENSE_SERVER_URL);
  const [buyLicenseInput, setBuyLicenseInput] = useState(plugin.settings.buyLicenseUrl || DEFAULT_BUY_LICENSE_URL);
  const [manageLicenseInput, setManageLicenseInput] = useState(plugin.settings.manageLicenseUrl || DEFAULT_MANAGE_LICENSE_URL);
  const [licenseKeyInput, setLicenseKeyInput] = useState("");
  const [licenseState, setLicenseState] = useState<LicenseState>(() => loadLicenseState());
  const [upgradePrompt, setUpgradePrompt] = useState<PageLimitUpgradePrompt | null>(null);
  const [isActivatingLicense, setIsActivatingLicense] = useState(false);
  const [isDeactivatingLicense, setIsDeactivatingLicense] = useState(false);
  const [excludedPaths, setExcludedPaths] = useState<string[]>(plugin.settings.excludedIndexPaths || []);
  const [newPathInput, setNewPathInput] = useState("");
  const [language, setLanguage] = useState<Locale>(plugin.settings.uiLanguage || "en");

  useEffect(() => {
    setLocale(plugin.settings.uiLanguage || "en");
    const unsub = onLocaleChange((l) => setLanguage(l));
    return () => { unsub(); };
  }, []);

  const activeModelConfig = EMBEDDING_MODELS[selectedModel] || EMBEDDING_MODELS[DEFAULT_MODEL_KEY];
  const activeSummaryConfig = SUMMARY_MODELS[selectedSummaryModel] || SUMMARY_MODELS[DEFAULT_SUMMARY_MODEL_KEY];
  const modelDescription = language === "zh"
    ? activeModelConfig.descriptionZh
    : activeModelConfig.description;
  const summaryModelNote = language === "zh" ? activeSummaryConfig.noteZh : activeSummaryConfig.noteEn;
  const activeSummarySize = installedSummarySizes[activeSummaryConfig.ollamaName] || activeSummaryConfig.estimatedSize;

  const [fileStatuses, setFileStatuses] = useState<FileIndexStatus[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [indexingFile, setIndexingFile] = useState<string | null>(null);
  const stopRequestedRef = useRef(false);

  const refreshServiceStatus = async () => {
    setServiceStatus(searchInstance.state.status);
    setModelReady(searchInstance.embeddingService?.isReady() ?? false);
    setModelProgress(searchInstance.state.modelDownloadProgress);
    setLastError(searchInstance.state.lastError);

    const healthy = await searchInstance.chromaManager?.isHealthy() ?? false;
    setChromaHealthy(healthy);

    if (searchInstance.vectorStore) {
      try {
        const count = await searchInstance.vectorStore.count();
        setDocCount(count);
      } catch {
        setDocCount(0);
      }
    }
  };

  const refreshFileStatuses = useCallback(() => {
    if (!searchInstance.documentIndexer) return;
    const files = plugin.app.vault.getMarkdownFiles();
    const statuses = searchInstance.documentIndexer.getAllFileStatuses(files);
    setFileStatuses(statuses);
  }, [plugin]);

  const [displayLimit, setDisplayLimit] = useState(100);


  function showUpgradePrompt(selectedCount: number, limit: number) {
    setUpgradePrompt(getPageLimitUpgradePrompt(selectedCount, limit, plugin.settings.buyLicenseUrl));
  }

  function getIndexedSlotCount(statuses: FileIndexStatus[]): number {
    return statuses.filter((file) => file.status !== "unindexed").length;
  }

  useEffect(() => {
    refreshServiceStatus();
    const interval = setInterval(refreshServiceStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const cached = loadLicenseState();
    refreshCachedLicense(plugin.settings.licenseServerUrl || licenseServerInput, cached, {
      deviceId: getOrCreateDeviceId(),
      vaultId: getVaultId(plugin.app),
      pluginVersion: appVersion,
    }).then((nextState) => {
      if (nextState !== cached) {
        saveLicenseState(nextState);
        setLicenseState(nextState);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    setDisplayLimit(100);
  }, [statusFilter, searchQuery]);

  const statusCounts = useMemo(() => {
    if (fileStatuses.length > 0) {
      const counts = { indexed: 0, outdated: 0, unindexed: 0, total: fileStatuses.length };
      for (const f of fileStatuses) {
        counts[f.status]++;
      }
      return counts;
    }
    const quick = searchInstance.documentIndexer?.getQuickStats();
    return { indexed: quick?.indexed ?? 0, outdated: 0, unindexed: 0, total: quick?.indexed ?? 0 };
  }, [fileStatuses]);

  const filteredFiles = useMemo(() => {
    let list = fileStatuses;
    if (statusFilter !== "all") {
      list = list.filter((f) => f.status === statusFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((f) => f.path.toLowerCase().includes(q) || f.name.toLowerCase().includes(q));
    }
    return list;
  }, [fileStatuses, statusFilter, searchQuery]);

  async function rebuildIndex() {
    if (!searchInstance.documentIndexer) {
      new Notice(t("settings.actions.indexerUnavailable"));
      return;
    }
    const files = plugin.app.vault.getMarkdownFiles();
    const limit = getCurrentPageLimit(licenseState);
    if (files.length > limit) {
      showUpgradePrompt(files.length, limit);
      new Notice(t("settings.license.vaultLimitExceeded", { limit, count: files.length }));
      return;
    }
    setUpgradePrompt(null);
    stopRequestedRef.current = false;
    setIsRebuilding(true);
    setRebuildProgress(null);
    try {
      await plugin.rebuildManagedChromaData(files, (p) => {
          setRebuildProgress(p);
          updateServiceState({ rebuildProgress: p });
      });
      if (!stopRequestedRef.current) {
        new Notice(t("settings.actions.rebuildDone"));
      }
      await refreshServiceStatus();
      refreshFileStatuses();
    } catch (err) {
      console.error("[Analogy] Rebuild error:", err);
      new Notice(t("settings.actions.rebuildFailed", { message: (err as Error).message }));
    } finally {
      setIsRebuilding(false);
      setIsStoppingIndex(false);
      setRebuildProgress(null);
      updateServiceState({ rebuildProgress: null });
    }
  }

  async function continueIndex() {
    if (!searchInstance.documentIndexer) {
      new Notice(t("settings.actions.indexerUnavailable"));
      return;
    }
    const files = plugin.app.vault.getMarkdownFiles();
    const limit = getCurrentPageLimit(licenseState);
    const statuses = searchInstance.documentIndexer.getAllFileStatuses(files);
    const pendingStatuses = statuses.filter((file) => file.status !== "indexed");
    const capacityPlan = getIndexCapacityPlan({
      indexedCount: getIndexedSlotCount(statuses),
      limit,
      candidates: pendingStatuses.map((file) => ({
        id: file.path,
        countsTowardLimit: file.status === "unindexed",
      })),
    });
    if (capacityPlan.isLimited) {
      showUpgradePrompt(capacityPlan.indexedCount + capacityPlan.allowedNewCount + capacityPlan.blockedNewCount, limit);
    } else {
      setUpgradePrompt(null);
    }
    const allowedPaths = new Set(capacityPlan.allowedIds);
    const allowedFiles = files.filter((file) => allowedPaths.has(file.path));
    if (allowedFiles.length === 0 && capacityPlan.isLimited) {
      new Notice(t("settings.license.upgradeToContinue", { limit }));
      return;
    }
    if (allowedFiles.length === 0) {
      new Notice(t("settings.actions.noPending"));
      return;
    }
    stopRequestedRef.current = false;
    setIsRebuilding(true);
    setRebuildProgress(null);
    try {
      await searchInstance.documentIndexer.indexFiles(allowedFiles, {
        onProgress: (p) => {
          const progress = {
            current: p.current,
            total: p.total,
            currentFile: p.currentFileName,
          };
          setRebuildProgress(progress);
          updateServiceState({ rebuildProgress: progress });
        },
      });
      if (!stopRequestedRef.current) {
        new Notice(
          capacityPlan.isLimited
            ? t("settings.license.indexedToFreeLimit")
            : t("settings.actions.continueDone")
        );
      }
      await refreshServiceStatus();
      refreshFileStatuses();
    } catch (err) {
      console.error("[Analogy] Continue index error:", err);
      new Notice(t("settings.actions.continueFailed", { message: (err as Error).message }));
    } finally {
      setIsRebuilding(false);
      setIsStoppingIndex(false);
      setRebuildProgress(null);
      updateServiceState({ rebuildProgress: null });
    }
  }

  async function stopIndexing() {
    const indexers = [searchInstance.documentIndexer, plugin.documentIndexer].filter(
      (indexer, index, all) => indexer && all.indexOf(indexer) === index
    );
    if (indexers.length === 0) return;
    stopRequestedRef.current = true;
    setIsStoppingIndex(true);
    setRebuildProgress(null);
    updateServiceState({ rebuildProgress: null });
    try {
      await Promise.all(indexers.map((indexer) => indexer!.stop()));
      await refreshServiceStatus();
      refreshFileStatuses();
      new Notice(t("settings.actions.indexStopped"));
    } catch (err) {
      console.error("[Analogy] Stop index error:", err);
      new Notice(t("settings.actions.stopFailed", { message: (err as Error).message }));
    } finally {
      setIsStoppingIndex(false);
      setIsRebuilding(false);
    }
  }

  async function indexSingleFile(filePath: string) {
    if (!searchInstance.documentIndexer) {
      new Notice(t("settings.actions.indexerUnavailable"));
      return;
    }
    const file = plugin.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      new Notice(t("settings.actions.fileNotFound", { path: filePath }));
      return;
    }
    const statuses = searchInstance.documentIndexer.getAllFileStatuses(plugin.app.vault.getMarkdownFiles());
    const fileStatus = statuses.find((status) => status.path === filePath);
    const capacityPlan = getIndexCapacityPlan({
      indexedCount: getIndexedSlotCount(statuses),
      limit: getCurrentPageLimit(licenseState),
      candidates: [{
        id: filePath,
        countsTowardLimit: !fileStatus || fileStatus.status === "unindexed",
      }],
    });
    if (capacityPlan.isLimited) {
      showUpgradePrompt(capacityPlan.indexedCount + capacityPlan.blockedNewCount, capacityPlan.limit);
      new Notice(t("settings.license.upgradeToIndexMore", { limit: capacityPlan.limit }));
      return;
    }
    setUpgradePrompt(null);
    setIndexingFile(filePath);
    try {
      await searchInstance.documentIndexer.reindexDocument(file);
      new Notice(t("settings.actions.indexed", { name: file.name }));
      refreshFileStatuses();
      if (searchInstance.vectorStore) {
        const count = await searchInstance.vectorStore.count();
        setDocCount(count);
      }
    } catch (err) {
      console.error(`[Analogy] Single index error for ${filePath}:`, err);
      new Notice(t("settings.actions.indexFailed", { message: (err as Error).message }));
    } finally {
      setIndexingFile(null);
    }
  }

  async function toggleMuted(filePath: string, currentlyMuted: boolean) {
    if (!searchInstance.documentIndexer) return;
    await searchInstance.documentIndexer.setMuted(filePath, !currentlyMuted);
    refreshFileStatuses();
    new Notice(
      currentlyMuted
        ? t("settings.actions.unmuted", { path: filePath })
        : t("settings.actions.muted", { path: filePath })
    );
  }

  async function saveModelHost() {
    const val = modelHostInput.trim();
    if (!/^https?:\/\/.+/i.test(val)) {
      new Notice(t("settings.embedding.hostInvalid"));
      return;
    }
    plugin.settings.embeddingModelHost = val.endsWith("/") ? val : `${val}/`;
    setModelHostInput(plugin.settings.embeddingModelHost);
    await plugin.saveSettings();
    new Notice(t("settings.embedding.hostSaved"));
  }

  async function checkOllama() {
    setIsCheckingOllama(true);
    setOllamaMessage("");
    try {
      const client = new OllamaClient({
        host: summaryHostInput.trim() || DEFAULT_SETTINGS.summaryOllamaHost,
        timeoutMs: Number(summaryTimeoutInput) || DEFAULT_SETTINGS.summaryTimeoutMs,
      });
      const models = await client.listModels();
      const sizes: Record<string, string> = {};
      for (const model of models) {
        if (model.size) sizes[model.name] = formatModelBytes(model.size);
      }
      setInstalledSummarySizes(sizes);
      const installed = models.some((m) => m.name === activeSummaryConfig.ollamaName);
      setOllamaAvailable(true);
      setOllamaStatus(installed ? "ready" : "error");
      setOllamaMessage(installed ? t("settings.summary.modelInstalled") : t("settings.summary.modelMissing"));
    } catch {
      setOllamaAvailable(false);
      setOllamaStatus("error");
      setOllamaMessage(t("settings.summary.ollamaUnavailable"));
    } finally {
      setIsCheckingOllama(false);
    }
  }

  async function applySummarySettings() {
    const summaryConfig = SUMMARY_MODELS[plugin.settings.summaryModel] || SUMMARY_MODELS[DEFAULT_SUMMARY_MODEL_KEY];
    const client = new OllamaClient({
      host: plugin.settings.summaryOllamaHost || DEFAULT_SETTINGS.summaryOllamaHost,
      timeoutMs: plugin.settings.summaryTimeoutMs || DEFAULT_SETTINGS.summaryTimeoutMs,
    });
    const summarizer = new DocumentSummarizer({
      enabled: Boolean(plugin.settings.summarizeBeforeEmbedding),
      model: summaryConfig.ollamaName,
      maxInputChars: plugin.settings.summaryMaxInputChars || DEFAULT_SETTINGS.summaryMaxInputChars,
      fallbackToOriginal: plugin.settings.summaryFallbackToOriginal !== false,
      promptTemplate: plugin.settings.summaryPrompt || DEFAULT_SETTINGS.summaryPrompt,
      client,
    });
    searchInstance.documentSummarizer = summarizer;
    if (searchInstance.localSearch) {
      searchInstance.localSearch.setDocumentSummarizer(summarizer);
    }
    updateServiceState({ summarySearchEnabled: Boolean(plugin.settings.summarizeBeforeEmbedding) });
    refreshFileStatuses();
    new Notice(t("settings.summary.applyHint"));
  }

  async function pullSummaryModel() {
    setIsPullingSummaryModel(true);
    setSummaryPullProgress("");
    try {
      const client = new OllamaClient({
        host: summaryHostInput.trim() || DEFAULT_SETTINGS.summaryOllamaHost,
        timeoutMs: Number(summaryTimeoutInput) || DEFAULT_SETTINGS.summaryTimeoutMs,
      });
      await client.pullModel(activeSummaryConfig.ollamaName, (progress) => {
        if (progress.total && progress.completed) {
          setSummaryPullProgress(`${progress.status} ${Math.round((progress.completed / progress.total) * 100)}%`);
        } else {
          setSummaryPullProgress(progress.status);
        }
      });
      new Notice(t("settings.summary.pullDone"));
      await checkOllama();
    } catch (err) {
      new Notice((err as Error).message);
      setOllamaStatus("error");
      setOllamaMessage((err as Error).message);
    } finally {
      setIsPullingSummaryModel(false);
    }
  }

  function openOllamaInstallDocs() {
    window.open("https://ollama.com/download", "_blank", "noopener,noreferrer");
  }

  async function saveLicenseSettings() {
    const licenseServerUrl = licenseServerInput.trim().replace(/\/+$/, "");
    if (licenseServerUrl && !/^https?:\/\/.+/i.test(licenseServerUrl)) {
      new Notice(t("settings.license.serverUrlInvalid"));
      return;
    }
    const buyLicenseUrl = buyLicenseInput.trim();
    const manageLicenseUrl = manageLicenseInput.trim();
    for (const url of [buyLicenseUrl, manageLicenseUrl]) {
      if (url && !/^https?:\/\/.+/i.test(url)) {
        new Notice(t("settings.license.linksInvalid"));
        return;
      }
    }
    plugin.settings.licenseServerUrl = licenseServerUrl;
    plugin.settings.buyLicenseUrl = buyLicenseUrl;
    plugin.settings.manageLicenseUrl = manageLicenseUrl;
    setLicenseServerInput(licenseServerUrl);
    await plugin.saveSettings();
    new Notice(t("settings.license.settingsSaved"));
  }

  async function activateLicense() {
    const licenseKey = licenseKeyInput.trim();
    if (!licenseKey) {
      new Notice(t("settings.license.enterKey"));
      return;
    }
    setIsActivatingLicense(true);
    try {
      const nextState = await validateLicense(plugin.settings.licenseServerUrl || licenseServerInput, {
        licenseKey,
        deviceId: getOrCreateDeviceId(),
        vaultId: getVaultId(plugin.app),
        pluginVersion: appVersion,
      });
      saveLicenseState(nextState);
      setLicenseState(nextState);
      setLicenseKeyInput("");
      if (nextState.status === "active") {
        new Notice(t("settings.license.activated"));
      } else {
        new Notice(t("settings.license.invalid"));
      }
    } catch (err) {
      new Notice((err as Error).message);
    } finally {
      setIsActivatingLicense(false);
    }
  }

  async function deactivateCurrentLicense() {
    if (!licenseState.licenseKey) {
      clearLicenseState();
      setLicenseState(getFreeLicenseState());
      new Notice(t("settings.license.localCleared"));
      return;
    }
    setIsDeactivatingLicense(true);
    try {
      await deactivateLicense(plugin.settings.licenseServerUrl || licenseServerInput, {
        licenseKey: licenseState.licenseKey,
        deviceId: getOrCreateDeviceId(),
        vaultId: getVaultId(plugin.app),
      });
      clearLicenseState();
      setLicenseState(getFreeLicenseState());
      new Notice(t("settings.license.deactivated"));
    } catch (err) {
      new Notice((err as Error).message);
    } finally {
      setIsDeactivatingLicense(false);
    }
  }

  async function syncExcludedPaths(paths: string[]) {
    plugin.settings.excludedIndexPaths = paths;
    setExcludedPaths(paths);
    await plugin.saveSettings();
    if (searchInstance.documentIndexer) {
      await searchInstance.documentIndexer.setExcludedIndexPaths(paths);
    }
    refreshFileStatuses();
    await refreshServiceStatus();
  }

  async function addExcludedPath() {
    const normalized = normalizeExcludedIndexPaths([newPathInput]);
    if (normalized.length === 0) return;
    const pathToAdd = normalized[0];
    if (excludedPaths.includes(pathToAdd)) {
      new Notice(t("settings.exclude.exists"));
      return;
    }
    const updated = [...excludedPaths, pathToAdd];
    await syncExcludedPaths(updated);
    setNewPathInput("");
    new Notice(t("settings.exclude.added", { path: pathToAdd }));
  }

  async function chooseExcludedFolder() {
    const adapter = plugin.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice(t("settings.exclude.chooseUnavailable"));
      return;
    }

    try {
      const remote = require("electron")?.remote;
      if (!remote?.dialog?.showOpenDialog || !remote?.getCurrentWindow) {
        new Notice(t("settings.exclude.chooseUnavailable"));
        return;
      }

      const selection = await openVaultFolderDialog({
        dialog: remote.dialog,
        parentWindow: remote.getCurrentWindow(),
        vaultBasePath: adapter.getBasePath(),
        platform: process.platform,
        title: t("settings.exclude.chooseFolderTitle"),
      });
      if (!selection) return;
      if (!selection.ok) {
        new Notice(t(selection.reason === "vault-root"
          ? "settings.exclude.vaultRoot"
          : "settings.exclude.outsideVault"));
        return;
      }

      setNewPathInput(selection.path);
    } catch (err) {
      console.error("[Analogy] Failed to choose no-index folder:", err);
      new Notice(t("settings.exclude.chooseFailed"));
    }
  }

  async function removeExcludedPath(pathToRemove: string) {
    const updated = excludedPaths.filter((p) => p !== pathToRemove);
    await syncExcludedPaths(updated);
    new Notice(t("settings.exclude.removed", { path: pathToRemove }));
  }

  async function clearIndex() {
    if (!searchInstance.vectorStore) {
      new Notice(t("settings.actions.vectorStoreUnavailable"));
      return;
    }
    if (!confirm(t("settings.actions.clearConfirm"))) {
      return;
    }
    try {
      const docs = await searchInstance.vectorStore.listIndexedDocs();
      for (const docId of docs) {
        await searchInstance.vectorStore.deleteDocument(docId);
      }
      if (searchInstance.documentIndexer) {
        await searchInstance.documentIndexer.clearState();
      }
      new Notice(t("settings.actions.clearDone"));
      await refreshServiceStatus();
      refreshFileStatuses();
    } catch (err) {
      console.error("[Analogy] Clear error:", err);
      new Notice(t("settings.actions.clearFailed", { message: (err as Error).message }));
    }
  }

  async function copySupportEmail() {
    try {
      await navigator.clipboard.writeText(SUPPORT_EMAIL);
      new Notice(t("settings.feedback.copySuccess"));
    } catch (error) {
      console.error("[Analogy] Failed to copy support email:", error);
      new Notice(t("settings.feedback.copyFailed"));
    }
  }

  function buildDiagnosticReport(userNote = diagnosticUserNote): DiagnosticReport | null {
    if (!recorder) return null;
    const host = plugin.getDiagnosticHostInfo();
    return recorder.buildReport({
      obsidianVersion: (plugin.app as any).version || "unknown",
      platform: host.platform,
      arch: host.arch,
      locale: plugin.settings.uiLanguage || "en",
      model: plugin.settings.embeddingModel || DEFAULT_MODEL_KEY,
      transformersVersion: runtimeVersions.transformers,
      onnxruntimeVersion: runtimeVersions.onnxruntime,
      chromaVersion: runtimeVersions.chroma,
      safeMode: plugin.getSafeModeState().enabled,
      userNote,
    });
  }

  function replaceDiagnosticSnapshot(userNote = diagnosticUserNote): DiagnosticReport | null {
    const report = buildDiagnosticReport(userNote);
    if (!report) {
      diagnosticSnapshot.invalidate();
      setDiagnosticPreviewReport(null);
      return null;
    }
    const snapshot = diagnosticSnapshot.replace(report);
    setDiagnosticPreviewReport(snapshot);
    return snapshot;
  }

  function getOrCreateDiagnosticSnapshot(): DiagnosticReport | null {
    return diagnosticSnapshot.get() ?? replaceDiagnosticSnapshot();
  }

  function openDiagnosticPreview() {
    replaceDiagnosticSnapshot();
    setDiagnosticPreviewOpen(true);
  }

  async function copyDiagnosticReport() {
    const report = getOrCreateDiagnosticSnapshot();
    if (!report) {
      new Notice(t("settings.diagnostics.noReport"));
      return;
    }
    try {
      await navigator.clipboard.writeText(diagnosticSnapshot.serialize()!);
      new Notice(t("common.copiedToClipboard"));
    } catch (error) {
      console.error("[Analogy] Failed to copy diagnostic report:", error);
      new Notice(t("settings.diagnostics.copyFailed"));
    }
  }

  async function saveDiagnosticReport() {
    const report = getOrCreateDiagnosticSnapshot();
    if (!report) {
      new Notice(t("settings.diagnostics.noReport"));
      return;
    }
    const fileName = generateReportFileName(report.plugin.version);
    try {
      await plugin.app.vault.adapter.write(fileName, diagnosticSnapshot.serialize()!);
      new Notice(t("settings.diagnostics.saved", { fileName }));
    } catch (error) {
      console.error("[Analogy] Failed to save diagnostic report:", error);
      new Notice(t("settings.diagnostics.saveFailed"));
    }
  }

  async function sendDiagnosticReportFromUI() {
    const report = diagnosticSnapshot.get();
    if (!report) {
      new Notice(t("settings.diagnostics.noReport"));
      return;
    }
    const endpoint = plugin.settings.licenseServerUrl
      ? `${plugin.settings.licenseServerUrl.replace(/\/$/, "")}/api/v1/obsidian/diagnostic-reports`
      : "";
    if (!endpoint) {
      new Notice(t("settings.diagnostics.endpointMissing"));
      return;
    }
    setDiagnosticSending(true);
    try {
      const response = await sendDiagnosticReport(report, {
        endpoint,
        timeoutMs: 30000,
        serializedReport: diagnosticSnapshot.serialize()!,
      });
      setDiagnosticLastReportId(response.data.report_id);
      new Notice(`${t("settings.diagnostics.sendSuccess")} ${response.data.report_id}`);
      setDiagnosticPreviewOpen(false);
    } catch (error) {
      console.error("[Analogy] Failed to send diagnostic report:", error);
      new Notice(`${t("settings.diagnostics.sendFailed")} ${(error as Error).message}`);
    } finally {
      setDiagnosticSending(false);
    }
  }

  async function clearDiagnosticData() {
    if (!window.confirm(t("settings.diagnostics.clearConfirm"))) return;
    await recorder?.clearDiagnostics();
    diagnosticSnapshot.invalidate();
    setDiagnosticPreviewReport(null);
    setDiagnosticLastReportId(null);
    new Notice(t("settings.diagnostics.cleared"));
  }

  async function recoverFromSafeMode() {
    setIsRecoveringSafeMode(true);
    try {
      await plugin.clearSafeModeAndRetry();
      setSafeModeState(plugin.getSafeModeState());
      new Notice(t("settings.diagnostics.safeModeRecovered"));
    } catch (error) {
      setSafeModeState(plugin.getSafeModeState());
      new Notice(`${t("settings.diagnostics.safeModeRetryFailed")} ${(error as Error).message}`);
    } finally {
      setIsRecoveringSafeMode(false);
    }
  }

  async function switchToRecommendedSmallModelAndRecover() {
    setIsRecoveringSafeMode(true);
    try {
      await plugin.switchToRecommendedSmallModelAndRetry();
      setSelectedModel(DEFAULT_MODEL_KEY);
      setSafeModeState(plugin.getSafeModeState());
      new Notice(t("settings.diagnostics.safeModeRecovered"));
    } catch (error) {
      setSelectedModel(plugin.settings.embeddingModel || DEFAULT_MODEL_KEY);
      setSafeModeState(plugin.getSafeModeState());
      new Notice(`${t("settings.diagnostics.safeModeRetryFailed")} ${(error as Error).message}`);
    } finally {
      setIsRecoveringSafeMode(false);
    }
  }

  function keepSafeMode() {
    setSafeModeState(plugin.getSafeModeState());
    new Notice(t("settings.diagnostics.safeModeKept"));
  }

  return (
    <div className="analogy-settings">
      <header className="analogy-settings__page-header">
        <h1 className="analogy-settings__page-title">{t("settings.page.title")}</h1>
        <p className="analogy-settings__page-description">{t("settings.page.description")}</p>
      </header>

      <section className="analogy-settings__section" aria-labelledby="analogy-settings-general">
        <SettingsSectionHeader
          id="analogy-settings-general"
          title={t("settings.section.general")}
          description={t("settings.section.generalDescription")}
        />

      <RuntimeSettingsPanel control={plugin.getRuntimeControlSurface()} />

      <Card className="analogy-settings-card">
        <CardHeader>
          <CardTitle className="text-base">{t("settings.language.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="analogy-settings-row flex items-center justify-between">
            <span className="text-sm text-[#444444]">{t("settings.language.hint")}</span>
            <select
              className="text-sm border border-[#e5e5e5] rounded-md px-2 py-1"
              aria-label={t("settings.language.title")}
              value={language}
              onChange={async (e) => {
                const next = e.target.value as Locale;
                if (!SUPPORTED_LOCALES.includes(next)) return;
                plugin.settings.uiLanguage = next;
                await plugin.saveSettings();
                setLocale(next);
                setLanguage(next);
              }}
            >
              <option value="en">{t("settings.language.english")}</option>
              <option value="zh">{t("settings.language.chinese")}</option>
            </select>
          </div>
        </CardContent>
      </Card>

      <Card className="analogy-settings-card">
        <CardHeader>
          <CardTitle className="text-base">{t("settings.license.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="analogy-settings-row flex items-center justify-between">
            <span className="text-sm text-[#444444]">{t("settings.license.plan")}</span>
            <Badge className={licenseState.status === "active" ? "bg-[#0a0a0a] text-white" : "bg-[#f5f5f5] text-[#444444]"}>
              {licenseState.status === "active"
                ? formatLicensePlan(licenseState.plan || "personal_lifetime")
                : formatLicensePlan("free")}
            </Badge>
          </div>
          <div className="analogy-settings-row flex items-center justify-between mt-2">
            <span className="text-sm text-[#444444]">{t("settings.license.pageLimit")}</span>
            <span className="text-sm font-medium">{formatPageLimit(getCurrentPageLimit(licenseState))}</span>
          </div>
          <div className="analogy-settings-row flex items-center justify-between mt-2">
            <span className="text-sm text-[#444444]">{t("settings.license.freeLimit")}</span>
            <span className="text-sm font-medium">{FREE_PAGE_LIMIT}</span>
          </div>
          {licenseState.licenseKeyMasked && (
            <div className="analogy-settings-row flex items-center justify-between mt-2">
              <span className="text-sm text-[#444444]">{t("settings.license.key")}</span>
              <span className="text-sm font-medium">{licenseState.licenseKeyMasked}</span>
            </div>
          )}

          <div className="analogy-settings-actions analogy-settings-actions--field mt-3 pt-3" style={{ borderTop: "1px solid var(--background-modifier-border)" }}>
            <input
              type="password"
              className="flex-1 text-sm border border-[#e5e5e5] rounded-md px-3 py-1.5"
              aria-label={t("settings.license.key")}
              name="analogy-license-key"
              autoComplete="off"
              spellCheck={false}
              placeholder={t("settings.license.keyPlaceholder")}
              value={licenseKeyInput}
              onChange={(e) => setLicenseKeyInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") activateLicense(); }}
            />
            <Button size="sm" onClick={activateLicense} disabled={isActivatingLicense}>
              {isActivatingLicense ? t("settings.license.activating") : t("settings.license.activate")}
            </Button>
            {licenseState.licenseKeyMasked && (
              <Button size="sm" variant="secondary" onClick={deactivateCurrentLicense} disabled={isDeactivatingLicense}>
                {isDeactivatingLicense ? t("settings.license.deactivating") : t("settings.license.deactivate")}
              </Button>
            )}
          </div>

          <details className="mt-3">
            <summary className="text-xs text-[#888888] cursor-pointer hover:text-[#444444]">
              {t("settings.license.links")}
            </summary>
            <div className="space-y-2 mt-2">
              <input
                type="text"
                className="w-full text-sm border border-[#e5e5e5] rounded-md px-3 py-1.5"
                aria-label={t("settings.license.serverUrl")}
                name="analogy-license-server-url"
                autoComplete="off"
                spellCheck={false}
                placeholder={t("settings.license.serverUrl")}
                value={licenseServerInput}
                onChange={(e) => setLicenseServerInput(e.target.value)}
              />
              <input
                type="text"
                className="w-full text-sm border border-[#e5e5e5] rounded-md px-3 py-1.5"
                aria-label={t("settings.license.buyUrl")}
                name="analogy-license-buy-url"
                autoComplete="off"
                spellCheck={false}
                placeholder={t("settings.license.buyUrl")}
                value={buyLicenseInput}
                onChange={(e) => setBuyLicenseInput(e.target.value)}
              />
              <input
                type="text"
                className="w-full text-sm border border-[#e5e5e5] rounded-md px-3 py-1.5"
                aria-label={t("settings.license.manageUrl")}
                name="analogy-license-manage-url"
                autoComplete="off"
                spellCheck={false}
                placeholder={t("settings.license.manageUrl")}
                value={manageLicenseInput}
                onChange={(e) => setManageLicenseInput(e.target.value)}
              />
              <div className="analogy-settings-actions">
                <Button size="sm" onClick={saveLicenseSettings}>{t("common.save")}</Button>
                {plugin.settings.buyLicenseUrl && (
                  <Button size="sm" variant="secondary" onClick={() => window.open(plugin.settings.buyLicenseUrl, "_blank")}>
                    {t("settings.license.buy")}
                  </Button>
                )}
                {plugin.settings.manageLicenseUrl && (
                  <Button size="sm" variant="secondary" onClick={() => window.open(plugin.settings.manageLicenseUrl, "_blank")}>
                    {t("settings.license.manage")}
                  </Button>
                )}
              </div>
            </div>
          </details>
        </CardContent>
      </Card>
      </section>

      <section className="analogy-settings__section" aria-labelledby="analogy-settings-search">
        <SettingsSectionHeader
          id="analogy-settings-search"
          title={t("settings.section.search")}
          description={t("settings.section.searchDescription")}
        />

      <Card className="analogy-settings-card">
        <CardHeader>
          <CardTitle className="text-base">{t("settings.chroma.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="analogy-settings-row flex items-center justify-between">
            <span className="text-sm text-[#444444]">{t("settings.chroma.status")}</span>
            {chromaHealthy ? (
              <Badge className="bg-[#0a0a0a] text-white">{t("settings.chroma.running")}</Badge>
            ) : (
              <Badge className="bg-[#e74c3c] text-white">{t("settings.chroma.stopped")}</Badge>
            )}
          </div>
          <div className="analogy-settings-row flex items-center justify-between mt-2">
            <span className="text-sm text-[#444444]">{t("settings.chroma.serviceStatus")}</span>
            <Badge className={
              serviceStatus === "ready"
                ? "bg-[#0a0a0a] text-white"
                : serviceStatus === "error"
                  ? "bg-[#e74c3c] text-white"
                  : "bg-[#f5f5f5] text-[#444444]"
            }>
              {formatServiceStatus(serviceStatus)}
            </Badge>
          </div>
          <div className="analogy-settings-row flex items-center justify-between mt-2">
            <span className="text-sm text-[#444444]">{t("settings.chroma.indexedChunks")}</span>
            <span className="text-sm font-medium">{docCount}</span>
          </div>
          <div className="analogy-settings-row flex items-center justify-between mt-2">
            <span className="text-sm text-[#444444]">{t("settings.chroma.indexedFiles")}</span>
            <span className="text-sm font-medium">{statusCounts.indexed} / {statusCounts.total}</span>
          </div>
          <div className="analogy-settings-row flex items-center justify-between mt-2">
            <span className="text-sm text-[#444444]">{t("settings.chroma.pendingFiles")}</span>
            <span className="text-sm font-medium">{statusCounts.outdated + statusCounts.unindexed}</span>
          </div>
          <div className="text-xs text-[#888888] mt-2 leading-relaxed">
            {t("settings.chroma.modelScopeHint")}
          </div>
        </CardContent>
      </Card>

      <Card className="analogy-settings-card">
        <CardHeader>
          <CardTitle className="text-base">{t("settings.embedding.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="analogy-settings-row flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <span className="text-sm text-[#444444]">{t("settings.embedding.model")}</span>
              <div className="text-xs text-[#888888] mt-0.5">{t("settings.embedding.runHint")}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <select
                className="text-sm border border-[#e5e5e5] rounded-md px-2 py-1 max-w-[260px]"
                aria-label={t("settings.embedding.model")}
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
              >
                {Object.entries(EMBEDDING_MODELS).map(([key, config]) => (
                  <option key={key} value={key}>{config.displayName}</option>
                ))}
              </select>
              {selectedModel !== (plugin.settings.embeddingModel || DEFAULT_MODEL_KEY) && (
                <Button size="sm" onClick={async () => {
                  await searchInstance.documentIndexer?.stop();
                  await plugin.documentIndexer?.stop();
                  updateServiceState({ rebuildProgress: null });
                  plugin.settings.embeddingModel = selectedModel;
                  await plugin.saveSettings();
                  new Notice(t("settings.embedding.modelChanged"));
                  await plugin.reload(plugin.manifest.id);
                }}>
                  {t("common.apply")}
                </Button>
              )}
            </div>
          </div>

          <div className="text-sm text-[#444444] mt-2 leading-relaxed bg-[#fafafa] border border-[#f0f0f0] rounded-md px-3 py-2">
            {modelDescription}
          </div>

          <details className="mt-2">
            <summary className="text-xs text-[#888888] cursor-pointer hover:text-[#444444]">
              {t("settings.embedding.howToChoose")}
            </summary>
            <pre className="whitespace-pre-wrap text-xs text-[#666666] mt-2 bg-[#fafafa] border border-[#f0f0f0] rounded-md px-3 py-2 font-mono">
{t("settings.embedding.pickerHelp")}
            </pre>
          </details>

          {selectedModel !== (plugin.settings.embeddingModel || DEFAULT_MODEL_KEY) && (
            <div className="text-sm text-[#f59e0b] mt-2">
              {t("settings.embedding.switchWarning")}
            </div>
          )}
          <div className="analogy-settings-row flex items-center justify-between mt-2">
            <span className="text-sm text-[#444444]">{t("settings.embedding.statusLabel")}</span>
            {modelReady ? (
              <Badge className="bg-[#0a0a0a] text-white">{t("settings.embedding.ready")}</Badge>
            ) : searchInstance.state.embeddingStatus === "downloading" ? (
              <Badge className="bg-[#f5f5f5] text-[#444444]">{t("settings.embedding.downloading")} {modelProgress}%</Badge>
            ) : searchInstance.state.embeddingStatus === "loading" ? (
              <Badge className="bg-[#f5f5f5] text-[#444444]">{t("settings.embedding.loading")} {modelProgress}%</Badge>
            ) : searchInstance.state.embeddingStatus === "error" ? (
              <Badge className="bg-[#e74c3c] text-white">{t("settings.embedding.error")}</Badge>
            ) : (
              <Badge className="bg-[#f5f5f5] text-[#444444]">{t("settings.embedding.initializing")}</Badge>
            )}
          </div>
          {(searchInstance.state.embeddingStatus === "downloading" || searchInstance.state.embeddingStatus === "loading") && (
            <div className="w-full bg-[#f5f5f5] rounded-full h-1.5 mt-2">
              <div
                className="bg-[#0a0a0a] h-1.5 rounded-full transition-all"
                style={{ width: `${modelProgress}%` }}
              />
            </div>
          )}
          {modelReady && serviceStatus === "ready" && statusCounts.indexed === 0 && (
            <div className="text-sm text-[#f59e0b] mt-2 bg-[#fffbeb] border border-[#fcd34d] rounded-md px-3 py-2">
              {t("settings.embedding.emptyIndexWarning")}
            </div>
          )}
        </CardContent>
      </Card>

      <Card id="analogy-settings-summary" tabIndex={-1} className="analogy-settings-card">
        <CardHeader>
          <CardTitle className="text-base">{t("settings.summary.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <label className="analogy-settings-row flex items-center justify-between gap-3">
            <span className="text-sm text-[#444444]">{t("settings.summary.enable")}</span>
            <input
              type="checkbox"
              checked={plugin.settings.summarizeBeforeEmbedding}
              onChange={async (e) => {
                plugin.settings.summarizeBeforeEmbedding = e.target.checked;
                await plugin.saveSettings();
                await applySummarySettings();
              }}
            />
          </label>

          <div className="analogy-settings-row flex items-start justify-between gap-3 mt-3">
            <div className="flex-1 min-w-0">
              <span className="text-sm text-[#444444]">{t("settings.summary.model")}</span>
              <div className="text-xs text-[#888888] mt-0.5">{t("settings.summary.modelHint")}</div>
            </div>
            <select
              className="text-sm border border-[#e5e5e5] rounded-md px-2 py-1 max-w-[260px]"
              aria-label={t("settings.summary.model")}
              value={selectedSummaryModel}
              onChange={async (e) => {
                const next = e.target.value;
                setSelectedSummaryModel(next);
                setOllamaAvailable(null);
                setOllamaStatus("idle");
                setOllamaMessage("");
                plugin.settings.summaryModel = next;
                await plugin.saveSettings();
                await applySummarySettings();
              }}
            >
              {Object.entries(SUMMARY_MODELS).map(([key, config]) => (
                <option key={key} value={key}>{config.label} · {installedSummarySizes[config.ollamaName] || config.estimatedSize}</option>
              ))}
            </select>
          </div>

          <div className="text-sm text-[#444444] mt-2 leading-relaxed bg-[#fafafa] border border-[#f0f0f0] rounded-md px-3 py-2">
            <div>{summaryModelNote}</div>
            <div className="text-xs text-[#888888] mt-1">{t("settings.summary.size")}: {activeSummarySize}</div>
          </div>

          <div className="analogy-settings-row flex items-center justify-between gap-3 mt-3">
            <span className="text-sm text-[#444444]">{t("settings.summary.ollamaHost")}</span>
            <input
              type="text"
              className="text-sm border border-[#e5e5e5] rounded-md px-2 py-1 w-[260px] max-w-full"
              aria-label={t("settings.summary.ollamaHost")}
              name="analogy-summary-ollama-host"
              autoComplete="off"
              spellCheck={false}
              value={summaryHostInput}
              onChange={(e) => setSummaryHostInput(e.target.value)}
              onBlur={async () => {
                const next = summaryHostInput.trim() || DEFAULT_SETTINGS.summaryOllamaHost;
                plugin.settings.summaryOllamaHost = next.replace(/\/+$/, "");
                setSummaryHostInput(plugin.settings.summaryOllamaHost);
                setOllamaAvailable(null);
                setOllamaStatus("idle");
                setOllamaMessage("");
                await plugin.saveSettings();
                await applySummarySettings();
              }}
            />
          </div>

          <div className="analogy-settings-grid mt-3">
            <label className="text-sm text-[#444444]">
              {t("settings.summary.timeout")}
              <input
                type="number"
                className="mt-1 w-full text-sm border border-[#e5e5e5] rounded-md px-2 py-1"
                min={1000}
                value={summaryTimeoutInput}
                onChange={(e) => setSummaryTimeoutInput(e.target.value)}
                onBlur={async () => {
                  plugin.settings.summaryTimeoutMs = Number(summaryTimeoutInput) || DEFAULT_SETTINGS.summaryTimeoutMs;
                  setSummaryTimeoutInput(String(plugin.settings.summaryTimeoutMs));
                  await plugin.saveSettings();
                  await applySummarySettings();
                }}
              />
            </label>
            <label className="text-sm text-[#444444]">
              {t("settings.summary.maxInput")}
              <input
                type="number"
                className="mt-1 w-full text-sm border border-[#e5e5e5] rounded-md px-2 py-1"
                min={1000}
                value={summaryMaxInputChars}
                onChange={(e) => setSummaryMaxInputChars(e.target.value)}
                onBlur={async () => {
                  plugin.settings.summaryMaxInputChars = Number(summaryMaxInputChars) || DEFAULT_SETTINGS.summaryMaxInputChars;
                  setSummaryMaxInputChars(String(plugin.settings.summaryMaxInputChars));
                  await plugin.saveSettings();
                  await applySummarySettings();
                }}
              />
            </label>
          </div>

          <label className="block mt-3 text-sm text-[#444444]">
            {t("settings.summary.prompt")}
            <textarea
              className="mt-1 w-full min-h-[160px] text-sm border border-[#e5e5e5] rounded-md px-2 py-2 font-mono leading-relaxed"
              value={summaryPromptInput}
              onChange={(e) => setSummaryPromptInput(e.target.value)}
              onBlur={async () => {
                const next = summaryPromptInput.trim() || DEFAULT_SETTINGS.summaryPrompt;
                plugin.settings.summaryPrompt = next;
                setSummaryPromptInput(next);
                await plugin.saveSettings();
                await applySummarySettings();
              }}
            />
            <div className="text-xs text-[#888888] mt-1 leading-relaxed">
              {t("settings.summary.promptHint")}
            </div>
          </label>

          <div className="analogy-settings-row flex items-center justify-between gap-3 mt-3">
            <label className="flex items-center gap-2 text-sm text-[#444444]">
              <input
                type="checkbox"
                checked={plugin.settings.summaryFallbackToOriginal !== false}
                onChange={async (e) => {
                  plugin.settings.summaryFallbackToOriginal = e.target.checked;
                  await plugin.saveSettings();
                  await applySummarySettings();
                }}
              />
              {t("settings.summary.fallback")}
            </label>
          </div>

          <div className="analogy-settings-actions mt-3 pt-3" style={{ borderTop: "1px solid var(--background-modifier-border)" }}>
            <Button size="sm" onClick={checkOllama} disabled={isCheckingOllama}>
              {isCheckingOllama ? t("settings.summary.checking") : t("settings.summary.check")}
            </Button>
            {ollamaAvailable === false ? (
              <Button size="sm" variant="secondary" onClick={openOllamaInstallDocs}>
                {t("settings.summary.installOllama")}
              </Button>
            ) : null}
            {ollamaAvailable === true && ollamaStatus === "error" ? (
              <Button size="sm" variant="secondary" onClick={pullSummaryModel} disabled={isPullingSummaryModel}>
                {isPullingSummaryModel ? t("settings.summary.pulling") : t("settings.summary.pull")}
              </Button>
            ) : null}
            <Badge className={
              ollamaStatus === "ready"
                ? "bg-[#0a0a0a] text-white"
                : ollamaStatus === "error"
                  ? "bg-[#e74c3c] text-white"
                  : "bg-[#f5f5f5] text-[#444444]"
            }>
              {formatOllamaStatus(ollamaStatus)}
            </Badge>
            {(ollamaMessage || summaryPullProgress) && (
              <span className="text-xs text-[#666666] truncate max-w-[260px]" title={ollamaMessage || summaryPullProgress}>
                {summaryPullProgress || ollamaMessage}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {lastError && (
        <div className="text-sm text-[#e74c3c] bg-[#fff5f5] p-3 rounded-md">
          {lastError}
        </div>
      )}

      </section>

      <section className="analogy-settings__section" aria-labelledby="analogy-settings-index">
        <SettingsSectionHeader
          id="analogy-settings-index"
          title={t("settings.section.index")}
          description={t("settings.section.indexDescription")}
        />

      {upgradePrompt && (
        <Card className="analogy-settings-card">
          <CardContent className="pt-4">
            <div className="whitespace-pre-line text-sm text-[#0a0a0a]">
              {t("settings.license.upgradePrompt", {
                limit: upgradePrompt.limit,
                selectedCount: upgradePrompt.selectedCount,
              })}
            </div>
            <div className="mt-3 flex items-center gap-2">
              {upgradePrompt.canOpenBuyUrl && (
                <Button size="sm" onClick={() => window.open(upgradePrompt.buyUrl, "_blank")}>
                  {t("settings.license.buy")}
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={() => setUpgradePrompt(null)}>
                {t("common.dismiss")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="analogy-settings-card">
        <CardHeader>
          <CardTitle className="text-base">{t("settings.exclude.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-[#444444] mb-2">
            {t("settings.exclude.hint")}
          </div>
          <div className="analogy-settings-actions analogy-settings-actions--field mb-3">
            <input
              type="text"
              className="flex-1 text-sm border border-[#e5e5e5] rounded-md px-3 py-1.5"
              aria-label={t("settings.exclude.title")}
              name="analogy-excluded-path"
              autoComplete="off"
              placeholder={t("settings.exclude.placeholder")}
              value={newPathInput}
              onChange={(e) => setNewPathInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addExcludedPath(); }}
            />
            <Button size="sm" variant="secondary" onClick={chooseExcludedFolder}>
              {t("settings.exclude.chooseFolder")}
            </Button>
            <Button size="sm" onClick={addExcludedPath}>{t("common.add")}</Button>
          </div>
          {excludedPaths.length === 0 ? (
            <div className="text-sm text-[#888888] text-center py-4">
              {t("settings.exclude.empty")}
            </div>
          ) : (
            <div className="border border-[#e5e5e5] rounded-md divide-y divide-[#f0f0f0]">
              {excludedPaths.map((p) => (
                <div key={p} className="analogy-settings-row flex items-center justify-between px-3 py-2 text-sm hover:bg-[#fafafa]">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="shrink-0 text-[#888888]">{p.endsWith(".md") ? "📄" : "📁"}</span>
                    <span className="truncate" title={p}>{p}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeExcludedPath(p)}
                    className="shrink-0 ml-2 text-[#888888] hover:text-[#e74c3c] text-base leading-none px-1"
                    title={t("common.remove")}
                    aria-label={`${t("common.remove")}: ${p}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {excludedPaths.length > 0 && (
            <div className="text-xs text-[#888888] mt-2">{excludedPaths.length} {t("settings.exclude.pathsCount")}</div>
          )}
        </CardContent>
      </Card>

      {isRebuilding && rebuildProgress && (
        <Card className="analogy-settings-card">
          <CardContent className="pt-4">
            <div className="analogy-settings-row flex items-center justify-between mb-2">
              <span className="text-sm font-medium">{t("settings.rebuild.progress")}</span>
              <span className="text-sm text-[#444444]">
                {rebuildProgress.current} / {rebuildProgress.total}
              </span>
            </div>
            <div className="w-full bg-[#f5f5f5] rounded-full h-2">
              <div
                className="bg-[#0a0a0a] h-2 rounded-full transition-all"
                style={{ width: `${Math.round((rebuildProgress.current / rebuildProgress.total) * 100)}%` }}
              />
            </div>
            <div className="text-xs text-[#888888] mt-1 truncate" title={rebuildProgress.currentFile}>
              {rebuildProgress.currentFile}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="analogy-settings-card">
        <CardHeader>
          <CardTitle className="text-base">{t("settings.actions.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="analogy-index-actions">
            <div>
              <p className="m-0 text-sm text-[#444444]">{t("settings.actions.description")}</p>
              <div className="analogy-index-actions__primary mt-3">
                {isRebuilding ? (
                  <Button onClick={stopIndexing} disabled={isStoppingIndex} variant="destructive">
                    {isStoppingIndex ? t("settings.actions.stoppingIndex") : t("settings.actions.stopIndex")}
                  </Button>
                ) : (
                  <Button onClick={continueIndex}>
                    {t("settings.actions.continueIndex")}
                  </Button>
                )}
                <Button onClick={rebuildIndex} disabled={isRebuilding} variant="secondary">
                  {isRebuilding
                    ? rebuildProgress
                      ? `${t("settings.actions.indexing").replace("...","")} ${Math.round((rebuildProgress.current / rebuildProgress.total) * 100)}%`
                      : t("settings.actions.indexing")
                    : t("settings.actions.rebuildIndex")}
                </Button>
              </div>
            </div>
            <div className="analogy-index-actions__danger">
              <p className="analogy-index-actions__danger-copy">
                {t("settings.actions.dangerDescription")}
              </p>
              <Button onClick={clearIndex} variant="destructive" size="sm">
                {t("settings.actions.clearIndex")}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="analogy-settings-card">
        <CardHeader>
          <CardTitle className="text-base">{t("settings.docs.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="analogy-doc-toolbar">
            <div className="analogy-doc-toolbar__filters">
            <button
              onClick={() => setStatusFilter("all")}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                statusFilter === "all"
                  ? "bg-[#0a0a0a] text-white border-[#0a0a0a]"
                  : "bg-white text-[#444444] border-[#e5e5e5] hover:border-[#aaa]"
              }`}
            >
              {t("settings.docs.filter.all")} ({statusCounts.total})
            </button>
            <button
              onClick={() => setStatusFilter("indexed")}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                statusFilter === "indexed"
                  ? "bg-[#0a0a0a] text-white border-[#0a0a0a]"
                  : "bg-white text-[#444444] border-[#e5e5e5] hover:border-[#aaa]"
              }`}
            >
              {t("settings.docs.filter.indexed")} ({statusCounts.indexed})
            </button>
            <button
              onClick={() => setStatusFilter("outdated")}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                statusFilter === "outdated"
                  ? "bg-[#0a0a0a] text-white border-[#0a0a0a]"
                  : "bg-white text-[#444444] border-[#e5e5e5] hover:border-[#aaa]"
              }`}
            >
              {t("settings.docs.filter.outdated")} ({statusCounts.outdated})
            </button>
            <button
              onClick={() => setStatusFilter("unindexed")}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                statusFilter === "unindexed"
                  ? "bg-[#0a0a0a] text-white border-[#0a0a0a]"
                  : "bg-white text-[#444444] border-[#e5e5e5] hover:border-[#aaa]"
              }`}
            >
              {t("settings.docs.filter.unindexed")} ({statusCounts.unindexed})
            </button>
            </div>
            <Button size="sm" variant="secondary" onClick={() => refreshFileStatuses()}>
              {t("common.refresh")}
            </Button>
          </div>

          <input
            type="text"
            placeholder={t("settings.docs.searchPlaceholder")}
            className="w-full text-sm border border-[#e5e5e5] rounded-md px-3 py-1.5 mb-3"
            aria-label={t("settings.docs.searchPlaceholder")}
            name="analogy-document-search"
            autoComplete="off"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />

          <div className="max-h-[400px] overflow-y-auto border border-[#e5e5e5] rounded-md">
            {filteredFiles.length === 0 ? (
              <div className="text-sm text-[#888888] text-center py-6">{t("settings.docs.noFiles")}</div>
            ) : (
              filteredFiles.slice(0, displayLimit).map((file) => (
                <div
                  key={file.path}
                  className="analogy-settings-row analogy-document-row flex items-center justify-between px-3 py-2 text-sm hover:bg-[#fafafa]"
                  style={{ borderBottom: "1px solid var(--background-modifier-border)" }}
                >
                  <div className="flex-1 min-w-0 mr-3">
                    <div className="font-medium truncate" title={file.path}>{file.name}</div>
                    <div className="text-xs text-[#888888] truncate">{file.path}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {file.status === "indexed" && !file.muted && (
                      <Badge className="bg-[#0a0a0a] text-white text-xs">{file.chunkCount} {t("settings.docs.chunks")}</Badge>
                    )}
                    {file.status === "indexed" && file.muted && (
                      <Badge className="bg-[#aaa] text-white text-xs">{t("settings.docs.muted")}</Badge>
                    )}
                    {file.status === "outdated" && (
                      <Badge className="bg-[#f59e0b] text-white text-xs">{t("settings.docs.filter.outdated")}</Badge>
                    )}
                    {file.status === "unindexed" && (
                      <Badge className="bg-[#e5e5e5] text-[#666] text-xs">{t("settings.docs.filter.unindexed")}</Badge>
                    )}
                    {file.status === "indexed" && (
                      <button
                        onClick={() => toggleMuted(file.path, file.muted)}
                        className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                          file.muted
                            ? "border-[#0a0a0a] bg-[#0a0a0a] text-white hover:bg-[#333]"
                            : "border-[#e5e5e5] hover:bg-[#f5f5f5]"
                        }`}
                      >
                        {file.muted ? t("settings.docs.unmute") : t("settings.docs.mute")}
                      </button>
                    )}
                    <button
                      onClick={() => indexSingleFile(file.path)}
                      disabled={indexingFile === file.path || isRebuilding}
                      className="text-xs px-2 py-0.5 rounded border border-[#e5e5e5] hover:bg-[#f5f5f5] disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {indexingFile === file.path ? "..." : file.status === "indexed" ? t("settings.docs.reindex") : t("settings.docs.index")}
                    </button>
                  </div>
                </div>
              ))
            )}
            {filteredFiles.length > displayLimit && (
              <div className="text-center py-2" style={{ borderTop: "1px solid var(--background-modifier-border)" }}>
                <button
                  onClick={() => setDisplayLimit((prev) => prev + 100)}
                  className="text-xs text-[#444444] hover:text-[#0a0a0a]"
                >
                  {t("settings.docs.showMore")} ({filteredFiles.length - displayLimit})
                </button>
              </div>
            )}
          </div>
          {filteredFiles.length > 0 && (
            <div className="text-xs text-[#888888] mt-2">
              {t("settings.docs.showing")} {Math.min(displayLimit, filteredFiles.length)} {t("settings.docs.of")} {filteredFiles.length} {t("settings.docs.files")}
              {statusFilter !== "all" || searchQuery
                ? ` (${t("settings.docs.totalCount", { count: statusCounts.total })})`
                : ""}
            </div>
          )}
        </CardContent>
      </Card>
      </section>

      <section className="analogy-settings__section" aria-labelledby="analogy-settings-support">
        <SettingsSectionHeader
          id="analogy-settings-support"
          title={t("settings.section.support")}
          description={t("settings.section.supportDescription")}
        />

      <Card className="analogy-settings-card">
        <CardHeader>
          <CardTitle className="text-base">{t("settings.diagnostics.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-[#444444] mb-3">
            {t("settings.diagnostics.description")}
          </div>
          {safeModeState.enabled && (
            <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              <div className="font-medium">{t("settings.diagnostics.safeModeTitle")}</div>
              <div className="mt-1 text-xs">
                {t("settings.diagnostics.safeModeDescription")}
              </div>
              {safeModeState.reason && (
                <div className="mt-2 break-words rounded bg-white/70 px-2 py-1 text-xs">
                  {t("settings.diagnostics.safeModeReason")}: {formatSafeModeReason(safeModeState.reason)}
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={switchToRecommendedSmallModelAndRecover}
                  disabled={isRecoveringSafeMode}
                  className="rounded-md bg-amber-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
                >
                  {isRecoveringSafeMode
                    ? t("settings.diagnostics.safeModeRetrying")
                    : t("settings.diagnostics.safeModeSwitchModel")}
                </button>
                <button
                  type="button"
                  onClick={recoverFromSafeMode}
                  disabled={isRecoveringSafeMode}
                  className="rounded-md border border-amber-900 bg-white px-3 py-2 text-xs font-medium text-amber-950 disabled:opacity-50"
                >
                  {t("settings.diagnostics.safeModeRetry")}
                </button>
                <button
                  type="button"
                  onClick={keepSafeMode}
                  disabled={isRecoveringSafeMode}
                  className="rounded-md border border-amber-300 bg-transparent px-3 py-2 text-xs font-medium text-amber-950 disabled:opacity-50"
                >
                  {t("settings.diagnostics.safeModeKeep")}
                </button>
              </div>
            </div>
          )}
          {(() => {
            const marker = recorder?.getMarker();
            const unclean = recorder?.isSuspectedUncleanExit();
            return (
              <div className="mb-3 text-sm space-y-1">
                <div>
                  {t("settings.diagnostics.lastRun")}: {" "}
                  {unclean ? (
                    <span className="text-red-600 font-medium">{t("settings.diagnostics.suspectedUncleanExit")}</span>
                  ) : (
                    <span className="text-green-600">{t("settings.diagnostics.cleanExit")}</span>
                  )}
                </div>
                <div>
                  {t("settings.diagnostics.lastStage")}: {" "}
                  <code className="text-xs bg-[#f5f5f5] px-1 rounded">{marker?.lastStage || "-"}</code>
                </div>
                <div>
                  {t("settings.diagnostics.eventCount")}: {recorder?.getEvents().length ?? 0}
                </div>
                {diagnosticLastReportId && (
                  <div className="text-xs text-[#888888]">
                    {t("settings.diagnostics.sendSuccess")} {diagnosticLastReportId}
                  </div>
                )}
              </div>
            );
          })()}
          <div className="analogy-settings-grid">
            <button
              type="button"
              onClick={openDiagnosticPreview}
              className="rounded-md border border-[#e5e5e5] bg-white px-3 py-2 text-sm font-medium text-[#0a0a0a] transition-colors hover:border-[#aaa] hover:bg-[#fafafa]"
            >
              {t("settings.diagnostics.preview")}
            </button>
            <button
              type="button"
              onClick={copyDiagnosticReport}
              className="rounded-md border border-[#e5e5e5] bg-white px-3 py-2 text-sm font-medium text-[#0a0a0a] transition-colors hover:border-[#aaa] hover:bg-[#fafafa]"
            >
              {t("settings.diagnostics.copy")}
            </button>
            <button
              type="button"
              onClick={saveDiagnosticReport}
              className="rounded-md border border-[#e5e5e5] bg-white px-3 py-2 text-sm font-medium text-[#0a0a0a] transition-colors hover:border-[#aaa] hover:bg-[#fafafa]"
            >
              {t("settings.diagnostics.save")}
            </button>
            <button
              type="button"
              onClick={clearDiagnosticData}
              className="rounded-md border border-[#e5e5e5] bg-white px-3 py-2 text-sm font-medium text-[#0a0a0a] transition-colors hover:border-[#aaa] hover:bg-[#fafafa]"
            >
              {t("settings.diagnostics.clear")}
            </button>
          </div>
          <div className="mt-3 text-xs text-[#888888]">
            {t("settings.feedback.description")}
            <button
              type="button"
              onClick={copySupportEmail}
              className="ml-1 underline hover:text-[#0a0a0a]"
            >
              {SUPPORT_EMAIL}
            </button>
          </div>
        </CardContent>
      </Card>
      </section>

      <Dialog open={diagnosticPreviewOpen} onOpenChange={setDiagnosticPreviewOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("settings.diagnostics.previewTitle")}</DialogTitle>
            <DialogDescription>{t("settings.diagnostics.dataDisclaimer")}</DialogDescription>
          </DialogHeader>
          {(() => {
            const report = diagnosticPreviewReport;
            if (!report) {
              return <div className="py-4 text-sm text-[#888888]">{t("settings.diagnostics.noReport")}</div>;
            }
            return (
              <div className="space-y-3 text-sm">
                <div className="analogy-settings-grid text-xs">
                  <div>{t("settings.diagnostics.fieldPlugin")}: {report.plugin.version}</div>
                  <div>{t("settings.diagnostics.fieldBuild")}: {report.plugin.build_id || t("common.development")}</div>
                  <div>{t("settings.diagnostics.fieldObsidian")}: {formatDiagnosticValue(report.host.obsidian_version)}</div>
                  <div>
                    {t("settings.diagnostics.fieldPlatform")}: {formatDiagnosticValue(report.host.platform)} {formatDiagnosticValue(report.host.arch)}
                  </div>
                  <div>{t("settings.diagnostics.fieldLocale")}: {formatDiagnosticLocale(report.host.locale)}</div>
                  <div>{t("settings.diagnostics.fieldModel")}: {report.runtime.model}</div>
                  <div>{t("settings.diagnostics.fieldLastStage")}: {report.session.last_stage}</div>
                  <div>
                    {t("settings.diagnostics.fieldUncleanExit")}: {report.session.suspected_unclean_exit ? t("common.yes") : t("common.no")}
                  </div>
                </div>
                <Textarea
                  placeholder={t("settings.diagnostics.optionalNote")}
                  value={diagnosticUserNote}
                  onChange={(e) => {
                    const nextNote = e.target.value;
                    setDiagnosticUserNote(nextNote);
                    replaceDiagnosticSnapshot(nextNote);
                  }}
                  className="min-h-[60px]"
                />
                <div className="text-xs font-medium">
                  {t("settings.diagnostics.finalPayload")}
                </div>
                <div className="rounded border border-[#e5e5e5] bg-[#fafafa] p-2 max-h-[240px] overflow-y-auto text-xs font-mono whitespace-pre-wrap">
                  {diagnosticSnapshot.serialize()}
                </div>
              </div>
            );
          })()}
          <DialogFooter className="mt-4">
            <button
              type="button"
              onClick={() => setDiagnosticPreviewOpen(false)}
              className="rounded-md border border-[#e5e5e5] bg-white px-4 py-2 text-sm font-medium text-[#0a0a0a] transition-colors hover:bg-[#fafafa]"
            >
              {t("settings.diagnostics.close")}
            </button>
            <button
              type="button"
              onClick={copyDiagnosticReport}
              className="rounded-md border border-[#e5e5e5] bg-white px-4 py-2 text-sm font-medium text-[#0a0a0a] transition-colors hover:bg-[#fafafa]"
            >
              {t("settings.diagnostics.copy")}
            </button>
            <button
              type="button"
              onClick={sendDiagnosticReportFromUI}
              disabled={diagnosticSending || !diagnosticPreviewReport}
              className="rounded-md bg-[#0a0a0a] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#333] disabled:opacity-50"
            >
              {diagnosticSending ? t("common.sending") : t("settings.diagnostics.send")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
