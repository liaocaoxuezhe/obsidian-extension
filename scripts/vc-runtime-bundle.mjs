import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Microsoft Visual C++ runtime DLLs that onnxruntime_binding.node and
 * onnxruntime.dll depend on. Shipping them app-local (next to the binding)
 * removes the "VC++ Redistributable not installed" failure on clean Windows.
 * They are taken only from Visual Studio's redistributable folder
 * (VC\Redist\MSVC\<version>\x64\Microsoft.VC14x.CRT), never from System32.
 */
export const VC_RUNTIME_FILES = Object.freeze(["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"]);

function containsAll(directory, exists) {
  return VC_RUNTIME_FILES.every((name) => exists(path.join(directory, name)));
}

function crtDirectoriesUnder(redistRoot, readdir, exists) {
  // <VCToolsRedistDir>\x64\Microsoft.VC14x.CRT
  const x64 = path.join(redistRoot, "x64");
  if (!exists(x64)) return [];
  return readdir(x64)
    .filter((name) => /^Microsoft\.VC14\d\.CRT$/i.test(name))
    .sort()
    .reverse()
    .map((name) => path.join(x64, name));
}

/**
 * Finds the CRT folder: --vc-redist-dir, then VCToolsRedistDir (Developer
 * shell), then vswhere's latest Visual Studio with the C++ toolset.
 */
export function resolveVisualCppRuntimeDirectory({
  explicit = null,
  env = process.env,
  exists = fs.existsSync,
  readdir = (directory) => fs.readdirSync(directory),
  runVswhere = (args) => execFileSync(
    path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe"),
    args,
    { encoding: "utf8", windowsHide: true },
  ),
} = {}) {
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (containsAll(resolved, exists)) return resolved;
    for (const candidate of crtDirectoriesUnder(resolved, readdir, exists)) {
      if (containsAll(candidate, exists)) return candidate;
    }
    throw new Error(`--vc-redist-dir does not contain ${VC_RUNTIME_FILES.join(", ")}: ${resolved}`);
  }
  if (env.VCToolsRedistDir) {
    for (const candidate of crtDirectoriesUnder(env.VCToolsRedistDir, readdir, exists)) {
      if (containsAll(candidate, exists)) return candidate;
    }
  }
  let installation = "";
  try {
    installation = String(runVswhere([
      "-latest", "-products", "*",
      "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property", "installationPath",
    ])).trim().split(/\r?\n/)[0] || "";
  } catch {
    installation = "";
  }
  if (installation) {
    const msvcRoot = path.join(installation, "VC", "Redist", "MSVC");
    if (exists(msvcRoot)) {
      const versions = readdir(msvcRoot).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort((left, right) => {
        const a = left.split(".").map(Number);
        const b = right.split(".").map(Number);
        return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
      });
      for (const version of versions) {
        for (const candidate of crtDirectoriesUnder(path.join(msvcRoot, version), readdir, exists)) {
          if (containsAll(candidate, exists)) return candidate;
        }
      }
    }
  }
  throw new Error(
    "Windows runtime builds must ship the Visual C++ runtime app-local. Install the Visual Studio C++ toolset "
      + "or pass --vc-redist-dir <VC\\Redist\\MSVC\\<version>\\x64\\Microsoft.VC14x.CRT>.",
  );
}

/** Copies the CRT DLLs next to onnxruntime_binding.node and returns their names. */
export async function bundleVisualCppRuntime(sourceDirectory, nativeDirectory) {
  if (!fs.existsSync(path.join(nativeDirectory, "onnxruntime_binding.node"))) {
    throw new Error(`onnxruntime_binding.node not found in ${nativeDirectory}`);
  }
  for (const name of VC_RUNTIME_FILES) {
    const source = path.join(sourceDirectory, name);
    const stat = await fs.promises.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Visual C++ runtime file is not a regular file: ${source}`);
    await fs.promises.copyFile(source, path.join(nativeDirectory, name));
  }
  return [...VC_RUNTIME_FILES];
}

export const VC_RUNTIME_NOTICE = [
  "===== Microsoft Visual C++ Runtime (app-local) =====",
  "",
  `Files: ${VC_RUNTIME_FILES.join(", ")}`,
  "Source: the Visual Studio redistributable folder (VC\\Redist\\MSVC\\<version>\\x64\\Microsoft.VC14x.CRT).",
  "These files are Distributable Code under the Microsoft Visual Studio license terms",
  "(https://visualstudio.microsoft.com/license-terms/) and are redistributed unmodified",
  "solely so the bundled ONNX Runtime can load on Windows without a separate installer.",
].join("\n");
