export type LicensePlan = "free" | "personal_lifetime" | "team" | "pro";

export type LicenseStatus = "inactive" | "active" | "revoked" | "expired";

export interface LicenseState {
	status: LicenseStatus;
	plan?: LicensePlan;
	maxPages?: number;
	expiresAt?: string | null;
	validatedAt?: string | null;
	graceUntil?: string | null;
	licenseKeyMasked?: string;
	licenseKey?: string;
	// 最近一次校验失败时服务端返回的业务码，成功后清空
	errorCode?: number;
}

export interface LicenseValidationRequest {
	licenseKey: string;
	deviceId: string;
	vaultId: string;
	pluginVersion: string;
}

export interface LicenseValidationData {
	status: LicenseStatus;
	plan: LicensePlan;
	max_pages?: number;
	maxPages?: number;
	expires_at?: string | null;
	expiresAt?: string | null;
	validated_at?: string;
	validatedAt?: string;
	grace_days?: number;
	graceDays?: number;
}

export interface LicenseValidationResponse {
	code: number;
	message?: string;
	data?: LicenseValidationData;
}
