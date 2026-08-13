import {appVersion} from "../model/Consts";
import {requestUrl} from "obsidian";
import type {
	LicenseState,
	LicenseValidationRequest,
	LicenseValidationResponse,
} from "./license-types";

export const DEFAULT_LICENSE_SERVER_URL = "https://analogy.zexing.club";
export const DEFAULT_BUY_LICENSE_URL = "https://analogy.zexing.club/analogy";
export const DEFAULT_MANAGE_LICENSE_URL = "https://analogy.zexing.club/analogy/account";
export const LICENSE_REFRESH_INTERVAL_DAYS = 7;

export interface CachedLicenseRefreshRequest {
	deviceId: string;
	vaultId: string;
	pluginVersion: string;
}

export interface LicenseDeactivateRequest {
	licenseKey: string;
	deviceId: string;
	vaultId: string;
}

function addDays(date: Date, days: number): string {
	const next = new Date(date.getTime());
	next.setDate(next.getDate() + days);
	return next.toISOString();
}

function maskLicenseKey(licenseKey: string): string {
	const trimmed = licenseKey.trim();
	if (trimmed.length <= 8) return "****";
	const parts = trimmed.split("-");
	if (parts.length >= 3 && parts[0]) {
		return `${parts[0]}-****-${parts[parts.length - 1]}`;
	}
	return `${trimmed.slice(0, 8)}****${trimmed.slice(-4)}`;
}

export function mapValidationResponseToLicenseState(
	response: LicenseValidationResponse,
	licenseKey: string,
	now = new Date()
): LicenseState {
	if (response.code !== 0 || !response.data || response.data.status !== "active") {
		return {
			status: response.data?.status ?? "inactive",
			plan: response.data?.plan ?? "free",
			maxPages: 2500,
			validatedAt: now.toISOString(),
			expiresAt: response.data?.expires_at ?? response.data?.expiresAt ?? null,
			graceUntil: null,
			licenseKeyMasked: maskLicenseKey(licenseKey),
			licenseKey: licenseKey.trim(),
		};
	}

	const data = response.data;
	const graceDays = data.grace_days ?? data.graceDays ?? 14;
	return {
		status: "active",
		plan: data.plan,
		maxPages: data.max_pages ?? data.maxPages ?? 2500,
		expiresAt: data.expires_at ?? data.expiresAt ?? null,
		validatedAt: data.validated_at ?? data.validatedAt ?? now.toISOString(),
		graceUntil: addDays(now, graceDays),
		licenseKeyMasked: maskLicenseKey(licenseKey),
		licenseKey: licenseKey.trim(),
	};
}

export async function validateLicense(
	serverUrl: string,
	request: LicenseValidationRequest
): Promise<LicenseState> {
	const baseUrl = serverUrl.trim().replace(/\/+$/, "");
	if (!baseUrl) {
		throw new Error("License server URL is not configured.");
	}
	const response = await requestUrl({
		url: `${baseUrl}/api/v1/obsidian/license/validate`,
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify({
			license_key: request.licenseKey,
			device_id: request.deviceId,
			vault_id: request.vaultId,
			plugin_version: request.pluginVersion || appVersion,
		}),
	});
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`License validation failed: HTTP ${response.status}`);
	}
	const data = response.json as LicenseValidationResponse;
	return mapValidationResponseToLicenseState(data, request.licenseKey);
}

export async function deactivateLicense(
	serverUrl: string,
	request: LicenseDeactivateRequest
): Promise<boolean> {
	const baseUrl = serverUrl.trim().replace(/\/+$/, "");
	if (!baseUrl) {
		throw new Error("License server URL is not configured.");
	}
	const response = await requestUrl({
		url: `${baseUrl}/api/v1/obsidian/license/deactivate`,
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify({
			license_key: request.licenseKey,
			device_id: request.deviceId,
			vault_id: request.vaultId,
		}),
	});
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`License deactivation failed: HTTP ${response.status}`);
	}
	const data = response.json as {code?: number; data?: {deactivated?: boolean}};
	if (data.code !== 0) {
		return false;
	}
	return Boolean(data.data?.deactivated);
}

export function shouldRefreshLicense(
	license: LicenseState | null | undefined,
	now = new Date()
): boolean {
	if (license?.status !== "active") return false;
	if (!license.licenseKey) return false;
	if (!license.validatedAt) return true;
	const lastValidated = Date.parse(license.validatedAt);
	if (Number.isNaN(lastValidated)) return true;
	const refreshAfterMs = LICENSE_REFRESH_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
	return now.getTime() - lastValidated >= refreshAfterMs;
}

export async function refreshCachedLicense(
	serverUrl: string,
	license: LicenseState,
	request: CachedLicenseRefreshRequest,
	now = new Date()
): Promise<LicenseState> {
	if (!shouldRefreshLicense(license, now)) return license;
	try {
		return await validateLicense(serverUrl, {
			licenseKey: license.licenseKey || "",
			deviceId: request.deviceId,
			vaultId: request.vaultId,
			pluginVersion: request.pluginVersion,
		});
	} catch {
		return license;
	}
}
