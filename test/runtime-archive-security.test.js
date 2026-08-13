"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");
const ts = require("typescript");

const loadedTypeScriptModules = new Map();

function loadTypeScriptFile(filename) {
  if (loadedTypeScriptModules.has(filename)) return loadedTypeScriptModules.get(filename);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  loadedTypeScriptModules.set(filename, module.exports);
  const localRequire = (specifier) => {
    if (!specifier.startsWith(".")) return require(specifier);
    const resolved = path.resolve(path.dirname(filename), specifier);
    return fs.existsSync(`${resolved}.ts`) ? loadTypeScriptFile(`${resolved}.ts`) : require(resolved);
  };
  Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports, localRequire, module, filename, path.dirname(filename),
  );
  loadedTypeScriptModules.set(filename, module.exports);
  return module.exports;
}

function loadExtractor() {
  return loadTypeScriptFile(path.join(process.cwd(), "src/runtime/archive-extractor.ts"));
}

function crc32(body) {
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const body = Buffer.from(entry.body || "");
    const compressedBody = entry.method === 8 ? zlib.deflateRawSync(body) : body;
    const flags = entry.flags === undefined ? 0x0800 : entry.flags;
    const method = entry.method || 0;
    const checksum = entry.crc === undefined ? crc32(body) : entry.crc;
    const declaredSize = entry.declaredSize === undefined ? body.length : entry.declaredSize;
    const declaredCompressedSize = entry.compressedSize === undefined ? compressedBody.length : entry.compressedSize;
    const extra = Buffer.from(entry.extra || []);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(entry.localCrc === undefined ? checksum : entry.localCrc, 14);
    local.writeUInt32LE(entry.localCompressedSize === undefined ? declaredCompressedSize : entry.localCompressedSize, 18);
    local.writeUInt32LE(entry.localSize === undefined ? declaredSize : entry.localSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    localParts.push(local, name, extra, compressedBody);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(3 << 8, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(declaredCompressedSize, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(((entry.mode || 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name, extra);
    localOffset += local.length + name.length + extra.length + compressedBody.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function withZip64Locator(zip) {
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  return Buffer.concat([zip.subarray(0, -22), locator, zip.subarray(-22)]);
}

function tarOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  buffer.write(encoded, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function makeTarGz(entries) {
  const parts = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    tarOctal(header, 100, 8, entry.mode || 0o644);
    tarOctal(header, 108, 8, 0);
    tarOctal(header, 116, 8, 0);
    const body = Buffer.from(entry.body || "");
    tarOctal(header, 124, 12, entry.declaredSize === undefined ? body.length : entry.declaredSize);
    tarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type || "0").charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    tarOctal(header, 148, 8, [...header].reduce((sum, byte) => sum + byte, 0));
    parts.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

async function fixture(t, archiveBody) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "Analogy 解包 空格 "));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const archivePath = path.join(root, "已校验 runtime.part");
  const stagingRoot = path.join(root, "staging 中文 目录");
  await fs.promises.writeFile(archivePath, archiveBody);
  return { archivePath, stagingRoot };
}

for (const [label, entry] of [
  ["parent traversal", { name: "../escape", body: "bad" }],
  ["absolute path", { name: "/tmp/escape", body: "bad" }],
  ["symbolic link", { name: "link", body: "target", mode: 0o120777 }],
]) {
  test(`zip rejects ${label} entries before writing staging content`, async (t) => {
    const input = await fixture(t, makeZip([entry]));
    await assert.rejects(
      loadExtractor().extractRuntimeArchive({ ...input, archive: "zip" }),
      /ARCHIVE_UNSAFE_ENTRY/,
    );
    assert.deepEqual(await fs.promises.readdir(input.stagingRoot), []);
  });
}

test("zip rejects duplicate normalized filenames", async (t) => {
  const input = await fixture(t, makeZip([
    { name: "bin/runtime", body: "one" },
    { name: "bin/runtime", body: "two" },
  ]));
  await assert.rejects(
    loadExtractor().extractRuntimeArchive({ ...input, archive: "zip" }),
    /ARCHIVE_DUPLICATE_ENTRY/,
  );
  assert.deepEqual(await fs.promises.readdir(input.stagingRoot), []);
});

test("zip rejects a declared unpacked total above 2 GiB", async (t) => {
  const input = await fixture(t, makeZip([{ name: "huge.bin", declaredSize: 0x80000001 }]));
  await assert.rejects(
    loadExtractor().extractRuntimeArchive({ ...input, archive: "zip" }),
    /ARCHIVE_SIZE_LIMIT/,
  );
  assert.deepEqual(await fs.promises.readdir(input.stagingRoot), []);
});

test("zip rejects content whose CRC32 does not match the signed central metadata", async (t) => {
  const input = await fixture(t, makeZip([{ name: "bin/runtime", body: "tampered", crc: 0x12345678 }]));
  await assert.rejects(loadExtractor().extractRuntimeArchive({ ...input, archive: "zip" }), /ARCHIVE_CRC_MISMATCH/);
});

test("zip rejects a directory entry with a nonzero CRC32", async (t) => {
  const input = await fixture(t, makeZip([{ name: "bin/", crc: 1, mode: 0o040755 }]));
  await assert.rejects(loadExtractor().extractRuntimeArchive({ ...input, archive: "zip" }), /ARCHIVE_CRC_MISMATCH/);
});

for (const entry of [
  { name: "crc-mismatch", body: "safe", localCrc: 1 },
  { name: "compressed-size-mismatch", body: "safe", localCompressedSize: 3 },
  { name: "size-mismatch", body: "safe", localSize: 3 },
]) {
  test(`zip rejects inconsistent local metadata for ${entry.name}`, async (t) => {
    const input = await fixture(t, makeZip([entry]));
    await assert.rejects(loadExtractor().extractRuntimeArchive({ ...input, archive: "zip" }), /ARCHIVE_INVALID_FORMAT/);
  });
}

test("zip fails closed on data descriptors", async (t) => {
  const input = await fixture(t, makeZip([{ name: "descriptor", body: "safe", flags: 0x0808 }]));
  await assert.rejects(loadExtractor().extractRuntimeArchive({ ...input, archive: "zip" }), /ARCHIVE_UNSUPPORTED_FORMAT/);
});

test("zip fails closed when a ZIP64 EOCD locator is present", async (t) => {
  const input = await fixture(t, withZip64Locator(makeZip([{ name: "zip64", body: "safe" }])));
  await assert.rejects(loadExtractor().extractRuntimeArchive({ ...input, archive: "zip" }), /ARCHIVE_UNSUPPORTED_FORMAT/);
});

test("zip fails closed on ZIP64 sentinel fields", async (t) => {
  const zip = makeZip([{ name: "zip64-sentinel", body: "safe" }]);
  zip.writeUInt16LE(0xffff, zip.length - 22 + 10);
  const input = await fixture(t, zip);
  await assert.rejects(loadExtractor().extractRuntimeArchive({ ...input, archive: "zip" }), /ARCHIVE_UNSUPPORTED_FORMAT/);
});

test("zip fails closed on a ZIP64 extra field", async (t) => {
  const input = await fixture(t, makeZip([{
    name: "zip64-extra", body: "safe", extra: Buffer.from([0x01, 0x00, 0x00, 0x00]),
  }]));
  await assert.rejects(loadExtractor().extractRuntimeArchive({ ...input, archive: "zip" }), /ARCHIVE_UNSUPPORTED_FORMAT/);
});

test("zip rejects independently encoded NFC canonical duplicates", async (t) => {
  const input = await fixture(t, makeZip([
    { name: "caf\u00e9/runtime", body: "one" },
    { name: "cafe\u0301/runtime", body: "two" },
  ]));
  await assert.rejects(loadExtractor().extractRuntimeArchive({ ...input, archive: "zip" }), /ARCHIVE_DUPLICATE_ENTRY/);
});

test("zip rejects an entry data range overlapping the next local header", async (t) => {
  const input = await fixture(t, makeZip([
    { name: "first", body: "one", compressedSize: 50, declaredSize: 50, localCompressedSize: 50, localSize: 50 },
    { name: "second", body: "two" },
  ]));
  await assert.rejects(loadExtractor().extractRuntimeArchive({ ...input, archive: "zip" }), /ARCHIVE_INVALID_FORMAT/);
});

for (const unsafeName of [
  "CON.txt",
  "folder/file:secret",
  "trailing. ",
  "C:relative",
  "control\u0001name",
]) {
  test(`zip rejects Windows-unsafe component ${JSON.stringify(unsafeName)}`, async (t) => {
    const input = await fixture(t, makeZip([{ name: unsafeName, body: "bad" }]));
    await assert.rejects(loadExtractor().extractRuntimeArchive({ ...input, archive: "zip" }), /ARCHIVE_UNSAFE_ENTRY/);
  });
}

test("zip applies Windows case and trailing-dot canonicalization to duplicate detection", async (t) => {
  const input = await fixture(t, makeZip([
    { name: "folder/Runtime", body: "one" },
    { name: "FOLDER/runtime.", body: "two" },
  ]));
  await assert.rejects(loadExtractor().extractRuntimeArchive({ ...input, archive: "zip" }), /ARCHIVE_(DUPLICATE|UNSAFE)_ENTRY/);
});

test("zip bounds a high-compression-ratio entry by its declared output size", async (t) => {
  const input = await fixture(t, makeZip([{
    name: "bomb", body: Buffer.alloc(8 * 1024 * 1024, 0x41), method: 8, declaredSize: 32,
  }]));
  await assert.rejects(loadExtractor().extractRuntimeArchive({ ...input, archive: "zip" }), /ARCHIVE_SIZE_MISMATCH/);
});

test("archive extraction fails closed if its staging root is replaced by a symlink", async (t) => {
  const input = await fixture(t, makeZip([{ name: "bin/runtime", body: "safe" }]));
  const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), "Analogy outside staging "));
  t.after(() => fs.promises.rm(outside, { recursive: true, force: true }));
  const originalOpen = fs.promises.open;
  let replaced = false;
  fs.promises.open = async (filename, flags, mode) => {
    const numericFlags = typeof flags === "number" ? flags : 0;
    if (!replaced && filename === path.join(input.stagingRoot, "bin", "runtime")
      && (numericFlags & fs.constants.O_CREAT) !== 0) {
      replaced = true;
      await fs.promises.rename(input.stagingRoot, `${input.stagingRoot}.original`);
      await fs.promises.symlink(outside, input.stagingRoot, "dir");
    }
    return originalOpen(filename, flags, mode);
  };
  t.after(() => { fs.promises.open = originalOpen; });

  await assert.rejects(
    loadExtractor().extractRuntimeArchive({ ...input, archive: "zip" }),
    /ARCHIVE_UNSAFE_STAGING_ROOT/,
  );
  fs.promises.open = originalOpen;
  assert.deepEqual(await fs.promises.readdir(outside), []);
});

test("directory entries fail closed if the staging root changes during mkdir", async (t) => {
  const input = await fixture(t, makeZip([{ name: "bin/", mode: 0o040755 }]));
  const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), "Analogy outside mkdir "));
  t.after(() => fs.promises.rm(outside, { recursive: true, force: true }));
  const originalMkdir = fs.promises.mkdir;
  let replaced = false;
  fs.promises.mkdir = async (directory, options) => {
    if (!replaced && directory === path.join(input.stagingRoot, "bin")) {
      replaced = true;
      await fs.promises.rename(input.stagingRoot, `${input.stagingRoot}.original`);
      await fs.promises.symlink(outside, input.stagingRoot, "dir");
    }
    return originalMkdir(directory, options);
  };
  t.after(() => { fs.promises.mkdir = originalMkdir; });

  await assert.rejects(
    loadExtractor().extractRuntimeArchive({ ...input, archive: "zip" }),
    /ARCHIVE_UNSAFE_STAGING_ROOT/,
  );
  fs.promises.mkdir = originalMkdir;
  assert.deepEqual(await fs.promises.readdir(outside), []);
});

test("staging guard detects a root replaced by a new ordinary directory at the same path", async (t) => {
  const input = await fixture(t, makeZip([{ name: "bin/runtime", body: "safe" }]));
  const originalOpen = fs.promises.open;
  let replaced = false;
  fs.promises.open = async (filename, flags, mode) => {
    const numericFlags = typeof flags === "number" ? flags : 0;
    if (!replaced && filename === path.join(input.stagingRoot, "bin", "runtime")
      && (numericFlags & fs.constants.O_CREAT) !== 0) {
      replaced = true;
      await fs.promises.rename(input.stagingRoot, `${input.stagingRoot}.original`);
      await fs.promises.mkdir(path.join(input.stagingRoot, "bin"), { recursive: true });
    }
    return originalOpen(filename, flags, mode);
  };
  t.after(() => { fs.promises.open = originalOpen; });

  await assert.rejects(
    loadExtractor().extractRuntimeArchive({ ...input, archive: "zip" }),
    /ARCHIVE_UNSAFE_STAGING_ROOT/,
  );
  fs.promises.open = originalOpen;
});

test("output open detects a leaf replaced by another ordinary file", async (t) => {
  const input = await fixture(t, makeZip([{ name: "runtime", body: "safe" }]));
  const destination = path.join(input.stagingRoot, "runtime");
  const originalOpen = fs.promises.open;
  let replaced = false;
  fs.promises.open = async (filename, flags, mode) => {
    const handle = await originalOpen(filename, flags, mode);
    const numericFlags = typeof flags === "number" ? flags : 0;
    if (!replaced && filename === destination && (numericFlags & fs.constants.O_CREAT) !== 0) {
      replaced = true;
      await fs.promises.rename(destination, `${destination}.opened`);
      await fs.promises.writeFile(destination, "replacement");
    }
    return handle;
  };
  t.after(() => { fs.promises.open = originalOpen; });

  await assert.rejects(
    loadExtractor().extractRuntimeArchive({ ...input, archive: "zip" }),
    /ARCHIVE_UNSAFE_FILE/,
  );
  fs.promises.open = originalOpen;
  assert.equal(await fs.promises.readFile(destination, "utf8"), "replacement");
});

test("tar.gz rejects device entries", async (t) => {
  const input = await fixture(t, makeTarGz([{ name: "device", type: "3" }]));
  await assert.rejects(
    loadExtractor().extractRuntimeArchive({ ...input, archive: "tar.gz" }),
    /ARCHIVE_UNSAFE_ENTRY/,
  );
  assert.deepEqual(await fs.promises.readdir(input.stagingRoot), []);
});

for (const [label, entries, error] of [
  ["traversal", [{ name: "../escape", body: "bad" }], /ARCHIVE_UNSAFE_ENTRY/],
  ["symlink", [{ name: "link", type: "2" }], /ARCHIVE_UNSAFE_ENTRY/],
  ["duplicate", [{ name: "same", body: "one" }, { name: "same", body: "two" }], /ARCHIVE_DUPLICATE_ENTRY/],
  ["declared size over 2 GiB", [{ name: "huge", declaredSize: 0x80000001 }], /ARCHIVE_SIZE_LIMIT/],
]) {
  test(`tar.gz rejects ${label} entries`, async (t) => {
    const input = await fixture(t, makeTarGz(entries));
    await assert.rejects(loadExtractor().extractRuntimeArchive({ ...input, archive: "tar.gz" }), error);
    assert.deepEqual(await fs.promises.readdir(input.stagingRoot), []);
  });
}

test("tar.gz safely extracts a regular executable under a UTF-8 staging root", async (t) => {
  const input = await fixture(t, makeTarGz([{ name: "bin/运行 时", body: "safe", mode: 0o755 }]));
  await loadExtractor().extractRuntimeArchive({ ...input, archive: "tar.gz" });
  assert.equal(await fs.promises.readFile(path.join(input.stagingRoot, "bin", "运行 时"), "utf8"), "safe");
});
