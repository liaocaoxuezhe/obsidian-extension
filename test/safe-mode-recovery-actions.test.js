const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.ts"), "utf8");
const settingsSource = fs.readFileSync(path.join(root, "src", "SettingView.tsx"), "utf8");
const i18nSource = fs.readFileSync(path.join(root, "src", "util", "i18n.ts"), "utf8");

function methodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing method ${signature}`);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated method ${signature}`);
}

const recoveryMethod = methodBody(mainSource, "async clearSafeModeAndRetry()");

assert(
  mainSource.includes("switchToRecommendedSmallModelAndRetry"),
  "plugin must expose a recommended-small-model recovery action",
);
assert(
  /(?:this\.embeddingService|recoveredEmbeddingService)\?\.isReady\(\)/.test(recoveryMethod),
  "manual recovery must verify that the embedding worker is actually ready",
);
assert(
  recoveryMethod.includes("this.safeModeManager.enterSafeMode"),
  "failed manual recovery must put the plugin back into safe mode",
);

for (const action of [
  "switchToRecommendedSmallModelAndRecover",
  "recoverFromSafeMode",
  "keepSafeMode",
]) {
  assert(settingsSource.includes(action), `settings must expose ${action}`);
}

for (const key of [
  "settings.diagnostics.safeModeSwitchModel",
  "settings.diagnostics.safeModeRetry",
  "settings.diagnostics.safeModeKeep",
]) {
  assert(i18nSource.includes(`"${key}"`), `missing i18n key ${key}`);
}

console.log("Safe mode recovery action tests passed");
