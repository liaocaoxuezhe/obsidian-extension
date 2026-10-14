#!/usr/bin/env node

/**
 * Vector scan benchmark (P3.4): exact top-10 latency of the SQLite store engine, single
 * thread vs worker-thread shards, and top-10 agreement. Run with the managed runtime Node:
 *   <runtime>/node/bin/node benchmark/vector-scan.mjs [--rows 100000] [--dimension 768] [--threads 4]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (
  index % 2 === 0 ? [...pairs, [value.replace(/^--/, ""), all[index + 1]]] : pairs), []));
const rows = Number(args.rows ?? 100_000);
const dimension = Number(args.dimension ?? 768);
const threads = Number(args.threads ?? 4);

async function load(source) {
  const esbuild = (await import(path.join(repositoryRoot, "node_modules", "esbuild", "lib", "main.js"))).default;
  const result = await esbuild.build({ entryPoints: [path.join(repositoryRoot, "src", source)], bundle: true, platform: "node", format: "cjs", write: false });
  const module = { exports: {} };
  new Function("module", "exports", "require", "__filename", result.outputFiles[0].text)(module, module.exports, require, fileURLToPath(import.meta.url));
  return module.exports;
}

const { VectorStoreEngine } = await load("local-vector/vector-store-engine.ts");
const { ParallelVectorScanner } = await load("local-vector/parallel-scan.ts");
const { DatabaseSync } = require("node:sqlite");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-scan-benchmark-"));
const scanner = new ParallelVectorScanner(threads);
try {
  const engine = new VectorStoreEngine(new DatabaseSync(path.join(root, "vectors.sqlite")), { scanner, parallelThreshold: 1 });
  const collection = "analogy_vault-v2-0123456789abcdef_benchmark";
  engine.ensureCollection(collection);
  const vector = () => Array.from({ length: dimension }, () => Math.random() - 0.5);
  for (let offset = 0; offset < rows; offset += 1000) {
    engine.upsert(collection, Array.from({ length: Math.min(1000, rows - offset) }, (_, index) => ({
      id: `chunk-${offset + index}`, document: null, embedding: vector(), metadata: null,
    })));
  }
  const queries = Array.from({ length: 20 }, vector);
  engine.query(collection, queries[0], 10);
  await engine.queryAsync(collection, queries[0], 10);
  let inlineMs = 0;
  let parallelMs = 0;
  let agreement = 0;
  for (const query of queries) {
    let started = performance.now();
    const expected = engine.query(collection, query, 10).map((match) => match.id);
    inlineMs += performance.now() - started;
    started = performance.now();
    const actual = (await engine.queryAsync(collection, query, 10)).map((match) => match.id);
    parallelMs += performance.now() - started;
    agreement += actual.filter((id, index) => id === expected[index]).length / 10;
  }
  console.log(JSON.stringify({
    rows, dimension, threads,
    singleThreadMs: Number((inlineMs / queries.length).toFixed(1)),
    parallelMs: Number((parallelMs / queries.length).toFixed(1)),
    top10Agreement: Number((agreement / queries.length).toFixed(4)),
  }));
  engine.close();
} finally {
  await scanner.dispose();
  fs.rmSync(root, { recursive: true, force: true });
}
