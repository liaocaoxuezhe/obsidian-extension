#!/usr/bin/env node

/**
 * Hybrid retrieval benchmark (P3.3): vector-only vs vector + keyword (RRF) on a built-in
 * Chinese corpus with proper nouns, people, code identifiers and purely semantic queries.
 * Run it with the managed runtime's Node (node:sqlite + Transformers) and a cached model:
 *
 *   <runtime>/node/bin/node benchmark/hybrid-retrieval.mjs \
 *     --module-root <runtime>/node_modules --cache-dir <models>/transformers-cache/bge-small-en-v1.5 \
 *     --model Xenova/bge-small-en-v1.5 [--query-prefix "..."] [--pooling mean] [--weight 1] [--json out.json]
 *
 * Loads the model offline only; never downloads. Prints Recall@10 and MRR per query category.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function options(argv) {
  const values = { pooling: "mean", "query-prefix": "", "document-prefix": "", weight: "1", dtype: "q8", k: "10" };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/, "");
    if (!name || argv[index + 1] === undefined) throw new Error("arguments come in --name value pairs");
    values[name] = argv[index + 1];
  }
  for (const required of ["module-root", "cache-dir", "model"]) {
    if (!values[required]) throw new Error(`--${required} is required`);
  }
  return values;
}

// ---------- corpus ----------
const PEOPLE = ["张三", "李四", "王芳", "陈晨", "刘洋", "赵磊", "周婷", "吴昊", "郑凯", "孙悦", "欧阳明", "司马懿"];
const IDENTIFIERS = ["useEffect", "useMemo", "asyncio.gather", "torch.no_grad", "git rebase", "kubectl rollout",
  "CREATE INDEX", "Promise.allSettled", "docker compose", "pandas.merge", "requestAnimationFrame", "IntersectionObserver"];
const PROPER = ["Zettelkasten", "Obsidian Canvas", "阿里云香港", "鹿鸣计划", "星火项目", "飞书多维表格",
  "Notion AI", "滴答清单", "Readwise", "Logseq", "番茄工作法", "GTD"];
const TOPICS = [
  ["如何建立长期有效的阅读习惯", "每天固定时间阅读，记录摘要，并定期回顾读过的内容。"],
  ["睡眠质量与第二天的专注力", "睡得不好时注意力难以集中，规律作息能改善白天的工作状态。"],
  ["写作时如何克服拖延", "先写一个很糟的初稿，降低开始的门槛，再慢慢修改。"],
  ["团队沟通中的反馈技巧", "给反馈时描述具体行为和影响，而不是评价人本身。"],
  ["个人财务的基本原则", "先储蓄再消费，建立应急基金，分散投资降低风险。"],
  ["跑步入门的注意事项", "从慢跑开始，控制心率，逐步增加距离，避免受伤。"],
  ["做决定时的常见偏差", "人们容易被锚定效应和损失厌恶影响，需要有意识地反思。"],
  ["城市旅行的省钱经验", "提前预订住宿，使用公共交通，避开旅游旺季。"],
  ["学习一门新语言的方法", "大量输入，每天坚持听说，并且找机会实际使用。"],
  ["家庭厨房的收纳整理", "按使用频率摆放厨具，常用的放在顺手的位置。"],
  ["如何准备一次技术分享", "确定听众最关心的问题，用例子讲清楚，控制时长。"],
  ["冥想对情绪的影响", "每天几分钟的冥想有助于觉察情绪，减少焦虑。"],
];
const PARAPHRASES = [
  "怎样养成坚持读书的习惯", "晚上睡不好会影响工作效率吗", "总是拖着不动笔怎么办", "怎么给同事提意见",
  "理财应该遵守哪些规则", "刚开始跑步要注意什么", "决策时容易犯哪些心理错误", "出去玩怎样少花钱",
  "怎么学好外语", "厨房东西太乱如何整理", "第一次做技术演讲怎么准备", "静坐练习能缓解焦虑吗",
];

function buildCorpus() {
  const notes = [];
  const queries = [];
  const fillers = TOPICS.map(([title, body]) => `${title}。${body}`);
  PEOPLE.forEach((name, index) => {
    const id = `person-${index}`;
    notes.push({ id, text: `会议纪要：${name}负责下一阶段的推进，${fillers[index % fillers.length]}` });
    queries.push({ category: "person", text: name, relevant: [id] });
  });
  IDENTIFIERS.forEach((identifier, index) => {
    const id = `code-${index}`;
    notes.push({ id, text: `踩坑记录：在项目里使用 ${identifier} 时要注意边界条件。${fillers[(index + 3) % fillers.length]}` });
    queries.push({ category: "identifier", text: identifier, relevant: [id] });
  });
  PROPER.forEach((term, index) => {
    const id = `proper-${index}`;
    notes.push({ id, text: `关于 ${term} 的一些记录与想法。${fillers[(index + 6) % fillers.length]}` });
    queries.push({ category: "proper-noun", text: term, relevant: [id] });
  });
  TOPICS.forEach(([title, body], index) => {
    const id = `topic-${index}`;
    notes.push({ id, text: `${title}\n${body}` });
    queries.push({ category: "semantic", text: PARAPHRASES[index], relevant: [id] });
  });
  return { notes, queries };
}

// ---------- evaluation ----------
async function loadEngine() {
  const esbuild = (await import(path.join(repositoryRoot, "node_modules", "esbuild", "lib", "main.js"))).default;
  const result = await esbuild.build({
    entryPoints: [path.join(repositoryRoot, "src", "local-vector", "vector-store-engine.ts")],
    bundle: true, platform: "node", format: "cjs", write: false,
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", "__filename", result.outputFiles[0].text)(
    module, module.exports, createRequire(import.meta.url), fileURLToPath(import.meta.url),
  );
  return module.exports.VectorStoreEngine;
}

function metrics(rankings, queries, k) {
  const byCategory = {};
  queries.forEach((query, index) => {
    const ranked = rankings[index];
    const firstHit = ranked.findIndex((id) => query.relevant.includes(id));
    const bucket = byCategory[query.category] ??= { queries: 0, recall: 0, mrr: 0 };
    bucket.queries += 1;
    bucket.recall += query.relevant.filter((id) => ranked.slice(0, k).includes(id)).length / query.relevant.length;
    bucket.mrr += firstHit >= 0 && firstHit < k ? 1 / (firstHit + 1) : 0;
  });
  const all = { queries: 0, recall: 0, mrr: 0 };
  for (const bucket of Object.values(byCategory)) {
    all.queries += bucket.queries; all.recall += bucket.recall; all.mrr += bucket.mrr;
  }
  byCategory.all = all;
  return Object.fromEntries(Object.entries(byCategory).map(([name, bucket]) => [name, {
    queries: bucket.queries,
    recall: Number((bucket.recall / bucket.queries).toFixed(3)),
    mrr: Number((bucket.mrr / bucket.queries).toFixed(3)),
  }]));
}

async function main() {
  const values = options(process.argv.slice(2));
  const k = Number(values.k);
  const runtimeRequire = createRequire(path.join(path.resolve(values["module-root"]), "noop.js"));
  const { env, pipeline } = runtimeRequire("@huggingface/transformers");
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = path.resolve(values["cache-dir"]);
  env.cacheDir = path.resolve(values["cache-dir"]);
  const extractor = await pipeline("feature-extraction", values.model, { dtype: values.dtype, local_files_only: true });
  const embed = async (texts, prefix) => {
    const output = await extractor(texts.map((text) => `${prefix}${text}`), { pooling: values.pooling, normalize: true });
    const dimension = output.dims[output.dims.length - 1];
    return texts.map((_, index) => Array.from(output.data.slice(index * dimension, (index + 1) * dimension)));
  };

  const { notes, queries } = buildCorpus();
  const VectorStoreEngine = await loadEngine();
  const { DatabaseSync } = runtimeRequire("node:sqlite");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-hybrid-benchmark-"));
  try {
    const engine = new VectorStoreEngine(new DatabaseSync(path.join(root, "vectors.sqlite")));
    const collection = "analogy_vault-v2-0123456789abcdef_benchmark";
    engine.ensureCollection(collection);
    const noteVectors = await embed(notes.map((note) => note.text), values["document-prefix"]);
    engine.upsert(collection, notes.map((note, index) => ({
      id: note.id, document: note.text, embedding: noteVectors[index], metadata: { doc_id: note.id, path: `${note.id}.md` },
    })));
    const queryVectors = await embed(queries.map((query) => query.text), values["query-prefix"]);
    const weight = Number(values.weight);
    const started = process.hrtime.bigint();
    const vectorRankings = queries.map((_, index) => engine.query(collection, queryVectors[index], k).map((match) => match.id));
    const hybridRankings = queries.map((query, index) => engine.hybridQuery(collection, queryVectors[index], query.text, k, weight)
      .map((match) => match.id));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const report = {
      model: values.model, weight, k, notes: notes.length, queries: queries.length,
      vector: metrics(vectorRankings, queries, k),
      hybrid: metrics(hybridRankings, queries, k),
      averageQueryMs: Number((elapsedMs / (queries.length * 2)).toFixed(2)),
    };
    console.log(`model ${report.model}  notes ${report.notes}  queries ${report.queries}  keyword weight ${weight}`);
    console.log(`${"category".padEnd(12)} ${"vector R@10".padStart(11)} ${"hybrid R@10".padStart(11)} ${"vector MRR".padStart(10)} ${"hybrid MRR".padStart(10)}`);
    for (const category of Object.keys(report.vector)) {
      const vector = report.vector[category];
      const hybrid = report.hybrid[category];
      console.log(`${category.padEnd(12)} ${String(vector.recall).padStart(11)} ${String(hybrid.recall).padStart(11)} ${String(vector.mrr).padStart(10)} ${String(hybrid.mrr).padStart(10)}`);
    }
    if (values.json) fs.writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
    engine.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[hybrid-benchmark] ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
