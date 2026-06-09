import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const versions = JSON.parse(fs.readFileSync(path.join(root, "versions.json"), "utf8"));

if (!/^[a-z0-9-]+$/.test(manifest.id)) {
	throw new Error(`manifest.id must be a lowercase slug without spaces: ${manifest.id}`);
}

if (manifest.version !== pkg.version) {
	throw new Error(`manifest.version (${manifest.version}) must match package.json version (${pkg.version})`);
}

if (versions[manifest.version] !== manifest.minAppVersion) {
	throw new Error(`versions.json must contain "${manifest.version}": "${manifest.minAppVersion}"`);
}

const requiredAssets = ["main.js", "manifest.json", "styles.css"];
for (const asset of requiredAssets) {
	const assetPath = path.join(root, asset);
	if (!fs.existsSync(assetPath)) {
		throw new Error(`Missing release asset: ${asset}`);
	}
}

const runtimeFiles = [
	"package.json",
	"package-lock.json",
	"scripts/download-jina-model.py",
	"scripts/install-local-runtime.mjs",
];

for (const file of runtimeFiles) {
	const filePath = path.join(root, file);
	if (!fs.existsSync(filePath)) {
		throw new Error(`Missing runtime setup file: ${file}`);
	}
}

const releaseDir = path.join(root, "release", manifest.version);
fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir, { recursive: true });
for (const asset of requiredAssets) {
	fs.copyFileSync(path.join(root, asset), path.join(releaseDir, asset));
}

for (const file of runtimeFiles) {
	const dest = path.join(releaseDir, file);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.copyFileSync(path.join(root, file), dest);
}

const mcpFiles = execFileSync("git", ["ls-files", "mcp-server"], {
	cwd: root,
	encoding: "utf8",
})
	.split(/\r?\n/)
	.filter(Boolean)
	.filter((file) => {
		const basename = path.basename(file);
		return !file.includes("/commercial/") && !basename.includes(".commercial");
	});

for (const file of mcpFiles) {
	const dest = path.join(releaseDir, file);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.copyFileSync(path.join(root, file), dest);
}

console.log(`Release assets prepared in release/${manifest.version}`);
console.log(`Create a GitHub release tagged exactly: ${manifest.version}`);
console.log("Upload these Obsidian assets: main.js, manifest.json, styles.css");
console.log("For full local RAG + MCP setup, publish the release directory contents or archive it.");
