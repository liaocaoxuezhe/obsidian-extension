import { Copy, FileText } from "lucide-react"
import { useEffect, useState } from "react"
import Markdown from "markdown-to-jsx"
import { Textarea } from "./components/textarea";
import { Button } from "./components/button";
import { Loading } from "./components/loading";
import { Card, CardContent, CardHeader, CardTitle } from "./components/card";
import { Notice, TFile } from "obsidian";
import { useApp } from "./model/AppContext";
import { searchInstance, subscribeServiceState, type ServiceState } from "./local-vector/search-instance";
import { LocalSearchResult } from "./local-vector/search";
import { searchResultCache, type SearchResultCacheKey } from "./local-vector/search-result-cache";
import { onLocaleChange, t } from "./util/i18n";

const SEARCH_LOG_PREFIX = "[Analogy][Search]";

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

// @ts-ignore
export const SmartConnection = ({ activeFile }) => {
	const [searchInputValue, setSearchInputValue] = useState("")
	const [searchResults, setSearchResults] = useState<LocalSearchResult[]>([])
	const [documentQueryText, setDocumentQueryText] = useState("")
	const [isSummaryHovered, setIsSummaryHovered] = useState(false)
	const [isLoading, setIsLoading] = useState(false)
	const [serviceState, setServiceState] = useState<ServiceState>({ ...searchInstance.state })
	const [, setLocaleVersion] = useState(0)
	// @ts-ignore
	const { workspace } = useApp()
	const serviceReady = serviceState.status === "ready";

	const getSearchCacheKey = (query: string, topK: number): SearchResultCacheKey | null => {
		const trimmedQuery = query.trim();
		if (trimmedQuery === "" && activeFile) {
			return {
				mode: "document",
				path: activeFile.path,
				mtime: activeFile.stat?.mtime,
				topK,
				model: serviceState.activeModel,
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
			};
		}
		return null;
	}

	const handleSearch = (event: { keyCode: number; key: string; preventDefault: () => void; }) => {
		if (event.keyCode === 13 || event.key === "Enter") {
			event.preventDefault()
			performSearch(searchInputValue)
		}
	}

	const copyDocumentQueryText = async () => {
		if (!documentQueryText) return;
		try {
			await navigator.clipboard.writeText(documentQueryText);
			new Notice(t("common.copiedToClipboard"));
		} catch (err) {
			console.error(`${SEARCH_LOG_PREFIX} copy-query-text-failed`, err);
			new Notice("复制失败，请手动选择文本复制。");
		}
	}

	const performSearch = async (query: string) => {
		if (!searchInstance.localSearch) {
			console.error(`${SEARCH_LOG_PREFIX} failed`, {
				mode: "unavailable",
				reason: "Local search not initialized",
			});
			new Notice("Local search not initialized yet.");
			return;
		}

		const trimmedQuery = query.trim();
		const mode = trimmedQuery === "" && activeFile ? "document" : "query";
		if (trimmedQuery === "" && !activeFile) {
			setSearchResults([]);
			setDocumentQueryText("");
			console.log(`${SEARCH_LOG_PREFIX} skipped`, {
				mode: "empty-query",
				reason: "No active file and no query text",
			});
			return;
		}

		const topK = 10;
		const cacheKey = getSearchCacheKey(query, topK);
		const cachedEntry = cacheKey ? searchResultCache.get(cacheKey) : null;
		if (cachedEntry) {
			setSearchResults(cachedEntry.results);
			setDocumentQueryText(mode === "document" ? cachedEntry.queryText || "" : "");
			console.log(`${SEARCH_LOG_PREFIX} cache-hit`, mode === "document"
				? { mode, path: activeFile.path, resultCount: cachedEntry.results.length }
				: { mode, query: compactSearchText(trimmedQuery), resultCount: cachedEntry.results.length }
			);
			return;
		}

		console.log(`${SEARCH_LOG_PREFIX} start`, mode === "document"
			? { mode, path: activeFile.path }
			: { mode, query: compactSearchText(trimmedQuery) }
		);

		setIsLoading(true);
		try {
			let results: LocalSearchResult[];
			let queryText = "";
			if (mode === "document" && activeFile) {
				const response = await searchInstance.localSearch.searchByDocumentWithQueryText(activeFile, topK);
				results = response.results;
				queryText = response.queryText || "";
			} else {
				results = await searchInstance.localSearch.searchByQuery(trimmedQuery, topK);
			}
			if (activeFile) {
				results = results.filter(r => r.path !== activeFile.path);
			}
			if (cacheKey) {
				searchResultCache.set(cacheKey, { results, queryText });
			}
			setDocumentQueryText(mode === "document" ? queryText : "");
			setSearchResults(results)
			console.log(`${SEARCH_LOG_PREFIX} success`, {
				mode,
				resultCount: results.length,
				paths: results.slice(0, 5).map((r) => r.path).filter(Boolean),
			});
		} catch (err) {
			console.error(`${SEARCH_LOG_PREFIX} failed`, {
				mode,
				error: (err as Error).message || String(err),
			});
			new Notice("Local search failed. Ensure ChromaDB is running.")
		} finally {
			setIsLoading(false)
		}
	}

	useEffect(() => {
		const cacheKey = getSearchCacheKey(searchInputValue, 10);
		const cachedEntry = cacheKey ? searchResultCache.get(cacheKey) : null;
		setSearchResults(cachedEntry?.results || []);
		setDocumentQueryText(cacheKey?.mode === "document" ? cachedEntry?.queryText || "" : "");
		setIsSummaryHovered(false);
	}, [activeFile, serviceState.activeModel])

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
			<div className="relative mt-2 rounded-md">
				<Textarea
					className="analogy-textarea-autoresize resize-none pl-3 pr-14 block tracking-wide placeholder:text-[#444444] rounded-md border-[#e5e5e5] focus-visible:ring-[#0a0a0a] disabled:opacity-50 text-sm"
					placeholder={serviceReady ? "输入内容后按 Enter 搜索" : "本地搜索不可用"}
					value={searchInputValue}
					disabled={!serviceReady}
					onChange={(e) => setSearchInputValue(e.target.value)}
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
						disabled={isLoading}
						onClick={() => performSearch("")}
					>
						基于文章内容搜索
					</Button>
					{documentQueryText && (
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
									{documentQueryText}
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
				{
					isLoading ? (
						Loading("正在搜索...")
					) : (
						searchResults?.length ? (
							searchResults.map((item: any, index) => (
								<div className="pt-2" key={index}>
									<Card
										className="hover:bg-[#f5f5f5] cursor-pointer"
										onClick={() => {
											if (item.path) {
												workspace.openLinkText(item.path, "", true)
											}
										}}
									>
										<CardHeader className="py-2.5 px-3">
											<CardTitle className="text-sm truncate m-0 flex items-center gap-1.5">
												<FileText className="w-4 h-4 shrink-0 text-[#444444]" />
												<span className="truncate">{item.title}</span>
											</CardTitle>
										</CardHeader>
										<CardContent className="px-3 pb-2.5 pt-0">
											<div className="text-[#444444] card-content-clamp text-sm leading-5">
												<Markdown>{item.content}</Markdown>
											</div>
										</CardContent>
									</Card>
								</div>
							)))
							: (
								<div className="pt-7">
									<div className="flex justify-center items-center text-sm text-[#444444]">
										暂无结果
									</div>
								</div>
							)
					)
				}
			</div>
		</div>
	)
}
