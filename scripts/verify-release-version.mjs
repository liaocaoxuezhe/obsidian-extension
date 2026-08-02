import fs from "fs";
import path from "path";
import process from "process";

const root = process.cwd();
const tag = (process.argv[2] || "").trim();

if (!/^\d+\.\d+\.\d+$/.test(tag)) {
  throw new Error(
    `Release tag "${tag}" must be a bare semantic version such as 1.2.3`,
  );
}

function readJson(relativePath) {
  const filePath = path.join(root, relativePath);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read ${relativePath}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

const pkg = readJson("package.json");
const packageLock = readJson("package-lock.json");
const manifest = readJson("manifest.json");
const versions = readJson("versions.json");

if (tag !== pkg.version) {
  throw new Error(
    `Release tag ${tag} does not match package.json version ${pkg.version}`,
  );
}
if (manifest.version !== pkg.version) {
  throw new Error(
    `manifest.json version ${manifest.version} does not match package.json version ${pkg.version}`,
  );
}
if (packageLock.version !== pkg.version) {
  throw new Error(
    `package-lock.json version ${packageLock.version} does not match package.json version ${pkg.version}`,
  );
}
if (packageLock.packages?.[""]?.version !== pkg.version) {
  throw new Error(
    `package-lock.json root package version ${packageLock.packages?.[""]?.version} does not match package.json version ${pkg.version}`,
  );
}
if (versions[tag] !== manifest.minAppVersion) {
  throw new Error(
    `versions.json must map ${tag} to manifest minAppVersion ${manifest.minAppVersion}`,
  );
}

console.log(
  `Release metadata verified: ${tag} (minimum Obsidian ${manifest.minAppVersion})`,
);
