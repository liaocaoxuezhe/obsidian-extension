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

const buildId = (process.env.ANALOGY_BUILD_ID || "").trim();
const artifactsRoot = path.join(root, "artifacts");
let resolvedBuildId = buildId;
if (!resolvedBuildId && fs.existsSync(artifactsRoot)) {
	const candidates = fs.readdirSync(artifactsRoot)
		.filter((dir) => dir.startsWith(`${manifest.version}+`) && fs.existsSync(path.join(artifactsRoot, dir, "build-info.json")))
		.map((dir) => ({ dir, mtime: fs.statSync(path.join(artifactsRoot, dir)).mtime.getTime() }))
		.sort((a, b) => b.mtime - a.mtime);
	if (candidates.length > 0) {
		resolvedBuildId = candidates[0].dir;
	}
}
const artifactsDir = resolvedBuildId ? path.join(artifactsRoot, resolvedBuildId) : "";
const buildInfoPath = artifactsDir ? path.join(artifactsDir, "build-info.json") : "";
if (resolvedBuildId) {
	if (!fs.existsSync(buildInfoPath)) {
		throw new Error(`Missing build-info artifact for ${resolvedBuildId}. Run npm run build first.`);
	}
	if (!fs.existsSync(path.join(artifactsDir, "main.js.map"))) {
		throw new Error(`Missing source map artifact for ${resolvedBuildId}.`);
	}
	const mainJs = fs.readFileSync(path.join(root, "main.js"), "utf8");
	if (!mainJs.includes(resolvedBuildId)) {
		throw new Error(`Build ID ${resolvedBuildId} not found in main.js. Rebuild first.`);
	}
} else {
	console.warn("[prepare-release] ANALOGY_BUILD_ID not set and no artifacts found; skipping source map artifact verification.");
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

const forbiddenReleaseFiles = fs.readdirSync(releaseDir, { recursive: true })
	.map((f) => path.join(releaseDir, f))
	.filter((f) => fs.statSync(f).isFile() && f.endsWith(".map"));
if (forbiddenReleaseFiles.length > 0) {
	throw new Error(`Release directory must not contain source maps: ${forbiddenReleaseFiles.join(", ")}`);
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
