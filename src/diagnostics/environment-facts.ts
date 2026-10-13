import * as os from "os";

/**
 * Device facts that explain most setup failures. Contains no paths, user names,
 * hostnames or addresses: only coarse, non-identifying values.
 */
export interface EnvironmentFacts {
  platform: string;
  arch: string;
  osRelease: string;
  totalMemoryGb: number | null;
  cpuModel: string;
  cpuCount: number | null;
  /** The home folder contains non-ASCII characters (e.g. a Chinese user name). */
  nonAsciiHome: boolean;
  /** The home folder contains spaces. */
  spaceInHome: boolean;
  /** HTTP(S)_PROXY / ALL_PROXY is configured for this process. */
  proxyConfigured: boolean;
}

export function collectEnvironmentFacts(environment: NodeJS.ProcessEnv = process.env): EnvironmentFacts {
  let home = "";
  try { home = os.homedir(); } catch { home = ""; }
  let cpus: os.CpuInfo[] = [];
  try { cpus = os.cpus(); } catch { cpus = []; }
  const cpuModel = (cpus[0]?.model ?? "").replace(/[^A-Za-z0-9 ()@.+-]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  const totalMemory = (() => { try { return os.totalmem(); } catch { return 0; } })();
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: (() => { try { return os.release().replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40); } catch { return ""; } })(),
    totalMemoryGb: totalMemory > 0 ? Math.round(totalMemory / 1024 ** 3) : null,
    cpuModel,
    cpuCount: cpus.length || null,
    nonAsciiHome: /[^\x20-\x7E]/.test(home),
    spaceInHome: /\s/.test(home),
    proxyConfigured: Boolean(environment.HTTPS_PROXY || environment.https_proxy || environment.HTTP_PROXY
      || environment.http_proxy || environment.ALL_PROXY || environment.all_proxy),
  };
}
