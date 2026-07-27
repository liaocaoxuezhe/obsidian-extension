import {WorkspaceLeaf, Plugin, addIcon, TFile} from 'obsidian';
import { IndexView, VIEW_TYPE_INDEX } from './src/IndexView';
import {AnalogySettings, DEFAULT_SETTINGS, AnalogySettingTab} from "./src/SettingView";
import {icon} from "./src/model/Consts";
import {ChromaProcessManager} from "./src/local-vector/chroma-process";
import {getEmbeddingErrorMessage, EMBEDDING_MODELS, DEFAULT_MODEL_KEY} from "./src/local-vector/embedding";
import {EmbeddingService} from "./src/local-vector/embedding-service";
import {SafeModeManager, type SafeModeState} from "./src/local-vector/safe-mode";
import {LocalVectorStore} from "./src/local-vector/vector-store";
import {DocumentIndexer, type IndexState} from "./src/local-vector/document-indexer";
import {DEFAULT_SUMMARY_PROMPT, DocumentSummarizer} from "./src/local-vector/document-summarizer";
import {OllamaClient} from "./src/local-vector/ollama-client";
import {DEFAULT_SUMMARY_MODEL_KEY, SUMMARY_MODELS} from "./src/local-vector/summary-models";
import {initLocalVectorServices, updateServiceState} from "./src/local-vector/search-instance";
import {getLocalRuntimeStatus} from "./src/local-vector/runtime-dependencies";
import {setLocale} from "./src/util/i18n";
import {refreshCachedLicense} from "./src/license/license-api";
import {loadLicenseState, saveLicenseState} from "./src/license/license-store";
import {getOrCreateDeviceId, getVaultId as getLicenseVaultId} from "./src/license/license-device";
import {appVersion} from "./src/model/Consts";
import {DiagnosticRecorder} from "./src/diagnostics/diagnostic-recorder";
import {setDiagnosticRecorder} from "./src/diagnostics/diagnostic-instance";
import type {DiagnosticStage} from "./src/diagnostics/diagnostic-types";
import * as crypto from "crypto";

declare const __ANALOGY_BUILD_ID__: string | undefined;
declare const __ANALOGY_EMBEDDING_WORKER_SOURCE__: string | undefined;

const INIT_LOG_PREFIX = "[Analogy][Init]";

export default class Analogy extends Plugin {
	settings: AnalogySettings;
	chromaManager: ChromaProcessManager | null = null;
	embeddingService: EmbeddingService | null = null;
	vectorStore: LocalVectorStore | null = null;
	documentIndexer: DocumentIndexer | null = null;
	private initLocalServicesPromise: Promise<void> | null = null;
	private diagnosticRecorder: DiagnosticRecorder | null = null;
	private safeModeManager: SafeModeManager | null = null;

	getSafeModeState(): SafeModeState {
		return this.safeModeManager?.getState() ?? {
			enabled: false,
			consecutiveUncleanExits: 0,
			lastUncleanStages: [],
			workerExitCount: 0,
			workerExitTimestamps: [],
		};
	}

	async clearSafeModeAndRetry(): Promise<void> {
		const pluginDir = this.getPluginDir();
		if (!this.safeModeManager) {
			this.safeModeManager = new SafeModeManager({pluginDir});
		}
		this.safeModeManager.clearSafeMode();
		this.diagnosticRecorder?.info(
			"safe-mode.recover",
			"safe-mode.manual-retry",
			"User cleared safe mode counters and requested a retry",
		);

		if (this.documentIndexer) {
			await this.documentIndexer.stop();
			this.documentIndexer.shutdown();
			await this.documentIndexer.flushState();
			this.documentIndexer = null;
		}
		if (this.embeddingService) {
			await this.embeddingService.dispose();
			this.embeddingService = null;
		}
		this.initLocalServicesPromise = null;
		await this.initLocalServices();
		const recoveredEmbeddingService =
			this.embeddingService as EmbeddingService | null;
		if (!recoveredEmbeddingService?.isReady()) {
			const reason = "Manual recovery could not initialize the isolated embedding worker.";
			this.safeModeManager.enterSafeMode(reason);
			await this.handleSafeModeEntered();
			throw new Error(reason);
		}
	}

	async switchToRecommendedSmallModelAndRetry(): Promise<void> {
		this.settings.embeddingModel = DEFAULT_MODEL_KEY;
		await this.saveSettings();
		this.diagnosticRecorder?.info(
			"safe-mode.recover",
			"safe-mode.small-model-retry",
			"User selected the recommended small model before retrying",
			{model: DEFAULT_MODEL_KEY},
		);
		await this.clearSafeModeAndRetry();
	}

	private async handleSafeModeEntered(): Promise<void> {
		this.diagnosticRecorder?.warn(
			"safe-mode.enter",
			"safe-mode.worker-exits",
			"Embedding and automatic indexing were paused after repeated worker exits",
		);
		if (this.documentIndexer) {
			try {
				await this.documentIndexer.stop();
				this.documentIndexer.shutdown();
				await this.documentIndexer.flushState();
			} catch (error) {
				this.diagnosticRecorder?.captureException(
					"safe-mode.enter",
					"safe-mode.indexer-stop.failed",
					error,
				);
			}
			this.documentIndexer = null;
		}
		updateServiceState({
			status: "error",
			embeddingStatus: "error",
			lastError: "Analogy entered safe mode after repeated embedding worker exits.",
			rebuildProgress: null,
		});
	}

	async onload() {
		await this.loadSettings();
		setLocale(this.settings.uiLanguage || "en");

		const pluginDir = this.getPluginDir();
		const buildId = (typeof __ANALOGY_BUILD_ID__ !== "undefined" && __ANALOGY_BUILD_ID__)
			? __ANALOGY_BUILD_ID__
			: `${this.manifest.version}+dev`;
		this.diagnosticRecorder = new DiagnosticRecorder({
			pluginDir,
			pluginVersion: this.manifest.version,
			buildId,
			obsidianVersion: (this.app as any).version || "unknown",
			platform: typeof process !== "undefined" ? process.platform : "unknown",
			arch: typeof process !== "undefined" ? process.arch : "unknown",
			locale: this.settings.uiLanguage || "en",
			model: this.settings.embeddingModel || DEFAULT_MODEL_KEY,
		});
		setDiagnosticRecorder(this.diagnosticRecorder);
		try {
			await this.diagnosticRecorder.initialize();
		} catch (err) {
			console.error("[Analogy] Diagnostic recorder initialization failed", err);
		}

		this.diagnosticRecorder.info(
			"plugin.onload",
			"plugin.onload.start",
			"Plugin onload started",
			{ pluginVersion: this.manifest.version, buildId }
		);

		if (this.diagnosticRecorder.isSuspectedUncleanExit()) {
			const previous = this.diagnosticRecorder.getPreviousMarker();
			this.diagnosticRecorder.recordEvent(
				"warn",
				"plugin.onload",
				"session.unclean_exit",
				"Previous session may have ended uncleanly",
				{
					previousSessionId: previous?.sessionId || "",
					previousLastStage: previous?.lastStage || "",
					previousPluginVersion: previous?.pluginVersion || "",
				}
			);
			this.safeModeManager = new SafeModeManager({ pluginDir });
			if (previous?.lastStage) {
				this.safeModeManager.recordUncleanExit(previous.lastStage);
			}
		} else {
			this.safeModeManager = new SafeModeManager({ pluginDir });
		}

		this.registerView(
			VIEW_TYPE_INDEX,
			(leaf) => new IndexView(leaf)
		)

		addIcon('analogy-icon', icon);

		this.addRibbonIcon('analogy-icon', 'Analogy', () => {
			this.activateView();
		});

		this.addSettingTab(new AnalogySettingTab(this.app, this));
		this.registerLicenseRefresh();

		this.app.workspace.onLayoutReady(() => {
			this.initLocalServices().catch((err) => {
				this.diagnosticRecorder?.captureException("plugin.layout-ready", "plugin.init.failed", err);
			});
		});
	}

	private getVaultId(): string {
		const basePath = (this.app.vault.adapter as any).basePath as string;
		return crypto.createHash("md5").update(basePath).digest("hex").slice(0, 12);
	}

	private getPluginDir(): string {
		const basePath = (this.app.vault.adapter as any).basePath as string;
		const manifestDir = (this.manifest as any).dir as string | undefined;
		if (manifestDir) {
			return require("path").resolve(basePath, manifestDir);
		}
		const configDir = (this.app.vault as any).configDir || ".obsidian";
		return require("path").join(basePath, configDir, "plugins", this.manifest.id);
	}

	private registerLicenseRefresh() {
		const refresh = () => {
			this.refreshLicenseCache().catch((err) => {
				this.diagnosticRecorder?.captureException("license.refresh", "license.refresh.failed", err);
			});
		};
		refresh();
		this.registerInterval(window.setInterval(refresh, 60 * 60 * 1000));
	}

	private async refreshLicenseCache() {
		const cached = loadLicenseState();
		const nextState = await refreshCachedLicense(this.settings.licenseServerUrl, cached, {
			deviceId: getOrCreateDeviceId(),
			vaultId: getLicenseVaultId(this.app),
			pluginVersion: appVersion,
		});
		if (nextState !== cached) {
			saveLicenseState(nextState);
		}
	}

	async initLocalServices() {
		if (this.initLocalServicesPromise) {
			return this.initLocalServicesPromise;
		}
		this.initLocalServicesPromise = this.doInitLocalServices().finally(() => {
			this.initLocalServicesPromise = null;
		});
		return this.initLocalServicesPromise;
	}

	private async doInitLocalServices() {
		const pluginDir = this.getPluginDir();
		const vaultId = this.getVaultId();
		const modelKey = this.settings.embeddingModel || DEFAULT_MODEL_KEY;
		const modelConfig = EMBEDDING_MODELS[modelKey] || EMBEDDING_MODELS[DEFAULT_MODEL_KEY];
		const dbPath = `${pluginDir}/chroma_data/${vaultId}`;
		const port = this.settings.chromaPort || 8000;
		const runtimeStatus = getLocalRuntimeStatus(pluginDir);

		this.diagnosticRecorder?.updateStage("runtime.check", "runtime.check.start");

		updateServiceState({
			status: "initializing",
			dbPath,
			port,
			embeddingStatus: "idle",
			vectorStoreStatus: "idle",
			modelDownloadProgress: 0,
			lastError: "",
			activeModel: modelConfig.shortName,
			summarySearchEnabled: Boolean(this.settings.summarizeBeforeEmbedding),
		});

		if (!runtimeStatus.ready) {
			const lastError = runtimeStatus.message;
			console.error(`${INIT_LOG_PREFIX} failed`, {
				stage: "runtime",
				missing: runtimeStatus.missing,
				lastError,
			});
			this.diagnosticRecorder?.recordEvent(
				"error",
				"runtime.check",
				"runtime.missing",
				lastError,
				{ missing: runtimeStatus.missing.join(",") }
			);
			updateServiceState({
				status: "error",
				dbPath,
				port,
				embeddingStatus: "error",
				vectorStoreStatus: "idle",
				lastError,
				summarySearchEnabled: Boolean(this.settings.summarizeBeforeEmbedding),
			});
			initLocalVectorServices(null, null, null, null, {
				status: "error",
				dbPath,
				port,
				embeddingStatus: "error",
				vectorStoreStatus: "idle",
				lastError,
				summarySearchEnabled: Boolean(this.settings.summarizeBeforeEmbedding),
			});
			return;
		}

		this.diagnosticRecorder?.updateStage("chroma.start", "chroma.start");
		this.chromaManager = this.chromaManager ?? new ChromaProcessManager();
		const started = await this.chromaManager.start(dbPath, port);

		if (!started) {
			const lastError = this.chromaManager.getLastError() || "ChromaDB is not running. Start it manually before using local search.";
			console.error(`${INIT_LOG_PREFIX} failed`, { stage: "chroma", lastError });
			this.diagnosticRecorder?.recordEvent("error", "chroma.start", "chroma.start.failed", lastError);
			updateServiceState({
				status: "error",
				chromaManager: this.chromaManager,
				dbPath,
				port,
				lastError,
				summarySearchEnabled: Boolean(this.settings.summarizeBeforeEmbedding),
			});
			initLocalVectorServices(null, null, null, this.chromaManager, { dbPath, port });
			return;
		}

		this.diagnosticRecorder?.updateStage("vector-store.initialize", "vector-store.initialize.start");
		this.vectorStore = this.vectorStore ?? new LocalVectorStore();
		let vectorStoreReady = false;
		try {
			await this.vectorStore.initialize(port, vaultId, modelConfig.shortName);
			vectorStoreReady = true;
			updateServiceState({ vectorStoreStatus: "ready", lastError: "" });
		} catch (err) {
			const lastError = `Vector store initialization failed: ${(err as Error).message}`;
			console.error(`${INIT_LOG_PREFIX} failed`, { stage: "vector-store", lastError });
			this.diagnosticRecorder?.captureException("vector-store.initialize", "vector-store.initialize.failed", err);
			updateServiceState({
				vectorStoreStatus: "error",
				lastError,
				summarySearchEnabled: Boolean(this.settings.summarizeBeforeEmbedding),
			});
			initLocalVectorServices(null, this.vectorStore, null, this.chromaManager, {
				status: "error",
				dbPath,
				port,
				lastError,
			});
			return;
		}

		this.diagnosticRecorder?.updateStage("embedding.model-load", "embedding.model-load.start");
		this.embeddingService = new EmbeddingService({
			cacheDir: `${pluginDir}/transformers-cache`,
			pluginDir,
			remoteHost: this.settings.embeddingModelHost,
			modelConfig,
			pluginVersion: this.manifest.version,
			buildId: (typeof __ANALOGY_BUILD_ID__ !== "undefined" && __ANALOGY_BUILD_ID__)
				? __ANALOGY_BUILD_ID__
				: `${this.manifest.version}+dev`,
			workerBundleSource:
				typeof __ANALOGY_EMBEDDING_WORKER_SOURCE__ !== "undefined"
					? __ANALOGY_EMBEDDING_WORKER_SOURCE__
					: "",
			recorder: this.diagnosticRecorder,
			safeModeManager: this.safeModeManager,
			onSafeModeEntered: () => this.handleSafeModeEntered(),
		});
		let embeddingReady = false;
		try {
			updateServiceState({ embeddingStatus: "downloading", lastError: "" });
			await this.embeddingService.initialize((progress) => {
				updateServiceState({ modelDownloadProgress: progress });
			});
			embeddingReady = true;
			updateServiceState({ embeddingStatus: "ready", modelDownloadProgress: 100, lastError: "" });
		} catch (err) {
			const lastError = getEmbeddingErrorMessage(err);
			console.error(`${INIT_LOG_PREFIX} failed`, { stage: "embedding", lastError });
			this.diagnosticRecorder?.captureException("embedding.model-load", "embedding.model-load.failed", err, { model: modelConfig.shortName });
			updateServiceState({
				embeddingStatus: "error",
				lastError,
				summarySearchEnabled: Boolean(this.settings.summarizeBeforeEmbedding),
			});
			initLocalVectorServices(this.embeddingService, this.vectorStore, null, this.chromaManager, {
				status: "error",
				dbPath,
				port,
				lastError,
			});
			return;
		}

		const ollamaClient = new OllamaClient({
			host: this.settings.summaryOllamaHost || DEFAULT_SETTINGS.summaryOllamaHost,
			timeoutMs: this.settings.summaryTimeoutMs || DEFAULT_SETTINGS.summaryTimeoutMs,
		});
		const summaryConfig = SUMMARY_MODELS[this.settings.summaryModel] || SUMMARY_MODELS[DEFAULT_SUMMARY_MODEL_KEY];
		const summarizer = new DocumentSummarizer({
			enabled: Boolean(this.settings.summarizeBeforeEmbedding),
			model: summaryConfig.ollamaName,
			maxInputChars: this.settings.summaryMaxInputChars || DEFAULT_SETTINGS.summaryMaxInputChars,
			fallbackToOriginal: this.settings.summaryFallbackToOriginal !== false,
			promptTemplate: this.settings.summaryPrompt || DEFAULT_SUMMARY_PROMPT,
			client: ollamaClient,
		});
		if (this.settings.summarizeBeforeEmbedding) {
			try {
				const models = await ollamaClient.listModels();
				const installed = models.some((m) => m.name === summaryConfig.ollamaName);
				if (!installed && this.settings.summaryAutoPullModel) {
					await ollamaClient.pullModel(summaryConfig.ollamaName);
				}
			} catch (err) {
				if (this.settings.summaryFallbackToOriginal === false) {
					console.error(`${INIT_LOG_PREFIX} failed`, { stage: "summary", error: (err as Error).message });
				}
			}
		}

		this.diagnosticRecorder?.updateStage("index.state-load", "index.state-load.start");
		this.documentIndexer = new DocumentIndexer(
			this.embeddingService,
			this.vectorStore,
			this.app.vault,
			this.createIndexStateStore(modelConfig.shortName),
			this.settings.excludedIndexPaths,
			this.app.workspace
		);
		await this.documentIndexer.loadState();
		this.documentIndexer.watchVault();
		this.diagnosticRecorder?.updateStage("index.document-read", "index.document-read.start");

		initLocalVectorServices(
			this.embeddingService,
			this.vectorStore,
			this.documentIndexer,
			this.chromaManager,
			{
				status: "ready",
				chromaManager: this.chromaManager,
				dbPath,
				port,
				vectorStoreStatus: "ready",
				embeddingStatus: "ready",
				activeModel: modelConfig.shortName,
				modelDownloadProgress: 100,
				lastError: "",
				summarySearchEnabled: Boolean(this.settings.summarizeBeforeEmbedding),
			},
			modelConfig.maxInputChars,
			summarizer
		);
		this.diagnosticRecorder?.updateStage("plugin.layout-ready", "plugin.layout-ready");
		this.diagnosticRecorder?.info(
			"plugin.layout-ready",
			"plugin.ready",
			"Local services initialized successfully",
			{ model: modelConfig.shortName }
		);
	}

	async onunload() {
		this.initLocalServicesPromise = null;
		this.diagnosticRecorder?.updateStage("plugin.unload", "plugin.unload.start");
		if (this.documentIndexer) {
			try {
				await this.documentIndexer.stop();
				this.documentIndexer.shutdown();
				await this.documentIndexer.flushState();
			} catch (err) {
				this.diagnosticRecorder?.captureException("plugin.unload", "indexer.shutdown.failed", err);
			}
			this.documentIndexer = null;
		}
		if (this.embeddingService) {
			try {
				// Dispose worker or in-process ONNX session to free memory
				await this.embeddingService.dispose();
			} catch (err) {
				this.diagnosticRecorder?.captureException("plugin.unload", "embedding.dispose.failed", err);
			}
			this.embeddingService = null;
		}
		if (this.chromaManager) {
			this.chromaManager.stop();
		}
		try {
			await this.diagnosticRecorder?.markCleanExit();
		} catch (err) {
			console.error("[Analogy] Failed to mark clean exit", err);
		}
		initLocalVectorServices(null, null, null, null, {
			status: "initializing",
			chromaManager: null,
			dbPath: "",
			port: 8000,
			embeddingStatus: "idle",
			vectorStoreStatus: "idle",
			modelDownloadProgress: 0,
			lastError: "",
			rebuildProgress: null,
			activeModel: "",
			summarySearchEnabled: false,
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.settings.excludedIndexPaths = Array.isArray(this.settings.excludedIndexPaths)
			? this.settings.excludedIndexPaths
			: [];
		this.settings.indexStates = this.settings.indexStates || {};
		this.settings.summaryPrompt = this.settings.summaryPrompt || DEFAULT_SUMMARY_PROMPT;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private createIndexStateStore(modelShortName: string) {
		return {
			load: async (): Promise<IndexState | undefined> => {
				return this.settings.indexStates?.[modelShortName];
			},
			save: async (state: IndexState): Promise<void> => {
				this.settings.indexStates = {
					...(this.settings.indexStates || {}),
					[modelShortName]: state,
				};
				await this.saveData(this.settings);
			},
		};
	}

	async activateView() {
		const {workspace} = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_INDEX);

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({type: VIEW_TYPE_INDEX, active: true});
			}
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	async reload(plugin: string) {
		const plugins = this.app.plugins;

		if (!plugins.enabledPlugins.has(plugin)) return;

		await plugins.disablePlugin(plugin);
		await plugins.enablePlugin(plugin);
	}
}

declare module "obsidian" {
	interface Vault {
		exists(path: string): Promise<boolean>
		on(type: "raw", handler: () => void): EventRef
	}
	interface DataAdapter {
		basePath: string
		watchers: Record<string, unknown>
		startWatchPath(path: string, flag: boolean): void
	}
	interface App {
		plugins: {
			manifests: PluginManifest[]
			getPluginFolder(): string
			enablePlugin(plugin: string): Promise<void>
			disablePlugin(plugin: string): Promise<void>
			enabledPlugins: Set<string>
		}
	}
}
