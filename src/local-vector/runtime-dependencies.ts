export interface LocalRuntimeStatus {
  ready: boolean;
  missing: string[];
  message: string;
}

export const REQUIRED_RUNTIME_MODULES = ["@huggingface/transformers", "onnxruntime-node"];
export const LOCAL_RUNTIME_PACKAGES = ["@huggingface/transformers@^4.2.0", "onnxruntime-node@^1.26.0"];

export function getLocalRuntimeStatus(pluginDir: string): LocalRuntimeStatus {
  const path = require("path");
  const Module = require("module");
  const pluginRequire = Module.createRequire(path.join(pluginDir, "main.js"));
  const missing: string[] = [];

  for (const moduleName of REQUIRED_RUNTIME_MODULES) {
    try {
      pluginRequire.resolve(moduleName);
    } catch {
      missing.push(moduleName);
    }
  }

  if (missing.length === 0) {
    return { ready: true, missing, message: "" };
  }

  return {
    ready: false,
    missing,
    message:
      "Local RAG runtime is not installed. Community plugin installs only include `main.js`, `manifest.json`, and `styles.css`; they do not install npm runtime dependencies. " +
      "Open Analogy settings and click `Install runtime`, or install `@huggingface/transformers` and `onnxruntime-node` in the plugin folder manually.",
  };
}

export function installLocalRuntimeDependencies(
  pluginDir: string,
  onLog?: (line: string) => void
): Promise<void> {
  const { spawn } = require("child_process");
  const fs = require("fs");

  if (!fs.existsSync(pluginDir)) {
    return Promise.reject(new Error(`Plugin folder does not exist: ${pluginDir}`));
  }

  return new Promise((resolve, reject) => {
    const args = ["install", "--no-audit", "--no-fund", ...LOCAL_RUNTIME_PACKAGES];
    const npmCommand = resolveNpmCommand();

    if (!npmCommand) {
      reject(
        new Error(
          "npm was not found. Install Node.js/npm, or start Obsidian from a terminal where npm is available."
        )
      );
      return;
    }

    onLog?.(`Using npm: ${npmCommand.label}`);
    onLog?.(`$ ${npmCommand.label} ${args.join(" ")}`);

    const child = spawn(npmCommand.command, [...npmCommand.prefixArgs, ...args], {
      cwd: pluginDir,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: npmCommand.pathEnv,
      },
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      onLog?.(chunk.toString("utf8").trimEnd());
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      onLog?.(chunk.toString("utf8").trimEnd());
    });
    child.on("error", (err: Error) => {
      onLog?.(`Failed to start npm: ${err.message}`);
      reject(err);
    });
    child.on("close", (code: number) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`npm install exited with code ${code}`));
    });
  });
}

function resolveNpmCommand(): { command: string; prefixArgs: string[]; label: string; pathEnv: string } | null {
  const { spawnSync } = require("child_process");
  const fs = require("fs");
  const path = require("path");
  const pathEnv = buildNpmPathEnv();

  const directCandidates = getNpmExecutableCandidates();
  for (const candidate of directCandidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    const result = spawnSync(candidate, ["--version"], {
      stdio: "ignore",
      env: { ...process.env, PATH: pathEnv },
    });
    if (result.status === 0) {
      return { command: candidate, prefixArgs: [], label: candidate, pathEnv };
    }
  }

  const npmName = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmName, ["--version"], {
    stdio: "ignore",
    shell: process.platform === "win32",
    env: { ...process.env, PATH: pathEnv },
  });
  if (result.status === 0) {
    return { command: npmName, prefixArgs: [], label: "npm", pathEnv };
  }

  return null;
}

function getNpmExecutableCandidates(): string[] {
  const fs = require("fs");
  const path = require("path");
  const home = process.env.HOME || "";
  const candidates = [
    process.env.npm_execpath || "",
    "/opt/homebrew/bin/npm",
    "/usr/local/bin/npm",
    "/usr/bin/npm",
  ];

  const nvmVersionsDir = home ? path.join(home, ".nvm", "versions", "node") : "";
  if (nvmVersionsDir && fs.existsSync(nvmVersionsDir)) {
    const nvmCandidates = fs
      .readdirSync(nvmVersionsDir)
      .filter((name: string) => /^v\d+\./.test(name))
      .sort()
      .reverse()
      .map((name: string) => path.join(nvmVersionsDir, name, "bin", "npm"));
    candidates.push(...nvmCandidates);
  }

  return candidates;
}

function buildNpmPathEnv(): string {
  const fs = require("fs");
  const path = require("path");
  const home = process.env.HOME || "";
  const paths = new Set<string>();

  for (const part of (process.env.PATH || "").split(path.delimiter)) {
    if (part) paths.add(part);
  }

  for (const part of ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    paths.add(part);
  }

  const nvmVersionsDir = home ? path.join(home, ".nvm", "versions", "node") : "";
  if (nvmVersionsDir && fs.existsSync(nvmVersionsDir)) {
    for (const name of fs.readdirSync(nvmVersionsDir)) {
      if (/^v\d+\./.test(name)) {
        paths.add(path.join(nvmVersionsDir, name, "bin"));
      }
    }
  }

  return Array.from(paths).join(path.delimiter);
}
