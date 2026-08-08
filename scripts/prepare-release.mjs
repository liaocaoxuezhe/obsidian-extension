import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { fileURLToPath } from "node:url";
import { assertGeneratedRuntimeBinding, computePublicRuntimeManifestSha256 } from "./runtime-manifest-binding.mjs";
import { EXPECTED_PACKS, RUNTIME_VERSIONS, validateRuntimeArtifactGroup } from "./runtime-package-validator.mjs";

const root = process.cwd();
const COMMUNITY_PLUGIN_FILES = Object.freeze(["main.js", "manifest.json", "styles.css"]);

export function verifyCommunityPluginDirectory(pluginDirectory) {
	const files = fs.readdirSync(pluginDirectory, { recursive: true })
		.map((entry) => String(entry))
		.filter((entry) => fs.statSync(path.join(pluginDirectory, entry)).isFile())
		.sort();
	if (JSON.stringify(files) !== JSON.stringify([...COMMUNITY_PLUGIN_FILES].sort())) {
		throw new Error(`Community plugin directory must contain exactly ${COMMUNITY_PLUGIN_FILES.join(", ")}`);
	}
	return files;
}

function parseRuntimeOptions(argv) {
	let runtimeOnly = false;
	let runtimeStaging = "";
	let allowDevelopmentRuntimeFixture = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--runtime-only") {
			runtimeOnly = true;
		} else if (argument === "--allow-development-runtime-fixture") {
			allowDevelopmentRuntimeFixture = true;
		} else if (argument === "--runtime-staging") {
			runtimeStaging = argv[index + 1] || "";
			index += 1;
		} else {
			throw new Error(`Unknown release argument: ${argument}`);
		}
	}
	if (runtimeOnly && !runtimeStaging) {
		throw new Error("--runtime-only requires --runtime-staging <directory>");
	}
	if (runtimeOnly && allowDevelopmentRuntimeFixture) {
		throw new Error("--allow-development-runtime-fixture cannot be combined with --runtime-only");
	}
	return { runtimeOnly, runtimeStaging, allowDevelopmentRuntimeFixture };
}

function requirePublishedGeneratedRuntimeManifest(projectRoot) {
	const generatedManifestPath = path.join(projectRoot, "src", "runtime", "generated-embedding-runtime-manifest.ts");
	const source = fs.existsSync(generatedManifestPath)
		? fs.readFileSync(generatedManifestPath, "utf8")
		: "";
	if (!source.includes('EMBEDDING_RUNTIME_MANIFEST_SOURCE = "published"')
		|| source.includes("development-fixture")
		|| source.includes("example.invalid")) {
		throw new Error("Default release requires a published embedding runtime manifest; development fixture is forbidden");
	}
}

function sha256File(filename) {
	const hash = crypto.createHash("sha256");
	const handle = fs.openSync(filename, "r");
	const buffer = Buffer.allocUnsafe(1024 * 1024);
	try {
		let bytesRead = 0;
		do {
			bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
			if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
		} while (bytesRead > 0);
	} finally {
		fs.closeSync(handle);
	}
	return hash.digest("hex");
}

function requireRegularFile(filename, label) {
	if (!fs.existsSync(filename)) throw new Error(`Missing ${label}: ${path.basename(filename)}`);
	const stat = fs.lstatSync(filename);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${path.basename(filename)}`);
	return stat;
}

function requireSafeFilename(filename, label) {
	if (typeof filename !== "string" || !filename || filename !== path.basename(filename) || filename.includes("\\")) {
		throw new Error(`${label} must be a basename: ${filename}`);
	}
}

export function verifyRuntimeRelease(runtimeStaging, {
	generatedManifestPath = "",
	mainJsPath = "",
	buildInfoPath = "",
	trustPolicy,
} = {}) {
	const stagingRoot = path.resolve(runtimeStaging);
	const manifestPath = path.join(stagingRoot, "embedding-runtime-manifest.json");
	requireRegularFile(manifestPath, "runtime release manifest");
	const runtimeManifestSource = fs.readFileSync(manifestPath, "utf8");
	const runtimeManifest = JSON.parse(runtimeManifestSource);
	if (runtimeManifestSource !== `${JSON.stringify(runtimeManifest, null, 2)}\n`) {
		throw new Error("embedding-runtime-manifest.json must use the canonical generated JSON representation");
	}
	if (runtimeManifest.schemaVersion !== 1 || runtimeManifest.runtimeVersion !== "node22-v1"
		|| typeof runtimeManifest.baseUrl !== "string" || !runtimeManifest.baseUrl.startsWith("https://")) {
		throw new Error("Invalid embedding-runtime-manifest.json header");
	}
	const expectedPlatforms = ["darwin-arm64", "win32-x64"];
	if (!Array.isArray(runtimeManifest.assets)
		|| runtimeManifest.assets.length !== expectedPlatforms.length
		|| JSON.stringify(runtimeManifest.assets.map((asset) => asset.platform)) !== JSON.stringify(expectedPlatforms)) {
		throw new Error("Runtime release manifest must contain exactly one asset for darwin-arm64 and win32-x64");
	}

	for (const asset of runtimeManifest.assets) {
		const expected = EXPECTED_PACKS.find((candidate) => candidate.platform === asset.platform);
		if (!expected || expected.fileName !== asset.fileName || expected.archive !== asset.archive) {
			throw new Error(`Unexpected runtime archive identity for ${asset.platform}`);
		}
		requireSafeFilename(asset.fileName, "Runtime pack filename");
		requireSafeFilename(asset.internalManifestFile, "Internal manifest filename");
		requireSafeFilename(asset.noticesFile, "Notices filename");
		requireSafeFilename(asset.smokeAttestationFile, "Smoke attestation filename");
		requireSafeFilename(asset.completionMarkerFile, "Completion marker filename");
		if (asset.kind !== "embedding-runtime" || asset.version !== "node22-v1" || asset.source !== "published"
			|| asset.id !== `embedding-runtime-node22-v1-${asset.platform}`
			|| asset.url !== `${runtimeManifest.baseUrl}/${asset.fileName}`
			|| asset.licenseUrl !== `${runtimeManifest.baseUrl}/${asset.noticesFile}`
			|| !/^[0-9a-f]{64}$/.test(asset.sha256 || "")
			|| !/^[0-9a-f]{64}$/.test(asset.internalManifestSha256 || "")
			|| !/^[0-9a-f]{64}$/.test(asset.noticesSha256 || "")
			|| !/^[0-9a-f]{64}$/.test(asset.smokeAttestationSha256 || "")
			|| !/^[0-9a-f]{64}$/.test(asset.completionMarkerSha256 || "")
			|| JSON.stringify(asset.runtimeVersions) !== JSON.stringify(RUNTIME_VERSIONS)) {
			throw new Error(`Invalid runtime manifest entry for ${asset.platform}`);
		}

		validateRuntimeArtifactGroup(stagingRoot, expected, { releaseAsset: asset, trustPolicy });

		const archivePath = path.join(stagingRoot, asset.fileName);
		const archiveStat = requireRegularFile(archivePath, "runtime pack");
		if (archiveStat.size !== asset.size) {
			throw new Error(`Runtime pack size mismatch for ${asset.fileName}: expected ${asset.size}, got ${archiveStat.size}`);
		}
		const archiveSha256 = sha256File(archivePath);
		if (archiveSha256 !== asset.sha256) {
			throw new Error(`Runtime pack SHA-256 mismatch for ${asset.fileName}: expected ${asset.sha256}, got ${archiveSha256}`);
		}

		const internalManifestPath = path.join(stagingRoot, asset.internalManifestFile);
		requireRegularFile(internalManifestPath, "runtime internal manifest");
		const internalManifestSha256 = sha256File(internalManifestPath);
		if (internalManifestSha256 !== asset.internalManifestSha256) {
			throw new Error(`Runtime internal manifest SHA-256 mismatch for ${asset.fileName}`);
		}
		const internalManifest = JSON.parse(fs.readFileSync(internalManifestPath, "utf8"));
		if (internalManifest.schemaVersion !== 1 || internalManifest.id !== asset.id
			|| internalManifest.platform !== asset.platform || internalManifest.version !== asset.version
			|| `analogy-embedding-runtime-node22-v1/${internalManifest.executableRelativePath}` !== asset.executableRelativePath
			|| internalManifest.noticesRelativePath !== "THIRD_PARTY_NOTICES.txt") {
			throw new Error(`Runtime internal manifest mismatch for ${asset.fileName}`);
		}
		const ortOverlay = internalManifest.inputs?.onnxruntimeNativeOverlay;
		if (ortOverlay !== undefined) {
			throw new Error(`Unexpected ONNX Runtime source overlay provenance for ${asset.platform}`);
		}

		const noticesPath = path.join(stagingRoot, asset.noticesFile);
		const noticesStat = requireRegularFile(noticesPath, "runtime THIRD_PARTY_NOTICES");
		if (noticesStat.size !== asset.noticesSize) {
			throw new Error(`Runtime THIRD_PARTY_NOTICES size mismatch for ${asset.fileName}`);
		}
		const noticesSha256 = sha256File(noticesPath);
		if (noticesSha256 !== asset.noticesSha256) {
			throw new Error(`Runtime THIRD_PARTY_NOTICES SHA-256 mismatch for ${asset.fileName}`);
		}
		if (!fs.readFileSync(noticesPath, "utf8").trim()) {
			throw new Error(`Runtime THIRD_PARTY_NOTICES is empty for ${asset.fileName}`);
		}
		const noticesEntry = Array.isArray(internalManifest.files)
			? internalManifest.files.find((entry) => entry.path === "THIRD_PARTY_NOTICES.txt")
			: null;
		if (!noticesEntry || noticesEntry.size !== asset.noticesSize || noticesEntry.sha256 !== asset.noticesSha256) {
			throw new Error(`Runtime internal notices hash mismatch for ${asset.fileName}`);
		}
		for (const [filename, expectedSha256, label] of [
			[asset.smokeAttestationFile, asset.smokeAttestationSha256, "runtime native smoke attestation"],
			[asset.completionMarkerFile, asset.completionMarkerSha256, "runtime completion marker"],
		]) {
			const pathname = path.join(stagingRoot, filename);
			requireRegularFile(pathname, label);
			if (sha256File(pathname) !== expectedSha256) throw new Error(`${label} SHA-256 mismatch for ${asset.fileName}`);
		}
	}
	if (generatedManifestPath) {
		requireRegularFile(generatedManifestPath, "generated TypeScript runtime manifest");
		assertGeneratedRuntimeBinding(fs.readFileSync(generatedManifestPath, "utf8"), runtimeManifest);
	}
	if (mainJsPath) {
		if (!buildInfoPath) throw new Error("Built main.js runtime binding requires build-info.json");
		requireRegularFile(mainJsPath, "built main.js");
		requireRegularFile(buildInfoPath, "build-info.json");
		const mainJs = fs.readFileSync(mainJsPath, "utf8");
		const publicManifestSha256 = computePublicRuntimeManifestSha256(runtimeManifest);
		const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
		if (buildInfo.embeddingRuntimePublicManifestSha256 !== publicManifestSha256) {
			throw new Error("build-info runtime manifest digest mismatch; regenerate manifest before building");
		}
		if (buildInfo.mainJsSha256 !== sha256File(mainJsPath)) {
			throw new Error("build-info main.js SHA-256 does not match the release bundle");
		}
		const markerMatches = [...mainJs.matchAll(/ANALOGY_EMBEDDING_RUNTIME_MANIFEST_SHA256:([0-9a-f]{64})/g)];
		const constantMatches = [...mainJs.matchAll(/(?:var|const) EMBEDDING_RUNTIME_BUILD_BINDING = "ANALOGY_EMBEDDING_RUNTIME_MANIFEST_SHA256:([0-9a-f]{64})";/g)];
		if (markerMatches.length !== 1 || constantMatches.length !== 1
			|| markerMatches[0][1] !== publicManifestSha256 || constantMatches[0][1] !== publicManifestSha256) {
			throw new Error("Built main.js must contain exactly one runtime manifest binding constant with the canonical staging digest");
		}
	}
	return runtimeManifest;
}

function copyRuntimeRelease(runtimeManifest, sourceRoot, destinationRoot) {
	fs.mkdirSync(destinationRoot, { recursive: true });
	const files = ["embedding-runtime-manifest.json"];
	for (const asset of runtimeManifest.assets) {
		files.push(
			asset.fileName,
			asset.internalManifestFile,
			asset.noticesFile,
			asset.smokeAttestationFile,
			asset.completionMarkerFile,
		);
	}
	for (const filename of [...new Set(files)]) {
		fs.copyFileSync(path.join(sourceRoot, filename), path.join(destinationRoot, filename));
	}
}

function main() {
const runtimeOptions = parseRuntimeOptions(process.argv.slice(2));
const generatedRuntimeManifestPath = path.join(root, "src", "runtime", "generated-embedding-runtime-manifest.ts");
if (runtimeOptions.runtimeOnly) {
	verifyRuntimeRelease(runtimeOptions.runtimeStaging, { generatedManifestPath: generatedRuntimeManifestPath });
	console.log(`[prepare-release] Verified embedding runtime staging: ${path.resolve(runtimeOptions.runtimeStaging)}`);
} else {
if (!runtimeOptions.allowDevelopmentRuntimeFixture) {
	requirePublishedGeneratedRuntimeManifest(root);
}
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

const configuredRuntimeRoot = (process.env.ANALOGY_RUNTIME_ASSETS_DIR || "").trim();
const runtimeSourceRoot = path.resolve(configuredRuntimeRoot || path.join(root, "dist", "runtime"));
let verifiedRuntimeManifest = null;
if (!runtimeOptions.allowDevelopmentRuntimeFixture) {
	// The default release is a single fail-closed gate: all supported completed,
	// archive-validated native generations must exist before release files mutate.
	verifiedRuntimeManifest = verifyRuntimeRelease(runtimeSourceRoot, {
		generatedManifestPath: generatedRuntimeManifestPath,
		mainJsPath: path.join(root, "main.js"),
		buildInfoPath,
	});
} else if (configuredRuntimeRoot || fs.existsSync(path.join(runtimeSourceRoot, "embedding-runtime-manifest.json"))) {
	verifiedRuntimeManifest = verifyRuntimeRelease(runtimeSourceRoot, {
		generatedManifestPath: generatedRuntimeManifestPath,
		mainJsPath: path.join(root, "main.js"),
		buildInfoPath,
	});
}

const releaseDir = path.join(root, "release", manifest.version);
fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir, { recursive: true });
for (const asset of requiredAssets) {
	fs.copyFileSync(path.join(root, asset), path.join(releaseDir, asset));
}

const communityDir = path.join(releaseDir, "community");
fs.mkdirSync(communityDir, { recursive: true });
for (const asset of COMMUNITY_PLUGIN_FILES) {
	fs.copyFileSync(path.join(root, asset), path.join(communityDir, asset));
}
verifyCommunityPluginDirectory(communityDir);

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

if (verifiedRuntimeManifest) {
	const runtimeReleaseDir = path.join(releaseDir, "runtime");
	copyRuntimeRelease(verifiedRuntimeManifest, runtimeSourceRoot, runtimeReleaseDir);
	verifyRuntimeRelease(runtimeReleaseDir, {
		generatedManifestPath: generatedRuntimeManifestPath,
		mainJsPath: path.join(root, "main.js"),
		buildInfoPath,
	});
}

console.log(`Release assets prepared in release/${manifest.version}`);
console.log(`Community three-file directory verified in release/${manifest.version}/community`);
console.log(`Create a GitHub release tagged exactly: ${manifest.version}`);
console.log("Upload these Obsidian assets: main.js, manifest.json, styles.css");
console.log("For full local RAG + MCP setup, publish the release directory contents or archive it.");
}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(`[prepare-release] ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
