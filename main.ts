import {WorkspaceLeaf, Plugin, addIcon, TFile} from 'obsidian';
import { IndexView, VIEW_TYPE_INDEX } from './src/IndexView';
import {AnalogySettings, DEFAULT_SETTINGS, AnalogySettingTab} from "./src/SettingView";
import {icon} from "./src/model/Consts";
import {ChromaProcessManager} from "./src/local-vector/chroma-process";
import {getEmbeddingErrorMessage, LocalEmbeddingService, EMBEDDING_MODELS, DEFAULT_MODEL_KEY} from "./src/local-vector/embedding";
import {LocalVectorStore} from "./src/local-vector/vector-store";
import {DocumentIndexer, type IndexState} from "./src/local-vector/document-indexer";
import {DEFAULT_SUMMARY_PROMPT, DocumentSummarizer} from "./src/local-vector/document-summarizer";
import {OllamaClient} from "./src/local-vector/ollama-client";
import {DEFAULT_SUMMARY_MODEL_KEY, SUMMARY_MODELS} from "./src/local-vector/summary-models";
import {initLocalVectorServices, updateServiceState} from "./src/local-vector/search-instance";
import {setLocale} from "./src/util/i18n";
import {refreshCachedLicense} from "./src/license/license-api";
import {loadLicenseState, saveLicenseState} from "./src/license/license-store";
import {getOrCreateDeviceId, getVaultId as getLicenseVaultId} from "./src/license/license-device";
import {appVersion} from "./src/model/Consts";
import * as crypto from "crypto";

const INIT_LOG_PREFIX = "[Analogy][Init]";

export default class Analogy extends Plugin {
	settings: AnalogySettings;
	chromaManager: ChromaProcessManager | null = null;
	embeddingService: LocalEmbeddingService | null = null;
	vectorStore: LocalVectorStore | null = null;
	documentIndexer: DocumentIndexer | null = null;

	async onload() {
		await this.loadSettings();
		setLocale(this.settings.uiLanguage || "en");

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
			this.initLocalServices().catch(() => {});
		});
	}

	private getVaultId(): string {
		const basePath = (this.app.vault.adapter as any).basePath as string;
		return crypto.createHash("md5").update(basePath).digest("hex").slice(0, 12);
	}

	private registerLicenseRefresh() {
		const refresh = () => {
			this.refreshLicenseCache().catch(() => {});
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
		const basePath = (this.app.vault.adapter as any).basePath;
		const manifestDir = (this.manifest as any).dir;
		const pluginDir = manifestDir
			? require("path").resolve(basePath, manifestDir)
			: `${basePath}/.obsidian/plugins/${this.manifest.id}`;
		const vaultId = this.getVaultId();
		const modelKey = this.settings.embeddingModel || DEFAULT_MODEL_KEY;
		const modelConfig = EMBEDDING_MODELS[modelKey] || EMBEDDING_MODELS[DEFAULT_MODEL_KEY];
		const dbPath = `${pluginDir}/chroma_data/${vaultId}`;
		const port = this.settings.chromaPort || 8000;

		console.log(`${INIT_LOG_PREFIX} start`, {
			pluginDir,
			dbPath,
			port,
			model: modelConfig.shortName,
		});

		this.chromaManager = new ChromaProcessManager();
		const started = await this.chromaManager.start(dbPath, port);

		if (!started) {
			const lastError = this.chromaManager.getLastError() || "ChromaDB is not running. Start it manually before using local search.";
			console.error(`${INIT_LOG_PREFIX} failed`, { stage: "chroma", lastError });
			updateServiceState({
				status: "error",
				chromaManager: this.chromaManager,
				dbPath,
				port,
				lastError,
			});
			initLocalVectorServices(null, null, null, this.chromaManager, { dbPath, port });
			return;
		}

		this.vectorStore = new LocalVectorStore();
		let vectorStoreReady = false;
		try {
			await this.vectorStore.initialize(port, vaultId, modelConfig.shortName);
			vectorStoreReady = true;
			updateServiceState({ vectorStoreStatus: "ready" });
		} catch (err) {
			const lastError = `Vector store initialization failed: ${(err as Error).message}`;
			console.error(`${INIT_LOG_PREFIX} failed`, { stage: "vector-store", lastError });
			updateServiceState({ vectorStoreStatus: "error", lastError });
			initLocalVectorServices(null, this.vectorStore, null, this.chromaManager, {
				status: "error",
				dbPath,
				port,
				lastError,
			});
			return;
		}

		this.embeddingService = new LocalEmbeddingService({
			cacheDir: `${pluginDir}/transformers-cache`,
			pluginDir,
			remoteHost: this.settings.embeddingModelHost,
			modelConfig,
		});
		let embeddingReady = false;
		try {
			updateServiceState({ embeddingStatus: "downloading" });
			await this.embeddingService.initialize((progress) => {
				updateServiceState({ modelDownloadProgress: progress });
			});
			embeddingReady = true;
			updateServiceState({ embeddingStatus: "ready", modelDownloadProgress: 100 });
		} catch (err) {
			const lastError = getEmbeddingErrorMessage(err);
			console.error(`${INIT_LOG_PREFIX} failed`, { stage: "embedding", lastError });
			updateServiceState({ embeddingStatus: "error", lastError });
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
			},
			modelConfig.maxInputChars,
			summarizer
		);
		console.log(`${INIT_LOG_PREFIX} success`, {
			dbPath,
			port,
			model: modelConfig.shortName,
		});
	}

	async onunload() {
		if (this.documentIndexer) {
			await this.documentIndexer.stop();
			this.documentIndexer.shutdown();
			await this.documentIndexer.flushState();
			this.documentIndexer = null;
		}
		if (this.embeddingService) {
			try {
				// Dispose ONNX session to free GPU/CPU memory before switching models
				if ((this.embeddingService as any).embedder?.dispose) {
					(this.embeddingService as any).embedder.dispose();
				}
			} catch {}
			this.embeddingService = null;
		}
		if (this.chromaManager) {
			this.chromaManager.stop();
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
