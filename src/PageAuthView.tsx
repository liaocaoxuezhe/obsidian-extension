import * as React from "react";
import {useEffect, useState} from "react";
import {Checkbox} from "./components/checkbox";
import {ScrollArea} from "./components/scroll-area";
import {Button} from "./components/button";
import {Badge} from "./components/badge";
import {useApp} from "./model/AppContext";
import {BuildPageId, PageAuthItem} from "./model/PageAuthList";
import {TFile} from "obsidian";
import {searchInstance} from "./local-vector/search-instance";
import {
	countSelectedMarkdownPagesFromMap,
	getCurrentPageLimit,
	getPageLimitUpgradePrompt,
	getPageLimitViolation,
	type PageLimitUpgradePrompt,
} from "./license/license-limits";
import {loadLicenseState} from "./license/license-store";

const SELECTION_KEY = "analogy_index_selection";
const PLUGIN_ID = "analogy-rag-in-your-vault";

export function GetVaultName():string {
	// @ts-ignore
	const {vault} = useApp()
	const winPathParts = vault.adapter.basePath.split("\\")
	if (winPathParts && winPathParts.length > 0) {
		return winPathParts[winPathParts.length-1]
	}
	const macPathParts = vault.adapter.basePath.split("/")
	if (macPathParts && macPathParts.length > 0) {
		return macPathParts[macPathParts.length-1]
	}
	return ""
}

// @ts-ignore
export function PageAuthCheckboxList({setLoginStatus, setIsLoginFinished, setUser}) {
	// @ts-ignore
	const app = useApp()
	// @ts-ignore
	const {vault} = app
	const fileMap:Map<string, TFile> = new Map(Object.entries(vault.fileMap))
	const fileTypeMap:Map<string, any> =  new Map(Object.entries(vault.adapter.files))
	const [pageAuthList, setPageAuthList] = useState<PageAuthItem[]>([])
	const [pageAuthMap, setPageAuthMap] = useState<Map<string, PageAuthItem>>(new Map())
	const [indexStatuses, setIndexStatuses] = useState<Map<string, string>>(new Map())
	const [isIndexing, setIsIndexing] = useState(false)
	const [indexedCount, setIndexedCount] = useState(0)
	const [indexProgress, setIndexProgress] = useState({ current: 0, total: 0 })
	const [upgradePrompt, setUpgradePrompt] = useState<PageLimitUpgradePrompt | null>(null)
	const vaultName = GetVaultName()

	function getBuyLicenseUrl(): string {
		return ((app as any).plugins?.plugins?.[PLUGIN_ID]?.settings?.buyLicenseUrl || "").trim();
	}

	function showUpgradePrompt(selectedCount: number, limit: number) {
		setUpgradePrompt(getPageLimitUpgradePrompt(selectedCount, limit, getBuyLicenseUrl()));
	}

	function handleFile(rootFile:TFile, pageMap:Map<string, PageAuthItem>) : PageAuthItem {
		const file = fileMap.get(rootFile.path)
		const fileType = fileTypeMap.get(rootFile.path)
		let pageItem = {
			id: BuildPageId(file?.path, fileType.ctime),
			isChecked: false,
			children: new Array<PageAuthItem>(),
			name: file?.name,
			path: file?.path,
			type: fileType.type,
			isSync: false,
			vaultName: vaultName,
			createAt: fileType.ctime,
			updateAt: fileType.mtime
		}
		// @ts-ignore
		if (rootFile && rootFile.children) {
			// @ts-ignore
			const children:TFile[] = Object.values(rootFile.children)
			for (let i = 0; i < children.length; i++) {
				pageItem.children.push(handleFile(children[i], pageMap))
			}
		}
		// @ts-ignore
		pageMap.set(pageItem.id, pageItem)
		// @ts-ignore
		return pageItem
	}

	function loadPersistedSelection(pageMap: Map<string, PageAuthItem>) {
		try {
			const raw = localStorage.getItem(SELECTION_KEY);
			if (!raw) return;
			const selectedIds: string[] = JSON.parse(raw);
			for (const id of selectedIds) {
				const item = pageMap.get(id);
				if (item) item.isChecked = true;
			}
		} catch {
			// ignore
		}
	}

	function persistSelection(pageMap: Map<string, PageAuthItem>) {
		const selectedIds: string[] = [];
		pageMap.forEach((item) => {
			if (item.isChecked) selectedIds.push(item.id);
		});
		localStorage.setItem(SELECTION_KEY, JSON.stringify(selectedIds));
	}

	function initPageAuthList() {
		let pageMap:Map<string, PageAuthItem> = new Map()
		const rootFile = fileMap.get("/")
		// @ts-ignore
		let basePage = handleFile(rootFile, pageMap)
		basePage.name = vaultName
		loadPersistedSelection(pageMap);
		setPageAuthMap(pageMap)
		setPageAuthList([basePage])
		return
	}

	// 处理父item的选中状态变化
	function handleSelected(newPageAuthMap:Map<string, PageAuthItem>, selectedId:string, isChecked:boolean) {
		let selectedItem = newPageAuthMap.get(selectedId)
		if (!selectedItem) {
			return newPageAuthMap
		}
		selectedItem.isChecked = isChecked
		if (selectedItem && selectedItem.children) {
			selectedItem.children.forEach(child => {
				handleSelected(newPageAuthMap, child.id, isChecked)
			})
		}
		return newPageAuthMap
	}

	async function refreshIndexStatuses() {
		if (!searchInstance.documentIndexer) return;
		const statuses = new Map<string, string>();
		let count = 0;
		for (const [id, item] of pageAuthMap) {
			if (item.type === "file" && item.path) {
				const file = fileMap.get(item.path);
				if (file) {
					const status = await searchInstance.documentIndexer.getIndexedStatus(file);
					statuses.set(id, status);
					if (status === "indexed") count++;
				}
			}
		}
		setIndexStatuses(statuses);
		setIndexedCount(count);
	}

	async function submitAuthPageList() {
		if (!searchInstance.documentIndexer) {
			alert("Local indexer not initialized");
			return;
		}
		const pageLimit = getCurrentPageLimit(loadLicenseState());
		const selectedMarkdownCount = countSelectedMarkdownPagesFromMap(pageAuthMap);
		const violation = getPageLimitViolation(selectedMarkdownCount, pageLimit);
		if (violation) {
			showUpgradePrompt(violation.selectedCount, violation.limit);
			return;
		}
		let selectedItemList:PageAuthItem[] = []
		pageAuthMap.forEach((val, _) => {
			if (val.type === "file" && val.path?.toLowerCase().endsWith(".md")) {
				if (val.isChecked) {
					selectedItemList.push(val)
				}
			}
		})

		setIsIndexing(true);
		setIndexProgress({ current: 0, total: selectedItemList.length });
		try {
			const files: TFile[] = [];
			for (const item of selectedItemList) {
				const file = fileMap.get(item.path);
				if (file) files.push(file);
			}
			// Custom rebuild with progress callback
			const indexer = searchInstance.documentIndexer;
			for (let i = 0; i < files.length; i++) {
				const file = files[i];
				if (file.extension !== "md") continue;
				try {
					await indexer.indexDocument(file);
				} catch (err) {
					console.error(`[Analogy] Index error for ${file.path}:`, err);
				}
				setIndexProgress({ current: i + 1, total: files.length });
				if (i % 10 === 0) {
					await new Promise((r) => setTimeout(r, 0));
				}
			}
			await indexer.saveState();
			await refreshIndexStatuses();
			// @ts-ignore
			if (setIsLoginFinished) setIsLoginFinished(true);
			if (setLoginStatus) setLoginStatus("login_finished");
		} catch (err) {
			console.error("[Analogy] Index build error:", err);
			alert("Index build failed: " + (err as Error).message);
		} finally {
			setIsIndexing(false);
			setIndexProgress({ current: 0, total: 0 });
		}
	}

	useEffect(() => {
		initPageAuthList()
	}, []);

	useEffect(() => {
		if (pageAuthMap.size > 0) {
			refreshIndexStatuses();
		}
	}, [pageAuthMap.size]);

	useEffect(() => {
		if (pageAuthMap.size === 0) return;
		const interval = setInterval(() => {
			if (searchInstance.documentIndexer) {
				refreshIndexStatuses();
			}
		}, 3000);
		return () => clearInterval(interval);
	}, [pageAuthMap.size]);

	function getStatusBadge(status: string | undefined) {
		if (status === "indexed") {
			return <Badge variant="secondary" className="ml-2 text-xs bg-[#0a0a0a] text-white">Indexed</Badge>;
		}
		if (status === "pending") {
			return <Badge variant="secondary" className="ml-2 text-xs bg-[#e74c3c] text-white">Pending</Badge>;
		}
		return <Badge variant="secondary" className="ml-2 text-xs bg-[#f5f5f5] text-[#444444]">Unindexed</Badge>;
	}

	const PageCheckboxList = (items: PageAuthItem[], level = 0) => {
		return items.map((item, index) => (
			<div key={item.id} style={{ marginLeft: level == 0 ? "0" : "22px"}}>
				<div style={index === 0 ? {padding: "0"} : {padding: "3px 0"}} className="flex items-center">
					<Checkbox
						className="w-5 h-5"
						style={{padding: "0", verticalAlign: "middle"}}
						checked={pageAuthMap.get(item.id)?.isChecked}
						onCheckedChange={(checked:boolean) => {
							let newPageAuthMap = new Map<string, PageAuthItem>()
							pageAuthMap.forEach((val, key) => {
								newPageAuthMap.set(key, {...val, children: val.children})
							})
							newPageAuthMap = handleSelected(newPageAuthMap, item.id, checked)
							const pageLimit = getCurrentPageLimit(loadLicenseState());
							const selectedMarkdownCount = countSelectedMarkdownPagesFromMap(newPageAuthMap);
							const violation = getPageLimitViolation(selectedMarkdownCount, pageLimit);
							if (violation) {
								showUpgradePrompt(violation.selectedCount, violation.limit);
								return;
							}
							setUpgradePrompt(null);
							setPageAuthMap(newPageAuthMap)
							persistSelection(newPageAuthMap);
						}}
					/>
					<label
						className="align-middle text-base font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
						style={{marginLeft: "5px", verticalAlign: "middle"}}
					>
						{item.name}
					</label>
					{item.type === "file" && getStatusBadge(indexStatuses.get(item.id))}
				</div>
				{item.children && PageCheckboxList(item.children, level + 1)}
			</div>
		))
	};
	const serviceReady = searchInstance.state.status === "ready";
	const serviceError = searchInstance.state.status === "error" ? searchInstance.state.lastError : null;

	return (
		<div className="h-full">
			<div className="flex items-center justify-between mb-2">
				<span className="text-sm text-[#444444]">Indexed: {indexedCount}</span>
			</div>
			{serviceError && (
				<div className="mb-2 text-xs text-[#e74c3c] bg-[#fff5f5] p-2 rounded-md">
					{serviceError}
				</div>
			)}
			{upgradePrompt && (
				<div className="mb-2 rounded-md border border-[#f2d7d5] bg-[#fff8f7] p-3">
					<div className="whitespace-pre-line text-sm text-[#0a0a0a]">
						{upgradePrompt.message}
					</div>
					<div className="mt-2 flex items-center gap-2">
						{upgradePrompt.canOpenBuyUrl && (
							<Button
								size="sm"
								onClick={() => window.open(upgradePrompt.buyUrl, "_blank")}
							>
								Buy License
							</Button>
						)}
						<Button size="sm" variant="secondary" onClick={() => setUpgradePrompt(null)}>
							Dismiss
						</Button>
					</div>
				</div>
			)}
			<ScrollArea type="auto" style={
				{
					margin:"8px 0",
					padding: "7px",
					maxHeight:"420px",
					height: "420px",
					border: "solid",
					borderColor: "#f5f5f5",
					borderWidth: "thin",
					borderRadius: "0.5rem",
				}
			}>
				{
					PageCheckboxList(pageAuthList)
				}
			</ScrollArea>
			{isIndexing && indexProgress.total > 0 && (
				<div className="mb-2">
					<div className="w-full bg-[#f5f5f5] rounded-full h-2">
						<div
							className="bg-[#0a0a0a] h-2 rounded-full transition-all"
							style={{ width: `${Math.round((indexProgress.current / indexProgress.total) * 100)}%` }}
						/>
					</div>
					<div className="text-xs text-[#444444] mt-1 text-right">
						{indexProgress.current} / {indexProgress.total}
					</div>
				</div>
			)}
			<Button
				onClick={submitAuthPageList}
				disabled={isIndexing || !serviceReady}
				className="w-full"
			>
				{isIndexing ? "Indexing..." : serviceReady ? "Build Local Index" : "Service Unavailable"}
			</Button>
		</div>
	)
}
