import { execFile } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface PersistedChromaProcessLease {
  schemaVersion: 1;
  runtimeVaultId: string;
  pid: number;
  port: number;
  executablePath: string;
  dataPath: string;
  runtimeVersion: string;
  startedAt: number;
  token: string;
}

export interface ChromaProcessLeaseStoreOptions {
  root: string;
  leasePath: string;
  runtimeVaultId: string;
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validLease(value: unknown, runtimeVaultId: string): value is PersistedChromaProcessLease {
  const lease = value as Partial<PersistedChromaProcessLease> | null;
  return lease?.schemaVersion === 1
    && lease.runtimeVaultId === runtimeVaultId
    && /^vault-v2-[0-9a-f]{16}$/.test(lease.runtimeVaultId)
    && Number.isSafeInteger(lease.pid) && (lease.pid as number) > 0
    && Number.isInteger(lease.port) && (lease.port as number) >= 1 && (lease.port as number) <= 65_535
    && typeof lease.executablePath === "string" && path.isAbsolute(lease.executablePath)
    && typeof lease.dataPath === "string" && path.isAbsolute(lease.dataPath)
    && typeof lease.runtimeVersion === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(lease.runtimeVersion)
    && Number.isFinite(lease.startedAt) && (lease.startedAt as number) > 0
    && typeof lease.token === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(lease.token);
}

async function assertNoSymlink(root: string, target: string, allowMissingLeaf: boolean): Promise<void> {
  if (!contained(root, target)) throw new Error("CHROMA_LEASE_PATH_INVALID");
  const relative = path.relative(path.resolve(root), path.resolve(target));
  let current = path.resolve(root);
  const parts = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    try {
      const stat = await fs.promises.lstat(current);
      if (stat.isSymbolicLink()) throw new Error("CHROMA_LEASE_UNSAFE_PATH");
      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error("CHROMA_LEASE_UNSAFE_PATH");
      if (index === parts.length - 1 && !stat.isFile()) throw new Error("CHROMA_LEASE_INVALID");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissingLeaf) return;
      throw error;
    }
  }
}

export class ChromaProcessLeaseStore {
  readonly runtimeVaultId: string;
  private readonly root: string;
  private readonly leasePath: string;

  constructor(options: ChromaProcessLeaseStoreOptions) {
    this.root = path.resolve(options.root);
    this.leasePath = path.resolve(options.leasePath);
    this.runtimeVaultId = options.runtimeVaultId;
    if (!contained(this.root, this.leasePath) || !/^vault-v2-[0-9a-f]{16}$/.test(this.runtimeVaultId)) {
      throw new Error("CHROMA_LEASE_PATH_INVALID");
    }
  }

  async read(): Promise<PersistedChromaProcessLease | null> {
    try {
      await assertNoSymlink(this.root, this.leasePath, false);
      const handle = await fs.promises.open(this.leasePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 16 * 1024) throw new Error("CHROMA_LEASE_INVALID");
        const value = JSON.parse(await handle.readFile("utf8"));
        if (!validLease(value, this.runtimeVaultId)) throw new Error("CHROMA_LEASE_INVALID");
        return value;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async publish(lease: PersistedChromaProcessLease): Promise<void> {
    if (!validLease(lease, this.runtimeVaultId)) throw new Error("CHROMA_LEASE_INVALID");
    const directory = path.dirname(this.leasePath);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    await assertNoSymlink(this.root, this.leasePath, true);
    const temporary = path.join(directory, `.chroma-process-lease.${process.pid}.${crypto.randomUUID()}.tmp`);
    const handle = await fs.promises.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(lease)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.promises.rename(temporary, this.leasePath);
    } finally {
      await fs.promises.rm(temporary, { force: true });
    }
  }

  async clearIfTokenMatches(token: string): Promise<boolean> {
    const current = await this.read();
    if (!current || current.token !== token) return false;
    await fs.promises.unlink(this.leasePath);
    return true;
  }

  async isolate(lease: PersistedChromaProcessLease): Promise<void> {
    const current = await this.read();
    if (!current || current.token !== lease.token) return;
    const isolated = `${this.leasePath}.isolated-${Date.now()}-${lease.token.slice(0, 12)}`;
    await fs.promises.rename(this.leasePath, isolated);
  }
}

function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 2_000, maxBuffer: 32 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export async function inspectChromaProcessIdentity(
  lease: PersistedChromaProcessLease,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  try {
    let command = "";
    if (platform === "win32") {
      const script = "$p=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $args[0]); if($p){$p.ExecutablePath; $p.CommandLine}";
      command = await execFileText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, String(lease.pid)]);
    } else if (platform === "darwin") {
      command = await execFileText("/bin/ps", ["-p", String(lease.pid), "-o", "command="]);
    } else return false;
    const normalized = command.replace(/\\/g, "/");
    const executable = path.resolve(lease.executablePath).replace(/\\/g, "/");
    const dataPath = path.resolve(lease.dataPath).replace(/\\/g, "/");
    return normalized.includes(executable)
      && /(?:^|\s)run(?:\s|$)/.test(normalized)
      && normalized.includes(dataPath)
      && normalized.includes("--host") && normalized.includes("127.0.0.1")
      && normalized.includes("--port") && normalized.includes(String(lease.port));
  } catch {
    return false;
  }
}
