const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");

async function loadModule(requestUrl) {
  const source = path.join(__dirname, "..", "src", "license", "license-api.ts");
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["obsidian"],
    write: false,
  });
  const module = { exports: {} };
  const fn = new Function("module", "exports", "require", result.outputFiles[0].text);
  fn(module, module.exports, (specifier) => specifier === "obsidian" ? {requestUrl} : require(specifier));
  return module.exports;
}

(async () => {
  const calls = [];
  const requestUrl = async (options) => {
    calls.push(options);
    if (options.url.endsWith("/validate")) {
      return {
        status: 200,
        json: {
          code: 0,
          data: {
            status: "active",
            plan: "personal_lifetime",
            max_pages: 60000,
            expires_at: null,
            validated_at: "2026-06-08T00:00:00.000Z",
            grace_days: 14,
          },
        },
      };
    }
    return {status: 200, json: {code: 0, data: {status: "deactivated", deactivated: true}}};
  };
  const {
    LICENSE_REFRESH_INTERVAL_DAYS,
    deactivateLicense,
    mapValidationResponseToLicenseState,
    refreshCachedLicense,
    shouldRefreshLicense,
  } = await loadModule(requestUrl);
  const now = new Date("2026-06-01T00:00:00.000Z");
  const state = mapValidationResponseToLicenseState({
    code: 0,
    data: {
      status: "active",
      plan: "personal_lifetime",
      max_pages: 500000,
      expires_at: null,
      validated_at: "2026-06-01T00:00:00.000Z",
      grace_days: 14,
    },
  }, "ANALOGY-1234-5678-9K2Q", now);

  assert.strictEqual(state.status, "active");
  assert.strictEqual(state.plan, "personal_lifetime");
  assert.strictEqual(state.maxPages, 500000);
  assert.strictEqual(state.expiresAt, null);
  assert.strictEqual(state.validatedAt, "2026-06-01T00:00:00.000Z");
  assert.strictEqual(state.graceUntil, "2026-06-15T00:00:00.000Z");
  assert.strictEqual(state.licenseKeyMasked, "ANALOGY-****-9K2Q");
  assert.strictEqual(state.licenseKey, "ANALOGY-1234-5678-9K2Q");

  const inactive = mapValidationResponseToLicenseState({
    code: 4001,
    message: "License is invalid or inactive",
  }, "BAD-KEY", now);

  assert.strictEqual(inactive.status, "inactive");
  assert.strictEqual(inactive.plan, "free");
  assert.strictEqual(inactive.maxPages, 2500);
  assert.strictEqual(inactive.licenseKey, "BAD-KEY");
  assert.strictEqual(inactive.errorCode, 4001);
  assert.strictEqual(state.errorCode, undefined);

  // 4003：服务端 data.status 仍是 active（license 本身有效），本设备不能被视为已激活
  const activationLimited = mapValidationResponseToLicenseState({
    code: 4003,
    message: "License activation limit exceeded",
    data: {status: "active", plan: "free", max_pages: 2500, grace_days: 0},
  }, "ANALOGY-1234-5678-9K2Q", now);
  assert.strictEqual(activationLimited.status, "inactive");
  assert.strictEqual(activationLimited.plan, "free");
  assert.strictEqual(activationLimited.maxPages, 2500);
  assert.strictEqual(activationLimited.errorCode, 4003);

  const redemptionLimited = mapValidationResponseToLicenseState({
    code: 4009,
    message: "License redemption limit exceeded",
    data: {status: "inactive", plan: "free", max_pages: 2500, grace_days: 0},
  }, "ANALOGY-1234-5678-9K2Q", now);
  assert.strictEqual(redemptionLimited.status, "inactive");
  assert.strictEqual(redemptionLimited.errorCode, 4009);
  assert.strictEqual(redemptionLimited.licenseKeyMasked, "ANALOGY-****-9K2Q");

  const revoked = mapValidationResponseToLicenseState({
    code: 4002,
    data: {status: "revoked", plan: "free"},
  }, "ANALOGY-1234-5678-9K2Q", now);
  assert.strictEqual(revoked.status, "revoked");
  assert.strictEqual(revoked.errorCode, 4002);

  const {getLicenseErrorReason} = await loadModule(requestUrl);
  const reasons = {4001: "invalid", 4002: "revoked", 4003: "activationLimit", 4004: "expired", 4009: "redemptionLimit"};
  for (const [code, reason] of Object.entries(reasons)) {
    assert.strictEqual(getLicenseErrorReason(Number(code)), reason);
  }
  assert.strictEqual(getLicenseErrorReason(4999), "unknown");
  assert.strictEqual(getLicenseErrorReason(undefined), "unknown");
  const i18nSource = require("fs").readFileSync(path.join(__dirname, "..", "src", "util", "i18n.ts"), "utf8");
  for (const reason of [...Object.values(reasons), "unknown"]) {
    assert(i18nSource.includes(`"settings.license.error.${reason}"`), `missing i18n key for ${reason}`);
  }

  assert.strictEqual(LICENSE_REFRESH_INTERVAL_DAYS, 7);
  assert.strictEqual(shouldRefreshLicense({
    ...state,
    validatedAt: "2026-06-01T00:00:00.000Z",
  }, new Date("2026-06-07T23:59:59.000Z")), false);
  assert.strictEqual(shouldRefreshLicense({
    ...state,
    validatedAt: "2026-06-01T00:00:00.000Z",
  }, new Date("2026-06-08T00:00:00.000Z")), true);
  assert.strictEqual(shouldRefreshLicense({
    ...state,
    licenseKey: undefined,
    validatedAt: "2026-06-01T00:00:00.000Z",
  }, new Date("2026-06-08T00:00:00.000Z")), false);

  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error("global fetch must not be used for License API requests"); };
  const refreshed = await refreshCachedLicense("https://license.example.com/", {
    ...state,
    validatedAt: "2026-06-01T00:00:00.000Z",
  }, {
    deviceId: "device-1",
    vaultId: "vault-1",
    pluginVersion: "1.0.0",
  }, new Date("2026-06-08T00:00:00.000Z"));
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, "https://license.example.com/api/v1/obsidian/license/validate");
  assert.strictEqual(calls[0].method, "POST");
  assert.strictEqual(calls[0].throw, false);
  assert.strictEqual(calls[0].headers["Content-Type"], "application/json");
  assert.strictEqual(JSON.parse(calls[0].body).license_key, "ANALOGY-1234-5678-9K2Q");
  assert.strictEqual(refreshed.maxPages, 60000);
  assert.strictEqual(refreshed.licenseKey, "ANALOGY-1234-5678-9K2Q");

  const offlineModule = await loadModule(async () => { throw new Error("offline"); });
  const preserved = await offlineModule.refreshCachedLicense("https://license.example.com", {
    ...state,
    validatedAt: "2026-06-01T00:00:00.000Z",
  }, {
    deviceId: "device-1",
    vaultId: "vault-1",
    pluginVersion: "1.0.0",
  }, new Date("2026-06-08T00:00:00.000Z"));
  assert.deepStrictEqual(preserved, {
    ...state,
    validatedAt: "2026-06-01T00:00:00.000Z",
  });

  const deactivated = await deactivateLicense("https://license.example.com/", {
    licenseKey: "ANALOGY-1234-5678-9K2Q",
    deviceId: "device-1",
    vaultId: "vault-1",
  });
  assert.strictEqual(deactivated, true);
  assert.strictEqual(calls[calls.length - 1].url, "https://license.example.com/api/v1/obsidian/license/deactivate");
  assert.strictEqual(calls[calls.length - 1].throw, false);
  assert.deepStrictEqual(JSON.parse(calls[calls.length - 1].body), {
    license_key: "ANALOGY-1234-5678-9K2Q",
    device_id: "device-1",
    vault_id: "vault-1",
  });

  const httpErrorCalls = [];
  const httpErrorModule = await loadModule(async (options) => {
    httpErrorCalls.push(options);
    return {status: options.url.endsWith("/validate") ? 503 : 429, json: {code: 5000}};
  });
  await assert.rejects(() => httpErrorModule.validateLicense("https://license.example.com", {
    licenseKey: "ANALOGY-1234-5678-9K2Q",
    deviceId: "device-1",
    vaultId: "vault-1",
    pluginVersion: "1.2.6",
  }), /License validation failed: HTTP 503/);
  await assert.rejects(() => httpErrorModule.deactivateLicense("https://license.example.com", {
    licenseKey: "ANALOGY-1234-5678-9K2Q",
    deviceId: "device-1",
    vaultId: "vault-1",
  }), /License deactivation failed: HTTP 429/);
  assert.deepStrictEqual(httpErrorCalls.map((call) => call.throw), [false, false]);

  global.fetch = originalFetch;

  console.log("License API tests passed");
})();
