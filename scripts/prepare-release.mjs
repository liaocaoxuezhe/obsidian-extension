import fs from "fs";
import path from "path";

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

const releaseDir = path.join(root, "release", manifest.version);
fs.mkdirSync(releaseDir, { recursive: true });
for (const asset of requiredAssets) {
	fs.copyFileSync(path.join(root, asset), path.join(releaseDir, asset));
}

console.log(`Release assets prepared in release/${manifest.version}`);
console.log(`Create a GitHub release tagged exactly: ${manifest.version}`);
console.log("Upload these binary assets: main.js, manifest.json, styles.css");
