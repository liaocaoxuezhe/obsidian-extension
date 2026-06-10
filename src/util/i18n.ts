/**
 * Minimal i18n helper for the Analogy Obsidian plugin.
 *
 * Only affects the frontend (React views) — settings, search, indexing logic
 * remain unchanged. Pages call `t("key")` to get the current locale's text.
 *
 * Adding a string:
 *   1. Add the key with `en` and `zh` entries to TRANSLATIONS below.
 *   2. Replace the literal in the .tsx with `t("your.key")`.
 */

export type Locale = "en" | "zh";

export const SUPPORTED_LOCALES: Locale[] = ["en", "zh"];

let currentLocale: Locale = "en";
const listeners = new Set<(l: Locale) => void>();

const TRANSLATIONS: Record<string, Record<Locale, string>> = {
  // --- Settings page: section titles ---
  "settings.localVectorStatus": {
    en: "Local Vector Status",
    zh: "本地向量状态",
  },
  "settings.language.title": {
    en: "Language",
    zh: "语言",
  },
  "settings.language.hint": {
    en: "Only affects the plugin's UI language.",
    zh: "只影响插件界面的语言。",
  },
  "settings.language.english": { en: "English", zh: "英文" },
  "settings.language.chinese": { en: "Chinese", zh: "中文" },

  "settings.runtime.title": { en: "Local RAG runtime", zh: "本地 RAG 运行时" },
  "settings.runtime.desc": {
    en: "Required for local embedding inference. Community installs do not include npm dependencies, so install them here once.",
    zh: "本地嵌入推理需要这些运行时依赖。社区插件安装不会包含 npm 依赖，请在这里安装一次。",
  },
  "settings.runtime.ready": { en: "Ready", zh: "就绪" },
  "settings.runtime.missing": { en: "Missing", zh: "缺失" },
  "settings.runtime.missingPackages": { en: "Missing packages", zh: "缺失依赖" },
  "settings.runtime.installHint": {
    en: "This runs npm install in the plugin folder and downloads packages from the npm registry. Keep Obsidian open until it finishes.",
    zh: "这会在插件目录中执行 npm install，并从 npm registry 下载依赖。安装完成前请保持 Obsidian 打开。",
  },
  "settings.runtime.install": { en: "Install runtime", zh: "安装运行时" },
  "settings.runtime.installing": { en: "Installing...", zh: "安装中..." },
  "settings.runtime.refreshing": { en: "Refreshing...", zh: "刷新中..." },
  "settings.runtime.installDone": { en: "Local RAG runtime installed", zh: "本地 RAG 运行时已安装" },
  "settings.runtime.installFailed": { en: "Runtime install failed", zh: "运行时安装失败" },
  "settings.runtime.confirm": {
    en: "Install local RAG runtime dependencies with npm? This downloads @huggingface/transformers and onnxruntime-node into the plugin folder.",
    zh: "要使用 npm 安装本地 RAG 运行时依赖吗？这会把 @huggingface/transformers 和 onnxruntime-node 下载到插件目录。",
  },

  "settings.chroma.title": { en: "ChromaDB", zh: "ChromaDB" },
  "settings.chroma.status": { en: "Status", zh: "状态" },
  "settings.chroma.running": { en: "Running", zh: "运行中" },
  "settings.chroma.stopped": { en: "Stopped", zh: "已停止" },
  "settings.chroma.serviceStatus": { en: "Service Status", zh: "服务状态" },
  "settings.chroma.indexedChunks": { en: "Indexed Chunks", zh: "已索引块数" },
  "settings.chroma.indexedFiles": { en: "Indexed Files", zh: "已索引文件" },
  "settings.chroma.storagePath": { en: "Storage Path", zh: "存储路径" },
  "settings.chroma.manualStart": { en: "Start ChromaDB before local search:", zh: "使用本地搜索前，请启动 ChromaDB：" },
  "settings.chroma.start": { en: "Start ChromaDB", zh: "启动 ChromaDB" },
  "settings.chroma.starting": { en: "Starting...", zh: "启动中..." },
  "settings.chroma.startDone": { en: "ChromaDB is ready", zh: "ChromaDB 已就绪" },
  "settings.chroma.port": { en: "Port", zh: "端口" },
  "common.save": { en: "Save", zh: "保存" },
  "common.apply": { en: "Apply", zh: "应用" },
  "common.add": { en: "Add", zh: "添加" },
  "common.refresh": { en: "Refresh", zh: "刷新" },
  "common.copy": { en: "Copy", zh: "复制" },
  "common.copiedToClipboard": { en: "Copied to clipboard", zh: "已复制到剪贴板" },

  // --- License ---
  "settings.license.title": { en: "License", zh: "许可证" },
  "settings.license.plan": { en: "Current Plan", zh: "当前计划" },
  "settings.license.pageLimit": { en: "Page Limit", zh: "页面上限" },
  "settings.license.freeLimit": { en: "Free Limit", zh: "免费上限" },
  "settings.license.key": { en: "License Key", zh: "许可证密钥" },
  "settings.license.keyPlaceholder": { en: "Enter license key", zh: "输入许可证密钥" },
  "settings.license.activate": { en: "Activate", zh: "激活" },
  "settings.license.activating": { en: "Activating...", zh: "激活中..." },
  "settings.license.deactivate": { en: "Deactivate", zh: "停用" },
  "settings.license.deactivating": { en: "Deactivating...", zh: "停用中..." },
  "settings.license.links": { en: "License server and payment links", zh: "许可证服务和支付链接" },
  "settings.license.serverUrl": { en: "License server URL", zh: "许可证服务 URL" },
  "settings.license.buyUrl": { en: "Buy license URL", zh: "购买链接 URL" },
  "settings.license.manageUrl": { en: "Manage license URL", zh: "管理链接 URL" },
  "settings.license.buy": { en: "Buy License", zh: "购买许可证" },
  "settings.license.manage": { en: "Manage License", zh: "管理许可证" },

  // --- Embedding model card ---
  "settings.embedding.title": { en: "Embedding Model", zh: "嵌入模型" },
  "settings.embedding.model": { en: "Model", zh: "模型" },
  "settings.embedding.runHint": {
    en: "Embedding model runs on your computer.",
    zh: "嵌入模型在你本机运行。",
  },
  "settings.embedding.switchWarning": {
    en: "After switching, the plugin will reload and use this model's separate index. If this model has not been indexed yet, run Build/Rebuild Index.",
    zh: "切换模型后会重新加载插件，并使用该模型独立的索引。如果这个模型还没有索引，请执行 Build/Rebuild Index。",
  },
  "settings.embedding.pickerHelp": {
    en: "Can your machine run 200M+ parameters?\n├── Yes → Jina v5 Nano (239M, best STS)\n│    More focused on analogical reasoning → EmbeddingGemma-300M\n└── No (only <100M) → Need Chinese?\n     ├── Yes → bge-small-en-v1.5 (33M, mild Chinese support) or bge-small-zh\n     └── No → Speed first? all-MiniLM-L6-v2 (22M)   Precision first? bge-small-en-v1.5 (33M)",
    zh: "你的机器能跑 200M+ 参数？\n├── 是 → Jina v5 Nano（239M，STS 最强）\n│    更关注类比关系判断 → EmbeddingGemma-300M\n└── 否（只能跑 <100M）→ 需要中文？\n     ├── 是 → bge-small-en-v1.5（33M，中文友好）或 bge-small-zh\n     └── 否 → 追求速度？all-MiniLM-L6-v2（22M）  追求精度？bge-small-en-v1.5（33M）",
  },
  "settings.embedding.statusLabel": { en: "Status", zh: "状态" },
  "settings.embedding.ready": { en: "Ready", zh: "就绪" },
  "settings.embedding.downloading": { en: "Downloading", zh: "下载中" },
  "settings.embedding.loading": { en: "Loading", zh: "加载中" },
  "settings.embedding.error": { en: "Error", zh: "错误" },
  "settings.embedding.initializing": { en: "Initializing...", zh: "初始化中..." },
  "settings.embedding.emptyIndexWarning": {
    en: "This model has no indexed documents yet. Click \"Rebuild Index\" below to build the vector index for this model.",
    zh: "当前模型还没有索引数据。点击下方「重建索引」按钮为该模型构建向量索引。",
  },

  // --- Summary preprocessing ---
  "settings.summary.title": { en: "Summarize Before Embedding", zh: "先总结再嵌入" },
  "settings.summary.enable": { en: "Enable summary preprocessing", zh: "启用摘要预处理" },
  "settings.summary.model": { en: "Summary model", zh: "摘要模型" },
  "settings.summary.modelHint": {
    en: "Used only when matching from the current article; it does not rewrite the Chroma index.",
    zh: "仅在基于当前文章匹配时使用，不会改写 Chroma 索引。",
  },
  "settings.summary.size": { en: "Size", zh: "大小" },
  "settings.summary.ollamaHost": { en: "Ollama host", zh: "Ollama 地址" },
  "settings.summary.timeout": { en: "Timeout (ms)", zh: "超时（毫秒）" },
  "settings.summary.maxInput": { en: "Max input characters", zh: "最大输入字符数" },
  "settings.summary.prompt": { en: "Summary prompt", zh: "摘要 Prompt" },
  "settings.summary.promptHint": {
    en: "Use {page_content} where the text to summarize should be inserted.",
    zh: "使用 {page_content} 指代会被放进去、用于摘要的文本内容。",
  },
  "settings.summary.check": { en: "Check Ollama", zh: "检测 Ollama" },
  "settings.summary.checking": { en: "Checking...", zh: "检测中..." },
  "settings.summary.pull": { en: "Download model", zh: "下载模型" },
  "settings.summary.pulling": { en: "Downloading...", zh: "下载中..." },
  "settings.summary.pullDone": { en: "Summary model downloaded", zh: "摘要模型已下载" },
  "settings.summary.autoPull": { en: "Download missing model automatically", zh: "自动下载缺失模型" },
  "settings.summary.fallback": { en: "Use original text if summary fails", zh: "摘要失败时使用原文索引" },
  "settings.summary.reloadHint": { en: "Summary changes apply to article-based matching only; existing indexes are unchanged.", zh: "摘要设置只影响基于文章的匹配；已有索引不会改变。" },
  "settings.summary.applyHint": { en: "Summary matching settings applied.", zh: "摘要匹配设置已应用。" },
  "settings.summary.modelInstalled": { en: "Selected model is installed.", zh: "所选模型已安装。" },
  "settings.summary.modelMissing": { en: "Selected model is not installed.", zh: "所选模型尚未安装。" },

  // --- Search view ---
  "search.articleSummaryQueryTitle": {
    en: "Query based on the following text",
    zh: "基于以下文章摘要匹配",
  },

  // --- Exclude / index management ---
  "settings.exclude.title": { en: "No-index Paths", zh: "不索引的路径" },
  "settings.exclude.hint": {
    en: "Use vault-relative paths. A folder path excludes that folder and everything inside.",
    zh: "使用 vault 内的相对路径。文件夹路径会排除该目录及子目录下所有文件。",
  },
  "settings.exclude.empty": { en: "No excluded paths yet", zh: "还没有排除任何路径" },
  "settings.exclude.placeholder": {
    en: "e.g. Daily or Archive/old-note.md",
    zh: "例如 每日创作 或 Archive/old-note.md",
  },
  "settings.exclude.pathsCount": {
    en: "paths excluded",
    zh: "条路径已排除",
  },

  "settings.actions.continueIndex": { en: "Continue Index", zh: "继续索引" },
  "settings.actions.indexing": { en: "Indexing...", zh: "索引中..." },
  "settings.actions.stopIndex": { en: "Stop", zh: "停止" },
  "settings.actions.stoppingIndex": { en: "Stopping...", zh: "停止中..." },
  "settings.actions.indexStopped": { en: "Indexing stopped", zh: "索引已停止" },
  "settings.actions.rebuildIndex": { en: "Rebuild Index", zh: "重建索引" },
  "settings.actions.clearIndex": { en: "Clear Index", zh: "清空索引" },

  "settings.docs.title": { en: "Document Index Management", zh: "文档索引管理" },
  "settings.docs.searchPlaceholder": { en: "Search files...", zh: "搜索文件..." },
  "settings.docs.filter.all": { en: "All", zh: "全部" },
  "settings.docs.filter.indexed": { en: "Indexed", zh: "已索引" },
  "settings.docs.filter.outdated": { en: "Outdated", zh: "过期" },
  "settings.docs.filter.unindexed": { en: "Unindexed", zh: "未索引" },
  "settings.docs.noFiles": { en: "No files found", zh: "没有找到文件" },
  "settings.docs.chunks": { en: "chunks", zh: "块" },
  "settings.docs.muted": { en: "Muted", zh: "已静音" },
  "settings.docs.mute": { en: "Mute", zh: "静音" },
  "settings.docs.unmute": { en: "Unmute", zh: "取消静音" },
  "settings.docs.reindex": { en: "Re-index", zh: "重新索引" },
  "settings.docs.index": { en: "Index", zh: "索引" },
  "settings.docs.showMore": { en: "Show more", zh: "显示更多" },
  "settings.docs.showing": { en: "Showing", zh: "显示" },
  "settings.docs.of": { en: "of", zh: "/" },
  "settings.docs.files": { en: "files", zh: "个文件" },

  "settings.rebuild.progress": { en: "Rebuild Progress", zh: "重建进度" },
};

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  if (!SUPPORTED_LOCALES.includes(locale)) return;
  if (locale === currentLocale) return;
  currentLocale = locale;
  listeners.forEach((cb) => {
    try { cb(locale); } catch {}
  });
}

export function onLocaleChange(cb: (l: Locale) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function t(key: string): string {
  const entry = TRANSLATIONS[key];
  if (!entry) return key;
  return entry[currentLocale] ?? entry.en ?? key;
}
