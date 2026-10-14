import { Worker } from "worker_threads";

/**
 * Exact brute-force vector scan sharded across worker threads. The matrix lives in a
 * SharedArrayBuffer, so each query only posts buffer references and the query vector.
 * Measured on 100k x 768: one thread ~45 ms, four threads ~11 ms, identical results.
 * (An int8 coarse pass was measured too and gave no speedup in JavaScript.)
 */

export interface ScanCandidate {
  slot: number;
  /** ||row||^2 + ||q||^2 - 2 row.q, the squared L2 distance up to rounding. */
  distance: number;
}

interface ScanRequest {
  id: number;
  data: SharedArrayBuffer;
  norms: SharedArrayBuffer;
  start: number;
  end: number;
  dimension: number;
  query: Float32Array;
  queryNorm: number;
  limit: number;
}

/** Thread body; kept dependency-free because it is evaluated from source. */
function scanThread(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- evaluated from source in a worker, where import is unavailable
  const { parentPort } = require("worker_threads") as typeof import("worker_threads");
  parentPort?.on("message", (request: ScanRequest) => {
    const data = new Float32Array(request.data);
    const norms = new Float64Array(request.norms);
    const { start, end, dimension, query, queryNorm, limit } = request;
    const slots: number[] = [];
    const distances: number[] = [];
    // Bounded max-heap of the `limit` smallest distances.
    const swap = (left: number, right: number) => {
      const slot = slots[left]; slots[left] = slots[right]; slots[right] = slot;
      const distance = distances[left]; distances[left] = distances[right]; distances[right] = distance;
    };
    for (let slot = start; slot < end; slot += 1) {
      const offset = slot * dimension;
      let sum0 = 0; let sum1 = 0; let sum2 = 0; let sum3 = 0; let index = 0;
      for (; index + 3 < dimension; index += 4) {
        sum0 += data[offset + index] * query[index];
        sum1 += data[offset + index + 1] * query[index + 1];
        sum2 += data[offset + index + 2] * query[index + 2];
        sum3 += data[offset + index + 3] * query[index + 3];
      }
      for (; index < dimension; index += 1) sum0 += data[offset + index] * query[index];
      const distance = norms[slot] + queryNorm - 2 * (sum0 + sum1 + sum2 + sum3);
      if (slots.length < limit) {
        slots.push(slot); distances.push(distance);
        let child = slots.length - 1;
        while (child > 0) {
          const parent = (child - 1) >> 1;
          if (distances[parent] >= distances[child]) break;
          swap(parent, child); child = parent;
        }
      } else if (distance < distances[0]) {
        slots[0] = slot; distances[0] = distance;
        let parent = 0;
        for (;;) {
          const left = parent * 2 + 1; const right = left + 1; let largest = parent;
          if (left < slots.length && distances[left] > distances[largest]) largest = left;
          if (right < slots.length && distances[right] > distances[largest]) largest = right;
          if (largest === parent) break;
          swap(largest, parent); parent = largest;
        }
      }
    }
    parentPort.postMessage({ id: request.id, slots, distances });
  });
}

export class ParallelVectorScanner {
  private readonly workers: Worker[];
  private nextId = 1;
  private disposed = false;

  constructor(readonly threads: number) {
    if (!Number.isSafeInteger(threads) || threads < 2) throw new Error("PARALLEL_SCAN_THREADS_INVALID");
    const source = `(${scanThread.toString()})();`;
    this.workers = Array.from({ length: threads }, () => {
      const worker = new Worker(source, { eval: true });
      worker.unref();
      return worker;
    });
  }

  /** Returns the `limit` nearest slots across every shard, sorted by distance then slot. */
  async scan(
    data: Float32Array,
    norms: Float64Array,
    size: number,
    dimension: number,
    query: Float32Array,
    queryNorm: number,
    limit: number,
  ): Promise<ScanCandidate[]> {
    if (this.disposed) throw new Error("PARALLEL_SCAN_DISPOSED");
    if (!(data.buffer instanceof SharedArrayBuffer) || !(norms.buffer instanceof SharedArrayBuffer)) {
      throw new Error("PARALLEL_SCAN_REQUIRES_SHARED_MEMORY");
    }
    const shards = this.workers.map((worker, index) => new Promise<ScanCandidate[]>((resolve, reject) => {
      const id = this.nextId++;
      const onMessage = (message: { id: number; slots: number[]; distances: number[] }) => {
        if (message.id !== id) return;
        cleanup();
        resolve(message.slots.map((slot, position) => ({ slot, distance: message.distances[position] })));
      };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => { worker.off("message", onMessage); worker.off("error", onError); };
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.postMessage({
        id,
        data: data.buffer as SharedArrayBuffer,
        norms: norms.buffer as SharedArrayBuffer,
        start: Math.floor((index * size) / this.workers.length),
        end: Math.floor(((index + 1) * size) / this.workers.length),
        dimension,
        query,
        queryNorm,
        limit,
      } satisfies ScanRequest);
    }));
    return (await Promise.all(shards)).flat()
      .sort((left, right) => left.distance - right.distance || left.slot - right.slot)
      .slice(0, limit);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all(this.workers.map((worker) => worker.terminate().catch(() => 0)));
  }
}

/** Threads to use for a CPU with `cpus` logical cores: leave one core for the rest of the system. */
export function parallelScanThreads(cpus: number): number {
  return Math.max(0, Math.min(4, Math.floor(cpus) - 1));
}
