/**
 * Headless Windows verification of the risky native path, run with the managed
 * runtime's own node.exe:
 *   node.exe harness.cjs probe   <packRoot>
 *   node.exe harness.cjs full    <packRoot> <workRoot>
 *   node.exe harness.cjs upgrade <workRoot> <assets.json> <fromArchive> <toArchive>
 * Prints one JSON line per step; never prints note content or secrets.
 * Bundle with test/manual/build-windows-harness.mjs; orchestrated by windows-clean-vm.sh.
 */
import * as fs from "fs";
import * as path from "path";
import { createProductionRuntimePipeline } from "../../src/onboarding/production-onboarding-dependencies";
import { detectEnvironment } from "../../src/runtime/environment-detector";
import { createRuntimePaths } from "../../src/runtime/runtime-paths";
import { readCurrentRuntime } from "../../src/runtime/atomic-runtime-installer";
import { RUNTIME_HISTORY_BINDING_REGISTRY, createRuntimeHistoryAssetResolver } from "../../src/runtime/runtime-manifest";
import { readTrustedRuntimeHistoryPointer } from "../../src/runtime/runtime-history-isolation";
import type { RuntimeAsset } from "../../src/runtime/runtime-types";
import { VectorStoreHost } from "../../src/local-vector/vector-store-host";
import { SqliteVectorStore } from "../../src/local-vector/sqlite-vector-store";
import { EmbeddingWorkerClient } from "../../src/local-vector/embedding-worker-client";
import { ensureModelFiles } from "../../src/local-vector/model-files";
import { runNativeProbe } from "../../src/runtime/native-probe";
import { collectEnvironmentFacts } from "../../src/diagnostics/environment-facts";

declare const WORKER_SOURCE: string;

const emit = (step: string, data: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ step, ...data })}\n`);
const failure = (error: unknown) => ({
  ok: false,
  code: (error as { code?: string })?.code ?? null,
  subStage: (error as { subStage?: string })?.subStage ?? null,
  evidence: (error as { evidence?: string[] })?.evidence ?? [],
  message: String((error as Error)?.message ?? error).slice(0, 300),
});

async function step<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  const started = Date.now();
  try {
    const value = await run();
    const { embeddings: _embeddings, ...printable } = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    emit(name, { ok: true, ms: Date.now() - started, ...printable });
    return value;
  } catch (error) {
    emit(name, { ms: Date.now() - started, ...failure(error) });
    return null;
  }
}

/** Installs the superseded runtime, proves it is detected as upgradable, then installs the new one. */
async function upgrade(workRoot: string, assetsFile: string, fromArchive: string, toArchive: string): Promise<void> {
  const { from, to } = JSON.parse(fs.readFileSync(assetsFile, "utf8")) as { from: RuntimeAsset; to: RuntimeAsset };
  const paths = createRuntimePaths(path.join(workRoot, "upgrade-data"), "vault-v2-0123456789abcdef");
  const install = async (asset: RuntimeAsset, archive: string) => {
    fs.mkdirSync(paths.downloads, { recursive: true });
    const copy = path.join(paths.downloads, `${asset.id}.harness`);
    fs.copyFileSync(archive, copy);
    const pipeline = createProductionRuntimePipeline({ asset, paths });
    const downloaded = { path: copy, metaPath: `${copy}.meta.json`, receivedBytes: 0, etag: null, lastModified: null, resumed: false };
    const verification = await pipeline.verify(downloaded);
    if (verification && !verification.ok) throw new Error(verification.errorCode ?? "DOWNLOAD_HASH_MISMATCH");
    return pipeline.install(downloaded);
  };
  const detect = () => detectEnvironment({
    platform: "win32-x64",
    paths,
    vectorBackend: "sqlite",
    getRuntimeAsset: () => to,
    inspectors: { embeddingModel: async () => "ready", index: async () => "ready" },
  });
  await step("upgrade-install-from", async () => ({ runtimeId: (await install(from, fromArchive)).runtimeId }));
  await step("upgrade-detect-upgradable", async () => {
    const report = await detect();
    if (report.embeddingRuntime !== "upgradable") throw new Error(`expected upgradable, got ${report.embeddingRuntime}`);
    return { recommendedAction: report.recommendedAction, upgrade: report.embeddingRuntimeUpgrade };
  });
  await step("upgrade-install-to", async () => ({ runtimeId: (await install(to, toArchive)).runtimeId }));
  await step("upgrade-detect-ready", async () => {
    const report = await detect();
    if (report.embeddingRuntime !== "ready") throw new Error(`expected ready, got ${report.embeddingRuntime}`);
    const current = await readCurrentRuntime(paths, "embedding-runtime");
    return { current: current?.runtimeId, previous: current?.previousRuntimeId };
  });
  await step("upgrade-history-trusted", async () => {
    const resolver = createRuntimeHistoryAssetResolver({ schemaVersion: 1, generatedAt: "", assets: [to] },
      RUNTIME_HISTORY_BINDING_REGISTRY, "win32-x64");
    const pointer = readTrustedRuntimeHistoryPointer(paths, "embedding-runtime", from.id, resolver);
    if (!pointer) throw new Error("superseded runtime is not a trusted history entry");
    return { isolatable: pointer.runtimeId };
  });
}

async function main(): Promise<void> {
  const [mode, packRoot, workRoot] = process.argv.slice(2);
  if (mode === "upgrade") {
    const [, upgradeWorkRoot, assetsFile, fromArchive, toArchive] = process.argv.slice(2);
    emit("environment", { facts: collectEnvironmentFacts(), node: process.version });
    await upgrade(upgradeWorkRoot, assetsFile, fromArchive, toArchive);
    return;
  }
  const nodeExecutable = [
    path.join(packRoot, "node", "bin", "node.exe"),
    path.join(packRoot, "node", "node.exe"),
    path.join(packRoot, "node", "bin", "node"),
  ]
    .find((candidate) => fs.existsSync(candidate));
  const moduleRoot = path.join(packRoot, "node_modules");
  if (!nodeExecutable) throw new Error(`node executable not found under ${packRoot}`);
  emit("environment", { facts: collectEnvironmentFacts(), node: process.version });

  await step("native-probe", async () => {
    await runNativeProbe({ nodeExecutable, moduleRoot });
    return {};
  });
  if (mode !== "full") return;

  fs.mkdirSync(workRoot, { recursive: true });
  const runtimeRoot = path.join(workRoot, "runtime");
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const cacheDir = path.join(workRoot, "models", "bge-small-en-v1.5");

  await step("model-download", async () => {
    let lastPercent = 0;
    await ensureModelFiles({
      shortName: "bge-small-en-v1.5",
      cacheDir,
      onProgress: (progress) => { lastPercent = progress.percent ?? lastPercent; },
    });
    return { lastPercent };
  });

  const worker = new EmbeddingWorkerClient({
    pluginDir: packRoot,
    workerRoot: runtimeRoot,
    workerDir: path.join(runtimeRoot, "worker"),
    buildId: "harness+win",
    workerBundleSource: WORKER_SOURCE,
    execPath: nodeExecutable,
    moduleRoot,
    timeoutMs: 180_000,
  });
  const host = new VectorStoreHost({
    databasePath: path.join(workRoot, "vaults", "向量 测试", "vector-store", "vectors.sqlite"),
    execPath: nodeExecutable,
    moduleRoot,
    pluginDir: packRoot,
    workerRoot: runtimeRoot,
    workerDir: path.join(runtimeRoot, "worker"),
    buildId: "harness+win",
    workerBundleSource: WORKER_SOURCE,
  });
  try {
    await step("worker-load-offline", async () => {
      await worker.initialize("Xenova/bge-small-en-v1.5", "q8", "mean", cacheDir, undefined, undefined, undefined, undefined, true);
      return {};
    });
    const vectors = await step("embed", async () => {
      const embeddings = await worker.embed(["苹果是一种水果", "The stock market fell today", "香蕉和橙子都是水果"]);
      return { dims: embeddings[0]?.length ?? 0, embeddings };
    });
    await step("sqlite-store", async () => {
      const store = new SqliteVectorStore(host);
      await store.initialize(8000, "vault-v2-0123456789abcdef", "bge-small-en-v1.5");
      const embeddings = (vectors as { embeddings: number[][] } | null)?.embeddings;
      if (!embeddings) throw new Error("no embeddings to store");
      await store.upsertDocument("水果.md", [
        { chunkId: "fruit#0", content: "a", embedding: embeddings[0], chunkIndex: 0, chunkCount: 1, sectionLabel: "" },
      ], { title: "水果", path: "水果.md", mtime: 1 });
      await store.upsertDocument("market.md", [
        { chunkId: "market#0", content: "b", embedding: embeddings[1], chunkIndex: 0, chunkCount: 1, sectionLabel: "" },
      ], { title: "market", path: "market.md", mtime: 1 });
      const results = await store.search(embeddings[2], 2);
      if (results[0]?.chunkId !== "fruit#0") throw new Error(`unexpected top result ${results[0]?.chunkId}`);
      return { count: await store.count(), top: results.map((item) => item.chunkId) };
    });
  } finally {
    await worker.dispose().catch(() => undefined);
    await host.dispose().catch(() => undefined);
  }
}

main().then(() => emit("done", { ok: true }), (error) => {
  emit("fatal", failure(error));
  process.exitCode = 1;
});
