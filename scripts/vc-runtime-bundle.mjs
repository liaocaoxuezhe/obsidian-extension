import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Microsoft Visual C++ runtime DLLs imported by onnxruntime_binding.node and
 * onnxruntime.dll (onnxruntime.dll also needs msvcp140_1 and
 * msvcp140_atomic_wait). Shipping all of them next to the binding removes the
 * "VC++ Redistributable not installed" failure: verified on a clean Windows
 * Server 2022 with no VC++ runtime, where the three-DLL subset still failed.
 * They are taken only from Visual Studio's redistributable folder
 * (VC\Redist\MSVC\<version>\x64\Microsoft.VC14x.CRT), never from System32.
 */
export const VC_RUNTIME_FILES = Object.freeze([
  "msvcp140.dll",
  "msvcp140_1.dll",
  "msvcp140_atomic_wait.dll",
  "vcruntime140.dll",
  "vcruntime140_1.dll",
]);

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

/** Lists the DLL names a PE image imports, including delay-loaded ones. */
export function readPeImports(buffer) {
  const peOffset = buffer.readUInt32LE(0x3c);
  if (buffer.toString("latin1", peOffset, peOffset + 4) !== "PE\0\0") throw new Error("Not a PE image");
  const sectionCount = buffer.readUInt16LE(peOffset + 6);
  const optionalSize = buffer.readUInt16LE(peOffset + 20);
  const optional = peOffset + 24;
  const dataDirectories = optional + (buffer.readUInt16LE(optional) === 0x20b ? 112 : 96);
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = optional + optionalSize + index * 40;
    sections.push({
      virtualSize: buffer.readUInt32LE(offset + 8),
      virtualAddress: buffer.readUInt32LE(offset + 12),
      rawSize: buffer.readUInt32LE(offset + 16),
      rawPointer: buffer.readUInt32LE(offset + 20),
    });
  }
  const fileOffset = (rva) => {
    const section = sections.find((item) => rva >= item.virtualAddress
      && rva < item.virtualAddress + Math.max(item.virtualSize, item.rawSize));
    if (!section) throw new Error("PE import RVA outside sections");
    return rva - section.virtualAddress + section.rawPointer;
  };
  const readName = (rva) => {
    const start = fileOffset(rva);
    return buffer.toString("latin1", start, buffer.indexOf(0, start));
  };
  const names = new Set();
  for (const [directory, stride, nameField] of [[1, 20, 12], [13, 32, 4]]) {
    const rva = buffer.readUInt32LE(dataDirectories + directory * 8);
    if (!rva) continue;
    for (let offset = fileOffset(rva); ; offset += stride) {
      const descriptor = buffer.subarray(offset, offset + stride);
      if (descriptor.every((byte) => byte === 0)) break;
      names.add(readName(descriptor.readUInt32LE(nameField)));
    }
  }
  return [...names];
}

/** VC++ runtime DLLs (msvcp*, vcruntime*, concrt*, vccorlib*) imported by the native payload. */
export function requiredVisualCppRuntimeFiles(nativeDirectory) {
  const required = new Set(VC_RUNTIME_FILES);
  for (const name of fs.readdirSync(nativeDirectory)) {
    // The VC++ runtime files themselves are what we copy, not payload to analyse.
    if (!/\.(dll|node)$/i.test(name) || /^(msvcp|vcruntime|concrt|vccorlib)\d/i.test(name)) continue;
    for (const imported of readPeImports(fs.readFileSync(path.join(nativeDirectory, name)))) {
      if (/^(msvcp|vcruntime|concrt|vccorlib)\d/i.test(imported)) required.add(imported.toLowerCase());
    }
  }
  return [...required].sort();
}

/**
 * Copies every VC++ runtime DLL the native payload imports next to
 * onnxruntime_binding.node, failing when the redistributable folder lacks one.
 */
export async function bundleVisualCppRuntime(sourceDirectory, nativeDirectory) {
  if (!fs.existsSync(path.join(nativeDirectory, "onnxruntime_binding.node"))) {
    throw new Error(`onnxruntime_binding.node not found in ${nativeDirectory}`);
  }
  const required = requiredVisualCppRuntimeFiles(nativeDirectory);
  for (const name of required) {
    const source = path.join(sourceDirectory, name);
    const stat = await fs.promises.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Visual C++ runtime file is not a regular file: ${source}`);
    await fs.promises.copyFile(source, path.join(nativeDirectory, name));
  }
  return required;
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
