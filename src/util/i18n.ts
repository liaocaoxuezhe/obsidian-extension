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
  "common.dismiss": { en: "Dismiss", zh: "关闭" },
  "common.remove": { en: "Remove", zh: "移除" },
  "common.yes": { en: "Yes", zh: "是" },
  "common.no": { en: "No", zh: "否" },
  "common.unknown": { en: "Unknown", zh: "未知" },
  "common.development": { en: "Development", zh: "开发版" },
  "common.sending": { en: "Sending...", zh: "发送中..." },
  "common.idle": { en: "Idle", zh: "空闲" },

  // --- Local service status ---
  "settings.service.ready": { en: "Ready", zh: "就绪" },
  "settings.service.initializing": { en: "Initializing", zh: "初始化中" },
  "settings.service.degraded": { en: "Degraded", zh: "部分可用" },
  "settings.service.error": { en: "Error", zh: "错误" },

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
  "settings.license.links": { en: "License server links", zh: "许可证服务链接" },
  "settings.license.serverUrl": { en: "License server URL", zh: "许可证服务 URL" },
  "settings.license.buyUrl": { en: "Buy license URL", zh: "购买链接 URL" },
  "settings.license.manageUrl": { en: "Manage license URL", zh: "管理链接 URL" },
  "settings.license.buy": { en: "Buy License", zh: "购买许可证" },
  "settings.license.manage": { en: "Manage License", zh: "管理许可证" },
  "settings.license.planFree": { en: "Free", zh: "免费版" },
  "settings.license.planPersonalLifetime": { en: "Personal Lifetime", zh: "个人终身版" },
  "settings.license.planTeam": { en: "Team", zh: "团队版" },
  "settings.license.planPro": { en: "Pro", zh: "专业版" },
  "settings.license.unlimited": { en: "Unlimited", zh: "无限制" },
  "settings.license.vaultLimitExceeded": {
    en: "Free plan supports indexing up to {limit} Markdown pages. This vault has {count} pages.",
    zh: "免费版最多可索引 {limit} 个 Markdown 页面。当前仓库共有 {count} 个页面。",
  },
  "settings.license.upgradeToContinue": {
    en: "Free plan supports indexing up to {limit} Markdown pages. Upgrade to continue indexing this vault.",
    zh: "免费版最多可索引 {limit} 个 Markdown 页面。升级后可继续索引此仓库。",
  },
  "settings.license.upgradeToIndexMore": {
    en: "Free plan supports indexing up to {limit} Markdown pages. Upgrade to index more pages.",
    zh: "免费版最多可索引 {limit} 个 Markdown 页面。升级后可索引更多页面。",
  },
  "settings.license.upgradePrompt": {
    en: "Free plan supports indexing up to {limit} Markdown pages.\nYou selected {selectedCount} pages. Upgrade Analogy Personal to index larger vaults.",
    zh: "免费版最多可索引 {limit} 个 Markdown 页面。\n你选择了 {selectedCount} 个页面。升级到 Analogy 个人版即可索引更大的仓库。",
  },
  "settings.license.indexedToFreeLimit": {
    en: "Indexed up to the free page limit. Upgrade to index the remaining pages.",
    zh: "已索引至免费版页面上限。升级后可索引剩余页面。",
  },
  "settings.license.serverUrlInvalid": {
    en: "License server URL must start with http:// or https://",
    zh: "许可证服务 URL 必须以 http:// 或 https:// 开头",
  },
  "settings.license.linksInvalid": {
    en: "License links must start with http:// or https://",
    zh: "许可证链接必须以 http:// 或 https:// 开头",
  },
  "settings.license.settingsSaved": { en: "License settings saved", zh: "许可证设置已保存" },
  "settings.license.enterKey": { en: "Enter a license key first", zh: "请先输入许可证密钥" },
  "settings.license.activated": { en: "License activated", zh: "许可证已激活" },
  "settings.license.invalid": { en: "License is invalid or inactive", zh: "许可证无效或未激活" },
  "settings.license.localCleared": { en: "Local license cleared", zh: "本地许可证已清除" },
  "settings.license.deactivated": {
    en: "License deactivated on this device",
    zh: "此设备上的许可证已停用",
  },

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
  "settings.embedding.howToChoose": { en: "How to choose?", zh: "如何选择？" },
  "settings.embedding.modelChanged": {
    en: "Embedding model changed. Reloading plugin...",
    zh: "嵌入模型已更改，正在重新加载插件...",
  },
  "settings.embedding.hostInvalid": {
    en: "Model host must start with http:// or https://",
    zh: "模型地址必须以 http:// 或 https:// 开头",
  },
  "settings.embedding.hostSaved": {
    en: "Embedding model host saved. Reload plugin to apply.",
    zh: "嵌入模型地址已保存，重新加载插件后生效。",
  },

  // --- Summary preprocessing ---
  "settings.summary.title": { en: "Article Summary Matching", zh: "文章摘要检索" },
  "settings.summary.enable": { en: "Show summary matching button", zh: "显示摘要检索按钮" },
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
  "search.articleContentButton": {
    en: "Search by article content",
    zh: "基于文章内容搜索",
  },
  "search.articleSummaryButton": {
    en: "Search by article summary",
    zh: "基于文章摘要检索",
  },
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
  "settings.exclude.exists": { en: "Path already in no-index list", zh: "该路径已在不索引列表中" },
  "settings.exclude.added": { en: "Added to no-index: {path}", zh: "已添加到不索引列表：{path}" },
  "settings.exclude.removed": { en: "Removed from no-index: {path}", zh: "已从不索引列表移除：{path}" },

  "settings.actions.continueIndex": { en: "Continue Index", zh: "继续索引" },
  "settings.actions.indexing": { en: "Indexing...", zh: "索引中..." },
  "settings.actions.stopIndex": { en: "Stop", zh: "停止" },
  "settings.actions.stoppingIndex": { en: "Stopping...", zh: "停止中..." },
  "settings.actions.indexStopped": { en: "Indexing stopped", zh: "索引已停止" },
  "settings.actions.rebuildIndex": { en: "Rebuild Index", zh: "重建索引" },
  "settings.actions.clearIndex": { en: "Clear Index", zh: "清空索引" },
  "settings.actions.indexerUnavailable": {
    en: "Local indexer not initialized",
    zh: "本地索引器尚未初始化",
  },
  "settings.actions.rebuildDone": { en: "Index rebuilt", zh: "索引重建完成" },
  "settings.actions.rebuildFailed": {
    en: "Rebuild failed: {message}",
    zh: "重建索引失败：{message}",
  },
  "settings.actions.noPending": {
    en: "No pending Markdown pages to index.",
    zh: "没有待索引的 Markdown 页面。",
  },
  "settings.actions.continueDone": { en: "Continue index done", zh: "继续索引完成" },
  "settings.actions.continueFailed": {
    en: "Continue index failed: {message}",
    zh: "继续索引失败：{message}",
  },
  "settings.actions.stopFailed": {
    en: "Stop index failed: {message}",
    zh: "停止索引失败：{message}",
  },
  "settings.actions.fileNotFound": { en: "File not found: {path}", zh: "未找到文件：{path}" },
  "settings.actions.indexed": { en: "Indexed: {name}", zh: "已索引：{name}" },
  "settings.actions.indexFailed": { en: "Index failed: {message}", zh: "索引失败：{message}" },
  "settings.actions.muted": { en: "Muted: {path}", zh: "已静音：{path}" },
  "settings.actions.unmuted": { en: "Unmuted: {path}", zh: "已取消静音：{path}" },
  "settings.actions.vectorStoreUnavailable": {
    en: "Local vector store not initialized",
    zh: "本地向量存储尚未初始化",
  },
  "settings.actions.clearConfirm": {
    en: "Are you sure you want to clear the local index? This cannot be undone.",
    zh: "确定要清空本地索引吗？此操作无法撤销。",
  },
  "settings.actions.clearDone": { en: "Local index cleared", zh: "本地索引已清空" },
  "settings.actions.clearFailed": {
    en: "Clear failed: {message}",
    zh: "清空失败：{message}",
  },

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
  "settings.docs.totalCount": { en: "{count} total", zh: "总计 {count}" },

  // --- User feedback ---
  "settings.feedback.title": { en: "User Feedback", zh: "用户反馈" },
  "settings.feedback.description": {
    en: "Questions or suggestions? Contact us by email.",
    zh: "如有问题或建议，欢迎通过邮箱联系我们。",
  },
  "settings.feedback.copyLabel": {
    en: "Copy support email address",
    zh: "复制客服邮箱地址",
  },
  "settings.feedback.copySuccess": {
    en: "Support email copied",
    zh: "客服邮箱已复制",
  },
  "settings.feedback.copyFailed": {
    en: "Failed to copy. Please copy the email address manually.",
    zh: "复制失败，请手动复制邮箱地址。",
  },

  // --- Diagnostics & crash reports ---
  "settings.diagnostics.title": { en: "Diagnostics & Crash Reports", zh: "诊断与问题报告" },
  "settings.diagnostics.description": {
    en: "Preview and voluntarily send diagnostic reports. No notes, paths, searches, or license keys are included.",
    zh: "预览并主动发送诊断报告。报告中不会包含笔记、路径、搜索词或许可证密钥。",
  },
  "settings.diagnostics.lastRun": { en: "Last run", zh: "上一次运行" },
  "settings.diagnostics.lastStage": { en: "Last stage", zh: "最后阶段" },
  "settings.diagnostics.eventCount": { en: "Local diagnostic events", zh: "本地诊断事件" },
  "settings.diagnostics.suspectedUncleanExit": { en: "Suspected unclean exit", zh: "疑似异常退出" },
  "settings.diagnostics.cleanExit": { en: "Clean exit", zh: "正常退出" },
  "settings.diagnostics.preview": { en: "Preview Report", zh: "预览诊断报告" },
  "settings.diagnostics.copy": { en: "Copy Report", zh: "复制诊断报告" },
  "settings.diagnostics.save": { en: "Save as JSON", zh: "保存为 JSON" },
  "settings.diagnostics.send": { en: "Send to Developer", zh: "发送给开发者" },
  "settings.diagnostics.clear": { en: "Clear Local Diagnostics", zh: "清除本地诊断数据" },
  "settings.diagnostics.clearConfirm": {
    en: "Clear all local diagnostic events and reset reporter ID? This does not affect settings or index.",
    zh: "清除所有本地诊断事件并重置报告者 ID？这不会影响设置和索引。",
  },
  "settings.diagnostics.noReport": { en: "No diagnostic report available.", zh: "暂无诊断报告。" },
  "settings.diagnostics.sendSuccess": { en: "Report sent. ID:", zh: "报告已发送，编号：" },
  "settings.diagnostics.sendFailed": { en: "Failed to send report:", zh: "发送报告失败：" },
  "settings.diagnostics.previewTitle": { en: "Diagnostic Report Preview", zh: "诊断报告预览" },
  "settings.diagnostics.dataDisclaimer": {
    en: "This report contains plugin version, runtime stage, sanitized error stacks, and recent events. It does NOT contain note content, file paths, search queries, embeddings, or license keys.",
    zh: "此报告包含插件版本、运行阶段、脱敏错误堆栈和最近事件。不包含笔记内容、文件路径、搜索词、embedding 或许可证密钥。",
  },
  "settings.diagnostics.close": { en: "Close", zh: "关闭" },
  "settings.diagnostics.finalPayload": {
    en: "Final payload to copy, save, or send",
    zh: "将被复制、保存或发送的最终内容",
  },
  "settings.diagnostics.fieldPlugin": { en: "Plugin", zh: "插件" },
  "settings.diagnostics.fieldBuild": { en: "Build", zh: "构建版本" },
  "settings.diagnostics.fieldObsidian": { en: "Obsidian", zh: "Obsidian" },
  "settings.diagnostics.fieldPlatform": { en: "Platform", zh: "平台" },
  "settings.diagnostics.fieldLocale": { en: "Locale", zh: "语言区域" },
  "settings.diagnostics.fieldModel": { en: "Model", zh: "模型" },
  "settings.diagnostics.fieldLastStage": { en: "Last stage", zh: "最后阶段" },
  "settings.diagnostics.fieldUncleanExit": { en: "Unclean exit", zh: "异常退出" },
  "settings.diagnostics.optionalNote": {
    en: "Optional note (do not include note content or paths)",
    zh: "可选备注（请勿包含笔记内容或路径）",
  },
  "settings.diagnostics.copyFailed": { en: "Copy failed", zh: "复制失败" },
  "settings.diagnostics.saved": { en: "Saved {fileName}", zh: "已保存 {fileName}" },
  "settings.diagnostics.saveFailed": { en: "Save failed", zh: "保存失败" },
  "settings.diagnostics.endpointMissing": {
    en: "Diagnostic endpoint not configured. Copy or save the report instead.",
    zh: "尚未配置诊断报告接口，请改为复制或保存报告。",
  },
  "settings.diagnostics.cleared": { en: "Local diagnostics cleared", zh: "本地诊断数据已清除" },
  "settings.diagnostics.safeModeTitle": {
    en: "Safe mode is active",
    zh: "安全模式已启用",
  },
  "settings.diagnostics.safeModeDescription": {
    en: "Embedding and automatic indexing are paused. Diagnostics and settings remain available.",
    zh: "Embedding 和自动索引已暂停，诊断与设置仍可使用。",
  },
  "settings.diagnostics.safeModeReason": {
    en: "Reason",
    zh: "进入原因",
  },
  "settings.diagnostics.safeModeRetry": {
    en: "Clear crash counters and retry",
    zh: "清除崩溃计数并重试",
  },
  "settings.diagnostics.safeModeSwitchModel": {
    en: "Use recommended small model and recover",
    zh: "切换推荐小模型并恢复",
  },
  "settings.diagnostics.safeModeKeep": {
    en: "Keep safe mode",
    zh: "保持安全模式",
  },
  "settings.diagnostics.safeModeKept": {
    en: "Safe mode remains active. Embedding and automatic indexing stay paused.",
    zh: "已保持安全模式，Embedding 与自动索引继续暂停。",
  },
  "settings.diagnostics.safeModeRetrying": {
    en: "Retrying…",
    zh: "正在重试…",
  },
  "settings.diagnostics.safeModeRecovered": {
    en: "Safe mode counters cleared and embedding retry completed.",
    zh: "安全模式计数已清除，Embedding 重试完成。",
  },
  "settings.diagnostics.safeModeRetryFailed": {
    en: "Embedding retry failed:",
    zh: "Embedding 重试失败：",
  },
  "settings.diagnostics.safeModeRecentUncleanExits": {
    en: "Recent unclean exits in embedding stages: {stages}",
    zh: "近期在 Embedding 阶段发生异常退出：{stages}",
  },
  "settings.diagnostics.safeModeWorkerExited": {
    en: "Worker exited unexpectedly multiple times",
    zh: "Worker 多次意外退出",
  },

  "settings.chroma.portInvalid": {
    en: "Port must be between 1 and 65535",
    zh: "端口必须在 1 到 65535 之间",
  },
  "settings.chroma.portSaved": {
    en: "ChromaDB port saved: {port}. Reload plugin to apply.",
    zh: "ChromaDB 端口已保存为 {port}，重新加载插件后生效。",
  },

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

export type TranslationParams = Record<string, string | number>;

export function t(key: string, params?: TranslationParams): string {
  const entry = TRANSLATIONS[key];
  if (!entry) return key;
  const template = entry[currentLocale] ?? entry.en ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params[name];
    return value === undefined ? placeholder : String(value);
  });
}
