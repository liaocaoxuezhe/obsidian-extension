import { runTestSet } from "./run-test-set.mjs";

if (process.env.ANALOGY_LEGACY_CHROMA_BIN && !process.env.ANALOGY_CHROMA_BIN) {
  throw new Error("ANALOGY_CHROMA_BIN is required for the real 0.5.x-to-1.4.4 migration contract");
}

runTestSet("runtime");
