const assert = require("assert");
const path = require("path");
const esbuild = require("../node_modules/esbuild");

async function loadModule() {
  const source = path.join(
    __dirname,
    "..",
    "src",
    "local-vector",
    "document-indexer.ts",
  );
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
  const testRequire = (id) => {
    if (id === "obsidian") {
      return { TFile: class TFile {}, Notice: class Notice {} };
    }
    return require(id);
  };
  fn(module, module.exports, testRequire);
  return module.exports;
}

(async () => {
  const { DocumentIndexer } = await loadModule();
  const indexer = new DocumentIndexer(
    {},
    {},
    { adapter: { read: async () => "" }, getFiles: () => [] },
    { load: async () => ({}), save: async () => {} },
  );

  const merged = indexer.mergeShortChunks([
    "短句一。",
    "这是一段足够长的内容，用来承接前面的短句，并且长度超过五十个字符，避免再次被暂存，同时保留完整语义上下文。",
    "短句二。",
    "这是下一段内容，也足够长，可以验证短 chunk 会和后面的 chunk 拼接在一起，并且不会继续吞掉后续分块。",
  ]);

  assert.deepStrictEqual(merged, [
    "短句一。\n这是一段足够长的内容，用来承接前面的短句，并且长度超过五十个字符，避免再次被暂存，同时保留完整语义上下文。",
    "短句二。\n这是下一段内容，也足够长，可以验证短 chunk 会和后面的 chunk 拼接在一起，并且不会继续吞掉后续分块。",
  ]);

  const trailing = indexer.mergeShortChunks([
    "这是一段已经足够长的内容，用来验证最后一个短 chunk 没有下一段时，会合并回前一个 chunk。",
    "尾句。",
  ]);

  assert.deepStrictEqual(trailing, [
    "这是一段已经足够长的内容，用来验证最后一个短 chunk 没有下一段时，会合并回前一个 chunk。\n尾句。",
  ]);

  console.log("Obsidian short chunk merge tests passed");
})();
