import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { createGunzip, createInflateRaw } from "zlib";
import { RuntimeAsset } from "./runtime-types";

export const MAX_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TAR_STREAM_BYTES = MAX_UNPACKED_BYTES + 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100_000;

export interface ExtractRuntimeArchiveInput {
  archivePath: string;
  archive: RuntimeAsset["archive"];
  stagingRoot: string;
  singleFileName?: string;
}

interface ArchiveEntry {
  name: string;
  destination: string;
  isDirectory: boolean;
  mode: number;
  unpackedSize: number;
}

interface ZipEntry extends ArchiveEntry {
  flags: number;
  compressionMethod: number;
  compressedSize: number;
  crc32: number;
  localHeaderOffset: number;
  dataOffset?: number;
}

interface TarEntry extends ArchiveEntry {
  dataOffset: number;
}

interface StagingGuard {
  root: string;
  realRoot: string;
  rootDevice: number;
  rootInode: number;
}

function archiveError(code: string, cause?: unknown): Error {
  const error = new Error(code);
  const coded = error as Error & { code?: string; cause?: unknown };
  coded.code = code;
  if (cause !== undefined) coded.cause = cause;
  return error;
}

function normalizedEntryName(rawName: string): string {
  if (!rawName || rawName.includes("\0")) throw archiveError("ARCHIVE_UNSAFE_ENTRY");
  const portableName = rawName.replace(/\\/g, "/");
  if (portableName.startsWith("/") || /^\/?[a-zA-Z]:\//.test(portableName)) {
    throw archiveError("ARCHIVE_UNSAFE_ENTRY");
  }
  const withoutTrailingSlash = portableName.endsWith("/")
    ? portableName.slice(0, -1)
    : portableName;
  const components = withoutTrailingSlash.split("/");
  if (!withoutTrailingSlash || components.some((part) => !part || part === "." || part === "..")) {
    throw archiveError("ARCHIVE_UNSAFE_ENTRY");
  }
  for (const component of components) {
    if (/[\x00-\x1f<>:"|?*]/.test(component) || /[. ]$/.test(component)) {
      throw archiveError("ARCHIVE_UNSAFE_ENTRY");
    }
    const windowsBaseName = component.split(".", 1)[0].toUpperCase();
    if (/^(CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])$/.test(windowsBaseName)) {
      throw archiveError("ARCHIVE_UNSAFE_ENTRY");
    }
  }
  return components.join("/").normalize("NFC");
}

function containedDestination(stagingRoot: string, entryName: string): string {
  const destination = path.resolve(stagingRoot, ...entryName.split("/"));
  const relative = path.relative(path.resolve(stagingRoot), destination);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw archiveError("ARCHIVE_UNSAFE_ENTRY");
  }
  return destination;
}

function validateEntrySet(entries: ArchiveEntry[]): void {
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw archiveError("ARCHIVE_TOO_MANY_ENTRIES");
  const byPortableName = new Map<string, ArchiveEntry>();
  let declaredTotal = 0;
  for (const entry of entries) {
    const duplicateKey = entry.name.toLocaleLowerCase("en-US");
    if (byPortableName.has(duplicateKey)) throw archiveError("ARCHIVE_DUPLICATE_ENTRY");
    byPortableName.set(duplicateKey, entry);
    declaredTotal += entry.unpackedSize;
    if (!Number.isSafeInteger(declaredTotal) || declaredTotal > MAX_UNPACKED_BYTES) {
      throw archiveError("ARCHIVE_SIZE_LIMIT");
    }
  }

  for (const entry of entries) {
    const components = entry.name.split("/");
    for (let index = 1; index < components.length; index += 1) {
      const ancestor = byPortableName.get(components.slice(0, index).join("/").toLocaleLowerCase("en-US"));
      if (ancestor && !ancestor.isDirectory) throw archiveError("ARCHIVE_DUPLICATE_ENTRY");
    }
  }
}

async function prepareStagingRoot(stagingRoot: string): Promise<StagingGuard> {
  await fs.promises.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const stat = await fs.promises.lstat(stagingRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw archiveError("ARCHIVE_UNSAFE_STAGING_ROOT");
  await fs.promises.chmod(stagingRoot, 0o700);
  if ((await fs.promises.readdir(stagingRoot)).length !== 0) {
    throw archiveError("ARCHIVE_STAGING_NOT_EMPTY");
  }
  return {
    root: stagingRoot,
    realRoot: await fs.promises.realpath(stagingRoot),
    rootDevice: stat.dev,
    rootInode: stat.ino,
  };
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function unlinkIfSameFile(
  destination: string,
  handle: fs.promises.FileHandle,
): Promise<void> {
  const openedStat = await handle.stat().catch(() => null);
  const pathStat = await fs.promises.lstat(destination).catch(() => null);
  if (openedStat && pathStat && sameFileIdentity(openedStat, pathStat)) {
    await fs.promises.unlink(destination).catch(() => undefined);
  }
}

async function assertStagingGuard(guard: StagingGuard, destination: string): Promise<void> {
  const rootStat = await fs.promises.lstat(guard.root).catch((error) => {
    throw archiveError("ARCHIVE_UNSAFE_STAGING_ROOT", error);
  });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw archiveError("ARCHIVE_UNSAFE_STAGING_ROOT");
  }
  if (rootStat.dev !== guard.rootDevice || rootStat.ino !== guard.rootInode) {
    throw archiveError("ARCHIVE_UNSAFE_STAGING_ROOT");
  }
  const currentRealRoot = await fs.promises.realpath(guard.root);
  if (currentRealRoot !== guard.realRoot) throw archiveError("ARCHIVE_UNSAFE_STAGING_ROOT");
  const realParent = await fs.promises.realpath(path.dirname(destination)).catch((error) => {
    throw archiveError("ARCHIVE_UNSAFE_STAGING_ROOT", error);
  });
  const relative = path.relative(guard.realRoot, realParent);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw archiveError("ARCHIVE_UNSAFE_STAGING_ROOT");
  }
}

async function ensureSafeStagingDirectory(
  guard: StagingGuard,
  directory: string,
  mode = 0o700,
): Promise<void> {
  const relative = path.relative(path.resolve(guard.root), path.resolve(directory));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw archiveError("ARCHIVE_UNSAFE_STAGING_ROOT");
  }
  let cursor = guard.root;
  for (const component of relative ? relative.split(path.sep) : []) {
    await assertStagingGuard(guard, path.join(cursor, ".analogy-parent-check"));
    cursor = path.join(cursor, component);
    let created = false;
    try {
      await fs.promises.mkdir(cursor, { mode });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      const stat = await fs.promises.lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw archiveError("ARCHIVE_UNSAFE_STAGING_ROOT");
      await assertStagingGuard(guard, path.join(cursor, ".analogy-child-check"));
    } catch (error) {
      if (created) await fs.promises.rmdir(cursor).catch(() => undefined);
      if ((error as Error).message === "ARCHIVE_UNSAFE_STAGING_ROOT") throw error;
      throw archiveError("ARCHIVE_UNSAFE_STAGING_ROOT", error);
    }
  }
}

async function readExactly(
  handle: fs.promises.FileHandle,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead === 0) throw archiveError("ARCHIVE_INVALID_FORMAT");
    offset += result.bytesRead;
  }
  return buffer;
}

const CRC32_TABLE = Array.from({ length: 256 }, (_unused, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

function countedBytes(expected: number, expectedCrc32?: number): Transform {
  let actual = 0;
  let crc = 0xffffffff;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      actual += chunk.length;
      if (actual > expected || actual > MAX_UNPACKED_BYTES) {
        callback(archiveError("ARCHIVE_SIZE_MISMATCH"));
        return;
      }
      if (expectedCrc32 !== undefined) {
        for (const byte of chunk) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (actual !== expected) {
        callback(archiveError("ARCHIVE_SIZE_MISMATCH"));
        return;
      }
      if (expectedCrc32 !== undefined && ((crc ^ 0xffffffff) >>> 0) !== expectedCrc32) {
        callback(archiveError("ARCHIVE_CRC_MISMATCH"));
        return;
      }
      callback();
    },
  });
}

async function openSafeFile(
  filename: string,
  accessFlags: number,
  mode?: number,
): Promise<fs.promises.FileHandle> {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const handle = await fs.promises.open(filename, accessFlags | noFollow, mode);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw archiveError("ARCHIVE_UNSAFE_FILE");
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function openSafeOutput(
  destination: string,
  mode: number,
  guard?: StagingGuard,
): Promise<fs.promises.FileHandle> {
  if (guard) await assertStagingGuard(guard, destination);
  let handle: fs.promises.FileHandle;
  try {
    handle = await openSafeFile(
      destination,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      mode || 0o600,
    );
  } catch (error) {
    if (guard) await assertStagingGuard(guard, destination);
    throw error;
  }
  if (guard) {
    const openedStat = await handle.stat();
    let pathStat: fs.Stats;
    try {
      pathStat = await fs.promises.lstat(destination);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw archiveError("ARCHIVE_UNSAFE_FILE", error);
    }
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || !sameFileIdentity(openedStat, pathStat)) {
      await handle.close().catch(() => undefined);
      throw archiveError("ARCHIVE_UNSAFE_FILE");
    }
    try {
      await assertStagingGuard(guard, destination);
    } catch (error) {
      await handle.close().catch(() => undefined);
      const latest = await fs.promises.lstat(destination).catch(() => null);
      if (latest && sameFileIdentity(openedStat, latest)) {
        await fs.promises.unlink(destination).catch(() => undefined);
      }
      throw error;
    }
  }
  return handle;
}

async function writeEmptyFile(destination: string, mode: number, guard?: StagingGuard): Promise<void> {
  const handle = await openSafeOutput(destination, mode, guard);
  await handle.close();
}

function zipUnixFileType(versionMadeBy: number, externalAttributes: number): number {
  const creator = versionMadeBy >>> 8;
  if (creator !== 3) return 0;
  return (externalAttributes >>> 16) & 0xf000;
}

function containsZip64Extra(extra: Buffer): boolean {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(cursor);
    const dataSize = extra.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + dataSize > extra.length) throw archiveError("ARCHIVE_INVALID_FORMAT");
    if (headerId === 0x0001) return true;
    cursor += dataSize;
  }
  if (cursor !== extra.length) throw archiveError("ARCHIVE_INVALID_FORMAT");
  return false;
}

async function readZipEntries(archivePath: string, stagingRoot: string): Promise<ZipEntry[]> {
  const handle = await openSafeFile(archivePath, fs.constants.O_RDONLY);
  try {
    const stat = await handle.stat();
    const tailLength = Math.min(stat.size, 65_557);
    if (tailLength < 22) throw archiveError("ARCHIVE_INVALID_FORMAT");
    const tail = await readExactly(handle, tailLength, stat.size - tailLength);
    let endOffset = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === 0x06054b50) {
        endOffset = index;
        break;
      }
    }
    if (endOffset < 0) throw archiveError("ARCHIVE_INVALID_FORMAT");
    const absoluteEndOffset = stat.size - tailLength + endOffset;
    if (absoluteEndOffset >= 20) {
      const possibleZip64Locator = await readExactly(handle, 4, absoluteEndOffset - 20);
      if (possibleZip64Locator.readUInt32LE(0) === 0x07064b50) {
        throw archiveError("ARCHIVE_UNSUPPORTED_FORMAT");
      }
    }
    const diskNumber = tail.readUInt16LE(endOffset + 4);
    const centralDisk = tail.readUInt16LE(endOffset + 6);
    const diskEntries = tail.readUInt16LE(endOffset + 8);
    const entryCount = tail.readUInt16LE(endOffset + 10);
    const centralSize = tail.readUInt32LE(endOffset + 12);
    const centralOffset = tail.readUInt32LE(endOffset + 16);
    const commentLength = tail.readUInt16LE(endOffset + 20);
    if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== entryCount
      || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff
      || endOffset + 22 + commentLength !== tail.length
      || centralOffset + centralSize > stat.size) {
      if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
        throw archiveError("ARCHIVE_UNSUPPORTED_FORMAT");
      }
      throw archiveError("ARCHIVE_INVALID_FORMAT");
    }
    if (entryCount > MAX_ARCHIVE_ENTRIES) throw archiveError("ARCHIVE_TOO_MANY_ENTRIES");

    const entries: ZipEntry[] = [];
    let cursor = centralOffset;
    const centralEnd = centralOffset + centralSize;
    for (let index = 0; index < entryCount; index += 1) {
      const header = await readExactly(handle, 46, cursor);
      if (header.readUInt32LE(0) !== 0x02014b50) throw archiveError("ARCHIVE_INVALID_FORMAT");
      const versionMadeBy = header.readUInt16LE(4);
      const flags = header.readUInt16LE(8);
      const compressionMethod = header.readUInt16LE(10);
      const crc32 = header.readUInt32LE(16);
      const compressedSize = header.readUInt32LE(20);
      const unpackedSize = header.readUInt32LE(24);
      const nameLength = header.readUInt16LE(28);
      const extraLength = header.readUInt16LE(30);
      const commentLengthForEntry = header.readUInt16LE(32);
      const externalAttributes = header.readUInt32LE(38);
      const localHeaderOffset = header.readUInt32LE(42);
      const variableLength = nameLength + extraLength + commentLengthForEntry;
      if (cursor + 46 + variableLength > centralEnd || !nameLength || (flags & 1) !== 0
        || (compressionMethod !== 0 && compressionMethod !== 8)
        || compressedSize === 0xffffffff || unpackedSize === 0xffffffff) {
        throw archiveError("ARCHIVE_INVALID_FORMAT");
      }
      if ((flags & 0x0008) !== 0) throw archiveError("ARCHIVE_UNSUPPORTED_FORMAT");
      const variable = await readExactly(handle, variableLength, cursor + 46);
      const rawName = variable.subarray(0, nameLength).toString("utf8");
      if (containsZip64Extra(variable.subarray(nameLength, nameLength + extraLength))) {
        throw archiveError("ARCHIVE_UNSUPPORTED_FORMAT");
      }
      const name = normalizedEntryName(rawName);
      const unixType = zipUnixFileType(versionMadeBy, externalAttributes);
      const dosDirectory = (externalAttributes & 0x10) !== 0;
      const isDirectory = rawName.replace(/\\/g, "/").endsWith("/") || dosDirectory || unixType === 0x4000;
      if (unixType !== 0 && unixType !== 0x8000 && unixType !== 0x4000) {
        throw archiveError("ARCHIVE_UNSAFE_ENTRY");
      }
      if (isDirectory && (compressedSize !== 0 || unpackedSize !== 0)) {
        throw archiveError("ARCHIVE_INVALID_FORMAT");
      }
      if (isDirectory && crc32 !== 0) throw archiveError("ARCHIVE_CRC_MISMATCH");
      entries.push({
        name,
        destination: containedDestination(stagingRoot, name),
        isDirectory,
        mode: (externalAttributes >>> 16) & 0o777,
        unpackedSize,
        flags,
        compressionMethod,
        compressedSize,
        crc32,
        localHeaderOffset,
      });
      cursor += 46 + variableLength;
    }
    if (cursor !== centralEnd) throw archiveError("ARCHIVE_INVALID_FORMAT");
    validateEntrySet(entries);

    for (const entry of entries) {
      const localHeader = await readExactly(handle, 30, entry.localHeaderOffset);
      if (localHeader.readUInt32LE(0) !== 0x04034b50) throw archiveError("ARCHIVE_INVALID_FORMAT");
      const localFlags = localHeader.readUInt16LE(6);
      const localMethod = localHeader.readUInt16LE(8);
      const localCrc32 = localHeader.readUInt32LE(14);
      const localCompressedSize = localHeader.readUInt32LE(18);
      const localUnpackedSize = localHeader.readUInt32LE(22);
      const nameLength = localHeader.readUInt16LE(26);
      const extraLength = localHeader.readUInt16LE(28);
      const localVariable = await readExactly(handle, nameLength + extraLength, entry.localHeaderOffset + 30);
      const localName = localVariable.subarray(0, nameLength).toString("utf8");
      if (normalizedEntryName(localName) !== entry.name || localFlags !== entry.flags
        || localMethod !== entry.compressionMethod || localCrc32 !== entry.crc32
        || localCompressedSize !== entry.compressedSize || localUnpackedSize !== entry.unpackedSize) {
        throw archiveError("ARCHIVE_INVALID_FORMAT");
      }
      if (containsZip64Extra(localVariable.subarray(nameLength))) {
        throw archiveError("ARCHIVE_UNSUPPORTED_FORMAT");
      }
      entry.dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
      if (entry.localHeaderOffset >= centralOffset || entry.dataOffset + entry.compressedSize > centralOffset) {
        throw archiveError("ARCHIVE_INVALID_FORMAT");
      }
    }
    const physicalEntries = [...entries].sort((left, right) => left.localHeaderOffset - right.localHeaderOffset);
    for (let index = 0; index + 1 < physicalEntries.length; index += 1) {
      const entryEnd = physicalEntries[index].dataOffset! + physicalEntries[index].compressedSize;
      if (entryEnd > physicalEntries[index + 1].localHeaderOffset) {
        throw archiveError("ARCHIVE_INVALID_FORMAT");
      }
    }
    return entries;
  } finally {
    await handle.close();
  }
}

async function extractZip(archivePath: string, stagingRoot: string, guard: StagingGuard): Promise<void> {
  const entries = await readZipEntries(archivePath, stagingRoot);
  for (const entry of entries) {
    if (entry.isDirectory) {
      await ensureSafeStagingDirectory(guard, entry.destination, entry.mode || 0o700);
      continue;
    }
    await ensureSafeStagingDirectory(guard, path.dirname(entry.destination));
    if (entry.unpackedSize === 0) {
      if (entry.crc32 !== 0) throw archiveError("ARCHIVE_CRC_MISMATCH");
      await writeEmptyFile(entry.destination, entry.mode || 0o600, guard);
      continue;
    }
    const sourceHandle = await openSafeFile(archivePath, fs.constants.O_RDONLY);
    let outputHandle: fs.promises.FileHandle | undefined;
    try {
      outputHandle = await openSafeOutput(entry.destination, entry.mode || 0o600, guard);
      const source = fs.createReadStream(archivePath, {
        fd: sourceHandle.fd,
        autoClose: false,
        start: entry.dataOffset!,
        end: entry.dataOffset! + entry.compressedSize - 1,
      });
      const output = fs.createWriteStream(entry.destination, { fd: outputHandle.fd, autoClose: false });
      if (entry.compressionMethod === 8) {
        await pipeline(source, createInflateRaw(), countedBytes(entry.unpackedSize, entry.crc32), output);
      } else {
        await pipeline(source, countedBytes(entry.unpackedSize, entry.crc32), output);
      }
    } catch (error) {
      if (outputHandle) await unlinkIfSameFile(entry.destination, outputHandle);
      throw error;
    } finally {
      await sourceHandle.close().catch(() => undefined);
      await outputHandle?.close().catch(() => undefined);
    }
  }
}

function tarString(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  return field.subarray(0, terminator < 0 ? field.length : terminator).toString("utf8");
}

function tarNumber(header: Buffer, offset: number, length: number): number {
  const field = header.subarray(offset, offset + length);
  if ((field[0] & 0x80) !== 0) throw archiveError("ARCHIVE_INVALID_FORMAT");
  const value = field.toString("ascii").replace(/\0.*$/, "").trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) throw archiveError("ARCHIVE_INVALID_FORMAT");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) throw archiveError("ARCHIVE_INVALID_FORMAT");
  return parsed;
}

function validateTarChecksum(header: Buffer): void {
  const declared = tarNumber(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (declared !== actual) throw archiveError("ARCHIVE_INVALID_FORMAT");
}

async function expandTarGz(archivePath: string, stagingRoot: string): Promise<string> {
  const temporaryTar = path.join(path.dirname(stagingRoot), `.runtime-${randomUUID()}.tar.tmp`);
  let expandedBytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      expandedBytes += chunk.length;
      callback(expandedBytes <= MAX_TAR_STREAM_BYTES ? null : archiveError("ARCHIVE_SIZE_LIMIT"), chunk);
    },
  });
  const sourceHandle = await openSafeFile(archivePath, fs.constants.O_RDONLY);
  const outputHandle = await openSafeOutput(temporaryTar, 0o600);
  try {
    await pipeline(
      fs.createReadStream(archivePath, { fd: sourceHandle.fd, autoClose: false }),
      createGunzip(),
      limit,
      fs.createWriteStream(temporaryTar, { fd: outputHandle.fd, autoClose: false }),
    );
    return temporaryTar;
  } catch (error) {
    await fs.promises.unlink(temporaryTar).catch(() => undefined);
    throw archiveError("ARCHIVE_INVALID_FORMAT", error);
  } finally {
    await sourceHandle.close().catch(() => undefined);
    await outputHandle.close().catch(() => undefined);
  }
}

async function readTarEntries(tarPath: string, stagingRoot: string): Promise<TarEntry[]> {
  const handle = await openSafeFile(tarPath, fs.constants.O_RDONLY);
  try {
    const stat = await handle.stat();
    const entries: TarEntry[] = [];
    let cursor = 0;
    while (cursor + 512 <= stat.size) {
      const header = await readExactly(handle, 512, cursor);
      if (header.every((byte) => byte === 0)) break;
      validateTarChecksum(header);
      const baseName = tarString(header, 0, 100);
      const prefix = tarString(header, 345, 155);
      const rawName = prefix ? `${prefix}/${baseName}` : baseName;
      const name = normalizedEntryName(rawName);
      const unpackedSize = tarNumber(header, 124, 12);
      const type = String.fromCharCode(header[156] || 0);
      const isDirectory = type === "5";
      if (type !== "\0" && type !== "0" && type !== "5") throw archiveError("ARCHIVE_UNSAFE_ENTRY");
      if (isDirectory && unpackedSize !== 0) throw archiveError("ARCHIVE_INVALID_FORMAT");
      const paddedSize = Math.ceil(unpackedSize / 512) * 512;
      if (unpackedSize > MAX_UNPACKED_BYTES) throw archiveError("ARCHIVE_SIZE_LIMIT");
      if (cursor + 512 + paddedSize > stat.size) throw archiveError("ARCHIVE_INVALID_FORMAT");
      entries.push({
        name,
        destination: containedDestination(stagingRoot, name),
        isDirectory,
        mode: tarNumber(header, 100, 8) & 0o777,
        unpackedSize,
        dataOffset: cursor + 512,
      });
      if (entries.length > MAX_ARCHIVE_ENTRIES) throw archiveError("ARCHIVE_TOO_MANY_ENTRIES");
      cursor += 512 + paddedSize;
    }
    validateEntrySet(entries);
    return entries;
  } finally {
    await handle.close();
  }
}

async function extractTarGz(archivePath: string, stagingRoot: string, guard: StagingGuard): Promise<void> {
  const tarPath = await expandTarGz(archivePath, stagingRoot);
  try {
    const entries = await readTarEntries(tarPath, stagingRoot);
    for (const entry of entries) {
      if (entry.isDirectory) {
        await ensureSafeStagingDirectory(guard, entry.destination, entry.mode || 0o700);
        continue;
      }
      await ensureSafeStagingDirectory(guard, path.dirname(entry.destination));
      if (entry.unpackedSize === 0) {
        await writeEmptyFile(entry.destination, entry.mode || 0o600, guard);
        continue;
      }
      const sourceHandle = await openSafeFile(tarPath, fs.constants.O_RDONLY);
      let outputHandle: fs.promises.FileHandle | undefined;
      try {
        outputHandle = await openSafeOutput(entry.destination, entry.mode || 0o600, guard);
        const output = fs.createWriteStream(entry.destination, { fd: outputHandle.fd, autoClose: false });
        await pipeline(
          fs.createReadStream(tarPath, {
            fd: sourceHandle.fd,
            autoClose: false,
            start: entry.dataOffset,
            end: entry.dataOffset + entry.unpackedSize - 1,
          }),
          countedBytes(entry.unpackedSize),
          output,
        );
      } catch (error) {
        if (outputHandle) await unlinkIfSameFile(entry.destination, outputHandle);
        throw error;
      } finally {
        await sourceHandle.close().catch(() => undefined);
        await outputHandle?.close().catch(() => undefined);
      }
    }
  } finally {
    await fs.promises.unlink(tarPath).catch(() => undefined);
  }
}

async function extractSingleFile(input: ExtractRuntimeArchiveInput, guard: StagingGuard): Promise<void> {
  const rawName = input.singleFileName ?? path.basename(input.archivePath);
  const name = normalizedEntryName(rawName);
  const destination = containedDestination(input.stagingRoot, name);
  const sourceStat = await fs.promises.lstat(input.archivePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw archiveError("ARCHIVE_UNSAFE_SOURCE");
  await ensureSafeStagingDirectory(guard, path.dirname(destination));
  const sourceHandle = await openSafeFile(input.archivePath, fs.constants.O_RDONLY);
  let outputHandle: fs.promises.FileHandle | undefined;
  try {
    outputHandle = await openSafeOutput(destination, sourceStat.mode & 0o777, guard);
    await pipeline(
      fs.createReadStream(input.archivePath, { fd: sourceHandle.fd, autoClose: false }),
      fs.createWriteStream(destination, { fd: outputHandle.fd, autoClose: false }),
    );
  } catch (error) {
    if (outputHandle) await unlinkIfSameFile(destination, outputHandle);
    throw error;
  } finally {
    await sourceHandle.close().catch(() => undefined);
    await outputHandle?.close().catch(() => undefined);
  }
  await fs.promises.chmod(destination, sourceStat.mode & 0o777);
}

export async function extractRuntimeArchive(input: ExtractRuntimeArchiveInput): Promise<void> {
  const guard = await prepareStagingRoot(input.stagingRoot);
  if (input.archive === "none") {
    await extractSingleFile(input, guard);
    return;
  }
  if (input.archive === "zip") {
    await extractZip(input.archivePath, input.stagingRoot, guard);
    return;
  }
  if (input.archive === "tar.gz") {
    await extractTarGz(input.archivePath, input.stagingRoot, guard);
    return;
  }
  throw archiveError("ARCHIVE_UNSUPPORTED_FORMAT");
}

export const extractArchive = extractRuntimeArchive;
