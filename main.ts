import {WorkspaceLeaf, Plugin, addIcon, TFile, Notice, requestUrl} from 'obsidian';
import {defaultRequest, type RuntimeRequest} from "./src/runtime/runtime-downloader";
import {createChunkedTransport, type ProxyAwareFetch} from "./src/runtime/download-transport";
import {importModelFiles, modelHosts} from "./src/local-vector/model-files";
import { IndexView, VIEW_TYPE_INDEX } from './src/IndexView';
import {AnalogySettings, DEFAULT_SETTINGS, AnalogySettingTab} from "./src/SettingView";
import {icon} from "./src/model/Consts";
import {EMBEDDING_MODELS, DEFAULT_MODEL_KEY} from "./src/local-vector/embedding";
import {EmbeddingService} from "./src/local-vector/embedding-service";
import {SafeModeManager, type SafeModeState} from "./src/local-vector/safe-mode";
import {LocalVectorStore, type VectorStore} from "./src/local-vector/vector-store";
import {SqliteVectorStore} from "./src/local-vector/sqlite-vector-store";
import {collectEnvironmentFacts} from "./src/diagnostics/environment-facts";
import {VectorStoreHost} from "./src/local-vector/vector-store-host";
import type {VectorStoreOperation, VectorStoreOperations} from "./src/local-vector/vector-store-protocol";
import {
	isChromaImportSettled,
	planChromaImport,
	readChromaImportMarker,
	runChromaImportIfNeeded,
	type ChromaImportMarker,
} from "./src/runtime/chroma-sqlite-import";
import {DocumentIndexer, type RebuildProgress} from "./src/local-vector/document-indexer";
import {DEFAULT_SUMMARY_PROMPT, DocumentSummarizer} from "./src/local-vector/document-summarizer";
import {OllamaClient} from "./src/local-vector/ollama-client";
import {DEFAULT_SUMMARY_MODEL_KEY, SUMMARY_MODELS} from "./src/local-vector/summary-models";
import {
	initLocalVectorServices,
	updateOnboardingState,
	updateServiceState,
} from "./src/local-vector/search-instance";
import {
	LocalServiceBootstrap,
	type LocalChromaServiceController,
	type LocalServiceReady,
} from "./src/local-vector/local-service-bootstrap";
import {setLocale, t} from "./src/util/i18n";
import {
	SemanticWalkItemView,
	type SemanticWalkOpenRequest,
	VIEW_TYPE_SEMANTIC_WALK,
} from "./src/semantic-walk/SemanticWalkItemView";
import {refreshCachedLicense} from "./src/license/license-api";
import {loadLicenseState, saveLicenseState} from "./src/license/license-store";
import {getOrCreateDeviceId, getVaultId as getLicenseVaultId} from "./src/license/license-device";
import {appVersion} from "./src/model/Consts";
import {DiagnosticRecorder} from "./src/diagnostics/diagnostic-recorder";
import {setDiagnosticRecorder} from "./src/diagnostics/diagnostic-instance";
import type {DiagnosticStage} from "./src/diagnostics/diagnostic-types";
import {detectSupportedPlatform} from "./src/runtime/platform-detector";
import {deriveRuntimeVaultId} from "./src/runtime/vault-identity";
import {createRuntimePaths, resolveAnalogyLocalDataRoot} from "./src/runtime/runtime-paths";
import {
	detectEnvironment,
	resolveVerifiedChromaRuntime,
} from "./src/runtime/environment-detector";
import {EmbeddingRuntimeManager} from "./src/runtime/embedding-runtime-manager";
import {ChromaRuntimeManager} from "./src/runtime/chroma-runtime-manager";
import {ChromaProcessLeaseStore} from "./src/runtime/chroma-process-lease";
import {OnboardingStore, type OnboardingLoadResult} from "./src/onboarding/onboarding-store";
import {OnboardingCoordinator} from "./src/onboarding/onboarding-coordinator";
import {
	createProductionEmbeddingModel,
	createProductionRuntimePipeline,
} from "./src/onboarding/production-onboarding-dependencies";
import {QuickIndexCoordinator} from "./src/onboarding/quick-index-coordinator";
import type {EnvironmentReport} from "./src/onboarding/onboarding-types";
import {OnboardingModal} from "./src/onboarding/OnboardingModal";
import type {OnboardingMode} from "./src/onboarding/OnboardingView";
import {
	createRuntimeHistoryAssetResolver,
	getRuntimeAsset,
	RUNTIME_HISTORY_BINDING_REGISTRY,
	RUNTIME_MANIFEST,
} from "./src/runtime/runtime-manifest";
import {
	RuntimeControlSurface,
	type RuntimeControlSurfaceCapability,
} from "./src/runtime/runtime-control-surface";
import {
	McpServerManager,
	type McpServiceState,
} from "./src/mcp/mcp-server-manager";
import {
	ChromaDataMigration,
	createChromaDataGeneration,
	createDeviceLocalIndexStateStore,
	createLegacyCleanupManager,
	extractDeviceLocalSettings,
	type ChromaDataGeneration,
} from "./src/runtime/chroma-data-migration";
import type {RuntimePaths} from "./src/runtime/runtime-types";
import {
	discoverLegacyRuntime,
	LegacyChromaRuntimeBridge,
	type LegacySourceSession,
} from "./src/runtime/legacy-chroma-runtime-bridge";
import {LegacyVectorMigration, type LegacyVectorMigrationEvidence} from "./src/runtime/legacy-vector-migration";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

declare const __ANALOGY_BUILD_ID__: string | undefined;
declare const __ANALOGY_EMBEDDING_WORKER_SOURCE__: string | undefined;

interface RuntimeLifecycle {
	coordinator: OnboardingCoordinator;
	chromaManager: ChromaRuntimeManager;
	loadOnboarding(): Promise<OnboardingLoadResult>;
	detect(signal: AbortSignal): Promise<EnvironmentReport>;
	createBootstrap(): LocalServiceBootstrap;
	createBootstrapForModel(modelShortName: string): LocalServiceBootstrap;
	dispose(): Promise<void>;
}

function environmentCanStartServices(report: EnvironmentReport): boolean {
	return (report.chroma === "installed" || report.chroma === "running" || report.chroma === "not-required")
		&& report.embeddingRuntime === "ready"
		&& report.embeddingModel === "ready"
		&& report.index === "ready"
		&& (report.recommendedAction === "start-services" || report.recommendedAction === "none");
}

async function safeDirectoryBytes(root: string): Promise<number | null> {
	let total = 0;
	const visit = async (directory: string): Promise<void> => {
		for (const name of await fs.promises.readdir(directory)) {
			const target = path.join(directory, name);
			const stat = await fs.promises.lstat(target);
			if (stat.isSymbolicLink()) throw new Error("LEGACY_DATA_PATH_UNSAFE");
			if (stat.isDirectory()) await visit(target);
			else if (stat.isFile()) total += stat.size;
			else throw new Error("LEGACY_DATA_PATH_UNSAFE");
		}
	};
	try {
		await visit(root);
		return Number.isSafeInteger(total) ? total : null;
	} catch {
		return null;
	}
}

export default class Analogy extends Plugin {
	settings: AnalogySettings;
	chromaManager: LocalChromaServiceController | null = null;
	embeddingService: EmbeddingService | null = null;
	vectorStore: VectorStore | null = null;
	documentIndexer: DocumentIndexer | null = null;
	private initLocalServicesPromise: Promise<void> | null = null;
	private localServiceBootstrap: LocalServiceBootstrap | null = null;
	private runtimeLifecycle: RuntimeLifecycle | null = null;
	private runtimeControlSurface: RuntimeControlSurface | null = null;
	private activeEmbeddingRuntimeId: string | null = null;
	private runtimePort = 8000;
	private runtimeVaultId: string | null = null;
	private runtimePaths: RuntimePaths | null = null;
	private chromaDataMigration: ChromaDataMigration | null = null;
	onboardingCoordinator: OnboardingCoordinator | null = null;
	private onboardingModal: OnboardingModal | null = null;
	private layoutReadyAbort: AbortController | null = null;
	private lifecycleGeneration = 0;
	private unloading = false;
	private diagnosticRecorder: DiagnosticRecorder | null = null;
	private safeModeManager: SafeModeManager | null = null;
	private semanticWalkActivationQueue: Promise<void> = Promise.resolve();
	private mcpServerManager: McpServerManager | null = null;
	private vectorStoreHost: VectorStoreHost | null = null;
	private vectorStoreHostPromise: Promise<VectorStoreHost> | null = null;
	private vectorStoreHostContext: {
		embeddingRuntimeManager: EmbeddingRuntimeManager;
		paths: RuntimePaths;
		buildId: string;
		workerBundleSource: string;
	} | null = null;
	private vectorStoreImportPromise: Promise<ChromaImportMarker> | null = null;
	private managedNodePath: string | null = null;

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

		if (this.localServiceBootstrap) {
			await this.localServiceBootstrap.stop();
			this.localServiceBootstrap = null;
		} else if (this.documentIndexer) {
			await this.documentIndexer.stop();
			this.documentIndexer.shutdown();
			await this.documentIndexer.flushState();
			this.documentIndexer = null;
		}
		if (!this.localServiceBootstrap && this.embeddingService) {
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
		this.unloading = false;
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
			(leaf) => new IndexView(leaf, this.manifest.version)
		)
		this.registerSemanticWalkFeatures();

		addIcon('analogy-icon', icon);

		this.addRibbonIcon('analogy-icon', 'Analogy', () => {
			this.activateView();
		});

		this.addSettingTab(new AnalogySettingTab(this.app, this));
		this.registerLicenseRefresh();

		this.app.workspace.onLayoutReady(() => {
			void this.initLocalServices().catch((err) => {
				if (this.unloading || (err as Error)?.message === "LOCAL_SERVICE_BOOTSTRAP_CANCELLED") return;
				updateOnboardingState({ visible: true });
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
		if (this.unloading) return;
		if (this.initLocalServicesPromise) {
			return this.initLocalServicesPromise;
		}
		const generation = this.lifecycleGeneration;
		const controller = new AbortController();
		this.layoutReadyAbort = controller;
		this.initLocalServicesPromise = this.runLayoutReadyLifecycle(generation, controller).finally(() => {
			this.initLocalServicesPromise = null;
			if (this.layoutReadyAbort === controller) this.layoutReadyAbort = null;
		});
		return this.initLocalServicesPromise;
	}

	private async runLayoutReadyLifecycle(generation: number, controller: AbortController): Promise<void> {
		const lifecycle = this.runtimeLifecycle ?? this.createRuntimeLifecycle();
		this.runtimeLifecycle = lifecycle;
		const loaded = await lifecycle.loadOnboarding();
		this.assertLifecycleCurrent(generation, controller.signal);
		this.diagnosticRecorder?.updateStage("environment.detect", "environment.detect.start");
		const report = await lifecycle.detect(controller.signal);
		this.assertLifecycleCurrent(generation, controller.signal);
		this.runtimeControlSurface?.publishEnvironment(report, {
			chromaRuntimeId: loaded.snapshot.chromaRuntimeId,
			embeddingRuntimeId: loaded.snapshot.embeddingRuntimeId,
		});
		this.diagnosticRecorder?.info(
			"environment.detect",
			"environment.detect.complete",
			"Local runtime environment detection completed",
			{
				platform: report.platform,
				recommendedAction: report.recommendedAction,
				chroma: report.chroma,
				embeddingRuntime: report.embeddingRuntime,
				embeddingModel: report.embeddingModel,
				index: report.index,
			},
		);

		if (!environmentCanStartServices(report)) {
			const visible = loaded.snapshot.dismissedAt === null;
			updateOnboardingState({
				environment: report,
				snapshot: loaded.snapshot,
				visible,
			});
			if (visible) this.openOnboarding(report.recommendedAction === "repair" ? "repair" : "setup");
			return;
		}

		updateOnboardingState({ environment: report, snapshot: loaded.snapshot, visible: false });
		const modelKey = this.settings.embeddingModel || DEFAULT_MODEL_KEY;
		const modelConfig = EMBEDDING_MODELS[modelKey] || EMBEDDING_MODELS[DEFAULT_MODEL_KEY];
		updateServiceState({
			status: "initializing",
			dbPath: "",
			port: this.runtimePort,
			embeddingStatus: "idle",
			vectorStoreStatus: "idle",
			modelDownloadProgress: 0,
			lastError: "",
			activeModel: modelConfig.shortName,
			summarySearchEnabled: Boolean(this.settings.summarizeBeforeEmbedding),
		});
		const bootstrap = this.localServiceBootstrap ?? lifecycle.createBootstrap();
		this.localServiceBootstrap = bootstrap;
		this.diagnosticRecorder?.updateStage("service.bootstrap", "service.bootstrap.start");
		await bootstrap.start();
		this.assertLifecycleCurrent(generation, controller.signal);
		this.diagnosticRecorder?.updateStage("search.readiness", "search.readiness.ready");
		this.diagnosticRecorder?.info(
			"plugin.layout-ready",
			"plugin.ready",
			"Local services initialized successfully",
			{ model: this.settings.embeddingModel || DEFAULT_MODEL_KEY },
		);
	}

	private assertLifecycleCurrent(generation: number, signal: AbortSignal): void {
		if (this.unloading || signal.aborted || generation !== this.lifecycleGeneration) {
			throw new Error("LOCAL_SERVICE_BOOTSTRAP_CANCELLED");
		}
	}

	createRuntimeLifecycle(): RuntimeLifecycle {
		const platform = detectSupportedPlatform();
		const basePath = (this.app.vault.adapter as any).basePath as string;
		const runtimeVaultId = deriveRuntimeVaultId(basePath, platform);
		const paths = createRuntimePaths(resolveAnalogyLocalDataRoot(), runtimeVaultId);
		this.runtimeVaultId = runtimeVaultId;
		this.runtimePaths = paths;
		const storePaths = this.getVectorStorePaths(paths);
		const chromaDataMigration = new ChromaDataMigration({
			runtimeStatePath: storePaths.runtimeState,
			runtimeVaultId,
		});
		this.chromaDataMigration = chromaDataMigration;
		const chromaRuntimeManager = new ChromaRuntimeManager({
			leaseStore: new ChromaProcessLeaseStore({
				root: paths.root,
				leasePath: paths.chromaProcessLease,
				runtimeVaultId,
			}),
		});
		const buildId = (typeof __ANALOGY_BUILD_ID__ !== "undefined" && __ANALOGY_BUILD_ID__)
			? __ANALOGY_BUILD_ID__
			: `${this.manifest.version}+dev`;
		const workerBundleSource = typeof __ANALOGY_EMBEDDING_WORKER_SOURCE__ !== "undefined"
			? __ANALOGY_EMBEDDING_WORKER_SOURCE__
			: "";
		const embeddingRuntimeManager = new EmbeddingRuntimeManager({
			paths,
			platform,
			buildId,
			workerBundleSource,
		});
		this.vectorStoreHostContext = {embeddingRuntimeManager, paths, buildId, workerBundleSource};
		const onboardingStore = new OnboardingStore({ paths });
		const modelKey = this.settings.embeddingModel || DEFAULT_MODEL_KEY;
		const modelConfig = EMBEDDING_MODELS[modelKey] || EMBEDDING_MODELS[DEFAULT_MODEL_KEY];
		const loadTargetIndexState = async () => {
			const state = await chromaDataMigration.readOptional();
			const pending = state?.pendingGeneration?.modelShortName === modelConfig.shortName
				? state.pendingGeneration : null;
			const evidenceId = pending?.transitionToken
				?? (state?.activeGeneration === "v2" && state.modelShortName === modelConfig.shortName
					? state.scopeCompletion?.evidenceId : undefined);
			const scopedStore = createDeviceLocalIndexStateStore(
				storePaths.root,
				"v2",
				modelConfig.shortName,
				evidenceId,
			);
			let indexState = await scopedStore.load();
			const baseCollection = `analogy_${runtimeVaultId}_${modelConfig.shortName}`;
			if (indexState === undefined && evidenceId && pending?.collectionName === baseCollection) {
				const previousStore = createDeviceLocalIndexStateStore(storePaths.root, "v2", modelConfig.shortName);
				const previousState = await previousStore.load();
				if (previousState) {
					await scopedStore.save(previousState);
					indexState = previousState;
				}
			}
			return {state, pending, evidenceId, store: scopedStore, indexState: indexState ?? {}};
		};
		const detectFreshEnvironment = async (signal: AbortSignal) => {
			// The SQLite store must own its state before anything reads index readiness.
			await this.ensureVectorStoreImported({paths, platform, chromaRuntimeManager, signal});
			const target = await loadTargetIndexState();
			const actualPort: number | null = null;
			const completed = await chromaDataMigration.isCompletedFor({
				modelShortName: modelConfig.shortName,
				indexState: target.indexState,
				actualPort,
			});
			const report = await detectEnvironment({
				platform,
				paths,
				vectorBackend: "sqlite",
				modelCacheKey: modelConfig.shortName,
				indexState: {
					entries: completed ? 1 : Object.keys(target.indexState).length,
					total: completed ? 1 : Math.max(1, Object.keys(target.indexState).length + 1),
					legacy: target.state?.activeGeneration === "legacy",
				},
				chromaRuntimeManager,
				signal,
			});
			if (report.index !== "legacy") return report;
			const legacyDataPath = path.join(this.getPluginDir(), "chroma_data", this.getVaultId());
			const legacyState = await createDeviceLocalIndexStateStore(
				storePaths.root, "legacy", modelConfig.shortName,
			).load().catch(() => undefined);
			const estimatedRecords = legacyState
				? Object.values(legacyState).reduce((sum, entry) => sum
					+ (Number.isSafeInteger(entry.chunkCount) && entry.chunkCount > 0 ? entry.chunkCount : 0), 0)
				: null;
			const runtimeAvailable = await discoverLegacyRuntime({
				pluginDir: this.getPluginDir(), legacyDataPath, platform,
			}).then(() => true, () => false);
			return {
				...report,
				legacyIndexSummary: {
					runtimeAvailable,
					estimatedRecords,
					sourceBytes: await safeDirectoryBytes(legacyDataPath),
				},
			};
		};
		const chromaAsset = getRuntimeAsset("chroma", platform);
		const embeddingAsset = getRuntimeAsset("embedding-runtime", platform);
		const resolveTrustedRuntimeAsset = createRuntimeHistoryAssetResolver(
			RUNTIME_MANIFEST,
			RUNTIME_HISTORY_BINDING_REGISTRY,
			platform,
		);
		const embeddingModel = createProductionEmbeddingModel({
			paths,
			runtimeManager: embeddingRuntimeManager,
			modelConfig,
			createService: (managedRuntime, cacheDir) => new EmbeddingService({
				cacheDir,
				pluginDir: this.getPluginDir(),
				remoteHost: this.settings.embeddingModelHost,
				modelConfig,
				pluginVersion: this.manifest.version,
				buildId,
				workerBundleSource,
				managedRuntime,
				allowInProcessFallback: false,
				...this.modelFileOptions(),
				recorder: this.diagnosticRecorder,
				safeModeManager: this.safeModeManager,
				onSafeModeEntered: () => this.handleSafeModeEntered(),
			}),
		});
		let coordinator!: OnboardingCoordinator;
		let lifecycleBootstrap: LocalServiceBootstrap | null = null;
		let quickOwnedBootstrap: LocalServiceBootstrap | null = null;
		let quickStagingIndexer: DocumentIndexer | null = null;
		let quickTransitionBootstrap: LocalServiceBootstrap | null = null;
		let legacyBridgeController: AbortController | null = null;
		let legacySource: LegacySourceSession | null = null;
		let legacyVectorMigration: LegacyVectorMigration | null = null;
		let legacyTransition: ChromaDataGeneration | null = null;
		let legacyCopyEvidence: LegacyVectorMigrationEvidence | null = null;
		let legacyReconciliationEvidence: Awaited<ReturnType<DocumentIndexer["reconcileMigratedIndex"]>> | null = null;
		let legacyEmbeddingService: EmbeddingService | null = null;
		let legacyStagingStore: VectorStore | null = null;
		let legacySearchStore: VectorStore | null = null;
		let legacyStagingIndexer: DocumentIndexer | null = null;
		let legacyPendingIndexCount = 0;
		let legacyCurrentIndexCount = 0;
		let legacySourceBytes = 0;
		const createBootstrapForModel = (modelShortName: string): LocalServiceBootstrap => {
			const modelEntry = Object.entries(EMBEDDING_MODELS)
				.find(([, config]) => config.shortName === modelShortName);
			if (!modelEntry) throw new Error("CHROMA_GENERATION_MODEL_UNAVAILABLE");
			return this.createLocalServiceBootstrap({
				platform,
				paths,
				runtimeVaultId,
				chromaRuntimeManager,
				embeddingRuntimeManager,
				buildId,
				workerBundleSource,
				coordinator,
				detectEnvironment: detectFreshEnvironment,
				modelKey: modelEntry[0],
			});
		};
		const getOrCreateBootstrap = (): LocalServiceBootstrap => {
			if (lifecycleBootstrap) return lifecycleBootstrap;
			lifecycleBootstrap = this.localServiceBootstrap
				?? createBootstrapForModel(modelConfig.shortName);
			this.localServiceBootstrap = lifecycleBootstrap;
			return lifecycleBootstrap;
		};
		const quickIndex = new QuickIndexCoordinator({
			vault: this.app.vault,
			getDocumentIndexer: async () => {
				const actualPort = this.runtimePort;
				const existingPending = await chromaDataMigration.resumePendingGeneration(
					paths.root,
					path.join(this.getPluginDir(), "chroma_data", this.getVaultId()),
				);
				const transition = existingPending?.modelShortName === modelConfig.shortName
					? await chromaDataMigration.publishActiveLease({...existingPending, port: actualPort})
					: await chromaDataMigration.begin(
						this.createActiveChromaGeneration(actualPort, modelConfig.shortName),
						(collectionName) => this.createVectorStore()
							.deleteCollectionByName(actualPort, collectionName),
					);
				const bootstrap = getOrCreateBootstrap();
				const readiness = bootstrap as LocalServiceBootstrap & {isReady?: () => boolean};
				const hadReadyBootstrap = typeof readiness.isReady === "function"
					? readiness.isReady()
					: Boolean(this.documentIndexer && this.embeddingService && this.chromaManager);
				if (hadReadyBootstrap) {
					if (!this.embeddingService || !this.runtimeVaultId) {
						throw Object.assign(new Error("QUICK_INDEX_EXISTING_SERVICE_UNAVAILABLE"), {
							code: "QUICK_INDEX_EXISTING_SERVICE_UNAVAILABLE",
						});
					}
					const stagingStore = this.createVectorStore();
					await stagingStore.initialize(
						actualPort,
						this.runtimeVaultId,
						modelConfig.shortName,
						transition.collectionName,
					);
					quickStagingIndexer = new DocumentIndexer(
						this.embeddingService,
						stagingStore,
						this.app.vault,
						createDeviceLocalIndexStateStore(
							storePaths.root,
							"v2",
							modelConfig.shortName,
							transition.transitionToken,
						),
						this.settings.excludedIndexPaths,
					);
					await quickStagingIndexer.loadState();
					quickTransitionBootstrap = bootstrap;
					return quickStagingIndexer;
				}
				quickOwnedBootstrap = bootstrap;
				const ready = await bootstrap.start();
				const indexer = ready.documentIndexer as DocumentIndexer;
				return typeof indexer?.indexFiles === "function" ? indexer : null;
			},
			getLicenseState: () => loadLicenseState(),
			hashSalt: runtimeVaultId,
			recordFailure: ({pathHash, errorCategory}) => this.diagnosticRecorder?.warn(
				"index.embed",
				"quick-index.file.failed",
				"Quick index file failed",
				{pathHash, errorCategory},
			),
				onSettled: async (outcome) => {
				quickStagingIndexer = null;
				quickTransitionBootstrap = null;
				const bootstrap = quickOwnedBootstrap;
				if (!bootstrap) return;
				if (outcome === "completed") {
					quickOwnedBootstrap = null;
					return;
				}
				try {
					await bootstrap.releaseSetupServices({preserveChromaLease: false});
				} finally {
					if (lifecycleBootstrap === bootstrap) lifecycleBootstrap = null;
					if (this.localServiceBootstrap === bootstrap) this.localServiceBootstrap = null;
					quickOwnedBootstrap = null;
					this.publishLocalServices(null, modelConfig.shortName);
				}
			},
		});
		const legacyMigration = {
			prepare: async (signal: AbortSignal) => {
				const legacyDataPath = path.join(this.getPluginDir(), "chroma_data", this.getVaultId());
				const collectionName = `analogy_${this.getVaultId()}_${modelConfig.shortName}`;
				const candidate = await discoverLegacyRuntime({
					pluginDir: this.getPluginDir(), legacyDataPath, platform,
				});
				// Legacy data is copied into the SQLite store; no Chroma v2 process is involved.
				const processState = {port: this.runtimePort};
				const pending = await chromaDataMigration.resumePendingGeneration(paths.root, legacyDataPath);
				legacyTransition = pending?.modelShortName === modelConfig.shortName
					? await chromaDataMigration.publishActiveLease({...pending, port: processState.port})
					: await chromaDataMigration.begin(
						this.createActiveChromaGeneration(processState.port, modelConfig.shortName),
						(name) => this.createVectorStore().deleteCollectionByName(processState.port, name),
					);
				legacyStagingStore = this.createVectorStore();
				await legacyStagingStore.initialize(
					processState.port, runtimeVaultId, modelConfig.shortName, legacyTransition.collectionName,
				);
				const managedRuntime = await embeddingRuntimeManager.resolve();
				legacyEmbeddingService = new EmbeddingService({
					cacheDir: path.join(paths.modelCache, modelConfig.shortName),
					pluginDir: this.getPluginDir(),
					remoteHost: this.settings.embeddingModelHost,
					modelConfig,
					pluginVersion: this.manifest.version,
					buildId,
					workerBundleSource,
					managedRuntime,
					allowInProcessFallback: false,
					...this.modelFileOptions(),
					recorder: this.diagnosticRecorder,
					safeModeManager: this.safeModeManager,
					onSafeModeEntered: () => this.handleSafeModeEntered(),
				});
				await legacyEmbeddingService.initialize();
				legacyBridgeController = new AbortController();
				if (signal.aborted) legacyBridgeController.abort();
				else signal.addEventListener("abort", () => legacyBridgeController?.abort(), {once: true});
				const bridge = new LegacyChromaRuntimeBridge({
					candidate,
					stagingRoot: path.join(storePaths.root, "legacy-migration"),
					migrationId: crypto.createHash("sha256")
						.update(`${runtimeVaultId}:${modelConfig.shortName}`, "utf8").digest("hex").slice(0, 32),
					collectionName,
					platform,
				});
				legacySource = await bridge.prepare(legacyBridgeController.signal);
				legacyVectorMigration = new LegacyVectorMigration({
					checkpointPath: path.join(storePaths.root, "legacy-vector-migration.json"),
					source: legacySource,
					destination: {
						upsertRecords: (records) => legacyStagingStore!.upsertRecords(records),
						getRecordIdentityPage: (offset, limit) => legacyStagingStore!.getRecordIdentityPage(offset, limit),
						count: () => legacyStagingStore!.count(),
						queryIds: async (embedding, topK) => (await legacyStagingStore!.search([...embedding], topK))
							.map((item) => item.chunkId),
					},
					sourceModel: {id: modelConfig.id, shortName: modelConfig.shortName},
					expectedCollectionNames: [collectionName],
					targetModel: {
						id: modelConfig.id,
						shortName: modelConfig.shortName,
						smokeEmbedding: () => legacyEmbeddingService!.embedQuery("Analogy 固定迁移验证查询"),
					},
					transition: legacyTransition,
				});
				const inspection = await legacyVectorMigration.inspect(signal);
				legacySourceBytes = inspection.sourceBytes;
				legacySearchStore = {
					search: async (embedding: number[], topK: number) => {
						const response = await legacySource!.query(embedding, topK);
						const ids = response.ids?.[0] ?? [];
						const documents = response.documents?.[0] ?? [];
						const metadatas = response.metadatas?.[0] ?? [];
						const distances = response.distances?.[0] ?? [];
						return ids.map((id, index) => ({
							chunkId: id, content: documents[index] ?? "", metadata: metadatas[index] ?? {},
							distance: distances[index] ?? 0, score: distances[index] ?? 0,
						}));
					},
					count: () => legacySource!.count(),
				} as unknown as VectorStore;
				initLocalVectorServices(legacyEmbeddingService, legacySearchStore, null, null, {
					status: "ready", chromaManager: null, dbPath: "", port: legacySource.port,
					embeddingStatus: "ready", vectorStoreStatus: "ready", modelDownloadProgress: 100,
					activeModel: modelConfig.shortName, lastError: "", rebuildProgress: null,
					summarySearchEnabled: false,
				}, modelConfig.maxInputChars);
				return {copiedRecords: 0, totalRecords: inspection.recordCount, sourceBytes: inspection.sourceBytes};
			},
			copy: async (signal: AbortSignal, onProgress: (progress: {
				copiedRecords: number; totalRecords: number; sourceBytes: number;
			}) => void) => {
				if (!legacyVectorMigration) throw new Error("LEGACY_MIGRATION_NOT_PREPARED");
				const unsubscribe = legacyVectorMigration.subscribe((snapshot) => onProgress({
					copiedRecords: snapshot.copiedRecords,
					totalRecords: snapshot.totalRecords,
					sourceBytes: legacySourceBytes,
				}));
				try {
					const checkpoint = path.join(storePaths.root, "legacy-vector-migration.json");
					legacyCopyEvidence = fs.existsSync(checkpoint)
						? await legacyVectorMigration.resume(signal)
						: await legacyVectorMigration.start(signal);
				} finally {
					unsubscribe();
				}
			},
			reconcile: async (signal: AbortSignal, onProgress: (progress: {
				copiedRecords: number; totalRecords: number; sourceBytes: number;
			}) => void) => {
				if (!legacyStagingStore || !legacyEmbeddingService || !legacyTransition) {
					throw new Error("LEGACY_MIGRATION_NOT_PREPARED");
				}
				legacyStagingIndexer = new DocumentIndexer(
					legacyEmbeddingService,
					legacyStagingStore,
					this.app.vault,
					createDeviceLocalIndexStateStore(
						storePaths.root, "v2", modelConfig.shortName, legacyTransition.transitionToken,
					),
					this.settings.excludedIndexPaths,
				);
				const files = this.app.vault.getMarkdownFiles();
				if (signal.aborted) throw Object.assign(new Error("LEGACY_MIGRATION_CANCELLED"), {
					code: "LEGACY_MIGRATION_CANCELLED",
				});
				legacyReconciliationEvidence = await legacyStagingIndexer.adoptMigratedIndex(files);
				const statuses = legacyStagingIndexer.getAllFileStatuses(files);
				legacyCurrentIndexCount = statuses.filter(({status}) => status === "indexed").length;
				legacyPendingIndexCount = statuses.length - legacyCurrentIndexCount;
				onProgress({
					copiedRecords: legacyReconciliationEvidence.expectedFileCount,
					totalRecords: legacyReconciliationEvidence.expectedFileCount,
					sourceBytes: legacySourceBytes,
				});
			},
			verify: async (_signal: AbortSignal) => {
				if (!legacyTransition || !legacyCopyEvidence || !legacyReconciliationEvidence || !legacyStagingIndexer) {
					throw new Error("LEGACY_MIGRATION_NOT_PREPARED");
				}
				const completed = await chromaDataMigration.completeLegacyVectorMigration(
					legacyTransition,
					legacyCopyEvidence,
					{
						expectedFileCount: legacyReconciliationEvidence.expectedFileCount,
						scopeType: "vault",
						selectedDocuments: legacyReconciliationEvidence.selectedDocuments,
						indexState: legacyReconciliationEvidence.indexState,
						collectionDocuments: legacyReconciliationEvidence.collectionDocuments,
						chunkCount: legacyReconciliationEvidence.chunkCount,
						smokeQuery: (query) => legacyStagingIndexer!.runSmokeQuery(query),
						cleanupCollection: (name) => this.createVectorStore()
							.deleteCollectionByName(legacyTransition!.port, name),
					},
				);
				const bootstrap = getOrCreateBootstrap();
				try {
					const readiness = bootstrap as LocalServiceBootstrap & {isReady?: () => boolean};
					if (readiness.isReady?.()) {
						await this.restartServicesAfterPointerSwitch(
							chromaDataMigration, completed, bootstrap, legacyTransition.port,
						);
					} else {
						await bootstrap.start();
					}
				} catch (error) {
					await chromaDataMigration.rollbackToPreviousGeneration(legacyTransition.port).catch(() => undefined);
					if (legacySource && legacyEmbeddingService && legacySearchStore) {
						initLocalVectorServices(legacyEmbeddingService, legacySearchStore, null, null, {
							status: "ready", chromaManager: null, dbPath: "", port: legacySource.port,
							embeddingStatus: "ready", vectorStoreStatus: "ready", modelDownloadProgress: 100,
							activeModel: modelConfig.shortName, lastError: "", rebuildProgress: null,
							summarySearchEnabled: false,
						}, modelConfig.maxInputChars);
					}
					throw error;
				}
				new Notice(t("onboarding.legacy.migratedSummary", {
					model: modelConfig.displayName,
					indexed: legacyCurrentIndexCount,
					pending: legacyPendingIndexCount,
				}), 12_000);
				await legacySource?.close().catch((error) => this.diagnosticRecorder?.captureException(
					"service.bootstrap", "legacy.snapshot.cleanup.failed", error,
				));
				legacySource = null;
				await legacyEmbeddingService?.dispose().catch((error) => this.diagnosticRecorder?.captureException(
					"embedding.model-load", "legacy.embedding.dispose.failed", error,
				));
				legacyEmbeddingService = null;
				legacySearchStore = null;
			},
			cancel: async () => {
				await legacyVectorMigration?.cancel().catch(() => undefined);
				legacyBridgeController?.abort();
				legacyBridgeController = null;
				await legacyEmbeddingService?.dispose().catch(() => undefined);
				legacyEmbeddingService = null;
				legacySource = null;
				legacySearchStore = null;
				initLocalVectorServices(null, null, null, null, {
					status: "idle", chromaManager: null, dbPath: "", port: this.runtimePort,
					embeddingStatus: "idle", vectorStoreStatus: "idle", modelDownloadProgress: 0,
					activeModel: "", lastError: "", rebuildProgress: null, summarySearchEnabled: false,
				});
			},
		};
		coordinator = new OnboardingCoordinator({
			detectEnvironment: detectFreshEnvironment,
			store: onboardingStore,
			runtimes: {
				chroma: createProductionRuntimePipeline({ asset: chromaAsset, paths, requests: this.downloadTransports() }),
				embedding: createProductionRuntimePipeline({ asset: embeddingAsset, paths, requests: this.downloadTransports() }),
			},
			chromaManager: chromaRuntimeManager,
			chromaStartOptions: (installed) => ({
				executablePath: installed?.executablePath
					?? path.join(paths.chromaVersions, chromaAsset.id, chromaAsset.executableRelativePath),
				dataPath: paths.chromaDataV2,
				preferredPort: this.runtimePort,
				runtimeVersion: chromaAsset.version,
			}),
			embeddingRuntimeManager,
			embeddingModel,
			quickIndex,
			legacyMigration,
			finalizeQuickIndex: async (result) => {
				try {
					if (result.failed !== 0 || result.selectedDocuments.length !== result.selectedFileCount) {
						throw new Error("QUICK_INDEX_EVIDENCE_INCOMPLETE");
					}
					const indexer = quickStagingIndexer ?? this.documentIndexer;
					if (!indexer) throw new Error("INDEXER_UNAVAILABLE");
					const migration = this.chromaDataMigration ?? chromaDataMigration;
					this.chromaDataMigration = migration;
					const generation = await migration.resumePendingGeneration(
						paths.root,
						path.join(this.getPluginDir(), "chroma_data", this.getVaultId()),
					);
					if (!generation || generation.modelShortName !== modelConfig.shortName) {
						throw new Error("CHROMA_REBUILD_PENDING_MISSING");
					}
					const evidence = await indexer.verifyCurrentGeneration(result.selectedDocuments);
					const completed = await migration.completeRebuild(generation, {
						expectedFileCount: evidence.expectedFileCount,
						scopeType: result.scopeType,
						selectedDocuments: evidence.selectedDocuments,
						indexState: evidence.indexState,
						collectionDocuments: evidence.collectionDocuments,
						chunkCount: evidence.chunkCount,
						smokeQuery: (query) => indexer.runSmokeQuery(query),
						cleanupCollection: (collectionName) => this.createVectorStore()
							.deleteCollectionByName(generation.port, collectionName),
					});
					if (quickTransitionBootstrap) {
						await this.restartServicesAfterPointerSwitch(
							migration,
							completed,
							quickTransitionBootstrap,
							generation.port,
						);
					}
				} catch (cause) {
					throw Object.assign(new Error("CHROMA_DATA_REBUILD_FAILED"), {
						code: "CHROMA_DATA_REBUILD_FAILED",
						cause,
					});
				}
			},
		});
		this.onboardingCoordinator = coordinator;
		let controlSurface!: RuntimeControlSurface;
		let recordedSetupStage = "";
		let recordedSetupError = "";
		let setupStageStartedAt = Date.now();
		const unsubscribeCoordinator = coordinator.subscribe((snapshot) => {
			if (snapshot.stage !== recordedSetupStage) {
				const now = Date.now();
				this.diagnosticRecorder?.recordRuntimeSetup({
					stage: snapshot.stage,
					platform: platform.startsWith("win32") ? "win32" : "darwin",
					arch: platform.endsWith("arm64") ? "arm64" : "x64",
					runtimeId: snapshot.embeddingRuntimeId ?? snapshot.chromaRuntimeId ?? undefined,
					durationMs: Math.max(0, now - setupStageStartedAt),
					receivedBytes: snapshot.completedBytes ?? 0,
					copiedRecords: snapshot.legacyRecordsCopied ?? undefined,
					totalRecords: snapshot.legacyRecordsTotal ?? undefined,
					sourceBytes: snapshot.legacySourceBytes ?? undefined,
				});
				recordedSetupStage = snapshot.stage;
				setupStageStartedAt = now;
			}
			if (snapshot.error && snapshot.error.code !== recordedSetupError) {
				this.diagnosticRecorder?.recordRuntimeSetup({
					stage: snapshot.stage,
					errorCode: snapshot.error.code,
					platform: platform.startsWith("win32") ? "win32" : "darwin",
					arch: platform.endsWith("arm64") ? "arm64" : "x64",
					portConflict: snapshot.error.code.includes("PORT"),
				});
				recordedSetupError = snapshot.error.code;
			}
			updateOnboardingState({
				snapshot,
				visible: snapshot.stage !== "ready" && snapshot.dismissedAt === null,
			});
			const environment = controlSurface?.getSnapshot().environment;
			if (environment) {
				controlSurface.publishEnvironment(environment, {
					chromaRuntimeId: snapshot.chromaRuntimeId,
					embeddingRuntimeId: snapshot.embeddingRuntimeId,
				});
			}
		});
		const revealStorage = async () => {
			const shell = require("electron")?.shell;
			if (!shell?.showItemInFolder) throw new Error("RUNTIME_REVEAL_UNAVAILABLE");
			await fs.promises.mkdir(paths.root, {recursive: true, mode: 0o700});
			shell.showItemInFolder(paths.root);
		};
		const trashItem = async (target: string) => {
			const shell = require("electron")?.shell;
			if (!shell?.trashItem) throw new Error("RUNTIME_TRASH_UNAVAILABLE");
			await shell.trashItem(target);
		};
		const legacyDataPath = path.join(this.getPluginDir(), "chroma_data", this.getVaultId());
		const legacyCleanup = createLegacyCleanupManager({
			legacyDataPath,
			pluginDirectory: this.getPluginDir(),
			isV2Completed: async () => {
				const state = await this.chromaDataMigration?.readOptional();
				return state?.activeGeneration === "v2" && state.rebuildCompletedAt !== null;
			},
			trashItem,
		});
		controlSurface = new RuntimeControlSurface({
			paths,
			platform,
			detectEnvironment: () => detectFreshEnvironment(new AbortController().signal),
			coordinator,
			chromaManager: chromaRuntimeManager,
			openOnboarding: (mode) => this.openOnboarding(mode),
			restartServices: async () => {
				const bootstrap = getOrCreateBootstrap();
				await bootstrap.stop();
				await bootstrap.start();
			},
			revealStorage,
			trashItem,
			resolveTrustedRuntimeAsset,
			getActiveEmbeddingRuntimeId: () => this.activeEmbeddingRuntimeId,
			legacyCleanup: (confirmation) => legacyCleanup.cleanup(confirmation),
			listLegacyRecoveries: () => legacyCleanup.listRecoveries(),
			retryLegacyRecovery: (id) => legacyCleanup.retryRecovery(id),
			restoreLegacyRecovery: (id) => legacyCleanup.restoreRecovery(id),
			importRuntimeArchive: async (filePath: string) => {
				// Work on a private copy so installer cleanup never touches the user's file.
				await fs.promises.mkdir(paths.downloads, {recursive: true, mode: 0o700});
				const copy = path.join(paths.downloads, `${embeddingAsset.id}.offline-import`);
				await fs.promises.copyFile(filePath, copy);
				try {
					const pipeline = createProductionRuntimePipeline({asset: embeddingAsset, paths});
					const downloaded = {path: copy, metaPath: `${copy}.meta.json`, receivedBytes: 0, etag: null, lastModified: null, resumed: false};
					const verification = await pipeline.verify(downloaded);
					if (verification && !verification.ok) {
						throw Object.assign(new Error(verification.errorCode ?? "DOWNLOAD_HASH_MISMATCH"), {
							code: verification.errorCode ?? "DOWNLOAD_HASH_MISMATCH",
						});
					}
					await pipeline.install(downloaded);
				} finally {
					await fs.promises.rm(copy, {force: true}).catch(() => undefined);
				}
			},
			importModelFolder: (directory: string) => importModelFiles(
				modelConfig.shortName,
				directory,
				path.join(paths.modelCache, modelConfig.shortName),
			),
			discardLegacyMigration: async () => {
				await legacyMigration.cancel();
				const transition = legacyTransition ?? await chromaDataMigration.resumePendingGeneration(
					paths.root, legacyDataPath,
				);
				if (transition) {
					await chromaDataMigration.discardPendingGeneration(
						transition.transitionToken,
						(name) => this.createVectorStore().deleteCollectionByName(transition.port, name),
					);
				}
				await legacyVectorMigration?.discard();
				legacyTransition = null;
				legacyCopyEvidence = null;
				legacyReconciliationEvidence = null;
			},
		});
		this.runtimeControlSurface = controlSurface;
		const lifecycle: RuntimeLifecycle = {
			coordinator,
			chromaManager: chromaRuntimeManager,
			loadOnboarding: () => onboardingStore.load({
				legacySettings: this.settings as unknown as Record<string, unknown>,
				persistSanitizedSettings: async (settings) => {
					this.settings = Object.assign({}, DEFAULT_SETTINGS, settings) as AnalogySettings;
					await this.saveSettings();
				},
			}),
			detect: detectFreshEnvironment,
			createBootstrap: getOrCreateBootstrap,
			createBootstrapForModel,
			dispose: async () => {
				unsubscribeCoordinator();
				await quickIndex.dispose();
				await coordinator.dispose();
				await embeddingModel.cancel();
				await onboardingStore.dispose();
				if (this.onboardingCoordinator === coordinator) this.onboardingCoordinator = null;
				if (this.runtimeControlSurface === controlSurface) this.runtimeControlSurface = null;
			},
		};
		return lifecycle;
	}

	private createLocalServiceBootstrap(input: {
		platform: ReturnType<typeof detectSupportedPlatform>;
		paths: ReturnType<typeof createRuntimePaths>;
		runtimeVaultId: string;
		chromaRuntimeManager: ChromaRuntimeManager;
		embeddingRuntimeManager: EmbeddingRuntimeManager;
		buildId: string;
		workerBundleSource: string;
		coordinator: OnboardingCoordinator;
		detectEnvironment(signal: AbortSignal): Promise<EnvironmentReport>;
		modelKey?: string;
	}): LocalServiceBootstrap {
		const modelKey = (input.modelKey ?? this.settings.embeddingModel) || DEFAULT_MODEL_KEY;
		const modelConfig = EMBEDDING_MODELS[modelKey] || EMBEDDING_MODELS[DEFAULT_MODEL_KEY];
		let serviceCollectionName: string | undefined;
		let serviceEvidenceId: string | undefined;
		const storeRoot = this.getVectorStorePaths(input.paths).root;
		return new LocalServiceBootstrap({
			resolveVerifiedRuntimes: async (signal) => {
				const embedding = await input.embeddingRuntimeManager.resolve();
				if (signal.aborted) throw new Error("LOCAL_SERVICE_BOOTSTRAP_CANCELLED");
				const migration = this.getStoreMigration(input.paths);
				const state = await migration.readOptional();
				const pending = state?.pendingGeneration?.modelShortName === modelConfig.shortName
					? state.pendingGeneration : null;
				if (pending) {
					serviceCollectionName = pending.collectionName;
					serviceEvidenceId = pending.transitionToken;
				} else if (state?.activeGeneration === "v2" && state.modelShortName === modelConfig.shortName) {
					serviceCollectionName = state.collectionName;
					serviceEvidenceId = state.scopeCompletion?.evidenceId;
				} else {
					serviceCollectionName = undefined;
					serviceEvidenceId = undefined;
				}
				if (serviceEvidenceId && pending?.collectionName
					=== `analogy_${input.runtimeVaultId}_${modelConfig.shortName}`) {
					const scopedStore = createDeviceLocalIndexStateStore(
						storeRoot, "v2", modelConfig.shortName, serviceEvidenceId,
					);
					if (await scopedStore.load() === undefined) {
						const oldStore = createDeviceLocalIndexStateStore(
							storeRoot, "v2", modelConfig.shortName,
						);
						const oldState = await oldStore.load();
						if (oldState) await scopedStore.save(oldState);
					}
				}
				if (signal.aborted) throw new Error("LOCAL_SERVICE_BOOTSTRAP_CANCELLED");
				return {chroma: null, embedding};
			},
			chromaManager: input.chromaRuntimeManager,
			sqliteBackend: this.createSqliteBackend(input.paths),
			vaultId: input.runtimeVaultId,
			modelShortName: modelConfig.shortName,
			maxInputChars: modelConfig.maxInputChars,
			resolveCollectionName: async () => serviceCollectionName,
			createVectorStore: () => this.createVectorStore(),
			createEmbeddingService: (managedRuntime) => new EmbeddingService({
				cacheDir: path.join(input.paths.modelCache, modelConfig.shortName),
				pluginDir: this.getPluginDir(),
				remoteHost: this.settings.embeddingModelHost,
				modelConfig,
				pluginVersion: this.manifest.version,
				buildId: input.buildId,
				workerBundleSource: input.workerBundleSource,
				managedRuntime,
				allowInProcessFallback: false,
				...this.modelFileOptions(),
				recorder: this.diagnosticRecorder,
				safeModeManager: this.safeModeManager,
				onSafeModeEntered: () => this.handleSafeModeEntered(),
			}),
			createSummarizer: () => {
				const summaryConfig = SUMMARY_MODELS[this.settings.summaryModel]
					|| SUMMARY_MODELS[DEFAULT_SUMMARY_MODEL_KEY];
				return new DocumentSummarizer({
					enabled: Boolean(this.settings.summarizeBeforeEmbedding),
					model: summaryConfig.ollamaName,
					maxInputChars: this.settings.summaryMaxInputChars || DEFAULT_SETTINGS.summaryMaxInputChars,
					fallbackToOriginal: this.settings.summaryFallbackToOriginal !== false,
					promptTemplate: this.settings.summaryPrompt || DEFAULT_SUMMARY_PROMPT,
					client: new OllamaClient({
						host: this.settings.summaryOllamaHost || DEFAULT_SETTINGS.summaryOllamaHost,
						timeoutMs: this.settings.summaryTimeoutMs || DEFAULT_SETTINGS.summaryTimeoutMs,
					}),
				});
			},
			createDocumentIndexer: (embedding, vectorStore) => new DocumentIndexer(
				embedding as EmbeddingService,
				vectorStore as VectorStore,
				this.app.vault,
				createDeviceLocalIndexStateStore(
					storeRoot,
					"v2",
					modelConfig.shortName,
					serviceEvidenceId,
				),
				this.settings.excludedIndexPaths,
				this.app.workspace,
			),
			publishServices: async (ready) => {
				if (ready) {
					try {
						await this.publishRuntimeState(ready.lease.port, modelConfig.shortName);
					} catch (error) {
						this.diagnosticRecorder?.captureException(
							"service.bootstrap",
							"runtime.state.write.failed",
							error,
						);
						throw error;
					}
				}
				this.publishLocalServices(ready, modelConfig.shortName);
			},
			updateSearchState: (patch) => updateServiceState(patch),
			recordCleanupError: (error) => this.diagnosticRecorder?.captureException(
				"service.bootstrap",
				"service.bootstrap.cleanup.failed",
				error,
			),
			coordinator: input.coordinator,
			detectEnvironment: input.detectEnvironment,
		});
	}

	/**
	 * Direct Node HTTPS first; Obsidian's requestUrl second. The latter runs in
	 * Electron's network stack and therefore follows the system proxy / PAC.
	 */
	private downloadTransports(): RuntimeRequest[] {
		return [defaultRequest, createChunkedTransport(requestUrl as unknown as ProxyAwareFetch)];
	}

	private modelFileOptions() {
		return {
			manageModelFiles: true,
			modelHosts: modelHosts(this.settings.embeddingModelHost),
			downloadTransports: this.downloadTransports(),
		};
	}

	/** Everything the SQLite store writes lives here; Chroma-era files stay untouched for rollback. */
	private getVectorStorePaths(paths: RuntimePaths): {root: string; runtimeState: string; database: string} {
		const root = path.join(paths.vaultRoot, "vector-store");
		return {
			root,
			runtimeState: path.join(root, "runtime-state.json"),
			database: path.join(root, "vectors.sqlite"),
		};
	}

	private getStoreMigration(paths: RuntimePaths): ChromaDataMigration {
		if (!this.chromaDataMigration) {
			this.chromaDataMigration = new ChromaDataMigration({
				runtimeStatePath: this.getVectorStorePaths(paths).runtimeState,
				runtimeVaultId: paths.runtimeVaultId,
			});
		}
		return this.chromaDataMigration;
	}

	private createVectorStore(): SqliteVectorStore {
		return new SqliteVectorStore({
			request: async <K extends VectorStoreOperation>(op: K, params: VectorStoreOperations[K]["params"]) =>
				(await this.getVectorStoreHost()).request(op, params),
		});
	}

	private getVectorStoreHost(): Promise<VectorStoreHost> {
		if (this.vectorStoreHost) return Promise.resolve(this.vectorStoreHost);
		if (this.vectorStoreHostPromise) return this.vectorStoreHostPromise;
		const context = this.vectorStoreHostContext;
		if (!context || this.unloading) return Promise.reject(new Error("VECTOR_STORE_UNAVAILABLE"));
		const operation = (async () => {
			const runtime = await context.embeddingRuntimeManager.resolve();
			const host = new VectorStoreHost({
				databasePath: this.getVectorStorePaths(context.paths).database,
				execPath: runtime.nodeExecutable,
				moduleRoot: runtime.moduleRoot,
				pluginDir: runtime.root,
				workerRoot: path.dirname(context.paths.workerVersions),
				workerDir: context.paths.workerVersions,
				buildId: context.buildId,
				workerBundleSource: context.workerBundleSource,
				spawnGuard: runtime.revalidate,
				recorder: this.diagnosticRecorder,
			});
			if (this.unloading) {
				await host.dispose();
				throw new Error("VECTOR_STORE_UNAVAILABLE");
			}
			this.vectorStoreHost = host;
			this.managedNodePath = runtime.nodeExecutable;
			return host;
		})();
		this.vectorStoreHostPromise = operation;
		void operation.then(
			() => { if (this.vectorStoreHostPromise === operation) this.vectorStoreHostPromise = null; },
			() => { if (this.vectorStoreHostPromise === operation) this.vectorStoreHostPromise = null; },
		);
		return operation;
	}

	private createSqliteBackend(paths: RuntimePaths) {
		const databasePath = this.getVectorStorePaths(paths).database;
		const describe = () => ({
			ownership: "analogy" as const,
			pid: this.vectorStoreHost?.getPid() ?? null,
			executablePath: this.managedNodePath,
			port: this.runtimePort,
			runtimeVersion: "sqlite-v1",
			startedAt: null,
		});
		return {
			healthy: async () => (await this.getVectorStoreHost()).healthy(),
			describe,
			controller: () => ({
				isHealthy: async () => this.vectorStoreHost?.healthy() ?? false,
				// The store process lives for the plugin session and is closed on unload.
				stop: async () => undefined,
				getLastError: () => this.vectorStoreHost?.getLastError() ?? "",
				getPort: () => this.runtimePort,
				getDbPath: () => databasePath,
				getProcessState: describe,
			}),
		};
	}

	/**
	 * Copies an existing Chroma index into SQLite once. Chroma is started only for
	 * this read and stopped afterwards; its data directory is never modified by us.
	 */
	private ensureVectorStoreImported(input: {
		paths: RuntimePaths;
		platform: ReturnType<typeof detectSupportedPlatform>;
		chromaRuntimeManager: ChromaRuntimeManager;
		signal: AbortSignal;
	}): Promise<ChromaImportMarker> {
		if (this.vectorStoreImportPromise) return this.vectorStoreImportPromise;
		const storePaths = this.getVectorStorePaths(input.paths);
		const progress: {notice: Notice | null} = {notice: null};
		const operation = (async () => {
			const settled = await readChromaImportMarker(storePaths.root);
			if (isChromaImportSettled(settled)) return settled!;
			const plan = await planChromaImport(input.paths.vaultRoot);
			if (plan.required.length + plan.optional.length > 0) {
				try {
					await this.getVectorStoreHost();
				} catch (error) {
					// No usable embedding runtime yet: onboarding repairs it first. The import
					// stays pending and runs on a later detection.
					this.diagnosticRecorder?.captureException("vector-store.initialize", "vector-store.import.deferred", error);
					return {
						schemaVersion: 1 as const,
						status: "failed" as const,
						attempts: settled?.attempts ?? 0,
						collections: [],
						errorCode: "CHROMA_IMPORT_DEFERRED",
						updatedAt: Date.now(),
					};
				}
			}
			const marker = await runChromaImportIfNeeded({
				legacyRoot: input.paths.vaultRoot,
				storeRoot: storePaths.root,
				// Resolved lazily: vaults without Chroma data never start the store process here.
				destination: {
					request: async <K extends VectorStoreOperation>(op: K, params: VectorStoreOperations[K]["params"]) =>
						(await this.getVectorStoreHost()).request(op, params),
				},
				signal: input.signal,
				withChromaSource: async (run) => {
					let runtime: Awaited<ReturnType<typeof resolveVerifiedChromaRuntime>>;
					try {
						runtime = await resolveVerifiedChromaRuntime({
							paths: input.paths,
							platform: input.platform,
							signal: input.signal,
						});
					} catch (cause) {
						throw Object.assign(new Error("CHROMA_IMPORT_RUNTIME_UNAVAILABLE"), {
							code: "CHROMA_IMPORT_RUNTIME_UNAVAILABLE",
							cause,
						});
					}
					progress.notice = new Notice(t("vectorStore.import.running"), 0);
					this.diagnosticRecorder?.info("vector-store.initialize", "vector-store.import.start", "Copying Chroma index into SQLite");
					const lease = await input.chromaRuntimeManager.start({
						executablePath: runtime.executablePath,
						dataPath: input.paths.chromaDataV2,
						preferredPort: this.runtimePort,
						runtimeVersion: runtime.runtimeVersion,
					});
					try {
						return await run(() => {
							const chroma = new LocalVectorStore();
							return {
								openCollection: (name) => chroma.openExistingCollection(lease.port, name),
								count: () => chroma.count(),
								readPage: (offset, limit) => chroma.getRecordPage(offset, limit),
							};
						});
					} finally {
						await input.chromaRuntimeManager.stopOwnedProcess(lease).catch((error) => {
							this.diagnosticRecorder?.captureException("vector-store.initialize", "vector-store.import.chroma-stop.failed", error);
						});
					}
				},
				onProgress: ({copied, total}) => {
					progress.notice?.setMessage(t("vectorStore.import.progress", {copied, total}));
				},
			});
			progress.notice?.hide();
			if (marker.status === "completed" && marker.collections.length > 0) {
				const records = marker.collections.reduce((sum, item) => sum + item.records, 0);
				new Notice(t("vectorStore.import.done", {records}), 8_000);
				this.diagnosticRecorder?.info("vector-store.initialize", "vector-store.import.completed", "Chroma index copied into SQLite", {records});
			} else if (marker.status === "rebuild-required") {
				new Notice(t("vectorStore.import.rebuildRequired", {code: marker.errorCode ?? ""}), 15_000);
				this.diagnosticRecorder?.warn("vector-store.initialize", "vector-store.import.rebuild-required", "Chroma import gave up; the vault will be re-indexed", {errorCode: marker.errorCode ?? ""});
			}
			return marker;
		})();
		this.vectorStoreImportPromise = operation;
		void operation.then((marker) => {
			if (marker.errorCode === "CHROMA_IMPORT_DEFERRED" && this.vectorStoreImportPromise === operation) {
				this.vectorStoreImportPromise = null;
			}
		}, () => undefined);
		void operation.catch((error) => {
			progress.notice?.hide();
			if (this.vectorStoreImportPromise === operation) this.vectorStoreImportPromise = null;
			const code = (error as {code?: string})?.code ?? (error as Error)?.message ?? "CHROMA_IMPORT_FAILED";
			if (code !== "CHROMA_IMPORT_CANCELLED") {
				new Notice(t("vectorStore.import.failed", {code}), 15_000);
				updateServiceState({status: "error", lastError: code});
			}
			this.diagnosticRecorder?.captureException("vector-store.initialize", "vector-store.import.failed", error);
		});
		return operation;
	}

	private createActiveChromaGeneration(port: number, modelShortName: string): ChromaDataGeneration {
		const platform = detectSupportedPlatform();
		const basePath = (this.app.vault.adapter as any).basePath as string;
		const runtimeVaultId = this.runtimeVaultId ?? deriveRuntimeVaultId(basePath, platform);
		const localDataRoot = this.runtimePaths?.root ?? resolveAnalogyLocalDataRoot();
		return createChromaDataGeneration({
			localDataRoot,
			runtimeVaultId,
			modelShortName,
			port,
			legacyDataPath: path.join(this.getPluginDir(), "chroma_data", this.getVaultId()),
		});
	}

	private async publishRuntimeState(port: number, modelShortName: string): Promise<void> {
		this.runtimePort = port;
		const paths = this.runtimePaths;
		if (!paths) return;
		const migration = this.getStoreMigration(paths);
		await migration.publishActiveLease(this.createActiveChromaGeneration(port, modelShortName));
	}

	async rebuildManagedChromaData(
		files: TFile[],
		onProgress?: (progress: RebuildProgress) => void,
	): Promise<ChromaDataGeneration> {
		if (!this.embeddingService || !this.runtimePaths || !this.runtimeVaultId) {
			throw new Error("CHROMA_REBUILD_UNAVAILABLE");
		}
		const modelKey = this.settings.embeddingModel || DEFAULT_MODEL_KEY;
		const modelConfig = EMBEDDING_MODELS[modelKey] || EMBEDDING_MODELS[DEFAULT_MODEL_KEY];
		const port = this.chromaManager?.getPort() || this.runtimePort;
		const migration = this.getStoreMigration(this.runtimePaths);
		const pending = await migration.resumePendingGeneration(
			this.runtimePaths.root,
			path.join(this.getPluginDir(), "chroma_data", this.getVaultId()),
		);
		const transition = pending?.modelShortName === modelConfig.shortName
			? await migration.publishActiveLease({...pending, port})
			: await migration.begin(
				this.createActiveChromaGeneration(port, modelConfig.shortName),
				(collectionName) => this.createVectorStore().deleteCollectionByName(port, collectionName),
			);
		const stagingStore = this.createVectorStore();
		await stagingStore.initialize(
			port,
			this.runtimeVaultId,
			modelConfig.shortName,
			transition.collectionName,
		);
		const stagingIndexer = new DocumentIndexer(
			this.embeddingService,
			stagingStore,
			this.app.vault,
			createDeviceLocalIndexStateStore(
				this.getVectorStorePaths(this.runtimePaths).root,
				"v2",
				modelConfig.shortName,
				transition.transitionToken,
			),
			this.settings.excludedIndexPaths,
		);
		await stagingIndexer.loadState();
		const evidence = await stagingIndexer.rebuildIndexVerified(files, {
			force: true,
			onProgress,
		});
		const completed = await migration.completeRebuild(transition, {
			expectedFileCount: evidence.expectedFileCount,
			scopeType: "vault",
			selectedDocuments: evidence.selectedDocuments,
			indexState: evidence.indexState,
			collectionDocuments: evidence.collectionDocuments,
			chunkCount: evidence.chunkCount,
			smokeQuery: (query) => stagingIndexer.runSmokeQuery(query),
			cleanupCollection: (collectionName) => this.createVectorStore()
				.deleteCollectionByName(port, collectionName),
		});
		const bootstrap = this.localServiceBootstrap;
		if (!bootstrap) {
			this.publishLocalServices(null, modelConfig.shortName);
			return completed;
		}
		return this.restartServicesAfterPointerSwitch(migration, completed, bootstrap, port);
	}

	private async restartServicesAfterPointerSwitch(
		migration: ChromaDataMigration,
		completed: ChromaDataGeneration,
		bootstrap: LocalServiceBootstrap,
		port: number,
	): Promise<ChromaDataGeneration> {
		try {
			const ready = await this.restartBootstrapForGenerationSwitch(bootstrap);
			return {...completed, port: ready.lease.port};
		} catch (primary) {
			let pointerRollbackError: unknown = null;
			try {
				await migration.rollbackToPreviousGeneration(port);
			} catch (error) {
				pointerRollbackError = error;
			}
			let recoveryError: unknown = null;
			try {
				// A failed stop may have released only part of the old service graph. Settle
				// the exact retained lease/context before recreating services from the
				// restored pointer.
				await this.restartBootstrapForGenerationSwitch(bootstrap);
			} catch (error) {
				recoveryError = error;
			}
			if (pointerRollbackError || recoveryError) {
				throw Object.assign(new Error("CHROMA_REBUILD_SERVICE_ROLLBACK_FAILED"), {
					code: "CHROMA_REBUILD_SERVICE_ROLLBACK_FAILED",
					cause: primary,
					pointerRollbackError,
					recoveryError,
				});
			}
			throw primary;
		}
	}

	private async restartBootstrapForGenerationSwitch(
		bootstrap: LocalServiceBootstrap,
	): Promise<LocalServiceReady> {
		const controlled = bootstrap as LocalServiceBootstrap & {
			restartForGenerationSwitch?: () => Promise<LocalServiceReady>;
		};
		if (typeof controlled.restartForGenerationSwitch === "function") {
			return controlled.restartForGenerationSwitch();
		}
		// Structural test doubles from older callers do not expose the controlled
		// transition method. Production LocalServiceBootstrap always does.
		await bootstrap.stop({preserveChromaLease: true});
		return bootstrap.start();
	}

	async rollbackManagedChromaData(): Promise<void> {
		if (!this.runtimePaths || !this.localServiceBootstrap || !this.runtimeLifecycle) {
			throw new Error("CHROMA_ROLLBACK_UNAVAILABLE");
		}
		const migration = this.getStoreMigration(this.runtimePaths);
		const state = await migration.read();
		const target = state.previousGeneration;
		if (!target) throw new Error("CHROMA_ROLLBACK_UNAVAILABLE");
		const targetModelEntry = Object.entries(EMBEDDING_MODELS)
			.find(([, config]) => config.shortName === target.modelShortName);
		if (!targetModelEntry) throw new Error("CHROMA_GENERATION_MODEL_UNAVAILABLE");
		const originalBootstrap = this.localServiceBootstrap;
		const originalLifecycle = this.runtimeLifecycle;
		const originalCoordinator = this.onboardingCoordinator;
		const originalControlSurface = this.runtimeControlSurface;
		const originalModelKey = this.settings.embeddingModel || DEFAULT_MODEL_KEY;
		let targetBootstrap: LocalServiceBootstrap | null = null;
		let targetLifecycle: RuntimeLifecycle | null = null;
		let originalStopped = false;
		let pointerChanged = false;
		let settingsChanged = false;
		try {
			await this.stopBootstrapForGenerationSwitch(originalBootstrap, false);
			originalStopped = true;
			await migration.rollbackToPreviousGeneration();
			pointerChanged = true;
			this.settings.embeddingModel = targetModelEntry[0];
			await this.saveSettings();
			settingsChanged = true;
			targetLifecycle = this.createRuntimeLifecycle();
			if (target.generation === "legacy") {
				this.localServiceBootstrap = null;
				this.publishLocalServices(null, target.modelShortName);
				this.runtimeLifecycle = targetLifecycle;
				await originalLifecycle.dispose();
				return;
			}
			targetBootstrap = targetLifecycle.createBootstrapForModel(target.modelShortName);
			await targetBootstrap.start();
			this.localServiceBootstrap = targetBootstrap;
			this.runtimeLifecycle = targetLifecycle;
			await originalLifecycle.dispose();
		} catch (primary) {
			const recoveryErrors: unknown[] = [];
			if (pointerChanged) {
				try { await migration.rollbackToPreviousGeneration(); }
				catch (error) { recoveryErrors.push(error); }
			}
			if (settingsChanged || this.settings.embeddingModel !== originalModelKey) {
				this.settings.embeddingModel = originalModelKey;
				try { await this.saveSettings(); } catch (error) { recoveryErrors.push(error); }
			}
			if (targetBootstrap) {
				try { await this.stopBootstrapForGenerationSwitch(targetBootstrap, false); }
				catch (error) { recoveryErrors.push(error); }
			}
			if (targetLifecycle) {
				try { await targetLifecycle.dispose(); } catch (error) { recoveryErrors.push(error); }
			}
			this.runtimeLifecycle = originalLifecycle;
			this.onboardingCoordinator = originalCoordinator;
			this.runtimeControlSurface = originalControlSurface;
			this.chromaDataMigration = migration;
			this.localServiceBootstrap = originalBootstrap;
			try {
				if (!originalStopped) await this.stopBootstrapForGenerationSwitch(originalBootstrap, false);
				await originalBootstrap.start();
			} catch (error) {
				recoveryErrors.push(error);
			}
			if (recoveryErrors.length > 0) {
				throw Object.assign(new Error("CHROMA_ROLLBACK_COMPENSATION_FAILED"), {
					code: "CHROMA_ROLLBACK_COMPENSATION_FAILED",
					cause: primary,
					recoveryErrors,
				});
			}
			throw primary;
		}
	}

	private async stopBootstrapForGenerationSwitch(
		bootstrap: LocalServiceBootstrap,
		preserveChromaLease: boolean,
	): Promise<void> {
		const controlled = bootstrap as LocalServiceBootstrap & {
			stopForGenerationSwitch?: (options: {preserveChromaLease: boolean}) => Promise<void>;
		};
		if (typeof controlled.stopForGenerationSwitch === "function") {
			await controlled.stopForGenerationSwitch({preserveChromaLease});
			return;
		}
		await bootstrap.stop({preserveChromaLease});
	}

	private publishLocalServices(
		ready: LocalServiceReady | null,
		modelShortName: string,
	): void {
		this.activeEmbeddingRuntimeId = ready?.runtimes.embedding.runtimeId ?? null;
		this.embeddingService = (ready?.embeddingService as EmbeddingService | undefined) ?? null;
		this.vectorStore = (ready?.vectorStore as VectorStore | undefined) ?? null;
		this.documentIndexer = (ready?.documentIndexer as DocumentIndexer | undefined) ?? null;
		this.chromaManager = ready?.chromaManager ?? null;
		initLocalVectorServices(
			this.embeddingService,
			this.vectorStore,
			this.documentIndexer,
			this.chromaManager,
			ready ? {
				status: "ready",
				chromaManager: this.chromaManager,
				dbPath: ready.chromaManager.getDbPath(),
				port: ready.lease.port,
				embeddingStatus: "ready",
				vectorStoreStatus: "ready",
				modelDownloadProgress: 100,
				activeModel: modelShortName,
				lastError: "",
				summarySearchEnabled: Boolean(this.settings.summarizeBeforeEmbedding),
			} : {
				status: "idle",
				chromaManager: null,
				dbPath: "",
				port: this.runtimePort,
				embeddingStatus: "idle",
				vectorStoreStatus: "idle",
				modelDownloadProgress: 0,
				activeModel: "",
				lastError: "",
				rebuildProgress: null,
				summarySearchEnabled: false,
			},
			ready?.maxInputChars,
			ready?.documentSummarizer ?? null,
		);
	}

	openOnboarding(mode: OnboardingMode = "setup"): void {
		if (this.unloading || this.onboardingModal) return;
		const lifecycle = this.runtimeLifecycle ?? this.createRuntimeLifecycle();
		this.runtimeLifecycle = lifecycle;
		const coordinator = lifecycle.coordinator;
		if (!coordinator) return;
		const buildId = (typeof __ANALOGY_BUILD_ID__ !== "undefined" && __ANALOGY_BUILD_ID__)
			? __ANALOGY_BUILD_ID__
			: `${this.manifest.version}+dev`;
		const modal = new OnboardingModal(this.app, {
			coordinator,
			mode,
			pluginBuildId: buildId,
			environmentFacts: collectEnvironmentFacts(),
			onStartSearching: () => { void this.activateView(); },
			onOpenOllama: () => this.openAnalogySettings("analogy-settings-summary"),
			onOpenHelp: () => (this.app as any).setting?.openTabById?.("analogy-rag-in-your-vault"),
			onChangePort: () => (this.app as any).setting?.openTabById?.("analogy-rag-in-your-vault"),
			onDidClose: () => {
				if (this.onboardingModal !== modal) return;
				this.onboardingModal = null;
				updateOnboardingState({visible: false});
			},
		});
		this.onboardingModal = modal;
		updateOnboardingState({visible: true});
		modal.open();
	}

	openAnalogySettings(sectionId?: string): void {
		(this.app as any).setting?.openTabById?.("analogy-rag-in-your-vault");
		if (!sectionId) return;
		let remainingFrames = 30;
		const focusSection = () => {
			if (this.unloading) return;
			const section = document.getElementById(sectionId);
			if (!section) {
				remainingFrames -= 1;
				if (remainingFrames > 0) window.requestAnimationFrame(focusSection);
				return;
			}
			section.focus({preventScroll: true});
			section.scrollIntoView({behavior: "smooth", block: "start"});
		};
		window.requestAnimationFrame(focusSection);
	}

	getRuntimeControlSurface(): RuntimeControlSurfaceCapability | null {
		if (!this.runtimeControlSurface && !this.unloading) {
			this.runtimeLifecycle = this.runtimeLifecycle ?? this.createRuntimeLifecycle();
		}
		return this.runtimeControlSurface;
	}

	getDiagnosticHostInfo(): {platform: string; arch: string} {
		return {
			platform: typeof process !== "undefined" ? process.platform : "unknown",
			arch: typeof process !== "undefined" ? process.arch : "unknown",
		};
	}

	getMcpServerConfig(): { json: string; serverPath: string; serverReady: boolean } {
		const vaultPath = ((this.app.vault.adapter as any)?.basePath as string | undefined) ?? "";
		const pluginDir = this.getPluginDir();
		const serverPath = path.join(pluginDir, "mcp-server", "dist", "index.js");
		const config = {
			mcpServers: {
				"analogy-vault": {
					// The MCP server reads SQLite through node:sqlite, which needs Node >= 22.13.
					command: this.managedNodePath ?? "node",
					args: [serverPath],
					env: {
						ANALOGY_VAULT_PATH: vaultPath,
						ANALOGY_PLUGIN_DIR: pluginDir,
						ANALOGY_MODEL: this.settings.embeddingModel || DEFAULT_MODEL_KEY,
					},
				},
			},
		};
		return {
			json: JSON.stringify(config, null, 2),
			serverPath,
			serverReady: fs.existsSync(serverPath),
		};
	}

	getMcpServiceState(): McpServiceState {
		return this.mcpServerManager?.getState() ?? { status: "stopped", message: "" };
	}

	onMcpServiceStateChange(listener: () => void): () => void {
		return this.getOrCreateMcpServerManager().subscribe(listener);
	}

	async startMcpService(): Promise<void> {
		await this.getOrCreateMcpServerManager().start();
	}

	async stopMcpService(): Promise<void> {
		await this.getOrCreateMcpServerManager().stop();
	}

	private getOrCreateMcpServerManager(): McpServerManager {
		if (!this.mcpServerManager) {
			const pluginDir = this.getPluginDir();
			const vaultPath = ((this.app.vault.adapter as any)?.basePath as string | undefined) ?? "";
			this.mcpServerManager = new McpServerManager({
				serverDir: path.join(pluginDir, "mcp-server"),
				env: {
					ANALOGY_VAULT_PATH: vaultPath,
					ANALOGY_PLUGIN_DIR: pluginDir,
					ANALOGY_MODEL: this.settings.embeddingModel || DEFAULT_MODEL_KEY,
					...(this.managedNodePath ? {ANALOGY_NODE_PATH: this.managedNodePath} : {}),
				},
			});
		}
		return this.mcpServerManager;
	}

	async onunload() {
		this.unloading = true;
		this.lifecycleGeneration += 1;
		this.layoutReadyAbort?.abort();
		this.layoutReadyAbort = null;
		this.onboardingModal?.close();
		this.onboardingModal = null;
		if (this.mcpServerManager) {
			await this.mcpServerManager.dispose();
			this.mcpServerManager = null;
		}
		this.diagnosticRecorder?.updateStage("plugin.unload", "plugin.unload.start");
		void this.initLocalServicesPromise?.catch(() => undefined);
		const bootstrap = this.localServiceBootstrap;
		let bootstrapStopped = true;
		if (bootstrap) {
			try {
				await bootstrap.dispose();
			} catch (err) {
				bootstrapStopped = false;
				this.diagnosticRecorder?.captureException("plugin.unload", "service.bootstrap.stop.failed", err);
			}
			if (bootstrapStopped && this.localServiceBootstrap === bootstrap) this.localServiceBootstrap = null;
		}
		const lifecycle = this.runtimeLifecycle;
		let lifecycleDisposed = true;
		if (lifecycle) {
			try {
				await lifecycle.dispose();
			} catch (err) {
				lifecycleDisposed = false;
				this.diagnosticRecorder?.captureException("plugin.unload", "onboarding.store.dispose.failed", err);
			}
			if (lifecycleDisposed && this.runtimeLifecycle === lifecycle) this.runtimeLifecycle = null;
		}
		const vectorStoreHost = this.vectorStoreHost;
		this.vectorStoreHost = null;
		this.vectorStoreImportPromise = null;
		if (vectorStoreHost) {
			try {
				await vectorStoreHost.dispose();
			} catch (err) {
				this.diagnosticRecorder?.captureException("plugin.unload", "vector-store.stop.failed", err);
			}
		}
		this.initLocalServicesPromise = null;
		updateOnboardingState({ visible: false, environment: null, snapshot: null });
		this.runtimeControlSurface = null;
		this.activeEmbeddingRuntimeId = null;
		if (bootstrapStopped) {
			this.embeddingService = null;
			this.vectorStore = null;
			this.documentIndexer = null;
			this.chromaManager = null;
		}
		if (bootstrapStopped && lifecycleDisposed) {
			try {
				await this.diagnosticRecorder?.markCleanExit();
			} catch (err) {
				console.error("[Analogy] Failed to mark clean exit", err);
			}
		}
		if (bootstrapStopped) initLocalVectorServices(null, null, null, null, {
			status: "idle",
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
		const loaded = (await this.loadData() ?? {}) as Record<string, unknown>;
		const migrated = extractDeviceLocalSettings(loaded);
		this.settings = Object.assign({}, DEFAULT_SETTINGS, migrated.synchronizedSettings) as AnalogySettings;
		this.settings.excludedIndexPaths = Array.isArray(this.settings.excludedIndexPaths)
			? this.settings.excludedIndexPaths
			: [];
		this.settings.summaryPrompt = this.settings.summaryPrompt || DEFAULT_SUMMARY_PROMPT;

		const platform = detectSupportedPlatform();
		const basePath = (this.app.vault.adapter as any).basePath as string;
		const runtimeVaultId = deriveRuntimeVaultId(basePath, platform);
		const paths = createRuntimePaths(resolveAnalogyLocalDataRoot(), runtimeVaultId);
		// Chroma-era state is read here only to seed the one-time SQLite import.
		const migration = new ChromaDataMigration({runtimeStatePath: paths.runtimeState});
		this.runtimeVaultId = runtimeVaultId;
		this.runtimePaths = paths;
		this.chromaDataMigration = null;
		const runtimeState = await migration.readOptional();
		this.runtimePort = runtimeState?.port ?? migrated.legacyPort ?? 8000;

		for (const [modelShortName, state] of Object.entries(migrated.legacyIndexStates)) {
			const store = createDeviceLocalIndexStateStore(paths.vaultRoot, "legacy", modelShortName);
			if (await store.load() === undefined) await store.save(state);
		}
		const legacyDataPath = path.join(this.getPluginDir(), "chroma_data", this.getVaultId());
		if (!runtimeState && (fs.existsSync(legacyDataPath)
			|| Object.keys(migrated.legacyIndexStates).length > 0
			|| migrated.legacyPort !== null)) {
			const modelKey = this.settings.embeddingModel || DEFAULT_MODEL_KEY;
			const modelConfig = EMBEDDING_MODELS[modelKey] || EMBEDDING_MODELS[DEFAULT_MODEL_KEY];
			await migration.writeLegacyPointerForMigration(
				"legacy",
				this.runtimePort,
				`analogy_${this.getVaultId()}_${modelConfig.shortName}`,
				modelConfig.shortName,
				runtimeVaultId,
			);
		}
		if (Object.prototype.hasOwnProperty.call(loaded, "chromaPort")
			|| Object.prototype.hasOwnProperty.call(loaded, "indexStates")) {
			await this.saveSettings();
		}
	}

	async saveSettings() {
		const {synchronizedSettings} = extractDeviceLocalSettings(
			this.settings as unknown as Record<string, unknown>,
		);
		await this.saveData(synchronizedSettings);
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

	registerSemanticWalkFeatures(): void {
		this.registerView(
			VIEW_TYPE_SEMANTIC_WALK,
			(leaf) => new SemanticWalkItemView(leaf, this.diagnosticRecorder),
		);
		this.addRibbonIcon(
			"waypoints",
			t("semanticWalk.viewName"),
			() => this.activateSemanticWalk({type: "empty"}),
		);
		this.addCommand({
			id: "semantic-walk-open",
			name: t("semanticWalk.command.open"),
			callback: () => this.activateSemanticWalk({type: "empty"}),
		});
		this.addCommand({
			id: "semantic-walk-current-document",
			name: t("semanticWalk.command.currentDocument"),
			callback: () => {
				const file = this.app.workspace.getActiveFile();
				const path = file instanceof TFile && file.extension.toLowerCase() === "md"
					? file.path
					: "";
				return this.activateSemanticWalk({type: "current-document", path});
			},
		});
		this.addCommand({
			id: "semantic-walk-random",
			name: t("semanticWalk.command.random"),
			callback: () => this.activateSemanticWalk({type: "random"}),
		});
	}

	async activateSemanticWalk(request: SemanticWalkOpenRequest): Promise<void> {
		const activation = this.semanticWalkActivationQueue.then(() => this.performSemanticWalkActivation(request));
		this.semanticWalkActivationQueue = activation.catch(() => undefined);
		return activation;
	}

	private async performSemanticWalkActivation(request: SemanticWalkOpenRequest): Promise<void> {
		const {workspace} = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_SEMANTIC_WALK)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({type: VIEW_TYPE_SEMANTIC_WALK, active: true});
		}

		let view = leaf.view as unknown;
		if (!this.isSemanticWalkView(view)) {
			await leaf.setViewState({type: VIEW_TYPE_SEMANTIC_WALK, active: true});
			view = leaf.view as unknown;
		}
		if (!this.isSemanticWalkView(view)) {
			throw new Error("Semantic walk view could not be initialized");
		}
		view.dispatchOpenRequest(request);
		workspace.revealLeaf(leaf);
	}

	private isSemanticWalkView(view: unknown): view is {
		getViewType(): string;
		dispatchOpenRequest(request: SemanticWalkOpenRequest): void;
	} {
		if (!view || typeof view !== "object") return false;
		const candidate = view as {
			getViewType?: unknown;
			dispatchOpenRequest?: unknown;
		};
		return typeof candidate.getViewType === "function"
			&& candidate.getViewType.call(view) === VIEW_TYPE_SEMANTIC_WALK
			&& typeof candidate.dispatchOpenRequest === "function";
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
