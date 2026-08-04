const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_SUBTYPE_MASK = 0xff000000;
const CPU_SUBTYPE_LIB64 = 0x80000000;
const CPU_SUBTYPE_X86_64_ALL = 3;
const CPU_SUBTYPE_ARM64_ALL = 0;
const CPU_SUBTYPE_ARM64_V8 = 1;
const CPU_SUBTYPE_ARM64E = 2;
const CPU_SUBTYPE_ARM64E_CAPABILITIES = 0x8f000000;

export function parseMachOCpuSubtype(rawSubtype, expectedArch, label = "Mach-O image") {
  const unsignedSubtype = rawSubtype >>> 0;
  const base = (unsignedSubtype & (~CPU_SUBTYPE_MASK >>> 0)) >>> 0;
  const capabilities = (unsignedSubtype & CPU_SUBTYPE_MASK) >>> 0;
  if (expectedArch === "x64") {
    if (base !== CPU_SUBTYPE_X86_64_ALL || ![0, CPU_SUBTYPE_LIB64].includes(capabilities)) {
      throw new Error(`${label} Mach-O CPU subtype must be CPU_SUBTYPE_X86_64_ALL with only known capability bits`);
    }
  } else if (expectedArch === "arm64") {
    const generic = (base === CPU_SUBTYPE_ARM64_ALL || base === CPU_SUBTYPE_ARM64_V8) && capabilities === 0;
    const arm64e = base === CPU_SUBTYPE_ARM64E
      && ((capabilities & (~CPU_SUBTYPE_ARM64E_CAPABILITIES >>> 0)) >>> 0) === 0;
    if (!generic && !arm64e) throw new Error(`${label} Mach-O CPU subtype is not a legal arm64 subtype/capability combination`);
  } else {
    throw new Error(`${label} uses unsupported Mach-O architecture ${expectedArch}`);
  }
  return { raw: unsignedSubtype, base, capabilities };
}

export function validateMachOImage(data, expectedArch, expectedFileType, label) {
  if (!Buffer.isBuffer(data) || data.length < 32 || data.readUInt32LE(0) !== MH_MAGIC_64) {
    throw new Error(`${label} must be a thin 64-bit Mach-O image`);
  }
  const expectedCpu = expectedArch === "arm64" ? CPU_TYPE_ARM64 : expectedArch === "x64" ? CPU_TYPE_X86_64 : -1;
  if (data.readUInt32LE(4) !== expectedCpu) throw new Error(`${label} Mach-O CPU type does not match ${expectedArch}`);
  parseMachOCpuSubtype(data.readUInt32LE(8), expectedArch, label);
  const fileType = data.readUInt32LE(12);
  const allowedFileTypes = Array.isArray(expectedFileType) ? expectedFileType : [expectedFileType];
  if (!allowedFileTypes.includes(fileType)) throw new Error(`${label} Mach-O filetype mismatch`);
  const commandCount = data.readUInt32LE(16);
  const commandBytes = data.readUInt32LE(20);
  if (commandCount === 0 || commandCount > 4096 || commandBytes < 72 || 32 + commandBytes > data.length) {
    throw new Error(`${label} has no complete Mach-O load-command body`);
  }
  let cursor = 32;
  let segments = 0;
  let fileBackedBytes = 0;
  for (let index = 0; index < commandCount; index += 1) {
    if (cursor + 8 > 32 + commandBytes) throw new Error(`${label} has a truncated Mach-O load command`);
    const command = data.readUInt32LE(cursor);
    const size = data.readUInt32LE(cursor + 4);
    if (size < 8 || cursor + size > 32 + commandBytes) throw new Error(`${label} has an invalid Mach-O load command size`);
    if (command === 0x19) {
      if (size < 72) throw new Error(`${label} has a truncated LC_SEGMENT_64 command`);
      const fileOffset = Number(data.readBigUInt64LE(cursor + 40));
      const fileSize = Number(data.readBigUInt64LE(cursor + 48));
      if (!Number.isSafeInteger(fileOffset) || !Number.isSafeInteger(fileSize) || fileOffset + fileSize > data.length) {
        throw new Error(`${label} Mach-O segment exceeds file bounds`);
      }
      segments += 1;
      fileBackedBytes += fileSize;
    }
    cursor += size;
  }
  if (cursor !== 32 + commandBytes || segments === 0 || fileBackedBytes <= 32 + commandBytes) {
    throw new Error(`${label} has no real file-backed Mach-O body`);
  }
}
