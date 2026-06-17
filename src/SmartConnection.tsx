import { Copy, FileText, Plus, Shuffle } from "lucide-react"
import { useEffect, useState } from "react"
import { Textarea } from "./components/textarea";
import { Button } from "./components/button";
import { Loading } from "./components/loading";
import { Card, CardContent, CardHeader, CardTitle } from "./components/card";
import { Notice } from "obsidian";
import { useApp } from "./model/AppContext";
import { searchInstance, subscribeServiceState, type ServiceState } from "./local-vector/search-instance";
import { LocalSearchResult } from "./local-vector/search";
import { searchResultCache, type SearchResultCacheKey } from "./local-vector/search-result-cache";
import {
	closeSearchTab,
	createDefaultSearchTab,
	createDerivedSearchTab,
	createEmptySearchTab,
	createTabTitle,
	canCreateSearchTab,
	MAX_SEARCH_TABS,
	type SearchTab,
} from "./search-tabs";
import { onLocaleChange, t } from "./util/i18n";

const SEARCH_LOG_PREFIX = "[Analogy][Search]";
const DEFAULT_TOP_K = 10;

function compactSearchText(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length <= 160 ? normalized : `${normalized.slice(0, 160)}...`;
}

function getServiceStatusMessage(state: ServiceState): string | null {
	const status = state.status;
	if (status === "ready") return null;
	if (status === "error") return state.lastError || "Local vector service error. Check settings.";
	if (status === "degraded") return "Local vector service degraded. Some features may be unavailable.";
	if (state.embeddingStatus === "downloading") return "Embedding model downloading...";
	return "Local vector service initializing...";
}

function createTabId(): string {
	return `search-tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

type SearchMode = "query" | "document";

type SearchTabBarProps = {
	tabs: SearchTab[];
	activeTabId: string;
	onSelectTab: (tabId: string) => void;
	onCreateTab: () => void;
	onCloseTab: (tabId: string) => void;
};

function SearchTabBar({ tabs, activeTabId, onSelectTab, onCreateTab, onCloseTab }: SearchTabBarProps) {
	const [hoveredTabId, setHoveredTabId] = useState<string | null>(null);

	return (
		<div className="mt-2 flex items-center gap-1">
			<div className="flex min-w-0 flex-1 gap-1 overflow-x-auto whitespace-nowrap pb-1">
				{tabs.map((tab) => {
					const active = tab.id === activeTabId;
					const hovered = tab.id === hoveredTabId;
					return (
						<button
							key={tab.id}
							type="button"
							className="shrink-0 truncate"
							style={{
								alignItems: "center",
								backgroundColor: active ? "#f0f0f0" : hovered ? "#f6f6f6" : "transparent",
								border: active ? "1px solid #d8d8d8" : "1px solid transparent",
								borderRadius: "9999px",
								boxShadow: active ? "0 1px 3px rgba(0, 0, 0, 0.12)" : "none",
								color: active ? "#111111" : hovered ? "#222222" : "#666666",
								cursor: "pointer",
								display: "inline-flex",
								fontSize: "12px",
								fontWeight: active ? 600 : 500,
								height: "32px",
								justifyContent: "flex-start",
								lineHeight: "16px",
								maxWidth: "168px",
								minWidth: "118px",
								padding: hovered ? "0 28px 0 12px" : "0 12px",
								position: "relative",
								transition: "background-color 120ms ease, color 120ms ease, border-color 120ms ease",
							}}
							onMouseEnter={() => setHoveredTabId(tab.id)}
							onMouseLeave={() => setHoveredTabId(null)}
							onClick={() => onSelectTab(tab.id)}
							title={tab.title}
						>
							<span className="truncate">{tab.title}</span>
							{hovered && (
								<span
									role="button"
									tabIndex={-1}
									aria-label={`关闭标签页 ${tab.title}`}
									title="关闭标签页"
									style={{
										alignItems: "center",
										backgroundColor: active ? "#e3e3e3" : "#eeeeee",
										borderRadius: "9999px",
										color: "#555555",
										display: "inline-flex",
										fontSize: "14px",
										height: "18px",
										justifyContent: "center",
										lineHeight: "18px",
										position: "absolute",
										right: "6px",
										top: "7px",
										width: "18px",
									}}
									onMouseDown={(event) => {
										event.preventDefault();
										event.stopPropagation();
									}}
									onPointerDown={(event) => {
										event.preventDefault();
										event.stopPropagation();
									}}
									onClick={(event) => {
										event.preventDefault();
										event.stopPropagation();
										onCloseTab(tab.id);
									}}
								>
									×
								</span>
							)}
						</button>
					);
				})}
			</div>
			<button
				type="button"
				className="shrink-0"
				style={{
					alignItems: "center",
					backgroundColor: "#ffffff",
					border: "1px solid #e2e2e2",
					borderRadius: "9999px",
					boxShadow: "0 2px 6px rgba(0, 0, 0, 0.16)",
					color: "#222222",
					cursor: "pointer",
					display: "inline-flex",
					height: "32px",
					justifyContent: "center",
					padding: 0,
					width: "32px",
				}}
				title="新增搜索标签"
				aria-label="新增搜索标签"
				onClick={onCreateTab}
			>
				<Plus style={{ width: "17px", height: "17px" }} />
			</button>
		</div>
	);
}

type SearchPanelProps = {
	tab: SearchTab;
	activeFile: any;
	serviceReady: boolean;
	onQueryChange: (value: string) => void;
	onSearch: (query: string) => void;
	onOpenResult: (path: string) => void;
	onExploreResult: (result: LocalSearchResult) => void;
};

function SearchPanel({
	tab,
	activeFile,
	serviceReady,
	onQueryChange,
	onSearch,
	onOpenResult,
	onExploreResult,
}: SearchPanelProps) {
	const [isSummaryHovered, setIsSummaryHovered] = useState(false);

	useEffect(() => {
		setIsSummaryHovered(false);
	}, [tab.id, tab.documentQueryText]);

	const handleSearch = (event: { keyCode: number; key: string; preventDefault: () => void; }) => {
		if (event.keyCode === 13 || event.key === "Enter") {
			event.preventDefault();
			onSearch(tab.query);
		}
	};

	const copyDocumentQueryText = async () => {
		if (!tab.documentQueryText) return;
		try {
			await navigator.clipboard.writeText(tab.documentQueryText);
			new Notice(t("common.copiedToClipboard"));
		} catch (err) {
			console.error(`${SEARCH_LOG_PREFIX} copy-query-text-failed`, err);
			new Notice("复制失败，请手动选择文本复制。");
		}
	};

	return (
		<>
			<div className="relative mt-2 rounded-md">
				<Textarea
					className="analogy-textarea-autoresize resize-none pl-3 pr-14 block tracking-wide placeholder:text-[#444444] rounded-md border-[#e5e5e5] focus-visible:ring-[#0a0a0a] disabled:opacity-50 text-sm"
					placeholder={serviceReady ? "输入内容后按 Enter 搜索" : "本地搜索不可用"}
					value={tab.query}
					disabled={!serviceReady}
					onChange={(e) => onQueryChange(e.target.value)}
					onKeyDown={handleSearch}
					onInput={(e) => {
						const target = e.target as HTMLTextAreaElement;
						target.setCssProps({ "--analogy-textarea-height": "auto" });
						target.setCssProps({ "--analogy-textarea-height": `${target.scrollHeight + 2}px` });
					}}
					rows={1}
				/>
				<div className="absolute inset-y-0 right-1.5 flex items-center">
					<span className="text-[#444444] text-xs">Enter ↵</span>
				</div>
			</div>
			{activeFile && serviceReady && (
				<div className="mt-2">
					<Button
						variant="secondary"
						size="sm"
						className="w-full text-xs"
						disabled={tab.isLoading}
						onClick={() => onSearch("")}
					>
						基于文章内容搜索
					</Button>
					{tab.documentQueryText && (
						<Card
							className="relative mt-2 overflow-hidden"
							style={{
								backgroundColor: "#f6f6f6",
								borderColor: "#e2e2e2",
								borderRadius: "14px",
							}}
							onMouseEnter={() => setIsSummaryHovered(true)}
							onMouseMove={() => setIsSummaryHovered(true)}
							onMouseLeave={() => setIsSummaryHovered(false)}
							onPointerEnter={() => setIsSummaryHovered(true)}
							onPointerLeave={() => setIsSummaryHovered(false)}
						>
							<CardHeader className="px-3 py-2.5">
								<CardTitle className="m-0 text-sm leading-5">
									{t("search.articleSummaryQueryTitle")}
								</CardTitle>
							</CardHeader>
							<CardContent className="px-3 pt-0" style={{ paddingBottom: "42px" }}>
								<div className="max-h-[400px] overflow-y-auto whitespace-pre-wrap break-all pr-1 text-sm leading-5 text-[#444444]">
									{tab.documentQueryText}
								</div>
							</CardContent>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								title={t("common.copy")}
								aria-label={t("common.copy")}
								className="absolute border border-[#e5e5e5] bg-white text-[#444444] shadow-md hover:bg-[#f5f5f5]"
								style={{
									position: "absolute",
									right: "12px",
									bottom: "12px",
									width: "34px",
									height: "34px",
									borderRadius: "9999px",
									backgroundColor: "rgba(255, 255, 255, 0.96)",
									opacity: isSummaryHovered ? 1 : 0,
									visibility: isSummaryHovered ? "visible" : "hidden",
									pointerEvents: isSummaryHovered ? "auto" : "none",
									zIndex: 2,
									transition: "opacity 120ms ease, transform 120ms ease",
								}}
								onMouseEnter={() => setIsSummaryHovered(true)}
								onFocus={() => setIsSummaryHovered(true)}
								onClick={copyDocumentQueryText}
							>
								<Copy className="h-4 w-4" />
							</Button>
						</Card>
					)}
				</div>
			)}
			<div>
				{tab.isLoading ? (
					Loading("正在搜索...")
				) : tab.results?.length ? (
					tab.results.map((item, index) => (
						<div className="pt-2" key={`${item.path || item.title}-${index}`}>
							<SearchResultCard
								result={item}
								serviceReady={serviceReady}
								onOpen={onOpenResult}
								onExplore={onExploreResult}
							/>
						</div>
					))
				) : (
					<div className="pt-7">
						<div className="flex justify-center items-center text-sm text-[#444444]">
							暂无结果
						</div>
					</div>
				)}
			</div>
		</>
	);
}

type SearchResultCardProps = {
	result: LocalSearchResult;
	serviceReady: boolean;
	onOpen: (path: string) => void;
	onExplore: (result: LocalSearchResult) => void;
};

function SearchResultCard({ result, serviceReady, onOpen, onExplore }: SearchResultCardProps) {
	const [isExploreHovered, setIsExploreHovered] = useState(false);
	const exploreButtonOpacity = serviceReady ? (isExploreHovered ? 1 : 0.5) : 0.3;

	return (
		<Card
			className="relative hover:bg-[#f5f5f5] cursor-pointer"
			onClick={() => {
				if (result.path) {
					onOpen(result.path);
				}
			}}
		>
			<button
				type="button"
				title="继续探索"
				aria-label="继续探索"
				disabled={!serviceReady}
				style={{
					WebkitAppearance: "none",
					alignItems: "center",
					backgroundColor: "#ffffff",
					border: "1px solid #e5e5e5",
					borderRadius: "50%",
					boxSizing: "border-box",
					boxShadow: "0 1px 3px rgba(0, 0, 0, 0.14)",
					color: "#222222",
					cursor: serviceReady ? "pointer" : "not-allowed",
					display: "inline-flex",
					flex: "0 0 24px",
					height: "24px",
					justifyContent: "center",
					lineHeight: 0,
					margin: 0,
					maxHeight: "24px",
					maxWidth: "24px",
					minHeight: "24px",
					minWidth: "24px",
					opacity: exploreButtonOpacity,
					outline: "none",
					padding: 0,
					position: "absolute",
					right: "8px",
					top: "8px",
					transform: "none",
					transition: "opacity 120ms ease, background-color 120ms ease, box-shadow 120ms ease",
					width: "24px",
					zIndex: 10,
				}}
				onFocus={() => setIsExploreHovered(true)}
				onBlur={() => setIsExploreHovered(false)}
				onMouseEnter={() => setIsExploreHovered(true)}
				onMouseLeave={() => setIsExploreHovered(false)}
				onPointerEnter={() => setIsExploreHovered(true)}
				onPointerLeave={() => setIsExploreHovered(false)}
				onMouseDown={(event) => {
					event.stopPropagation();
				}}
				onPointerDown={(event) => {
					event.stopPropagation();
				}}
				onClick={(event) => {
					event.stopPropagation();
					onExplore(result);
				}}
			>
				<Shuffle style={{ display: "block", width: "13px", height: "13px", flexShrink: 0 }} />
			</button>
			<CardHeader className="py-2.5 pl-3" style={{ paddingRight: "40px" }}>
				<CardTitle className="text-sm truncate m-0 flex items-center gap-1.5">
					<FileText className="w-4 h-4 shrink-0 text-[#444444]" />
					<span className="truncate">{result.title}</span>
				</CardTitle>
			</CardHeader>
			<CardContent className="px-3 pb-2.5 pt-0">
					<div className="text-[#444444] card-content-clamp whitespace-pre-wrap break-all text-sm leading-5">
						{result.content}
					</div>
				</CardContent>
			</Card>
	);
}

// @ts-ignore
export const SmartConnection = ({ activeFile }) => {
	const [tabs, setTabs] = useState<SearchTab[]>(() => [createDefaultSearchTab(createTabId())]);
	const [activeTabId, setActiveTabId] = useState<string>(() => "");
	const [serviceState, setServiceState] = useState<ServiceState>({ ...searchInstance.state })
	const [, setLocaleVersion] = useState(0)
	// @ts-ignore
	const { workspace } = useApp()
	const serviceReady = serviceState.status === "ready";
	const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0];

	useEffect(() => {
		setActiveTabId((current) => current || tabs[0]?.id || "");
	}, [tabs]);

	const updateTab = (tabId: string, updater: (tab: SearchTab) => SearchTab) => {
		setTabs((currentTabs) => currentTabs.map((tab) => tab.id === tabId ? updater(tab) : tab));
	};

	const getSearchCacheKey = (
		query: string,
		topK: number,
		excludePaths: string[]
	): SearchResultCacheKey | null => {
		const trimmedQuery = query.trim();
		if (trimmedQuery === "" && activeFile) {
			return {
				mode: "document",
				path: activeFile.path,
				mtime: activeFile.stat?.mtime,
				topK,
				model: serviceState.activeModel,
				excludePaths,
			};
		}
		if (trimmedQuery !== "") {
			return {
				mode: "query",
				query: trimmedQuery,
				activePath: activeFile?.path,
				mtime: activeFile?.stat?.mtime,
				topK,
				model: serviceState.activeModel,
				excludePaths,
			};
		}
		return null;
	}

	const performSearchForTab = async (
		tabId: string,
		query: string,
		excludePaths: string[],
		titleText?: string
	) => {
		if (!searchInstance.localSearch) {
			console.error(`${SEARCH_LOG_PREFIX} failed`, {
				mode: "unavailable",
				reason: "Local search not initialized",
			});
			new Notice("Local search not initialized yet.");
			return;
		}

		const trimmedQuery = query.trim();
		const mode: SearchMode = trimmedQuery === "" && activeFile ? "document" : "query";
		if (trimmedQuery === "" && !activeFile) {
			updateTab(tabId, (tab) => ({
				...tab,
				results: [],
				documentQueryText: "",
				isLoading: false,
			}));
			console.log(`${SEARCH_LOG_PREFIX} skipped`, {
				mode: "empty-query",
				reason: "No active file and no query text",
			});
			return;
		}

		const cacheKey = getSearchCacheKey(query, DEFAULT_TOP_K, excludePaths);
		const cachedEntry = cacheKey ? searchResultCache.get(cacheKey) : null;
		if (cachedEntry) {
			updateTab(tabId, (tab) => ({
				...tab,
				title: mode === "document"
					? createTabTitle(titleText || activeFile?.basename || activeFile?.name || activeFile?.path || "", tab.title)
					: createTabTitle(trimmedQuery, tab.title),
				query,
				results: cachedEntry.results,
				documentQueryText: mode === "document" ? cachedEntry.queryText || "" : "",
				isLoading: false,
				excludedPaths: excludePaths,
				source: mode === "document" ? { type: "document", sourcePath: activeFile?.path } : tab.source,
			}));
			console.log(`${SEARCH_LOG_PREFIX} cache-hit`, mode === "document"
				? { mode, path: activeFile.path, resultCount: cachedEntry.results.length }
				: { mode, query: compactSearchText(trimmedQuery), resultCount: cachedEntry.results.length }
			);
			return;
		}

		console.log(`${SEARCH_LOG_PREFIX} start`, mode === "document"
			? { mode, path: activeFile.path, excludeCount: excludePaths.length }
			: { mode, query: compactSearchText(trimmedQuery), excludeCount: excludePaths.length }
		);

		updateTab(tabId, (tab) => ({
			...tab,
			query,
			isLoading: true,
			excludedPaths: excludePaths,
			title: mode === "document"
				? createTabTitle(titleText || activeFile?.basename || activeFile?.name || activeFile?.path || "", tab.title)
				: createTabTitle(trimmedQuery, tab.title),
			source: mode === "document" ? { type: "document", sourcePath: activeFile?.path } : tab.source,
		}));

		try {
			let results: LocalSearchResult[];
			let queryText = "";
			if (mode === "document" && activeFile) {
				const response = await searchInstance.localSearch.searchByDocumentWithQueryText(
					activeFile,
					DEFAULT_TOP_K,
					{ excludePaths }
				);
				results = response.results;
				queryText = response.queryText || "";
			} else {
				results = await searchInstance.localSearch.searchByQuery(
					trimmedQuery,
					DEFAULT_TOP_K,
					{ excludePaths }
				);
			}
			if (activeFile) {
				results = results.filter((result) => result.path !== activeFile.path);
			}
			if (cacheKey) {
				searchResultCache.set(cacheKey, { results, queryText });
			}
			updateTab(tabId, (tab) => ({
				...tab,
				documentQueryText: mode === "document" ? queryText : "",
				results,
				isLoading: false,
			}));
			console.log(`${SEARCH_LOG_PREFIX} success`, {
				mode,
				resultCount: results.length,
				paths: results.slice(0, 5).map((result) => result.path).filter(Boolean),
			});
		} catch (err) {
			console.error(`${SEARCH_LOG_PREFIX} failed`, {
				mode,
				error: (err as Error).message || String(err),
			});
			updateTab(tabId, (tab) => ({ ...tab, isLoading: false }));
			new Notice("Local search failed. Ensure ChromaDB is running.")
		}
	}

	const createManualTab = () => {
		if (!canCreateSearchTab(tabs)) {
			new Notice(`最多只能打开 ${MAX_SEARCH_TABS} 个标签页`);
			return;
		}
		const nextTab = createEmptySearchTab(createTabId());
		setTabs((currentTabs) => [...currentTabs, nextTab]);
		setActiveTabId(nextTab.id);
	};

	const closeTab = (tabId: string) => {
		const fallbackTabId = createTabId();
		const nextState = closeSearchTab(
			tabs,
			tabId,
			activeTab?.id || activeTabId,
			createDefaultSearchTab,
			fallbackTabId
		);
		setTabs(nextState.tabs);
		setActiveTabId(nextState.activeTabId);
	};

	const exploreResult = (result: LocalSearchResult) => {
		if (!serviceReady) {
			new Notice("本地搜索不可用");
			return;
		}
		if (!activeTab) return;
		if (!canCreateSearchTab(tabs)) {
			new Notice(`最多只能打开 ${MAX_SEARCH_TABS} 个标签页`);
			return;
		}
		const nextTab = createDerivedSearchTab(createTabId(), activeTab, result);
		setTabs((currentTabs) => [...currentTabs, nextTab]);
		setActiveTabId(nextTab.id);
		performSearchForTab(nextTab.id, nextTab.query, nextTab.excludedPaths);
	};

	useEffect(() => {
		return subscribeServiceState((state) => {
			setServiceState(state);
		});
	}, []);

	useEffect(() => {
		return onLocaleChange(() => {
			setLocaleVersion((version) => version + 1);
		});
	}, []);

	const statusMsg = getServiceStatusMessage(serviceState);

	return (
		<div className="px-2 animate-fade-in-up">
			{statusMsg && (
				<div className="mb-2 text-xs text-[#e74c3c] bg-[#fff5f5] p-2 rounded-md">
					{statusMsg}
				</div>
			)}
			<SearchTabBar
				tabs={tabs}
				activeTabId={activeTab?.id || ""}
				onSelectTab={setActiveTabId}
				onCreateTab={createManualTab}
				onCloseTab={closeTab}
			/>
			{activeTab && (
				<SearchPanel
					tab={activeTab}
					activeFile={activeFile}
					serviceReady={serviceReady}
					onQueryChange={(value) => updateTab(activeTab.id, (tab) => ({ ...tab, query: value }))}
					onSearch={(query) => performSearchForTab(activeTab.id, query, activeTab.excludedPaths)}
					onOpenResult={(path) => workspace.openLinkText(path, "", true)}
					onExploreResult={exploreResult}
				/>
			)}
		</div>
	)
}
