import { StrictMode } from 'react';
import { ItemView, WorkspaceLeaf } from 'obsidian';
import { Root, createRoot } from 'react-dom/client';
import { AppContext } from './model/AppContext';
import { HomeView } from './HomeView';
import { AnalogyErrorBoundary } from './diagnostics/AnalogyErrorBoundary';
import { getDiagnosticRecorder } from './diagnostics/diagnostic-instance';

export const VIEW_TYPE_INDEX = 'analogy-view';

export class IndexView extends ItemView {
	root: Root | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType() {
		return VIEW_TYPE_INDEX;
	}

	getDisplayText() {
		return 'Analogy View';
	}

	getIcon() {
		return 'analogy-icon';
	}

	async onOpen() {
		const recorder = getDiagnosticRecorder();
		this.root = createRoot(this.containerEl.children[1]);
		this.root.render(
			<StrictMode>
				<AnalogyErrorBoundary
					recorder={recorder || ({ captureException: () => {} } as any)}
					viewName="IndexView"
					onCopyReport={() => {
						const snapshot = recorder?.getSnapshot();
						if (!snapshot) return;
						navigator.clipboard
							.writeText(JSON.stringify(snapshot, null, 2))
							.catch((error) => console.error("[Analogy] Failed to copy diagnostics", error));
					}}
					onReload={() => {
						this.root?.unmount();
						this.onOpen();
					}}
					onOpenSettings={() => {
						// @ts-ignore
						this.app.setting?.openTabById?.("analogy-rag-in-your-vault");
					}}
					onSendReport={() => {
						// @ts-ignore
						this.app.setting?.openTabById?.("analogy-rag-in-your-vault");
					}}
				>
					<AppContext.Provider value={this.app}>
						<HomeView main={this}/>
					</AppContext.Provider>
				</AnalogyErrorBoundary>
			</StrictMode>
		);
	}

	async onClose() {
		this.root?.unmount();
	}
}
