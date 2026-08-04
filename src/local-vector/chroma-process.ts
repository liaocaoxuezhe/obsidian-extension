import {
  ChromaRuntimeManager,
  type ChromaRuntimeManagerHooks,
  type ManagedProcessState,
  PINNED_CHROMA_RUNTIME_VERSION,
} from "../runtime/chroma-runtime-manager";

export interface ChromaProcessManagerOptions extends ChromaRuntimeManagerHooks {
  executablePath?: string;
  runtimeVersion?: string;
  external?: boolean;
}

/**
 * Backwards-compatible local-vector façade. Runtime installation and path
 * selection live outside this class; callers provide the verified executable.
 */
export class ChromaProcessManager {
  private readonly manager: ChromaRuntimeManager;
  private readonly executablePath: string;
  private readonly runtimeVersion: string;
  private readonly external: boolean;
  private dbPath = "";
  private port = 8000;
  private lastError = "";

  constructor(options: ChromaProcessManagerOptions = {}) {
    const {
      executablePath = "",
      runtimeVersion = PINNED_CHROMA_RUNTIME_VERSION,
      external = false,
      ...hooks
    } = options;
    this.executablePath = executablePath;
    this.runtimeVersion = runtimeVersion;
    this.external = external;
    this.manager = new ChromaRuntimeManager(hooks);
  }

  async start(dbPath: string, port: number = 8000): Promise<boolean> {
    this.lastError = "";
    try {
      const state = await this.manager.start({
        executablePath: this.executablePath,
        dataPath: dbPath,
        preferredPort: port,
        runtimeVersion: this.runtimeVersion,
        external: this.external,
      });
      this.dbPath = dbPath;
      this.port = state.port;
      return true;
    } catch (error) {
      if (this.manager.getState().ownership === "none") {
        this.dbPath = dbPath;
        this.port = port;
      }
      this.lastError = (error as Error).message || this.manager.getLastError();
      return false;
    }
  }

  isHealthy(): Promise<boolean> {
    return this.manager.health(this.port);
  }

  async stop(): Promise<void> {
    try {
      await this.manager.stopOwnedProcess();
    } catch (error) {
      this.lastError = (error as Error).message;
      throw error;
    }
  }

  getLastError(): string {
    return this.lastError || this.manager.getLastError();
  }

  getManualStartCommand(): string {
    const executable = this.executablePath || "<installed-chroma-runtime>";
    return `"${executable}" run --path "${this.dbPath}" --host 127.0.0.1 --port ${this.port}`;
  }

  getPort(): number {
    return this.port;
  }

  getDbPath(): string {
    return this.dbPath;
  }

  getProcessState(): ManagedProcessState {
    return this.manager.getState();
  }
}
