const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");

async function loadModule(relativePath) {
  const source = path.join(__dirname, "..", relativePath);
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const module = { exports: {} };
  const fn = new Function("module", "exports", "require", result.outputFiles[0].text);
  fn(module, module.exports, require);
  return module.exports;
}

(async () => {
  const { DocumentSummarizer } = await loadModule("src/local-vector/document-summarizer.ts");

  const calls = [];
  const summarizer = new DocumentSummarizer({
    enabled: true,
    model: "qwen3.5:0.8b",
    maxInputChars: 1000,
    fallbackToOriginal: true,
    client: {
      generate: async (input) => {
        calls.push(input);
        return "这是摘要。";
      },
    },
  });

  const result = await summarizer.summarize("原文内容", "note.md");
  assert.strictEqual(result.text, "这是摘要。");
  assert.strictEqual(result.usedSummary, true);
  assert.match(calls[0].prompt, /Summarize the following article into a 200-word abstract/);
  assert.match(calls[0].prompt, /Output language: Keep the same as the content's language/);
  assert.match(calls[0].prompt, /Do not output reasoning/);

  const fencedSummarizer = new DocumentSummarizer({
    enabled: true,
    model: "qwen3.5:0.8b",
    maxInputChars: 1000,
    fallbackToOriginal: true,
    client: {
      generate: async () => "```markdown\n这是带围栏的摘要。\n```",
    },
  });

  const fencedResult = await fencedSummarizer.summarize("原文内容", "note.md");
  assert.strictEqual(fencedResult.text, "这是带围栏的摘要。");
  assert.strictEqual(fencedResult.usedSummary, true);

  const customCalls = [];
  const customPromptSummarizer = new DocumentSummarizer({
    enabled: true,
    model: "qwen3.5:0.8b",
    maxInputChars: 1000,
    fallbackToOriginal: true,
    promptTemplate: "请总结：\n{page_content}\n只输出摘要。",
    client: {
      generate: async (input) => {
        customCalls.push(input);
        return "自定义摘要。";
      },
    },
  });

  const customResult = await customPromptSummarizer.summarize("可配置原文", "note.md");
  assert.strictEqual(customResult.text, "自定义摘要。");
  assert.match(customCalls[0].prompt, /^请总结：/);
  assert.match(customCalls[0].prompt, /可配置原文/);
  assert.doesNotMatch(customCalls[0].prompt, /\{page_content\}/);

  const fallback = new DocumentSummarizer({
    enabled: true,
    model: "qwen3.5:0.8b",
    maxInputChars: 1000,
    fallbackToOriginal: true,
    client: { generate: async () => { throw new Error("offline"); } },
  });

  const fallbackResult = await fallback.summarize("原文内容", "note.md");
  assert.strictEqual(fallbackResult.text, "原文内容");
  assert.strictEqual(fallbackResult.usedSummary, false);
  assert.match(fallbackResult.error, /offline/);

  console.log("Document summarizer tests passed");
})();
