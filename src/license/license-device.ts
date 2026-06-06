import {App} from "obsidian";

export const DEVICE_ID_KEY = "analogy_device_id";

export function getOrCreateDeviceId(): string {
	const existing = localStorage.getItem(DEVICE_ID_KEY);
	if (existing) return existing;
	const generated = `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	localStorage.setItem(DEVICE_ID_KEY, generated);
	return generated;
}

export function getVaultId(app: App): string {
	const basePath = (app.vault.adapter as any).basePath || "";
	let hash = 0;
	for (let i = 0; i < basePath.length; i++) {
		hash = ((hash << 5) - hash + basePath.charCodeAt(i)) | 0;
	}
	return `vault-${Math.abs(hash).toString(36)}`;
}
