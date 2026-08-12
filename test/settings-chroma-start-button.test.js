const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const settings = fs.readFileSync(path.join(root, "src", "SettingView.tsx"), "utf8");
const i18n = fs.readFileSync(path.join(root, "src", "util", "i18n.ts"), "utf8");
const constants = fs.readFileSync(path.join(root, "src", "model", "Consts.ts"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

assert.match(settings, /import \{RuntimeSettingsPanel\} from "\.\/runtime\/RuntimeControlPanel"/);
assert.match(settings, /<RuntimeSettingsPanel control=\{plugin\.getRuntimeControlSurface\(\)\} \/>/);
assert.doesNotMatch(settings, /startChromaFromSettings|npm install --omit=dev/);
assert.match(i18n, /"settings\.runtime\.title"/);
assert.match(i18n, /"runtimeControl\.openSetup"/);
assert.match(constants, /require\("\.\.\/\.\.\/manifest\.json"\)\.version/);
assert.doesNotMatch(constants, /appVersion:\s*string\s*=\s*"\d+\.\d+\.\d+"/);
assert.strictEqual(manifest.version, packageJson.version);

const i18nPath = path.join(root, "src", "util", "i18n.ts");
const compiled = esbuild.transformSync(i18n, {
  loader: "ts",
  format: "cjs",
  target: "node16",
}).code;
const i18nModule = new Module(i18nPath, module);
i18nModule.filename = i18nPath;
i18nModule.paths = Module._nodeModulePaths(path.dirname(i18nPath));
i18nModule._compile(compiled, i18nPath);

const { setLocale, t } = i18nModule.exports;
const expected = {
  en: {
    "common.dismiss": "Dismiss",
    "common.remove": "Remove",
    "common.yes": "Yes",
    "common.no": "No",
    "common.unknown": "Unknown",
    "common.development": "Development",
    "common.sending": "Sending...",
    "common.idle": "Idle",
    "settings.service.ready": "Ready",
    "settings.service.initializing": "Initializing",
    "settings.service.degraded": "Degraded",
    "settings.service.error": "Error",
    "settings.license.planFree": "Free",
    "settings.license.planPersonalLifetime": "Personal Lifetime",
    "settings.license.planTeam": "Team",
    "settings.license.planPro": "Pro",
    "settings.license.unlimited": "Unlimited",
    "settings.embedding.howToChoose": "How to choose?",
    "settings.diagnostics.fieldPlugin": "Plugin",
    "settings.diagnostics.fieldBuild": "Build",
    "settings.diagnostics.fieldPlatform": "Platform",
    "settings.diagnostics.fieldLocale": "Locale",
    "settings.diagnostics.fieldModel": "Model",
    "settings.diagnostics.fieldLastStage": "Last stage",
    "settings.diagnostics.fieldUncleanExit": "Unclean exit",
    "settings.diagnostics.optionalNote": "Optional note (do not include note content or paths)",
  },
  zh: {
    "common.dismiss": "关闭",
    "common.remove": "移除",
    "common.yes": "是",
    "common.no": "否",
    "common.unknown": "未知",
    "common.development": "开发版",
    "common.sending": "发送中...",
    "common.idle": "空闲",
    "settings.service.ready": "就绪",
    "settings.service.initializing": "初始化中",
    "settings.service.degraded": "部分可用",
    "settings.service.error": "错误",
    "settings.license.planFree": "免费版",
    "settings.license.planPersonalLifetime": "个人终身版",
    "settings.license.planTeam": "团队版",
    "settings.license.planPro": "专业版",
    "settings.license.unlimited": "无限制",
    "settings.embedding.howToChoose": "如何选择？",
    "settings.diagnostics.fieldPlugin": "插件",
    "settings.diagnostics.fieldBuild": "构建版本",
    "settings.diagnostics.fieldPlatform": "平台",
    "settings.diagnostics.fieldLocale": "语言区域",
    "settings.diagnostics.fieldModel": "模型",
    "settings.diagnostics.fieldLastStage": "最后阶段",
    "settings.diagnostics.fieldUncleanExit": "异常退出",
    "settings.diagnostics.optionalNote": "可选备注（请勿包含笔记内容或路径）",
  },
};

for (const locale of ["en", "zh"]) {
  setLocale(locale);
  for (const [key, value] of Object.entries(expected[locale])) {
    assert.strictEqual(t(key), value, `${locale} translation mismatch for ${key}`);
  }
  const usedKeys = [...settings.matchAll(/\bt\("([^"]+)"/g)].map((match) => match[1]);
  for (const key of new Set(usedKeys)) {
    assert.notStrictEqual(t(key), key, `${locale} translation missing for ${key}`);
  }
}

setLocale("en");
assert.strictEqual(
  t("settings.license.vaultLimitExceeded", { limit: 2500, count: 3000 }),
  "Free plan supports indexing up to 2500 Markdown pages. This vault has 3000 pages.",
);
setLocale("zh");
assert.strictEqual(
  t("settings.license.vaultLimitExceeded", { limit: 2500, count: 3000 }),
  "免费版最多可索引 2500 个 Markdown 页面。当前仓库共有 3000 个页面。",
);

console.log("settings Chroma start button and i18n tests passed");
