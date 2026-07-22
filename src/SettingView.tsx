import {App, Notice, PluginSettingTab, Setting, TFile} from "obsidian";
import Analogy from "../main";
import {createRoot, Root} from "react-dom/client";
import {StrictMode, useCallback, useEffect, useMemo, useRef, useState} from "react";
import {AppContext} from "./model/AppContext";
import * as React from "react";
import {Button} from "./components/button";
import {Badge} from "./components/badge";
import {Card, CardContent, CardHeader, CardTitle} from "./components/card";
import { searchInstance, updateServiceState } from "./local-vector/search-instance";
import type { FileIndexStatus, IndexState, RebuildProgress } from "./local-vector/document-indexer";
import {normalizeExcludedIndexPaths} from "./local-vector/excluded-paths";
import {EMBEDDING_MODELS, DEFAULT_MODEL_KEY} from "./local-vector/embedding";
import {OllamaClient} from "./local-vector/ollama-client";
import {DEFAULT_SUMMARY_PROMPT, DocumentSummarizer} from "./local-vector/document-summarizer";
import {DEFAULT_SUMMARY_MODEL_KEY, formatModelBytes, SUMMARY_MODELS} from "./local-vector/summary-models";
import {
  getLocalRuntimeStatus,
  installLocalRuntimeDependencies,
  type LocalRuntimeStatus,
} from "./local-vector/runtime-dependencies";
import {getLocale, setLocale, onLocaleChange, t, type Locale, SUPPORTED_LOCALES} from "./util/i18n";
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

const SUPPORT_EMAIL = "analogypkm@gmail.com";

export interface AnalogySettings {
  chromaPort: number;
  embeddingModelHost: string;
  excludedIndexPaths: string[];
  embeddingModel: string;
  licenseServerUrl: string;
  buyLicenseUrl: string;
  manageLicenseUrl: string;
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
}

export const DEFAULT_SETTINGS: AnalogySettings = {
  chromaPort: 8000,
  embeddingModelHost: "https://hf-mirror.com/",
  excludedIndexPaths: [],
  embeddingModel: DEFAULT_MODEL_KEY,
  licenseServerUrl: DEFAULT_LICENSE_SERVER_URL,
  buyLicenseUrl: DEFAULT_BUY_LICENSE_URL,
  manageLicenseUrl: DEFAULT_MANAGE_LICENSE_URL,
  indexStates: {},
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
    this.root = createRoot(this.containerEl);
    this.root.render(
      <StrictMode>
        <AppContext.Provider value={this.app}>
          <SettingDetail plugin={this.plugin} setting={this}/>
        </AppContext.Provider>
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
  return limit >= Number.MAX_SAFE_INTEGER ? "Unlimited" : String(limit);
}

function getPluginDir(plugin: Analogy): string {
  const path = require("path");
  const basePath = (plugin.app.vault.adapter as any).basePath;
  const manifestDir = (plugin.manifest as any).dir;
  if (manifestDir) {
    return path.resolve(basePath, manifestDir);
  }
  const configDir = (plugin.app.vault as any).configDir || ".obsidian";
  return path.join(basePath, configDir, "plugins", plugin.manifest.id);
}

function SettingDetail({plugin, setting}:{plugin:Analogy, setting:AnalogySettingTab}) {
  const pluginDir = useMemo(() => getPluginDir(plugin), [plugin]);
  const [chromaHealthy, setChromaHealthy] = useState(false);
  const [docCount, setDocCount] = useState(0);
  const [modelReady, setModelReady] = useState(false);
  const [modelProgress, setModelProgress] = useState(0);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [isStoppingIndex, setIsStoppingIndex] = useState(false);
  const [isStartingChroma, setIsStartingChroma] = useState(false);
  const [rebuildProgress, setRebuildProgress] = useState<RebuildProgress | null>(null);
  const [dbPath, setDbPath] = useState("");
  const [lastError, setLastError] = useState("");
  const [serviceStatus, setServiceStatus] = useState(searchInstance.state.status);
  const [portInput, setPortInput] = useState(String(plugin.settings.chromaPort || 8000));
  const [modelHostInput, setModelHostInput] = useState(plugin.settings.embeddingModelHost || DEFAULT_SETTINGS.embeddingModelHost);
  const [selectedModel, setSelectedModel] = useState(plugin.settings.embeddingModel || DEFAULT_MODEL_KEY);
  const [selectedSummaryModel, setSelectedSummaryModel] = useState(plugin.settings.summaryModel || DEFAULT_SUMMARY_MODEL_KEY);
  const [summaryHostInput, setSummaryHostInput] = useState(plugin.settings.summaryOllamaHost || DEFAULT_SETTINGS.summaryOllamaHost);
  const [summaryTimeoutInput, setSummaryTimeoutInput] = useState(String(plugin.settings.summaryTimeoutMs || DEFAULT_SETTINGS.summaryTimeoutMs));
  const [summaryMaxInputChars, setSummaryMaxInputChars] = useState(String(plugin.settings.summaryMaxInputChars || DEFAULT_SETTINGS.summaryMaxInputChars));
  const [summaryPromptInput, setSummaryPromptInput] = useState(plugin.settings.summaryPrompt || DEFAULT_SETTINGS.summaryPrompt);
  const [ollamaStatus, setOllamaStatus] = useState<"idle" | "ready" | "error">("idle");
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
  const [runtimeStatus, setRuntimeStatus] = useState<LocalRuntimeStatus>(() => getLocalRuntimeStatus(pluginDir));
  const [isInstallingRuntime, setIsInstallingRuntime] = useState(false);
  const [isRefreshingRuntime, setIsRefreshingRuntime] = useState(false);
  const [runtimeInstallLog, setRuntimeInstallLog] = useState("");

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
  const chromaBin = dbPath
    ? `${dbPath.replace(/\/chroma_data\/[^/]+$/, "")}/chroma-venv/bin/chroma`
    : "<plugin-data-dir>/chroma-venv/bin/chroma";
  const manualChromaCommand = `"${chromaBin}" run --path "${dbPath || "<plugin-data-dir>/chroma_data/<vault-id>"}" --host 127.0.0.1 --port ${portInput || "8000"}`;

  const [fileStatuses, setFileStatuses] = useState<FileIndexStatus[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [indexingFile, setIndexingFile] = useState<string | null>(null);
  const stopRequestedRef = useRef(false);

  const refreshServiceStatus = async () => {
    setServiceStatus(searchInstance.state.status);
    setModelReady(searchInstance.embeddingService?.isReady() ?? false);
    setModelProgress(searchInstance.state.modelDownloadProgress);
    setDbPath(searchInstance.state.dbPath);
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

  function refreshRuntimeStatus() {
    const nextStatus = getLocalRuntimeStatus(pluginDir);
    setRuntimeStatus(nextStatus);
    return nextStatus;
  }

  async function refreshRuntimeAndServices() {
    setIsRefreshingRuntime(true);
    try {
      const nextStatus = refreshRuntimeStatus();
      if (nextStatus.ready) {
        await plugin.initLocalServices();
      }
      await refreshServiceStatus();
      refreshFileStatuses();
    } catch (err) {
      const message = (err as Error).message;
      setLastError(message);
      new Notice(message);
    } finally {
      setIsRefreshingRuntime(false);
    }
  }

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
      new Notice("Local indexer not initialized");
      return;
    }
    const files = plugin.app.vault.getMarkdownFiles();
    const limit = getCurrentPageLimit(licenseState);
    if (files.length > limit) {
      showUpgradePrompt(files.length, limit);
      new Notice(`Free plan supports indexing up to ${limit} Markdown pages. This vault has ${files.length} pages.`);
      return;
    }
    setUpgradePrompt(null);
    stopRequestedRef.current = false;
    setIsRebuilding(true);
    setRebuildProgress(null);
    try {
      await searchInstance.documentIndexer.rebuildIndex(files, {
        force: true,
        onProgress: (p) => {
          setRebuildProgress(p);
          updateServiceState({ rebuildProgress: p });
        },
      });
      if (!stopRequestedRef.current) {
        new Notice("Index rebuilt");
      }
      await refreshServiceStatus();
      refreshFileStatuses();
    } catch (err) {
      console.error("[Analogy] Rebuild error:", err);
      new Notice("Rebuild failed: " + (err as Error).message);
    } finally {
      setIsRebuilding(false);
      setIsStoppingIndex(false);
      setRebuildProgress(null);
      updateServiceState({ rebuildProgress: null });
    }
  }

  async function continueIndex() {
    if (!searchInstance.documentIndexer) {
      new Notice("Local indexer not initialized");
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
      new Notice(`Free plan supports indexing up to ${limit} Markdown pages. Upgrade to continue indexing this vault.`);
      return;
    }
    if (allowedFiles.length === 0) {
      new Notice("No pending Markdown pages to index.");
      return;
    }
    stopRequestedRef.current = false;
    setIsRebuilding(true);
    setRebuildProgress(null);
    try {
      await searchInstance.documentIndexer.continueIndex(allowedFiles, {
        onProgress: (p) => {
          setRebuildProgress(p);
          updateServiceState({ rebuildProgress: p });
        },
      });
      if (!stopRequestedRef.current) {
        new Notice(capacityPlan.isLimited ? "Indexed up to the free page limit. Upgrade to index the remaining pages." : "Continue index done");
      }
      await refreshServiceStatus();
      refreshFileStatuses();
    } catch (err) {
      console.error("[Analogy] Continue index error:", err);
      new Notice("Continue index failed: " + (err as Error).message);
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
      new Notice("Stop index failed: " + (err as Error).message);
    } finally {
      setIsStoppingIndex(false);
      setIsRebuilding(false);
    }
  }

  async function indexSingleFile(filePath: string) {
    if (!searchInstance.documentIndexer) {
      new Notice("Local indexer not initialized");
      return;
    }
    const file = plugin.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      new Notice("File not found: " + filePath);
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
      new Notice(`Free plan supports indexing up to ${capacityPlan.limit} Markdown pages. Upgrade to index more pages.`);
      return;
    }
    setUpgradePrompt(null);
    setIndexingFile(filePath);
    try {
      await searchInstance.documentIndexer.reindexDocument(file);
      new Notice(`Indexed: ${file.name}`);
      refreshFileStatuses();
      if (searchInstance.vectorStore) {
        const count = await searchInstance.vectorStore.count();
        setDocCount(count);
      }
    } catch (err) {
      console.error(`[Analogy] Single index error for ${filePath}:`, err);
      new Notice("Index failed: " + (err as Error).message);
    } finally {
      setIndexingFile(null);
    }
  }

  async function toggleMuted(filePath: string, currentlyMuted: boolean) {
    if (!searchInstance.documentIndexer) return;
    await searchInstance.documentIndexer.setMuted(filePath, !currentlyMuted);
    refreshFileStatuses();
    new Notice(currentlyMuted ? `Unmuted: ${filePath}` : `Muted: ${filePath}`);
  }

  async function savePort() {
    const val = parseInt(portInput, 10);
    if (isNaN(val) || val < 1 || val > 65535) {
      new Notice("Port must be between 1 and 65535");
      return;
    }
    plugin.settings.chromaPort = val;
    await plugin.saveSettings();
    new Notice(`ChromaDB port saved: ${val}. Reload plugin to apply.`);
  }

  async function startChromaFromSettings() {
    const val = parseInt(portInput, 10);
    if (isNaN(val) || val < 1 || val > 65535) {
      new Notice("Port must be between 1 and 65535");
      return;
    }
    setIsStartingChroma(true);
    try {
      plugin.settings.chromaPort = val;
      await plugin.saveSettings();
      await plugin.initLocalServices();
      await refreshServiceStatus();
      refreshFileStatuses();
      if (searchInstance.state.status === "ready") {
        new Notice(t("settings.chroma.startDone"));
      } else if (searchInstance.state.lastError) {
        new Notice(searchInstance.state.lastError);
      }
    } catch (err) {
      const message = (err as Error).message;
      setLastError(message);
      new Notice(message);
    } finally {
      setIsStartingChroma(false);
    }
  }

  async function saveModelHost() {
    const val = modelHostInput.trim();
    if (!/^https?:\/\/.+/i.test(val)) {
      new Notice("Model host must start with http:// or https://");
      return;
    }
    plugin.settings.embeddingModelHost = val.endsWith("/") ? val : `${val}/`;
    setModelHostInput(plugin.settings.embeddingModelHost);
    await plugin.saveSettings();
    new Notice("Embedding model host saved. Reload plugin to apply.");
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
      setOllamaStatus(installed ? "ready" : "error");
      setOllamaMessage(installed ? t("settings.summary.modelInstalled") : t("settings.summary.modelMissing"));
    } catch (err) {
      setOllamaStatus("error");
      setOllamaMessage((err as Error).message);
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

  async function saveLicenseSettings() {
    const licenseServerUrl = licenseServerInput.trim().replace(/\/+$/, "");
    if (licenseServerUrl && !/^https?:\/\/.+/i.test(licenseServerUrl)) {
      new Notice("License server URL must start with http:// or https://");
      return;
    }
    const buyLicenseUrl = buyLicenseInput.trim();
    const manageLicenseUrl = manageLicenseInput.trim();
    for (const url of [buyLicenseUrl, manageLicenseUrl]) {
      if (url && !/^https?:\/\/.+/i.test(url)) {
        new Notice("License links must start with http:// or https://");
        return;
      }
    }
    plugin.settings.licenseServerUrl = licenseServerUrl;
    plugin.settings.buyLicenseUrl = buyLicenseUrl;
    plugin.settings.manageLicenseUrl = manageLicenseUrl;
    setLicenseServerInput(licenseServerUrl);
    await plugin.saveSettings();
    new Notice("License settings saved");
  }

  async function activateLicense() {
    const licenseKey = licenseKeyInput.trim();
    if (!licenseKey) {
      new Notice("Enter a license key first");
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
        new Notice("License activated");
      } else {
        new Notice("License is invalid or inactive");
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
      new Notice("Local license cleared");
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
      new Notice("License deactivated on this device");
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
      new Notice("Path already in no-index list");
      return;
    }
    const updated = [...excludedPaths, pathToAdd];
    await syncExcludedPaths(updated);
    setNewPathInput("");
    new Notice(`Added to no-index: ${pathToAdd}`);
  }

  async function removeExcludedPath(pathToRemove: string) {
    const updated = excludedPaths.filter((p) => p !== pathToRemove);
    await syncExcludedPaths(updated);
    new Notice(`Removed from no-index: ${pathToRemove}`);
  }

  async function clearIndex() {
    if (!searchInstance.vectorStore) {
      new Notice("Local vector store not initialized");
      return;
    }
    if (!confirm("Are you sure you want to clear the local index? This cannot be undone.")) {
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
      new Notice("Local index cleared");
      await refreshServiceStatus();
      refreshFileStatuses();
    } catch (err) {
      console.error("[Analogy] Clear error:", err);
      new Notice("Clear failed: " + (err as Error).message);
    }
  }

  async function installRuntime() {
    if (!confirm(t("settings.runtime.confirm"))) {
      return;
    }
    setIsInstallingRuntime(true);
    setRuntimeInstallLog("");
    try {
      await installLocalRuntimeDependencies(pluginDir, (line) => {
        if (!line.trim()) return;
        setRuntimeInstallLog((prev) => `${prev}${prev ? "\n" : ""}${line}`);
      });
      const nextStatus = refreshRuntimeStatus();
      if (!nextStatus.ready) {
        throw new Error(nextStatus.message);
      }
      new Notice(t("settings.runtime.installDone"));
      await plugin.initLocalServices();
      await refreshServiceStatus();
      refreshFileStatuses();
    } catch (err) {
      const message = (err as Error).message;
      setRuntimeInstallLog((prev) => `${prev}${prev ? "\n" : ""}${message}`);
      new Notice(`${t("settings.runtime.installFailed")}: ${message}`);
    } finally {
      setIsInstallingRuntime(false);
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

  return (
    <div className="space-y-4 py-4">
      <h2 className="font-serif text-xl font-bold text-[#0a0a0a] mb-4">{t("settings.localVectorStatus")}</h2>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("settings.runtime.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-[#444444]">{t("settings.runtime.desc")}</div>
              <div className="text-xs text-[#888888] mt-1 break-all">{pluginDir}</div>
            </div>
            <Badge className={runtimeStatus.ready ? "bg-[#0a0a0a] text-white" : "bg-[#e74c3c] text-white"}>
              {runtimeStatus.ready ? t("settings.runtime.ready") : t("settings.runtime.missing")}
            </Badge>
          </div>

          {!runtimeStatus.ready && (
            <div className="mt-3 bg-[#fff8f2] border border-[#f2d6c1] rounded-md px-3 py-2">
              <div className="text-sm text-[#7a3e16]">{t("settings.runtime.missingPackages")}: {runtimeStatus.missing.join(", ")}</div>
              <div className="text-xs text-[#7a3e16] mt-1 leading-relaxed">{t("settings.runtime.installHint")}</div>
              <div className="flex items-center gap-2 mt-3">
                <Button size="sm" onClick={installRuntime} disabled={isInstallingRuntime}>
                  {isInstallingRuntime ? t("settings.runtime.installing") : t("settings.runtime.install")}
                </Button>
                <Button size="sm" variant="secondary" onClick={refreshRuntimeAndServices} disabled={isInstallingRuntime || isRefreshingRuntime}>
                  {isRefreshingRuntime ? t("settings.runtime.refreshing") : t("common.refresh")}
                </Button>
              </div>
            </div>
          )}

          {runtimeInstallLog && (
            <pre className="mt-3 max-h-[180px] overflow-auto whitespace-pre-wrap text-xs bg-[#0f172a] text-[#e5e7eb] rounded-md px-3 py-2 font-mono">
{runtimeInstallLog}
            </pre>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("settings.language.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <span className="text-sm text-[#444444]">{t("settings.language.hint")}</span>
            <select
              className="text-sm border border-[#e5e5e5] rounded-md px-2 py-1"
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("settings.license.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <span className="text-sm text-[#444444]">{t("settings.license.plan")}</span>
            <Badge className={licenseState.status === "active" ? "bg-[#0a0a0a] text-white" : "bg-[#f5f5f5] text-[#444444]"}>
              {licenseState.status === "active" ? (licenseState.plan || "Personal") : "Free"}
            </Badge>
          </div>
          <div className="flex items-center justify-between mt-2">
            <span className="text-sm text-[#444444]">{t("settings.license.pageLimit")}</span>
            <span className="text-sm font-medium">{formatPageLimit(getCurrentPageLimit(licenseState))}</span>
          </div>
          <div className="flex items-center justify-between mt-2">
            <span className="text-sm text-[#444444]">{t("settings.license.freeLimit")}</span>
            <span className="text-sm font-medium">{FREE_PAGE_LIMIT}</span>
          </div>
          {licenseState.licenseKeyMasked && (
            <div className="flex items-center justify-between mt-2">
              <span className="text-sm text-[#444444]">{t("settings.license.key")}</span>
              <span className="text-sm font-medium">{licenseState.licenseKeyMasked}</span>
            </div>
          )}

          <div className="flex items-center gap-2 mt-3 pt-3" style={{ borderTop: "1px solid #f5f5f5" }}>
            <input
              type="password"
              className="flex-1 text-sm border border-[#e5e5e5] rounded-md px-3 py-1.5"
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
                placeholder={t("settings.license.serverUrl")}
                value={licenseServerInput}
                onChange={(e) => setLicenseServerInput(e.target.value)}
              />
              <input
                type="text"
                className="w-full text-sm border border-[#e5e5e5] rounded-md px-3 py-1.5"
                placeholder={t("settings.license.buyUrl")}
                value={buyLicenseInput}
                onChange={(e) => setBuyLicenseInput(e.target.value)}
              />
              <input
                type="text"
                className="w-full text-sm border border-[#e5e5e5] rounded-md px-3 py-1.5"
                placeholder={t("settings.license.manageUrl")}
                value={manageLicenseInput}
                onChange={(e) => setManageLicenseInput(e.target.value)}
              />
              <div className="flex gap-2">
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("settings.chroma.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <span className="text-sm text-[#444444]">{t("settings.chroma.status")}</span>
            {chromaHealthy ? (
              <Badge className="bg-[#0a0a0a] text-white">{t("settings.chroma.running")}</Badge>
            ) : (
              <Badge className="bg-[#e74c3c] text-white">{t("settings.chroma.stopped")}</Badge>
            )}
          </div>
          <div className="flex items-center justify-between mt-2">
            <span className="text-sm text-[#444444]">{t("settings.chroma.serviceStatus")}</span>
            <Badge className={
              serviceStatus === "ready"
                ? "bg-[#0a0a0a] text-white"
                : serviceStatus === "error"
                  ? "bg-[#e74c3c] text-white"
                  : "bg-[#f5f5f5] text-[#444444]"
            }>
              {serviceStatus}
            </Badge>
          </div>
          <div className="flex items-center justify-between mt-2">
            <span className="text-sm text-[#444444]">{t("settings.chroma.indexedChunks")}</span>
            <span className="text-sm font-medium">{docCount}</span>
          </div>
          <div className="flex items-center justify-between mt-2">
            <span className="text-sm text-[#444444]">{t("settings.chroma.indexedFiles")}</span>
            <span className="text-sm font-medium">{statusCounts.indexed} / {statusCounts.total}</span>
          </div>
          <div className="flex items-center justify-between mt-2">
            <span className="text-sm text-[#444444]">{t("settings.chroma.storagePath")}</span>
            <span className="text-sm font-medium truncate max-w-[200px]" title={dbPath}>{dbPath}</span>
          </div>
          {!chromaHealthy && (
            <div className="mt-3 text-xs text-[#666666] bg-[#fafafa] border border-[#f0f0f0] rounded-md px-3 py-2">
              <div className="mb-2">{t("settings.chroma.manualStart")}</div>
              <Button size="sm" onClick={startChromaFromSettings} disabled={isStartingChroma} className="mb-2">
                {isStartingChroma ? t("settings.chroma.starting") : t("settings.chroma.start")}
              </Button>
              <code className="block whitespace-pre-wrap break-all font-mono text-[#333333]">{manualChromaCommand}</code>
            </div>
          )}
          <div className="flex items-center justify-between mt-3 pt-3" style={{ borderTop: "1px solid #f5f5f5" }}>
            <span className="text-sm text-[#444444]">{t("settings.chroma.port")}</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                className="text-sm border border-[#e5e5e5] rounded-md px-2 py-1 w-20"
                value={portInput}
                min={1}
                max={65535}
                onChange={(e) => setPortInput(e.target.value)}
              />
              <Button size="sm" onClick={savePort}>{t("common.save")}</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("settings.embedding.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <span className="text-sm text-[#444444]">{t("settings.embedding.model")}</span>
              <div className="text-xs text-[#888888] mt-0.5">{t("settings.embedding.runHint")}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <select
                className="text-sm border border-[#e5e5e5] rounded-md px-2 py-1 max-w-[260px]"
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
                  new Notice("Embedding model changed. Reloading plugin...");
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
              {language === "zh" ? "如何选择？" : "How to choose?"}
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
          <div className="flex items-center justify-between mt-2">
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("settings.summary.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <label className="flex items-center justify-between gap-3">
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

          <div className="flex items-start justify-between gap-3 mt-3">
            <div className="flex-1 min-w-0">
              <span className="text-sm text-[#444444]">{t("settings.summary.model")}</span>
              <div className="text-xs text-[#888888] mt-0.5">{t("settings.summary.modelHint")}</div>
            </div>
            <select
              className="text-sm border border-[#e5e5e5] rounded-md px-2 py-1 max-w-[260px]"
              value={selectedSummaryModel}
              onChange={async (e) => {
                const next = e.target.value;
                setSelectedSummaryModel(next);
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

          <div className="flex items-center justify-between gap-3 mt-3">
            <span className="text-sm text-[#444444]">{t("settings.summary.ollamaHost")}</span>
            <input
              type="text"
              className="text-sm border border-[#e5e5e5] rounded-md px-2 py-1 w-[260px] max-w-full"
              value={summaryHostInput}
              onChange={(e) => setSummaryHostInput(e.target.value)}
              onBlur={async () => {
                const next = summaryHostInput.trim() || DEFAULT_SETTINGS.summaryOllamaHost;
                plugin.settings.summaryOllamaHost = next.replace(/\/+$/, "");
                setSummaryHostInput(plugin.settings.summaryOllamaHost);
                await plugin.saveSettings();
                await applySummarySettings();
              }}
            />
          </div>

          <div className="grid grid-cols-2 gap-2 mt-3">
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

          <div className="flex items-center justify-between gap-3 mt-3">
            <label className="flex items-center gap-2 text-sm text-[#444444]">
              <input
                type="checkbox"
                checked={plugin.settings.summaryAutoPullModel}
                onChange={async (e) => {
                  plugin.settings.summaryAutoPullModel = e.target.checked;
                  await plugin.saveSettings();
                  await applySummarySettings();
                }}
              />
              {t("settings.summary.autoPull")}
            </label>
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

          <div className="flex flex-wrap items-center gap-2 mt-3 pt-3" style={{ borderTop: "1px solid #f5f5f5" }}>
            <Button size="sm" onClick={checkOllama} disabled={isCheckingOllama}>
              {isCheckingOllama ? t("settings.summary.checking") : t("settings.summary.check")}
            </Button>
            <Button size="sm" variant="secondary" onClick={pullSummaryModel} disabled={isPullingSummaryModel}>
              {isPullingSummaryModel ? t("settings.summary.pulling") : t("settings.summary.pull")}
            </Button>
            <Badge className={
              ollamaStatus === "ready"
                ? "bg-[#0a0a0a] text-white"
                : ollamaStatus === "error"
                  ? "bg-[#e74c3c] text-white"
                  : "bg-[#f5f5f5] text-[#444444]"
            }>
              {ollamaStatus}
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

      {upgradePrompt && (
        <Card>
          <CardContent className="pt-4">
            <div className="whitespace-pre-line text-sm text-[#0a0a0a]">
              {upgradePrompt.message}
            </div>
            <div className="mt-3 flex items-center gap-2">
              {upgradePrompt.canOpenBuyUrl && (
                <Button size="sm" onClick={() => window.open(upgradePrompt.buyUrl, "_blank")}>
                  {t("settings.license.buy")}
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={() => setUpgradePrompt(null)}>
                Dismiss
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("settings.exclude.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-[#444444] mb-2">
            {t("settings.exclude.hint")}
          </div>
          <div className="flex items-center gap-2 mb-3">
            <input
              type="text"
              className="flex-1 text-sm border border-[#e5e5e5] rounded-md px-3 py-1.5"
              placeholder={t("settings.exclude.placeholder")}
              value={newPathInput}
              onChange={(e) => setNewPathInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addExcludedPath(); }}
            />
            <Button size="sm" onClick={addExcludedPath}>{t("common.add")}</Button>
          </div>
          {excludedPaths.length === 0 ? (
            <div className="text-sm text-[#888888] text-center py-4">
              {t("settings.exclude.empty")}
            </div>
          ) : (
            <div className="border border-[#e5e5e5] rounded-md divide-y divide-[#f0f0f0]">
              {excludedPaths.map((p) => (
                <div key={p} className="flex items-center justify-between px-3 py-2 text-sm hover:bg-[#fafafa]">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="shrink-0 text-[#888888]">{p.endsWith(".md") ? "📄" : "📁"}</span>
                    <span className="truncate" title={p}>{p}</span>
                  </div>
                  <button
                    onClick={() => removeExcludedPath(p)}
                    className="shrink-0 ml-2 text-[#888888] hover:text-[#e74c3c] text-base leading-none px-1"
                    title="Remove"
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
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center justify-between mb-2">
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

      <div className="flex gap-2 pt-2">
        {isRebuilding ? (
          <Button onClick={stopIndexing} disabled={isStoppingIndex} variant="destructive" className="flex-1">
            {isStoppingIndex ? t("settings.actions.stoppingIndex") : t("settings.actions.stopIndex")}
          </Button>
        ) : (
          <Button onClick={continueIndex} className="flex-1">
            {t("settings.actions.continueIndex")}
          </Button>
        )}
        <Button onClick={rebuildIndex} disabled={isRebuilding} className="flex-1">
          {isRebuilding
            ? rebuildProgress
              ? `${t("settings.actions.indexing").replace("...","")} ${Math.round((rebuildProgress.current / rebuildProgress.total) * 100)}%`
              : t("settings.actions.indexing")
            : t("settings.actions.rebuildIndex")}
        </Button>
        <Button onClick={clearIndex} variant="destructive" className="flex-1">
          {t("settings.actions.clearIndex")}
        </Button>
      </div>

      <Card className="mt-4">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">{t("settings.docs.title")}</CardTitle>
          <Button size="sm" variant="secondary" onClick={() => refreshFileStatuses()}>
            {t("common.refresh")}
          </Button>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3 mb-3">
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
                  ? "bg-[#f59e0b] text-white border-[#f59e0b]"
                  : "bg-white text-[#444444] border-[#e5e5e5] hover:border-[#aaa]"
              }`}
            >
              {t("settings.docs.filter.outdated")} ({statusCounts.outdated})
            </button>
            <button
              onClick={() => setStatusFilter("unindexed")}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                statusFilter === "unindexed"
                  ? "bg-[#e74c3c] text-white border-[#e74c3c]"
                  : "bg-white text-[#444444] border-[#e5e5e5] hover:border-[#aaa]"
              }`}
            >
              {t("settings.docs.filter.unindexed")} ({statusCounts.unindexed})
            </button>
          </div>

          <input
            type="text"
            placeholder={t("settings.docs.searchPlaceholder")}
            className="w-full text-sm border border-[#e5e5e5] rounded-md px-3 py-1.5 mb-3"
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
                  className="flex items-center justify-between px-3 py-2 text-sm hover:bg-[#fafafa]"
                  style={{ borderBottom: "1px solid #f0f0f0" }}
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
              <div className="text-center py-2" style={{ borderTop: "1px solid #f0f0f0" }}>
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
              {statusFilter !== "all" || searchQuery ? ` (${statusCounts.total} total)` : ""}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">{t("settings.feedback.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-[#444444] mb-3">
            {t("settings.feedback.description")}
          </div>
          <button
            type="button"
            onClick={copySupportEmail}
            className="group flex w-full items-center justify-between gap-3 rounded-md border border-[#e5e5e5] px-3 py-2 text-left transition-colors hover:border-[#aaa] hover:bg-[#fafafa] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#0a0a0a]"
            aria-label={t("settings.feedback.copyLabel")}
            title={t("settings.feedback.copyLabel")}
          >
            <span className="min-w-0 truncate text-sm font-medium text-[#0a0a0a]">
              {SUPPORT_EMAIL}
            </span>
            <span className="shrink-0 text-xs text-[#888888] transition-colors group-hover:text-[#0a0a0a]">
              {t("common.copy")}
            </span>
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
