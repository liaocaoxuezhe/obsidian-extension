import { TFile, type App, type EventRef } from "obsidian";
import { bumpIndexRevision, getIndexRevision } from "../local-vector/search-instance";
import { isMarkdownPath } from "./markdown-file";

export { isMarkdownPath } from "./markdown-file";

export type FileValidity = "valid" | "stale" | "missing";

export interface CurrentMarkdownDocument {
  path: string;
  mtime: number;
}

export interface SemanticWalkFileBridge {
  getCurrentDocument(): CurrentMarkdownDocument | null;
  getFileValidity(path: string, indexedMtime: number): FileValidity;
  getIndexRevision(): number;
  subscribe(listener: () => void): () => void;
  openDocument(path: string): Promise<boolean>;
}

function markdownDocument(file: unknown): CurrentMarkdownDocument | null {
  if (!(file instanceof TFile) || !isMarkdownPath(file.path)) return null;
  return { path: file.path, mtime: file.stat.mtime };
}

export class ObsidianSemanticWalkFileBridge implements SemanticWalkFileBridge {
  private readonly listeners = new Set<() => void>();
  private eventRefs: Array<{ source: { offref(ref: EventRef): void }; ref: EventRef }> = [];

  constructor(private readonly app: Pick<App, "workspace" | "vault">) {}

  getCurrentDocument(): CurrentMarkdownDocument | null {
    return markdownDocument(this.app.workspace.getActiveFile());
  }

  getFileValidity(path: string, indexedMtime: number): FileValidity {
    const document = markdownDocument(this.app.vault.getAbstractFileByPath(path));
    if (!document) return "missing";
    return indexedMtime > 0 && document.mtime === indexedMtime ? "valid" : "stale";
  }

  getIndexRevision(): number {
    return getIndexRevision();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    listener();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  async openDocument(path: string): Promise<boolean> {
    if (this.getFileValidity(path, markdownDocument(this.app.vault.getAbstractFileByPath(path))?.mtime ?? 0) === "missing") {
      return false;
    }
    await this.app.workspace.openLinkText(path, "", false);
    return true;
  }

  dispose(): void {
    this.listeners.clear();
    this.stop();
  }

  private start(): void {
    const workspace = this.app.workspace as any;
    const vault = this.app.vault as any;
    this.track(workspace, workspace.on("file-open", () => this.notify(false)));
    this.track(workspace, workspace.on("active-leaf-change", () => this.notify(false)));
    this.track(vault, vault.on("modify", (file: unknown) => {
      if (markdownDocument(file)) this.notify(true);
    }));
    this.track(vault, vault.on("rename", (file: unknown, oldPath: string) => {
      if (markdownDocument(file) || isMarkdownPath(oldPath)) this.notify(true);
    }));
    this.track(vault, vault.on("delete", (file: unknown) => {
      if (markdownDocument(file)) this.notify(true);
    }));
  }

  private track(source: { offref(ref: EventRef): void }, ref: EventRef): void {
    this.eventRefs.push({ source, ref });
  }

  private stop(): void {
    for (const { source, ref } of this.eventRefs) source.offref(ref);
    this.eventRefs = [];
  }

  private notify(indexChanged: boolean): void {
    if (indexChanged) bumpIndexRevision();
    for (const listener of this.listeners) listener();
  }
}
