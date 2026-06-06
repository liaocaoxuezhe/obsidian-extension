import type {LicenseState} from "./license-types";
import type {PageAuthItem} from "../model/PageAuthList";

export const FREE_PAGE_LIMIT = 2500;

export interface PageLimitViolation {
	selectedCount: number;
	limit: number;
}

export interface PageLimitUpgradePrompt extends PageLimitViolation {
	message: string;
	buyUrl: string;
	canOpenBuyUrl: boolean;
}

export interface IndexCapacityCandidate {
	id: string;
	countsTowardLimit: boolean;
}

export interface IndexCapacityPlan {
	allowedIds: string[];
	blockedIds: string[];
	indexedCount: number;
	limit: number;
	remainingSlots: number;
	allowedNewCount: number;
	blockedNewCount: number;
	isLimited: boolean;
}

export function getCurrentPageLimit(license: LicenseState | null | undefined, now = new Date()): number {
	if (isLicenseUsable(license, now) && typeof license?.maxPages === "number" && license.maxPages > 0) {
		return license.maxPages;
	}
	return FREE_PAGE_LIMIT;
}

export function isLicenseUsable(license: LicenseState | null | undefined, now = new Date()): boolean {
	if (license?.status !== "active") return false;
	if (isPastIsoDate(license.expiresAt, now)) return false;
	if (license.graceUntil && isPastIsoDate(license.graceUntil, now)) return false;
	return true;
}

function isPastIsoDate(value: string | null | undefined, now: Date): boolean {
	if (!value) return false;
	const time = Date.parse(value);
	if (Number.isNaN(time)) return true;
	return time < now.getTime();
}

export function countSelectedMarkdownPages(items: PageAuthItem[]): number {
	const selected = new Set<string>();
	const stack = [...items];
	while (stack.length > 0) {
		const item = stack.pop();
		if (!item) continue;
		if (item.children?.length) {
			stack.push(...item.children);
		}
		if (item.type !== "file" || !item.isChecked || !item.path) continue;
		if (item.path.toLowerCase().endsWith(".md")) {
			selected.add(item.id);
		}
	}
	return selected.size;
}

export function countSelectedMarkdownPagesFromMap(pageAuthMap: Map<string, PageAuthItem>): number {
	const selected = new Set<string>();
	pageAuthMap.forEach((item) => {
		if (item.type !== "file" || !item.isChecked || !item.path) return;
		if (item.path.toLowerCase().endsWith(".md")) {
			selected.add(item.id);
		}
	});
	return selected.size;
}

export function getPageLimitViolation(selectedCount: number, limit: number): PageLimitViolation | null {
	if (selectedCount > limit) {
		return {selectedCount, limit};
	}
	return null;
}

export function formatPageLimitMessage(selectedCount: number, limit: number): string {
	return `Free plan supports indexing up to ${limit} Markdown pages.\nYou selected ${selectedCount} pages. Upgrade Analogy Personal to index larger vaults.`;
}

export function getPageLimitUpgradePrompt(
	selectedCount: number,
	limit: number,
	buyUrl?: string
): PageLimitUpgradePrompt {
	const normalizedBuyUrl = normalizeHttpUrl(buyUrl);
	return {
		selectedCount,
		limit,
		message: formatPageLimitMessage(selectedCount, limit),
		buyUrl: normalizedBuyUrl,
		canOpenBuyUrl: Boolean(normalizedBuyUrl),
	};
}

export function getIndexCapacityPlan(input: {
	indexedCount: number;
	limit: number;
	candidates: IndexCapacityCandidate[];
}): IndexCapacityPlan {
	const indexedCount = Math.max(0, input.indexedCount);
	const limit = Math.max(0, input.limit);
	let remainingSlots = Math.max(0, limit - indexedCount);
	let allowedNewCount = 0;
	let blockedNewCount = 0;
	const allowedIds: string[] = [];
	const blockedIds: string[] = [];

	for (const candidate of input.candidates) {
		if (!candidate.countsTowardLimit) {
			allowedIds.push(candidate.id);
			continue;
		}
		if (remainingSlots > 0) {
			allowedIds.push(candidate.id);
			remainingSlots--;
			allowedNewCount++;
		} else {
			blockedIds.push(candidate.id);
			blockedNewCount++;
		}
	}

	return {
		allowedIds,
		blockedIds,
		indexedCount,
		limit,
		remainingSlots,
		allowedNewCount,
		blockedNewCount,
		isLimited: blockedIds.length > 0,
	};
}

function normalizeHttpUrl(value: string | null | undefined): string {
	const trimmed = value?.trim() ?? "";
	if (!trimmed) return "";
	return /^https?:\/\/.+/i.test(trimmed) ? trimmed : "";
}
