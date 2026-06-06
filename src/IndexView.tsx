import { StrictMode } from 'react';
import { ItemView, WorkspaceLeaf } from 'obsidian';
import { Root, createRoot } from 'react-dom/client';
import { AppContext } from './model/AppContext';
import { HomeView } from './HomeView';

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
		this.root = createRoot(this.containerEl.children[1]);
		this.root.render(
			<StrictMode>
				<AppContext.Provider value={this.app}>
					<HomeView main={this}/>
				</AppContext.Provider>
			</StrictMode>
		);
	}

	async onClose() {
		this.root?.unmount();
	}
}
