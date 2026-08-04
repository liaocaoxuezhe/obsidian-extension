import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export const ARCHIVE_LIMITS = Object.freeze({
  compressedBytes: 512 * 1024 * 1024,
  unpackedBytes: 768 * 1024 * 1024,
  entryBytes: 256 * 1024 * 1024,
  entries: 30_000,
  pathBytes: 512,
});

export const NORMALIZED_MTIME_SECONDS = 946684800;
const TAR_BLOCK_SIZE = 512;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;

export function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function fail(message) {
  throw new Error(`Invalid runtime archive: ${message}`);
}

function assertPortableArchivePath(rawPath, { directory = false } = {}) {
  if (typeof rawPath !== "string" || !rawPath || rawPath.includes("\\") || rawPath.includes("\0")) {
    fail("entry path is empty or non-portable");
  }
  const normalized = directory && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)
    || normalized.split("/").some((component) => !component || component === "." || component === "..")
    || Buffer.byteLength(normalized, "utf8") > ARCHIVE_LIMITS.pathBytes
    || path.posix.normalize(normalized) !== normalized) {
    fail(`unsafe or non-canonical entry path: ${rawPath}`);
  }
  return normalized;
}

function readOctal(header, offset, length, label) {
  const field = header.subarray(offset, offset + length);
  if ((field[0] & 0x80) !== 0) fail(`${label} uses unsupported base-256 encoding`);
  const value = field.toString("ascii").replace(/\0.*$/, "").trim();
  if (value && !/^[0-7]+$/.test(value)) fail(`${label} is not canonical octal`);
  const parsed = value ? Number.parseInt(value, 8) : 0;
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(`${label} is outside safe integer range`);
  return parsed;
}

function tarText(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul < 0 ? field.length : nul).toString("utf8");
}

function verifyTarChecksum(header) {
  const expected = readOctal(header, 148, 8, "tar checksum");
  let sum = 0;
  for (let index = 0; index < header.length; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (sum !== expected) fail("tar header checksum mismatch");
}

function parseTar(archive) {
  if (archive.length < 18 || archive[0] !== 0x1f || archive[1] !== 0x8b || archive[2] !== 8) {
    fail("tar.gz does not have a gzip header");
  }
  if ((archive[3] & 0xe0) !== 0 || archive.readUInt32LE(4) !== 0) {
    fail("gzip header is not canonical (reserved flags or mtime)");
  }
  let tar;
  try {
    tar = zlib.gunzipSync(archive, { maxOutputLength: ARCHIVE_LIMITS.unpackedBytes });
  } catch (error) {
    fail(`tar.gz decompression failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entries = [];
  const seen = new Set();
  let payloadBytes = 0;
  let offset = 0;
  let zeroBlocks = 0;
  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    offset += TAR_BLOCK_SIZE;
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks === 2) break;
      continue;
    }
    if (zeroBlocks !== 0) fail("non-zero tar header after end marker");
    if (entries.length >= ARCHIVE_LIMITS.entries) fail("too many entries");
    verifyTarChecksum(header);
    const name = [tarText(header, 345, 155), tarText(header, 0, 100)].filter(Boolean).join("/");
    const type = tarText(header, 156, 1) || "0";
    if (type !== "0" && type !== "5") fail(`unsupported tar entry type ${JSON.stringify(type)} for ${name}`);
    const directory = type === "5";
    const canonicalPath = assertPortableArchivePath(name, { directory });
    if (seen.has(canonicalPath)) fail(`duplicate entry: ${canonicalPath}`);
    seen.add(canonicalPath);
    const size = readOctal(header, 124, 12, `size for ${canonicalPath}`);
    if (directory && size !== 0) fail(`directory has a payload: ${canonicalPath}`);
    if (size > ARCHIVE_LIMITS.entryBytes) fail(`entry exceeds size limit: ${canonicalPath}`);
    payloadBytes += size;
    if (payloadBytes > ARCHIVE_LIMITS.unpackedBytes) fail("total payload exceeds size limit");
    const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    if (offset + paddedSize > tar.length) fail(`truncated payload: ${canonicalPath}`);
    if (tarText(header, 257, 6) !== "ustar" || tarText(header, 263, 2) !== "00") {
      fail(`entry is not canonical USTAR: ${canonicalPath}`);
    }
    const mode = readOctal(header, 100, 8, `mode for ${canonicalPath}`);
    const uid = readOctal(header, 108, 8, `uid for ${canonicalPath}`);
    const gid = readOctal(header, 116, 8, `gid for ${canonicalPath}`);
    const mtime = readOctal(header, 136, 12, `mtime for ${canonicalPath}`);
    if (uid !== 0 || gid !== 0 || tarText(header, 265, 32) !== "root"
      || tarText(header, 297, 32) !== "root" || mtime !== NORMALIZED_MTIME_SECONDS) {
      fail(`entry ownership or timestamp is not canonical: ${canonicalPath}`);
    }
    const expectedMode = directory ? 0o755 : canonicalPath.endsWith("/node/bin/node") ? 0o755 : 0o644;
    if (mode !== expectedMode) fail(`entry mode is not canonical: ${canonicalPath}`);
    entries.push({
      path: canonicalPath,
      directory,
      mode,
      data: directory ? Buffer.alloc(0) : Buffer.from(tar.subarray(offset, offset + size)),
    });
    offset += paddedSize;
  }
  if (zeroBlocks !== 2 || offset !== tar.length) fail("tar must end with exactly two zero blocks");
  return entries;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    table[value] = crc >>> 0;
  }
  return table;
})();

export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function findZipEocd(archive) {
  if (archive.length < 22) fail("zip is too short");
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset -= 1) {
    if (archive.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) return offset;
  }
  fail("zip end-of-central-directory is missing");
}

function parseZip(archive) {
  const eocd = findZipEocd(archive);
  if (archive.readUInt16LE(eocd + 4) !== 0 || archive.readUInt16LE(eocd + 6) !== 0
    || archive.readUInt16LE(eocd + 8) !== archive.readUInt16LE(eocd + 10)
    || archive.readUInt16LE(eocd + 20) !== 0 || eocd + 22 !== archive.length) {
    fail("zip must be single-disk, comment-free, and have no trailing data");
  }
  const count = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (count > ARCHIVE_LIMITS.entries || centralOffset + centralSize !== eocd) fail("zip central directory bounds are invalid");
  const entries = [];
  const localRecords = [];
  const seen = new Set();
  let cursor = centralOffset;
  let payloadBytes = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > eocd || archive.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) fail("malformed zip central directory");
    const versionMadeBy = archive.readUInt16LE(cursor + 4);
    const versionNeeded = archive.readUInt16LE(cursor + 6);
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const dosTime = archive.readUInt16LE(cursor + 12);
    const dosDate = archive.readUInt16LE(cursor + 14);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const unpackedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const disk = archive.readUInt16LE(cursor + 34);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    if (versionMadeBy !== 0x0314 || versionNeeded !== 20 || flags !== 0x0800 || method !== 0
      || dosTime !== 0 || dosDate !== 0x2821 || extraLength !== 0 || commentLength !== 0 || disk !== 0) {
      fail("zip entry metadata is not canonical");
    }
    if (cursor + 46 + nameLength + extraLength + commentLength > eocd) fail("truncated zip central directory entry");
    const rawName = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const directory = rawName.endsWith("/");
    const canonicalPath = assertPortableArchivePath(rawName, { directory });
    if (Buffer.byteLength(rawName, "utf8") !== nameLength) fail(`zip name is not valid UTF-8: ${canonicalPath}`);
    if (seen.has(canonicalPath)) fail(`duplicate entry: ${canonicalPath}`);
    seen.add(canonicalPath);
    if (compressedSize !== unpackedSize || unpackedSize > ARCHIVE_LIMITS.entryBytes) fail(`zip entry size or method is invalid: ${canonicalPath}`);
    payloadBytes += unpackedSize;
    if (payloadBytes > ARCHIVE_LIMITS.unpackedBytes) fail("total payload exceeds size limit");
    if (localOffset + 30 > centralOffset || archive.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE) fail(`missing local zip header: ${canonicalPath}`);
    const localVersionNeeded = archive.readUInt16LE(localOffset + 4);
    const localFlags = archive.readUInt16LE(localOffset + 6);
    const localMethod = archive.readUInt16LE(localOffset + 8);
    const localDosTime = archive.readUInt16LE(localOffset + 10);
    const localDosDate = archive.readUInt16LE(localOffset + 12);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    if (localVersionNeeded !== versionNeeded || localFlags !== flags || localMethod !== method
      || localDosTime !== dosTime || localDosDate !== dosDate
      || localNameLength !== nameLength || localExtraLength !== extraLength
      || archive.readUInt32LE(localOffset + 14) !== expectedCrc
      || archive.readUInt32LE(localOffset + 18) !== compressedSize
      || archive.readUInt32LE(localOffset + 22) !== unpackedSize) {
      fail(`local zip header differs from central directory: ${canonicalPath}`);
    }
    const localName = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    const centralName = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    if (!localName.equals(centralName)) fail(`local zip name differs from central directory: ${canonicalPath}`);
    const dataOffset = localOffset + 30 + localNameLength;
    if (dataOffset + compressedSize > centralOffset) fail(`truncated zip payload: ${canonicalPath}`);
    const data = Buffer.from(archive.subarray(dataOffset, dataOffset + compressedSize));
    if (crc32(data) !== expectedCrc) fail(`zip CRC mismatch: ${canonicalPath}`);
    const unixType = (externalAttributes >>> 16) & 0xf000;
    const mode = (externalAttributes >>> 16) & 0o777;
    const expectedMode = directory ? 0o755 : /\/node\/bin\/node(?:\.exe)?$/.test(canonicalPath) ? 0o755 : 0o644;
    if (unixType !== (directory ? 0x4000 : 0x8000) || mode !== expectedMode) fail(`zip entry mode/type is not canonical: ${canonicalPath}`);
    entries.push({ path: canonicalPath, directory, mode, data: directory ? Buffer.alloc(0) : data });
    localRecords.push({ path: canonicalPath, start: localOffset, end: dataOffset + compressedSize });
    cursor += 46 + nameLength;
  }
  if (cursor !== eocd) fail("zip central directory has undeclared bytes");
  localRecords.sort((left, right) => left.start - right.start);
  let expectedLocalOffset = 0;
  for (const record of localRecords) {
    if (record.start !== expectedLocalOffset || record.end < record.start) {
      fail(`zip must have a continuous, gap-free local file region before the central directory: ${record.path}`);
    }
    expectedLocalOffset = record.end;
  }
  if (expectedLocalOffset !== centralOffset) fail("zip must have a continuous, gap-free local file region before the central directory");
  return entries;
}

export function readRuntimeArchive(filename, archiveKind) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > ARCHIVE_LIMITS.compressedBytes) {
    fail("pack must be a non-empty regular file within the compressed-size limit");
  }
  const archive = fs.readFileSync(filename);
  const entries = archiveKind === "tar.gz" ? parseTar(archive) : archiveKind === "zip" ? parseZip(archive) : fail(`unsupported kind ${archiveKind}`);
  const paths = entries.map((entry) => entry.path);
  const sorted = [...paths].sort(compareUtf8Bytes);
  if (JSON.stringify(paths) !== JSON.stringify(sorted)) fail("entries are not sorted by UTF-8 bytes");
  return entries;
}

function splitUstarPath(entryPath, directory) {
  const rendered = entryPath;
  if (Buffer.byteLength(rendered, "utf8") <= 100) return { name: rendered, prefix: "" };
  const components = rendered.split("/");
  for (let index = components.length - 1; index > 0; index -= 1) {
    const prefix = components.slice(0, index).join("/");
    const name = components.slice(index).join("/");
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(name, "utf8") <= 100) return { name, prefix };
  }
  throw new Error(`Runtime archive path exceeds USTAR limits: ${rendered}`);
}

function writeTarText(header, offset, length, value) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > length) throw new Error(`USTAR field is too long: ${value}`);
  encoded.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  const rendered = value.toString(8).padStart(length - 1, "0");
  if (rendered.length !== length - 1) throw new Error(`USTAR numeric field overflow: ${value}`);
  header.write(rendered, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function createTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(TAR_BLOCK_SIZE);
    const fields = splitUstarPath(entry.path, entry.directory);
    writeTarText(header, 0, 100, fields.name);
    writeTarOctal(header, 100, 8, entry.mode);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, entry.directory ? 0 : entry.data.length);
    writeTarOctal(header, 136, 12, NORMALIZED_MTIME_SECONDS);
    header.fill(0x20, 148, 156);
    header[156] = entry.directory ? 0x35 : 0x30;
    writeTarText(header, 257, 6, "ustar");
    writeTarText(header, 263, 2, "00");
    writeTarText(header, 265, 32, "root");
    writeTarText(header, 297, 32, "root");
    writeTarText(header, 345, 155, fields.prefix);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header);
    if (!entry.directory) {
      chunks.push(entry.data);
      const padding = (TAR_BLOCK_SIZE - (entry.data.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
      if (padding) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

function createZip(entries) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(`${entry.path}${entry.directory ? "/" : ""}`, "utf8");
    const data = entry.directory ? Buffer.alloc(0) : entry.data;
    const checksum = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(ZIP_LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x2821, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(ZIP_CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x2821, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((((entry.directory ? 0x4000 : 0x8000) | entry.mode) << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centrals.push(central);
    localOffset += local.length + data.length;
  }
  const centralOffset = localOffset;
  const centralSize = centrals.reduce((sum, value) => sum + value.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_EOCD_SIGNATURE, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

async function collectTreeEntries(root, relative = "") {
  const result = [];
  const names = (await fs.promises.readdir(path.join(root, ...relative.split("/").filter(Boolean)), { withFileTypes: true }))
    .map((entry) => entry.name).sort(compareUtf8Bytes);
  for (const name of names) {
    const childRelative = path.posix.join(relative, name);
    const absolute = path.join(root, ...childRelative.split("/"));
    const stat = await fs.promises.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Runtime pack cannot contain symbolic links: ${childRelative}`);
    if (stat.isDirectory()) {
      result.push({ path: childRelative, directory: true, mode: 0o755, data: Buffer.alloc(0) });
      result.push(...await collectTreeEntries(root, childRelative));
    } else if (stat.isFile()) {
      result.push({
        path: childRelative,
        directory: false,
        mode: /(?:^|\/)node\/bin\/node(?:\.exe)?$/.test(childRelative) ? 0o755 : 0o644,
        data: await fs.promises.readFile(absolute),
      });
    } else {
      throw new Error(`Runtime pack contains unsupported filesystem entry: ${childRelative}`);
    }
  }
  return result;
}

export async function createDeterministicRuntimeArchive(packParent, packRoot, archiveKind) {
  const rootName = path.basename(packRoot);
  const entries = [{ path: rootName, directory: true, mode: 0o755, data: Buffer.alloc(0) }];
  for (const entry of await collectTreeEntries(packRoot)) entries.push({ ...entry, path: `${rootName}/${entry.path}` });
  entries.sort((left, right) => compareUtf8Bytes(left.path, right.path));
  if (entries.length > ARCHIVE_LIMITS.entries) throw new Error("Runtime pack has too many entries");
  const archive = archiveKind === "tar.gz" ? createTar(entries) : archiveKind === "zip" ? createZip(entries) : null;
  if (!archive) throw new Error(`Unsupported runtime archive kind: ${archiveKind}`);
  if (archive.length > ARCHIVE_LIMITS.compressedBytes) throw new Error("Runtime pack exceeds compressed-size limit");
  return archive;
}
