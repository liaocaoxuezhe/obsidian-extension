import { createHash } from "crypto";
import * as fs from "fs";
import { RuntimeAsset } from "./runtime-types";

export interface VerificationResult {
  ok: boolean;
  actualSize: number;
  actualSha256: string;
  errorCode: "DOWNLOAD_SIZE_MISMATCH" | "DOWNLOAD_HASH_MISMATCH" | null;
}

export async function verifyRuntimeAsset(
  asset: RuntimeAsset,
  filePath: string,
): Promise<VerificationResult> {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("DOWNLOAD_UNSAFE_FILE");
  }

  const hash = createHash("sha256");
  let actualSize = 0;
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const handle = await fs.promises.open(filePath, flags);
  try {
    const openStat = await handle.stat();
    if (!openStat.isFile()) throw new Error("DOWNLOAD_UNSAFE_FILE");
    const stream = fs.createReadStream(filePath, { fd: handle.fd, autoClose: false });
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      actualSize += bytes.length;
      hash.update(bytes);
    }
  } finally {
    await handle.close();
  }
  const actualSha256 = hash.digest("hex");
  const errorCode = actualSize !== asset.size
    ? "DOWNLOAD_SIZE_MISMATCH"
    : actualSha256 !== asset.sha256
      ? "DOWNLOAD_HASH_MISMATCH"
      : null;
  return {
    ok: errorCode === null,
    actualSize,
    actualSha256,
    errorCode,
  };
}
