"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {pathToFileURL} = require("node:url");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const contractRoot = path.join(root, "contracts", "commercial-api", "v1");

function json(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(contractRoot, relativePath), "utf8"));
}

async function validator() {
  return import(pathToFileURL(path.join(root, "scripts", "json-schema-lite.mjs")).href);
}

async function loadLicenseApi() {
  const result = await esbuild.build({
    entryPoints: [path.join(root, "src", "license", "license-api.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    external: ["obsidian"],
  });
  const module = {exports: {}};
  new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

test("public request schemas require stable snake_case fields", async () => {
  const {validateJsonSchema} = await validator();
  const validateSchema = json("license-validate.request.schema.json");
  const valid = {license_key: "ANALOGY-TEST", device_id: "device", vault_id: "vault", plugin_version: "1.2.4"};
  assert.equal(validateJsonSchema(validateSchema, valid).valid, true);
  for (const field of ["license_key", "device_id", "vault_id", "plugin_version"]) {
    const malformed = {...valid};
    delete malformed[field];
    assert.equal(validateJsonSchema(validateSchema, malformed).valid, false, `${field} must be required`);
  }
  assert.equal(validateJsonSchema(validateSchema, {...valid, deviceId: "camel-case-is-not-wire-format"}).valid, false);
});

test("client parses active, revoked, and expired v1 response fixtures", async () => {
  const {validateJsonSchema} = await validator();
  const schema = json("license-validate.response.schema.json");
  const {mapValidationResponseToLicenseState} = await loadLicenseApi();
  for (const [fixture, expectedStatus] of [
    ["license-active.json", "active"],
    ["license-revoked.json", "revoked"],
    ["license-expired.json", "expired"],
  ]) {
    const response = json(`fixtures/${fixture}`);
    assert.equal(validateJsonSchema(schema, response).valid, true, fixture);
    assert.equal(mapValidationResponseToLicenseState(response, "ANALOGY-TEST").status, expectedStatus);
  }
  const missingStableField = json("fixtures/license-active.json");
  delete missingStableField.data.grace_days;
  assert.equal(validateJsonSchema(schema, missingStableField).valid, false);
});

test("activation-limit and server errors have stable numeric codes", async () => {
  const {validateJsonSchema} = await validator();
  const schema = json("error.response.schema.json");
  for (const fixture of ["license-activation-limit.error.json", "server-error.error.json"]) {
    const response = json(`fixtures/${fixture}`);
    assert.equal(validateJsonSchema(schema, response).valid, true);
    assert.equal(Number.isInteger(response.code), true);
  }
  assert.equal(validateJsonSchema(schema, {code: "4003", message: "wrong type"}).valid, false);
});
