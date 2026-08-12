"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");
const ts = require("typescript");

const loaded = new Map();
function loadTypeScriptFile(filename) {
  if (loaded.has(filename)) return loaded.get(filename);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  loaded.set(filename, module.exports);
  const localRequire = (specifier) => {
    if (!specifier.startsWith(".")) return require(specifier);
    const resolved = path.resolve(path.dirname(filename), specifier);
    return fs.existsSync(`${resolved}.ts`) ? loadTypeScriptFile(`${resolved}.ts`) : require(resolved);
  };
  Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports, localRequire, module, filename, path.dirname(filename),
  );
  loaded.set(filename, module.exports);
  return module.exports;
}

function downloader() {
  return loadTypeScriptFile(path.join(process.cwd(), "src/runtime/runtime-downloader.ts"));
}

function assetFor(body, overrides = {}) {
  const crypto = require("node:crypto");
  return {
    id: "chroma-test-darwin-arm64",
    kind: "chroma",
    platform: "darwin-arm64",
    version: "test",
    url: "https://downloads.example.test/runtime",
    fileName: "runtime",
    archive: "none",
    size: body.length,
    sha256: crypto.createHash("sha256").update(body).digest("hex"),
    executableRelativePath: "runtime",
    licenseName: "Apache-2.0",
    licenseUrl: "https://example.test/license",
    source: "development-fixture",
    ...overrides,
  };
}

function response(statusCode, headers, chunks, options = {}) {
  let index = 0;
  const stream = new Readable({
    read() {
      if (index >= chunks.length) {
        if (options.abortAtEnd) {
          this.destroy(new Error("socket interrupted"));
        } else {
          this.push(null);
        }
        return;
      }
      const chunk = chunks[index++];
      if (options.delay) setTimeout(() => this.push(chunk), options.delay);
      else this.push(chunk);
    },
  });
  stream.statusCode = statusCode;
  stream.headers = headers;
  return stream;
}

function requestSequence(entries, calls = []) {
  return async (url, options) => {
    calls.push({ url: url.toString(), headers: { ...options.headers } });
    const entry = entries.shift();
    if (entry instanceof Error) throw entry;
    return entry;
  };
}

async function fixture(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "analogy 下载 测试 "));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  return path.join(root, "带空格 runtime.part");
}

test("streams chunked HTTPS responses into a non-executable owner-only part and records atomic metadata", async (t) => {
  const partPath = await fixture(t);
  const body = Buffer.from("streamed runtime payload");
  const asset = assetFor(body);
  const progress = [];
  const result = await downloader().downloadRuntimeAsset({
    asset,
    partPath,
    signal: new AbortController().signal,
    request: requestSequence([
      response(200, { "content-length": String(body.length), etag: '"v1"' }, [body.subarray(0, 7), body.subarray(7)]),
    ]),
    onProgress: (value) => progress.push(value),
  });

  assert.equal(result.path, partPath);
  assert.equal(result.resumed, false);
  assert.deepEqual(await fs.promises.readFile(partPath), body);
  assert.equal((await fs.promises.stat(partPath)).mode & 0o777, 0o600);
  assert.equal((await fs.promises.stat(partPath)).mode & 0o111, 0);
  assert.deepEqual(JSON.parse(await fs.promises.readFile(`${partPath}.meta.json`, "utf8")), {
    schemaVersion: 1,
    assetId: asset.id,
    sha256: asset.sha256,
    expectedSize: body.length,
    etag: '"v1"',
    lastModified: null,
  });
  assert.equal(progress.at(-1).receivedBytes, body.length);
  assert.equal(progress.at(-1).totalBytes, body.length);
  assert.equal(progress.at(-1).percent, 100);
});

test("reports null response-derived totals without content-length and limits non-final progress to once per 100ms", async (t) => {
  const partPath = await fixture(t);
  const body = Buffer.from("abcd");
  const times = [0, 20, 50, 99, 100, 140, 200];
  const progress = [];
  await downloader().downloadRuntimeAsset({
    asset: assetFor(body), partPath, signal: new AbortController().signal,
    request: requestSequence([response(200, {}, [...body].map((byte) => Buffer.from([byte])))]),
    now: () => times.shift() ?? 200,
    onProgress: (value) => progress.push(value),
  });

  assert.ok(progress.length <= 3, `unexpected progress count: ${progress.length}`);
  assert.equal(progress[0].totalBytes, null);
  assert.equal(progress[0].percent, null);
  assert.equal(progress.at(-1).receivedBytes, body.length);
});

test("keeps the trailing completion progress at least 100ms after the previous event", async (t) => {
  const partPath = await fixture(t);
  const body = Buffer.from("ab");
  const times = [0, 100, 101, 102, 200];
  let clock = -1;
  const progress = [];
  await downloader().downloadRuntimeAsset({
    asset: assetFor(body), partPath, signal: new AbortController().signal,
    request: requestSequence([response(200, {}, [body.subarray(0, 1), body.subarray(1)])]),
    now: () => {
      clock = times.shift() ?? 200;
      return clock;
    },
    onProgress: (value) => progress.push({ at: clock, value }),
  });

  assert.equal(progress.at(-1).value.receivedBytes, body.length);
  for (let index = 1; index < progress.length; index += 1) {
    assert.ok(progress[index].at - progress[index - 1].at >= 100, JSON.stringify(progress));
  }
});

test("cancels promptly while a trailing completion progress event is waiting", async (t) => {
  const partPath = await fixture(t);
  const body = Buffer.from("ab");
  const controller = new AbortController();
  const progress = [];
  let abortedAt = 0;
  const pending = downloader().downloadRuntimeAsset({
    asset: assetFor(body), partPath, signal: controller.signal,
    request: requestSequence([response(200, {}, [body.subarray(0, 1), body.subarray(1)])]),
    onProgress: (value) => progress.push(value),
  });
  setTimeout(() => {
    abortedAt = Date.now();
    controller.abort();
  }, 20);

  await assert.rejects(pending, /DOWNLOAD_CANCELLED/);
  assert.ok(Date.now() - abortedAt < 75, "cancellation waited for the trailing progress timer");
  assert.ok(progress.every((value) => value.receivedBytes < body.length));
});

test("destroys the response when invalid or unsafe Content-Length fails setup", async (t) => {
  const partPath = await fixture(t);
  const body = Buffer.from("payload");
  for (const [index, contentLength] of ["invalid", "9007199254740992"].entries()) {
    const res = response(200, { "content-length": contentLength }, [body]);
    let destroyCalled = false;
    const originalDestroy = res.destroy.bind(res);
    res.destroy = (...args) => {
      destroyCalled = true;
      return originalDestroy(...args);
    };
    await assert.rejects(
      downloader().downloadRuntimeAsset({
        asset: assetFor(body, { id: `bad-length-${index}` }),
        partPath: `${partPath}.${index}`,
        signal: new AbortController().signal,
        request: requestSequence([res]),
      }),
      /DOWNLOAD_INVALID_CONTENT_LENGTH/,
    );
    assert.equal(destroyCalled, true);
  }
});

test("destroys the response when atomic metadata publication fails", async (t) => {
  const partPath = await fixture(t);
  const body = Buffer.from("payload");
  const res = response(200, {}, [body]);
  let destroyCalled = false;
  const originalDestroy = res.destroy.bind(res);
  res.destroy = (...args) => {
    destroyCalled = true;
    return originalDestroy(...args);
  };
  const originalRename = fs.promises.rename;
  fs.promises.rename = async (source, destination) => {
    if (destination === `${partPath}.meta.json`) {
      const error = new Error("metadata rename denied");
      error.code = "EACCES";
      throw error;
    }
    return originalRename(source, destination);
  };
  try {
    await assert.rejects(
      downloader().downloadRuntimeAsset({
        asset: assetFor(body), partPath, signal: new AbortController().signal,
        request: requestSequence([res]),
      }),
      /metadata rename denied/,
    );
    assert.equal(destroyCalled, true);
  } finally {
    fs.promises.rename = originalRename;
  }
});

test("follows at most five HTTPS redirects and rejects protocol downgrade", async (t) => {
  const partPath = await fixture(t);
  const body = Buffer.from("ok");
  const redirects = Array.from({ length: 5 }, (_, index) =>
    response(302, { location: `https://cdn${index}.example.test/runtime` }, []));
  await downloader().downloadRuntimeAsset({
    asset: assetFor(body), partPath, signal: new AbortController().signal,
    request: requestSequence([...redirects, response(200, { "content-length": "2" }, [body])]),
  });
  await assert.rejects(
    downloader().downloadRuntimeAsset({
      asset: assetFor(body, { id: "other", url: "https://example.test/start" }),
      partPath: `${partPath}.other`, signal: new AbortController().signal,
      request: requestSequence([response(302, { location: "http://example.test/plain" }, [])]),
    }),
    /DOWNLOAD_INSECURE_REDIRECT/,
  );
  await assert.rejects(
    downloader().downloadRuntimeAsset({
      asset: assetFor(body, { id: "too-many", url: "https://example.test/start" }),
      partPath: `${partPath}.many`, signal: new AbortController().signal,
      request: requestSequence(Array.from({ length: 6 }, () => response(302, { location: "https://example.test/again" }, []))),
    }),
    /DOWNLOAD_TOO_MANY_REDIRECTS/,
  );
});

test("resumes only a matching part with Range and If-Range", async (t) => {
  const partPath = await fixture(t);
  const body = Buffer.from("resume this payload");
  const asset = assetFor(body);
  await fs.promises.writeFile(partPath, body.subarray(0, 7), { mode: 0o600 });
  await fs.promises.writeFile(`${partPath}.meta.json`, JSON.stringify({
    schemaVersion: 1, assetId: asset.id, sha256: asset.sha256, expectedSize: body.length,
    etag: '"stable"', lastModified: null,
  }), { mode: 0o600 });
  const calls = [];
  const result = await downloader().downloadRuntimeAsset({
    asset, partPath, signal: new AbortController().signal,
    request: requestSequence([
      response(206, {
        "content-range": `bytes 7-${body.length - 1}/${body.length}`,
        "content-length": String(body.length - 7), etag: '"stable"',
      }, [body.subarray(7)]),
    ], calls),
  });

  assert.equal(result.resumed, true);
  assert.deepEqual(calls[0].headers, { Range: "bytes=7-", "If-Range": '"stable"' });
  assert.deepEqual(await fs.promises.readFile(partPath), body);
});

test("uses Last-Modified as If-Range when ETag is unavailable", async (t) => {
  const partPath = await fixture(t);
  const body = Buffer.from("last modified fallback");
  const asset = assetFor(body);
  const lastModified = "Mon, 03 Aug 2026 12:00:00 GMT";
  await fs.promises.writeFile(partPath, body.subarray(0, 4), { mode: 0o600 });
  await fs.promises.writeFile(`${partPath}.meta.json`, JSON.stringify({
    schemaVersion: 1, assetId: asset.id, sha256: asset.sha256, expectedSize: body.length,
    etag: null, lastModified,
  }), { mode: 0o600 });
  const calls = [];
  await downloader().downloadRuntimeAsset({
    asset, partPath, signal: new AbortController().signal,
    request: requestSequence([response(206, {
      "content-range": `bytes 4-${body.length - 1}/${body.length}`,
      "last-modified": lastModified,
    }, [body.subarray(4)])], calls),
  });
  assert.equal(calls[0].headers["If-Range"], lastModified);
  assert.deepEqual(await fs.promises.readFile(partPath), body);
});

test("safely restarts when a server ignores Range instead of appending duplicate bytes", async (t) => {
  const partPath = await fixture(t);
  const body = Buffer.from("complete body");
  const asset = assetFor(body);
  await fs.promises.writeFile(partPath, body.subarray(0, 4), { mode: 0o600 });
  await fs.promises.writeFile(`${partPath}.meta.json`, JSON.stringify({
    schemaVersion: 1, assetId: asset.id, sha256: asset.sha256, expectedSize: body.length,
    etag: '"old"', lastModified: null,
  }), { mode: 0o600 });

  const result = await downloader().downloadRuntimeAsset({
    asset, partPath, signal: new AbortController().signal,
    request: requestSequence([response(200, { "content-length": String(body.length), etag: '"new"' }, [body])]),
  });
  assert.equal(result.resumed, false);
  assert.deepEqual(await fs.promises.readFile(partPath), body);
  assert.equal(JSON.parse(await fs.promises.readFile(`${partPath}.meta.json`)).etag, '"new"');
});

test("isolates a resumed part when a 206 validator changes and retries without Range", async (t) => {
  const partPath = await fixture(t);
  const body = Buffer.from("validator changed");
  const asset = assetFor(body);
  await fs.promises.writeFile(partPath, body.subarray(0, 5), { mode: 0o600 });
  await fs.promises.writeFile(`${partPath}.meta.json`, JSON.stringify({
    schemaVersion: 1, assetId: asset.id, sha256: asset.sha256, expectedSize: body.length,
    etag: '"old"', lastModified: null,
  }), { mode: 0o600 });
  const calls = [];
  await downloader().downloadRuntimeAsset({
    asset, partPath, signal: new AbortController().signal,
    request: requestSequence([
      response(206, {
        "content-range": `bytes 5-${body.length - 1}/${body.length}`, etag: '"new"',
      }, [body.subarray(5)]),
      response(200, { "content-length": String(body.length), etag: '"new"' }, [body]),
    ], calls),
  });
  assert.equal(calls[0].headers.Range, "bytes=5-");
  assert.deepEqual(calls[1].headers, {});
  assert.deepEqual(await fs.promises.readFile(partPath), body);
});

test("isolates mismatched asset metadata and changed validators before a clean download", async (t) => {
  const partPath = await fixture(t);
  const body = Buffer.from("new payload");
  const asset = assetFor(body);
  await fs.promises.writeFile(partPath, "stale", { mode: 0o600 });
  await fs.promises.writeFile(`${partPath}.meta.json`, JSON.stringify({
    schemaVersion: 1, assetId: "different", sha256: "0".repeat(64), expectedSize: 999,
    etag: '"stale"', lastModified: null,
  }), { mode: 0o600 });
  const calls = [];
  await downloader().downloadRuntimeAsset({
    asset, partPath, signal: new AbortController().signal,
    request: requestSequence([response(200, { etag: '"fresh"' }, [body])], calls),
  });

  assert.deepEqual(calls[0].headers, {});
  assert.deepEqual(await fs.promises.readFile(partPath), body);
  const siblings = await fs.promises.readdir(path.dirname(partPath));
  const partPrefix = `${path.basename(partPath)}.isolated-`;
  const metaPrefix = `${path.basename(partPath)}.meta.json.isolated-`;
  const isolatedPart = siblings.find((name) => name.startsWith(partPrefix));
  const isolatedMeta = siblings.find((name) => name.startsWith(metaPrefix));
  assert.ok(isolatedPart);
  assert.ok(isolatedMeta);
  assert.equal(isolatedPart.slice(partPrefix.length), isolatedMeta.slice(metaPrefix.length));
});

test("rejects symlink parts without touching their targets", async (t) => {
  const partPath = await fixture(t);
  const target = `${partPath}.target`;
  await fs.promises.writeFile(target, "do not touch");
  await fs.promises.symlink(target, partPath);
  await assert.rejects(
    downloader().downloadRuntimeAsset({
      asset: assetFor(Buffer.from("payload")), partPath, signal: new AbortController().signal,
      request: requestSequence([]),
    }),
    /DOWNLOAD_UNSAFE_PART/,
  );
  assert.equal(await fs.promises.readFile(target, "utf8"), "do not touch");
});

test("rejects a metadata file replaced by a symlink after lstat without reading its target", async (t) => {
  const partPath = await fixture(t);
  const body = Buffer.from("safe metadata race");
  const asset = assetFor(body);
  const metaPath = `${partPath}.meta.json`;
  const attackerPath = `${partPath}.attacker.json`;
  const validMetadata = JSON.stringify({
    schemaVersion: 1, assetId: asset.id, sha256: asset.sha256, expectedSize: body.length,
    etag: '"attacker"', lastModified: null,
  });
  await fs.promises.writeFile(partPath, body.subarray(0, 4), { mode: 0o600 });
  await fs.promises.writeFile(metaPath, validMetadata, { mode: 0o600 });
  await fs.promises.writeFile(attackerPath, validMetadata, { mode: 0o600 });

  const originalLstat = fs.promises.lstat;
  let swapped = false;
  fs.promises.lstat = async (candidate) => {
    const stat = await originalLstat(candidate);
    if (candidate === metaPath && !swapped) {
      swapped = true;
      await fs.promises.unlink(metaPath);
      await fs.promises.symlink(attackerPath, metaPath);
    }
    return stat;
  };
  try {
    await assert.rejects(
      downloader().downloadRuntimeAsset({
        asset, partPath, signal: new AbortController().signal,
        request: async () => { throw new Error("REQUEST_MUST_NOT_RUN"); },
      }),
      /DOWNLOAD_UNSAFE_META/,
    );
  } finally {
    fs.promises.lstat = originalLstat;
  }
  assert.equal(await fs.promises.readFile(attackerPath, "utf8"), validMetadata);
});

test("rejects interrupted responses, leaves only a resumable part, and creates no final executable", async (t) => {
  const partPath = await fixture(t);
  const body = Buffer.from("interrupted body");
  await assert.rejects(
    downloader().downloadRuntimeAsset({
      asset: assetFor(body), partPath, signal: new AbortController().signal,
      request: requestSequence([response(200, { etag: '"v1"' }, [body.subarray(0, 5)], { abortAtEnd: true })]),
    }),
    /socket interrupted|DOWNLOAD_NETWORK_ERROR/,
  );
  assert.deepEqual(await fs.promises.readFile(partPath), body.subarray(0, 5));
  assert.equal(fs.existsSync(partPath.replace(/\.part$/, "")), false);
});

test("cancellation destroys the response, closes the part, and returns DOWNLOAD_CANCELLED", async (t) => {
  const partPath = await fixture(t);
  const body = Buffer.from("cancel this payload");
  const controller = new AbortController();
  const res = response(200, { etag: '"v1"' }, [body.subarray(0, 6), body.subarray(6)], { delay: 30 });
  let destroyed = false;
  res.once("close", () => { destroyed = true; });
  const pending = downloader().downloadRuntimeAsset({
    asset: assetFor(body), partPath, signal: controller.signal,
    request: requestSequence([res]),
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, /DOWNLOAD_CANCELLED/);
  assert.equal(destroyed, true);
  await fs.promises.rename(partPath, `${partPath}.closed`);
  assert.equal(fs.existsSync(partPath.replace(/\.part$/, "")), false);
});

test("rejects a mismatched 206 Content-Range without appending attacker bytes", async (t) => {
  const partPath = await fixture(t);
  const body = Buffer.from("trusted payload");
  const asset = assetFor(body);
  const prefix = body.subarray(0, 4);
  await fs.promises.writeFile(partPath, prefix, { mode: 0o600 });
  await fs.promises.writeFile(`${partPath}.meta.json`, JSON.stringify({
    schemaVersion: 1, assetId: asset.id, sha256: asset.sha256, expectedSize: body.length,
    etag: '"same"', lastModified: null,
  }));
  await assert.rejects(
    downloader().downloadRuntimeAsset({
      asset, partPath, signal: new AbortController().signal,
      request: requestSequence([response(206, {
        "content-range": `bytes 5-${body.length - 1}/${body.length}`, etag: '"same"',
      }, [body.subarray(4)])]),
    }),
    /DOWNLOAD_INVALID_CONTENT_RANGE/,
  );
  assert.deepEqual(await fs.promises.readFile(partPath), prefix);
});
