import type {LicenseState} from "./license-types";

export const LICENSE_STORAGE_KEY = "analogy_license_state";

const FREE_LICENSE_STATE: LicenseState = {
	status: "inactive",
	plan: "free",
	maxPages: 1000,
	expiresAt: null,
	validatedAt: null,
	graceUntil: null,
};

function canUseLocalStorage(): boolean {
	return typeof localStorage !== "undefined";
}

export function getFreeLicenseState(): LicenseState {
	return {...FREE_LICENSE_STATE};
}

export function loadLicenseState(): LicenseState {
	if (!canUseLocalStorage()) return getFreeLicenseState();
	try {
		const raw = localStorage.getItem(LICENSE_STORAGE_KEY);
		if (!raw) return getFreeLicenseState();
		const parsed = JSON.parse(raw) as LicenseState;
		if (!parsed || typeof parsed !== "object" || typeof parsed.status !== "string") {
			return getFreeLicenseState();
		}
		return {
			...getFreeLicenseState(),
			...parsed,
		};
	} catch {
		return getFreeLicenseState();
	}
}

export function saveLicenseState(state: LicenseState): void {
	if (!canUseLocalStorage()) return;
	localStorage.setItem(LICENSE_STORAGE_KEY, JSON.stringify(state));
}

export function clearLicenseState(): void {
	if (!canUseLocalStorage()) return;
	localStorage.removeItem(LICENSE_STORAGE_KEY);
}
