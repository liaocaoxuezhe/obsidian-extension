/**
 * W3: real-proxy download check. Runs the plugin's runtime and model downloaders with the
 * production transport order (direct Node HTTPS, then a proxy-aware ranged transport) and
 * prints one JSON line per step. The proxy-aware transport stands in for Obsidian's
 * requestUrl (Electron's network stack, which follows the system proxy): it tunnels through
 * the HTTP proxy given by --proxy and follows redirects like Electron does.
 *
 *   node proxy-download-check.cjs <scenario> --proxy http://127.0.0.1:7897 --work <dir> [--asset-json <file>]
 * Scenarios: runtime | runtime-resume | model | proxy-auth
 * Run "runtime"/"model" under test/manual/proxy-only.sb to block every direct connection.
 */
import * as fs from "fs";
import * as http from "http";
import * as tls from "tls";
import * as path from "path";
import { createChunkedTransport, type ProxyAwareFetch } from "../../src/runtime/download-transport";
import { defaultRequest, downloadRuntimeAsset, type DownloadableAsset } from "../../src/runtime/runtime-downloader";
import { ensureModelFiles } from "../../src/local-vector/model-files";

const emit = (step: string, data: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ step, ...data })}\n`);

/** Error codes along the cause chain, e.g. DOWNLOAD_NETWORK_ERROR > EPERM. */
function causes(error: unknown): string {
  const parts: string[] = [];
  for (let current = error as { code?: string; message?: string; cause?: unknown } | undefined; current && parts.length < 5;
    current = current.cause as typeof current) {
    parts.push(String(current.code ?? current.message ?? current).slice(0, 80));
  }
  return parts.join(" > ");
}

function args(): Record<string, string> {
  const values: Record<string, string> = { scenario: process.argv[2] ?? "" };
  for (let index = 3; index < process.argv.length; index += 2) values[process.argv[index].replace(/^--/, "")] = process.argv[index + 1];
  return values;
}

/** CONNECT-tunnelled HTTPS fetch through an HTTP proxy, following redirects. */
export function proxyFetch(proxy: URL, authorization?: string): ProxyAwareFetch {
  const once = (target: URL, headers: Record<string, string>) => new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
    const connect = http.request({
      host: proxy.hostname, port: Number(proxy.port), method: "CONNECT", path: `${target.hostname}:443`,
      headers: authorization ? { "Proxy-Authorization": authorization } : {},
    });
    connect.once("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        resolve({ status: response.statusCode ?? 0, headers: {}, body: Buffer.alloc(0) });
        return;
      }
      // The tunnel already carries TLS, so the request itself is plain HTTP over that socket.
      const secure = tls.connect({ socket, servername: target.hostname });
      const request = http.request({
        host: target.hostname, path: `${target.pathname}${target.search}`, method: "GET",
        headers: { Host: target.hostname, "User-Agent": "Analogy-Proxy-Check", ...headers },
        createConnection: () => secure,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => secure.destroy());
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          headers: Object.fromEntries(Object.entries(res.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : String(value ?? "")])),
          body: Buffer.concat(chunks),
        }));
        res.on("error", reject);
      });
      request.on("error", reject);
      request.end();
    });
    connect.on("error", reject);
    connect.end();
  });
  return async ({ url, headers = {} }) => {
    let target = new URL(url);
    for (let hop = 0; hop < 6; hop += 1) {
      const response = await once(target, headers);
      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
        target = new URL(response.headers.location, target);
        continue;
      }
      return { status: response.status, headers: response.headers,
        arrayBuffer: response.body.buffer.slice(response.body.byteOffset, response.body.byteOffset + response.body.byteLength) as ArrayBuffer };
    }
    throw new Error("too many redirects");
  };
}

async function main(): Promise<void> {
  const values = args();
  const proxy = new URL(values.proxy ?? "http://127.0.0.1:7897");
  const work = path.resolve(values.work ?? "proxy-check");
  fs.mkdirSync(work, { recursive: true });
  // --auth user:pass sends Basic proxy credentials, as Electron does after the system prompt.
  const authorization = values.auth ? `Basic ${Buffer.from(values.auth).toString("base64")}` : undefined;
  const transports = [defaultRequest, createChunkedTransport(proxyFetch(proxy, authorization), { chunkSize: 4 * 1024 * 1024 })];
  const started = Date.now();
  if (values.scenario.startsWith("runtime")) {
    const asset = JSON.parse(fs.readFileSync(values["asset-json"], "utf8")) as DownloadableAsset;
    const partPath = path.join(work, `${asset.id}.part`);
    if (values.scenario === "runtime-resume") {
      // Interrupt after ~20 MB, then resume with a fresh call, as after an Obsidian restart.
      const controller = new AbortController();
      await downloadRuntimeAsset({ asset, partPath, signal: controller.signal, requests: transports,
        onProgress: (progress) => { if (progress.receivedBytes > 20_000_000) controller.abort(); } })
        .then(() => emit("interrupt", { ok: false, message: "finished before interruption" }),
          (error: { code?: string; message?: string }) => emit("interrupt", {
            ok: error?.code === "DOWNLOAD_CANCELLED", code: error?.code ?? error?.message,
            partBytes: fs.existsSync(partPath) ? fs.statSync(partPath).size : 0,
          }));
    }
    try {
      const result = await downloadRuntimeAsset({ asset, partPath, signal: new AbortController().signal, requests: transports });
      emit(values.scenario, { ok: true, resumed: result.resumed, bytes: result.receivedBytes, seconds: Math.round((Date.now() - started) / 1000) });
    } catch (error) {
      emit(values.scenario, { ok: false, code: causes(error) });
    }
  } else if (values.scenario === "model") {
    try {
      await ensureModelFiles({ shortName: values.model ?? "bge-small-zh", cacheDir: path.join(work, "models"), transports });
      emit("model", { ok: true, seconds: Math.round((Date.now() - started) / 1000) });
    } catch (error) {
      emit("model", { ok: false, code: (error as { code?: string })?.code ?? String(error), evidence: (error as { evidence?: string[] })?.evidence });
    }
  } else if (values.scenario === "proxy-auth") {
    const asset = JSON.parse(fs.readFileSync(values["asset-json"], "utf8")) as DownloadableAsset;
    try {
      await downloadRuntimeAsset({ asset, partPath: path.join(work, "auth.part"), signal: new AbortController().signal, requests: transports });
      emit("proxy-auth", { ok: false, message: "download unexpectedly succeeded" });
    } catch (error) {
      emit("proxy-auth", { ok: true, code: (error as { code?: string })?.code ?? String(error) });
    }
  } else {
    throw new Error(`unknown scenario ${values.scenario}`);
  }
}

if (require.main === module) main().catch((error) => { emit("fatal", { ok: false, message: String((error as Error)?.message ?? error) }); process.exitCode = 1; });
