#!/usr/bin/env node

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import process from "process";

const root = process.cwd();
const MIN_PYTHON = [3, 9];

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd || root,
		stdio: options.capture ? "pipe" : "inherit",
		encoding: "utf8",
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		const details = options.capture
			? `\n${result.stdout || ""}${result.stderr || ""}`.trim()
			: "";
		throw new Error(`${command} ${args.join(" ")} failed${details ? `: ${details}` : ""}`);
	}
	return result.stdout || "";
}

function commandExists(command) {
	const result = spawnSync(command, ["--version"], {
		stdio: "pipe",
		encoding: "utf8",
	});
	return result.status === 0;
}

function parsePythonVersion(output) {
	const match = output.match(/Python\s+(\d+)\.(\d+)\.(\d+)/);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isPythonSupported(version) {
	if (!version) return false;
	if (version[0] !== MIN_PYTHON[0]) return version[0] > MIN_PYTHON[0];
	return version[1] >= MIN_PYTHON[1];
}

function findPython() {
	for (const command of ["python3", "python"]) {
		const result = spawnSync(command, ["--version"], {
			stdio: "pipe",
			encoding: "utf8",
		});
		if (result.status !== 0) continue;
		const version = parsePythonVersion(`${result.stdout || ""}${result.stderr || ""}`);
		if (isPythonSupported(version)) {
			return { command, version };
		}
	}
	throw new Error("Python 3.9 or newer is required. Install Python 3.9+ and rerun this script.");
}

function formatPythonVersion(version) {
	return version.join(".");
}

function main() {
	if (!commandExists("npm")) {
		throw new Error("npm is required. Install Node.js/npm and rerun this script.");
	}

	const python = findPython();
	console.log(`Using ${python.command} ${formatPythonVersion(python.version)}`);

	if (!fs.existsSync(path.join(root, "package.json"))) {
		throw new Error("Run this script from the installed Analogy plugin folder.");
	}

	console.log("\nInstalling Obsidian plugin runtime dependencies...");
	run("npm", ["install", "--omit=dev"]);

	console.log("\nInstalling ChromaDB for the local vector store...");
	run(python.command, ["-m", "pip", "install", "chromadb"]);

	const modelScript = path.join(root, "scripts", "download-jina-model.py");
	if (fs.existsSync(modelScript)) {
		console.log("\nDownloading the default local embedding model...");
		run(python.command, [modelScript]);
	}

	const mcpDir = path.join(root, "mcp-server");
	if (fs.existsSync(path.join(mcpDir, "package.json"))) {
		console.log("\nInstalling and building the companion MCP server...");
		run("npm", ["ci"], { cwd: mcpDir });
		run("npm", ["run", "build"], { cwd: mcpDir });
	}

	console.log("\nLocal runtime setup finished.");
	console.log("Enable Analogy in Obsidian, then start or verify ChromaDB from the plugin settings.");
}

try {
	main();
} catch (err) {
	console.error(`\nLocal runtime setup failed: ${(err && err.message) || err}`);
	process.exit(1);
}
