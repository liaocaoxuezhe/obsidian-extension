const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");

async function loadModule(entry) {
  const source = path.join(__dirname, "..", "src", "diagnostics", entry);
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    external: ["obsidian"],
  });
  const module = { exports: {} };
  const fn = new Function("module", "exports", "require", result.outputFiles[0].text);
  fn(module, module.exports, require);
  return module.exports;
}

(async () => {
  const { createRedactor, generateReportSalt } = await loadModule("diagnostic-redaction.ts");

  const redactor = createRedactor({
    vaultPath: "/Users/alice/Vault",
    salt: generateReportSalt(),
  });

  // Path redaction
  const text = "Error reading /Users/alice/Vault/Project/secret.md";
  const redacted = redactor.redactString(text);
  assert(!redacted.includes("/Users/alice/Vault"), "vault path should be redacted");
  assert(!redacted.includes("secret.md"), "file name should be redacted");
  assert(redacted.includes("<vault-path>"), "should contain vault-path marker");

  // macOS user home
  const macText = "file:///Users/bob/Documents/note.md";
  const macRedacted = redactor.redactString(macText);
  assert(!macRedacted.includes("/Users/bob"), "macOS user dir should be redacted");

  // Windows user home
  const winText = "C:\\Users\\alice\\Notes\\secret.md";
  const winRedacted = redactor.redactString(winText);
  assert(!winRedacted.includes("C:\\Users\\alice"), "Windows user dir should be redacted");
  assert(winRedacted.includes("<user-home>"), "should contain user-home marker");

  // License key
  const licenseText = "Authorization failed for ANALOGY-PRO-1234567890";
  const licenseRedacted = redactor.redactString(licenseText);
  assert(!licenseRedacted.includes("ANALOGY-PRO-1234567890"), "license key should be redacted");
  assert(licenseRedacted.includes("<license-key>"), "should contain license marker");

  // Email
  const emailText = "contact user@example.com please";
  const emailRedacted = redactor.redactString(emailText);
  assert(!emailRedacted.includes("user@example.com"), "email should be redacted");

  // Bearer token
  const bearerText = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
  const bearerRedacted = redactor.redactString(bearerText);
  assert(!bearerRedacted.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), "bearer token should be redacted");

  // Context redaction
  const ctx = { vaultPath: "/Users/alice/Vault", count: 3, ok: true };
  const redactedCtx = redactor.redactContext(ctx);
  assert(!redactedCtx.vaultPath.includes("/Users/alice"), "context vault path should be redacted");
  assert.strictEqual(redactedCtx.count, 3, "numeric context should be preserved");
  assert.strictEqual(redactedCtx.ok, true, "boolean context should be preserved");

  // Same file should produce same hash within one report (for correlation only)
  const hash1 = redactor.fileHash("Project/secret.md");
  const hash2 = redactor.fileHash("Project/secret.md");
  assert.strictEqual(hash1, hash2, "same file should produce same report-level hash");

  // Different salt should produce different hash
  const redactor2 = createRedactor({ vaultPath: "/Users/alice/Vault" });
  const hash3 = redactor2.fileHash("Project/secret.md");
  assert.notStrictEqual(hash1, hash3, "different salt should produce different hash");

  const locallyRedacted = redactor.redactString(
    "Error reading /Users/alice/Vault/Project/secret.md",
  );
  const reportRedactor1 = createRedactor({ salt: "report-one" });
  const reportRedactor2 = createRedactor({ salt: "report-two" });
  const reportFileId1 = reportRedactor1.redactString(locallyRedacted);
  const reportFileId2 = reportRedactor2.redactString(locallyRedacted);
  assert.notStrictEqual(
    reportFileId1,
    reportFileId2,
    "already-anonymous local file IDs must be re-salted per report",
  );

  console.log("Diagnostic redaction tests passed");
})();
