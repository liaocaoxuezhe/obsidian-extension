"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const esbuild = require("esbuild");
const { DatabaseSync } = require("node:sqlite");

async function loadModule(source) {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, "..", "src", source)],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", "__filename", result.outputFiles[0].text)(
    module, module.exports, require, __filename,
  );
  return module.exports;
}

function tempDatabase(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-hybrid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "混合 检索", "vectors.sqlite");
}

function unit(values) {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / norm);
}

const COLLECTION = "analogy_vault-v2-0123456789abcdef_bge-small-en-v1.5";
// The query vector points at "semantic" notes; keyword-only notes sit far away in vector space.
const QUERY = unit([1, 0, 0, 0]);
const NOTES = [
  ["semantic-1", "关于知识管理的一般性思考", [1, 0.05, 0, 0]],
  ["semantic-2", "如何整理读书笔记与卡片", [0.95, 0.1, 0, 0]],
  ["semantic-3", "第二大脑与个人知识库", [0.9, 0.2, 0, 0]],
  ["hooks", "React 里 useEffect 的依赖数组要写全", [0, 0, 1, 0]],
  ["person", "张三在会议上提出了新的复盘流程", [0, 0, 0, 1]],
  ["project", "项目代号 Zettelkasten-X 的迁移计划", [0, 1, 0, 0]],
];

function record(id, document, embedding) {
  return { id, document, embedding: unit(embedding), metadata: { doc_id: `${id}.md`, path: `${id}.md` } };
}

async function seededEngine(t) {
  const { VectorStoreEngine } = await loadModule("local-vector/vector-store-engine.ts");
  const file = tempDatabase(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const engine = new VectorStoreEngine(new DatabaseSync(file));
  t.after(() => { try { engine.close(); } catch { /* already closed */ } });
  engine.ensureCollection(COLLECTION);
  engine.upsert(COLLECTION, NOTES.map(([id, document, embedding]) => record(id, document, embedding)));
  return { engine, file, VectorStoreEngine };
}

test("keyword queries keep code identifiers whole and split CJK runs into trigrams", async () => {
  const { buildKeywordQuery, likePattern } = await loadModule("local-vector/keyword-search.ts");
  assert.deepEqual(buildKeywordQuery("useEffect 依赖"), { match: "\"useeffect\"", shortTerms: ["依赖"] });
  assert.deepEqual(buildKeywordQuery("张三"), { match: null, shortTerms: ["张三"] });
  const chinese = buildKeywordQuery("复盘流程");
  assert.equal(chinese.match, "\"复盘流程\" OR \"复盘流\" OR \"盘流程\"");
  assert.equal(buildKeywordQuery("react-dom user_id a").match, "\"react-dom\" OR \"user_id\"");
  assert.equal(buildKeywordQuery("say \"hi\" there").match, "\"say\" OR \"there\"");
  assert.equal(buildKeywordQuery("").match, null);
  assert.equal(likePattern("50%_off\\"), "%50\\%\\_off\\\\%");
});

test("reciprocal rank fusion rewards agreement and honours list weights", async () => {
  const { reciprocalRankFusion, clampKeywordWeight } = await loadModule("local-vector/keyword-search.ts");
  const fused = reciprocalRankFusion([{ ids: ["a", "b", "c"], weight: 1 }, { ids: ["c", "d"], weight: 1 }]);
  assert.equal(fused[0].id, "c", "found by both retrievers");
  assert.deepEqual(reciprocalRankFusion([{ ids: ["a"], weight: 1 }, { ids: ["b"], weight: 0 }]).map((entry) => entry.id), ["a"]);
  assert.equal(clampKeywordWeight(9), 3);
  assert.equal(clampKeywordWeight(-1), 0);
  assert.equal(clampKeywordWeight("x"), 1);
});

test("hybrid search surfaces exact names, people and identifiers that vector search misses", async (t) => {
  const { engine } = await seededEngine(t);
  assert.deepEqual(engine.keywordStatus(), { state: "ready", indexed: 0, total: 0 });
  const vectorOnly = engine.query(COLLECTION, QUERY, 3).map((match) => match.id);
  assert.equal(vectorOnly.includes("hooks"), false);

  const identifier = engine.hybridQuery(COLLECTION, QUERY, "useEffect", 3, 1);
  assert.ok(identifier.some((match) => match.id === "hooks" && match.matchedBy.includes("keyword")));
  const hooks = identifier.find((match) => match.id === "hooks");
  assert.ok(hooks.distance > 1, "keyword-only hits still carry their real vector distance");

  const person = engine.hybridQuery(COLLECTION, QUERY, "张三", 3, 1).map((match) => match.id);
  assert.ok(person.includes("person"), "two-character names are matched without trigrams");
  const project = engine.hybridQuery(COLLECTION, QUERY, "zettelkasten-x", 3, 1).map((match) => match.id);
  assert.ok(project.includes("project"), "matching is case-insensitive");

  const semanticOnly = engine.hybridQuery(COLLECTION, QUERY, "useEffect", 3, 0).map((match) => match.id);
  assert.deepEqual(semanticOnly, vectorOnly, "weight 0 is pure vector search");
  assert.ok(engine.hybridQuery(COLLECTION, QUERY, "完全无关的词语组合", 3, 1).length === 3);
});

test("the keyword index follows upserts and deletes, including writes from an older plugin version", async (t) => {
  const { engine, file } = await seededEngine(t);
  engine.upsert(COLLECTION, [record("hooks", "改写后的内容 useMemo", [0, 0, 1, 0])]);
  assert.equal(engine.hybridQuery(COLLECTION, QUERY, "useEffect", 3, 1).some((match) => match.id === "hooks"), false);
  assert.ok(engine.hybridQuery(COLLECTION, QUERY, "useMemo", 3, 1).some((match) => match.id === "hooks"));
  engine.deleteByDocId(COLLECTION, "person.md");
  assert.equal(engine.hybridQuery(COLLECTION, QUERY, "复盘流程", 6, 1).some((match) => match.id === "person"), false);

  // An older engine knows nothing about the keyword index; the triggers keep it in sync anyway.
  const raw = new DatabaseSync(file);
  const collectionId = raw.prepare("SELECT id FROM collections WHERE name = ?").get(COLLECTION).id;
  const vector = Buffer.from(new Float32Array(unit([0, 0, 0, 1])).buffer);
  raw.prepare("INSERT INTO records (collection_id, id, doc_id, document, metadata, embedding) VALUES (?, ?, ?, ?, ?, ?)")
    .run(collectionId, "legacy", "legacy.md", "旧版本写入的 Obsidian 插件说明", JSON.stringify({ doc_id: "legacy.md", path: "legacy.md" }), vector);
  raw.close();
  engine.close();
  const { VectorStoreEngine } = await loadModule("local-vector/vector-store-engine.ts");
  const reopened = new VectorStoreEngine(new DatabaseSync(file));
  t.after(() => reopened.close());
  assert.ok(reopened.hybridQuery(COLLECTION, QUERY, "obsidian", 3, 1).some((match) => match.id === "legacy"));
});

test("an existing store is backfilled in batches and searches stay vector-only until it is ready", async (t) => {
  const { engine, file, VectorStoreEngine } = await seededEngine(t);
  engine.close();
  // Simulate a 1.2.x database created before the keyword index existed.
  const raw = new DatabaseSync(file);
  raw.exec(`DROP TRIGGER records_fts_insert; DROP TRIGGER records_fts_update; DROP TRIGGER records_fts_delete;
    DROP TABLE records_fts; DELETE FROM meta WHERE key LIKE 'fts_%';`);
  raw.close();

  const upgraded = new VectorStoreEngine(new DatabaseSync(file));
  t.after(() => upgraded.close());
  assert.deepEqual(upgraded.keywordStatus(), { state: "backfilling", indexed: 0, total: NOTES.length });
  const before = upgraded.hybridQuery(COLLECTION, QUERY, "useEffect", 3, 1);
  assert.ok(before.every((match) => match.matchedBy.length === 1 && match.matchedBy[0] === "vector"));

  assert.equal(upgraded.keywordBackfillStep(4), true);
  assert.deepEqual(upgraded.keywordStatus(), { state: "backfilling", indexed: 4, total: NOTES.length });
  // A write during backfill is indexed by the trigger and re-indexed idempotently later.
  upgraded.upsert(COLLECTION, [record("semantic-1", "关于知识管理 useEffect 的思考", [1, 0.05, 0, 0])]);
  while (upgraded.keywordBackfillStep(4)) { /* drain */ }
  assert.equal(upgraded.keywordStatus().state, "ready");
  const after = upgraded.hybridQuery(COLLECTION, QUERY, "useEffect", 6, 1).map((match) => match.id);
  assert.ok(after.includes("hooks") && after.includes("semantic-1"));
  assert.equal(after.filter((id) => id === "semantic-1").length, 1);
});
