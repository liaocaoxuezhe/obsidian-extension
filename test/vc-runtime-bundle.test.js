"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const modulePromise = import(pathToFileURL(path.join(__dirname, "..", "scripts", "vc-runtime-bundle.mjs")).href);

/** Builds a minimal PE32+ image whose import table lists the given DLL names. */
function minimalPe(importNames) {
  const buffer = Buffer.alloc(0x400);
  buffer.writeUInt32LE(0x40, 0x3c);
  buffer.write("PE\0\0", 0x40, "latin1");
  const coff = 0x44;
  buffer.writeUInt16LE(0x8664, coff);
  buffer.writeUInt16LE(1, coff + 2);
  buffer.writeUInt16LE(240, coff + 16);
  const optional = 0x58;
  buffer.writeUInt16LE(0x20b, optional);
  const dataDirectories = optional + 112;
  const section = optional + 240;
  const sectionRva = 0x1000;
  const raw = 0x200;
  buffer.write(".idata", section, "latin1");
  buffer.writeUInt32LE(0x200, section + 8);
  buffer.writeUInt32LE(sectionRva, section + 12);
  buffer.writeUInt32LE(0x200, section + 16);
  buffer.writeUInt32LE(raw, section + 20);
  buffer.writeUInt32LE(sectionRva, dataDirectories + 8);
  let nameOffset = raw + (importNames.length + 1) * 20;
  importNames.forEach((name, index) => {
    buffer.writeUInt32LE(sectionRva + (nameOffset - raw), raw + index * 20 + 12);
    buffer.write(`${name}\0`, nameOffset, "latin1");
    nameOffset += name.length + 1;
  });
  return buffer;
}

function makeCrt(root, version = "14.40.33807", toolset = "Microsoft.VC143.CRT", files) {
  const directory = path.join(root, "VC", "Redist", "MSVC", version, "x64", toolset);
  fs.mkdirSync(directory, { recursive: true });
  for (const name of files) fs.writeFileSync(path.join(directory, name), name);
  return directory;
}

test("the Visual C++ runtime is found in the Visual Studio redistributable folder only", async (t) => {
  const { resolveVisualCppRuntimeDirectory, VC_RUNTIME_FILES } = await modulePromise;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-vcrt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  makeCrt(root, "14.38.33130", "Microsoft.VC143.CRT", VC_RUNTIME_FILES);
  const newest = makeCrt(root, "14.40.33807", "Microsoft.VC143.CRT", VC_RUNTIME_FILES);
  makeCrt(root, "14.41.0", "Microsoft.VC143.CRT", ["vcruntime140.dll"]);

  const fromVswhere = resolveVisualCppRuntimeDirectory({ env: {}, runVswhere: () => `${root}\n` });
  assert.equal(fromVswhere, newest, "the newest complete CRT folder wins");

  const explicit = resolveVisualCppRuntimeDirectory({ explicit: newest, env: {}, runVswhere: () => "" });
  assert.equal(explicit, newest);
  assert.throws(() => resolveVisualCppRuntimeDirectory({ explicit: root, env: {}, runVswhere: () => "" }),
    /does not contain/);
  assert.throws(() => resolveVisualCppRuntimeDirectory({ env: {}, runVswhere: () => { throw new Error("no vswhere"); } }),
    /must ship the Visual C\+\+ runtime/);
});

test("every VC++ DLL imported by the native payload is copied next to the binding", async (t) => {
  const { bundleVisualCppRuntime, readPeImports, VC_RUNTIME_FILES } = await modulePromise;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-vcrt-copy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const crt = makeCrt(root, "14.40.33807", "Microsoft.VC143.CRT", [...VC_RUNTIME_FILES, "msvcp140_2.dll"]);
  const native = path.join(root, "napi-v6", "win32", "x64");
  fs.mkdirSync(native, { recursive: true });
  await assert.rejects(bundleVisualCppRuntime(crt, native), /onnxruntime_binding\.node not found/);
  fs.writeFileSync(path.join(native, "onnxruntime_binding.node"), minimalPe(["KERNEL32.dll", "MSVCP140.dll", "onnxruntime.dll"]));
  fs.writeFileSync(path.join(native, "onnxruntime.dll"), minimalPe(["MSVCP140_2.dll", "VCRUNTIME140_1.dll", "api-ms-win-crt-heap-l1-1-0.dll"]));
  assert.deepEqual(readPeImports(fs.readFileSync(path.join(native, "onnxruntime.dll"))),
    ["MSVCP140_2.dll", "VCRUNTIME140_1.dll", "api-ms-win-crt-heap-l1-1-0.dll"]);
  const copied = await bundleVisualCppRuntime(crt, native);
  assert.deepEqual(copied, [...new Set([...VC_RUNTIME_FILES, "msvcp140_2.dll"])].sort());
  for (const name of copied) assert.equal(fs.readFileSync(path.join(native, name), "utf8"), name);

  fs.writeFileSync(path.join(native, "onnxruntime.dll"), minimalPe(["MSVCP140_9.dll"]));
  await assert.rejects(bundleVisualCppRuntime(crt, native), /msvcp140_9\.dll/);
});

/** Builds a PE32+ image with both a load-time import table and a delay-load import table. */
function peWithDelayImports(importNames, delayNames) {
  const buffer = minimalPe(importNames);
  const optional = 0x58;
  const dataDirectories = optional + 112;
  const sectionRva = 0x1000;
  const raw = 0x200;
  // Place delay descriptors (32 bytes each, DLL name RVA at +4) after the import names.
  let cursor = raw + (importNames.length + 1) * 20 + importNames.reduce((sum, name) => sum + name.length + 1, 0);
  cursor = (cursor + 7) & ~7;
  const delayTable = cursor;
  buffer.writeUInt32LE(sectionRva + (delayTable - raw), dataDirectories + 13 * 8);
  let nameOffset = delayTable + (delayNames.length + 1) * 32;
  delayNames.forEach((name, index) => {
    buffer.writeUInt32LE(sectionRva + (nameOffset - raw), delayTable + index * 32 + 4);
    buffer.write(`${name}\0`, nameOffset, "latin1");
    nameOffset += name.length + 1;
  });
  return buffer;
}

test("DirectML files are stripped only when no native file imports them at load time", async (t) => {
  const { readPeImportTables, readPeImports, stripDelayLoadedNativeFiles } = await modulePromise;
  const directMl = ["DirectML.dll", "dxcompiler.dll", "dxil.dll"];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-directml-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const onnxruntime = peWithDelayImports(["KERNEL32.dll", "MSVCP140.dll"], ["DirectML.dll", "d3d12.dll", "dxgi.dll"]);
  assert.deepEqual(readPeImportTables(onnxruntime), {
    imports: ["KERNEL32.dll", "MSVCP140.dll"],
    delayImports: ["DirectML.dll", "d3d12.dll", "dxgi.dll"],
  });
  assert.deepEqual(readPeImports(onnxruntime), ["KERNEL32.dll", "MSVCP140.dll", "DirectML.dll", "d3d12.dll", "dxgi.dll"]);

  const delayLoaded = path.join(root, "delay");
  fs.mkdirSync(delayLoaded);
  fs.writeFileSync(path.join(delayLoaded, "onnxruntime.dll"), onnxruntime);
  fs.writeFileSync(path.join(delayLoaded, "onnxruntime_binding.node"), minimalPe(["onnxruntime.dll"]));
  // DirectML itself hard-imports d3d12; it is one of the files being removed, so it is not analysed.
  fs.writeFileSync(path.join(delayLoaded, "DirectML.dll"), minimalPe(["d3d12.dll"]));
  for (const name of ["dxcompiler.dll", "dxil.dll"]) fs.writeFileSync(path.join(delayLoaded, name), minimalPe(["KERNEL32.dll"]));
  assert.deepEqual(await stripDelayLoadedNativeFiles(delayLoaded, directMl), directMl);
  assert.deepEqual(fs.readdirSync(delayLoaded).sort(), ["onnxruntime.dll", "onnxruntime_binding.node"]);

  const hardImport = path.join(root, "hard");
  fs.mkdirSync(hardImport);
  fs.writeFileSync(path.join(hardImport, "onnxruntime.dll"), minimalPe(["KERNEL32.dll", "DirectML.dll"]));
  for (const name of directMl) fs.writeFileSync(path.join(hardImport, name), minimalPe(["KERNEL32.dll"]));
  await assert.rejects(stripDelayLoadedNativeFiles(hardImport, directMl), /imports DirectML\.dll at load time/);
  assert.equal(fs.readdirSync(hardImport).length, 4, "nothing is removed when a load-time import exists");

  const missing = path.join(root, "missing");
  fs.mkdirSync(missing);
  fs.writeFileSync(path.join(missing, "onnxruntime.dll"), onnxruntime);
  await assert.rejects(stripDelayLoadedNativeFiles(missing, directMl), /Expected native file to strip is missing: DirectML\.dll/);
});
