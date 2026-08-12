#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const FORBIDDEN_PATHS = [
  /(^|\/)mcp-server\/src\/commercial(?:\/|$)/,
  /(^|\/)mcp-server\/dist\/commercial(?:\/|$)/,
  /(^|\/)mcp-server\/(?:Dockerfile\.commercial|docker-compose\.commercial\.yml|\.env\.commercial)(?:$|\/)/,
  /(^|\/)test\/commercial-[^/]*\.test\.js$/,
  /(^|\/)docs\/(?:commercial(?:-[^/]+|ization)\.(?:html|md)|privacy-policy-template\.md)$/,
];

const FORBIDDEN_CONTENT = [
  {id: "stripe-live-secret", pattern: /sk_live_[A-Za-z0-9_]{16,}/},
  {id: "stripe-webhook-secret", pattern: /whsec_[A-Za-z0-9_]{16,}/},
  {id: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/},
  {id: "database-url-with-password", pattern: /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@/i},
  {
    id: "commercial-server-entry",
    pattern: new RegExp([
      "class\\s+Stripe" + "CheckoutService",
      "parseAndVerify" + "StripeWebhook",
      "class\\s+Postgres" + "CommercialStore",
    ].join("|")),
  },
];

const BASELINE_EXCLUDED_PREFIXES = [
  ".git/",
  "node_modules/",
  "mcp-server/node_modules/",
  "artifacts/",
  "dist/",
  "release/",
  "test/fixtures/public-boundary/",
];

function normalize(relativePath) {
  return relativePath.split(path.sep).join("/").replace(/^\.\//, "");
}

function isExcluded(relativePath) {
  const normalized = normalize(relativePath);
  return BASELINE_EXCLUDED_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

function isProbablyText(filePath) {
  const sample = fs.readFileSync(filePath).subarray(0, 8192);
  return !sample.includes(0);
}

export function scanPaths(root, paths, {excludeBaselineFixtures = true} = {}) {
  const violations = [];
  for (const candidate of paths) {
    const relativePath = normalize(candidate);
    if (excludeBaselineFixtures && isExcluded(relativePath)) {
      continue;
    }
    for (const pattern of FORBIDDEN_PATHS) {
      if (pattern.test(relativePath)) {
        violations.push({path: relativePath, rule: "forbidden-path"});
        break;
      }
    }
    const absolutePath = path.join(root, relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile() || !isProbablyText(absolutePath)) {
      continue;
    }
    const content = fs.readFileSync(absolutePath, "utf8");
    for (const rule of FORBIDDEN_CONTENT) {
      if (rule.pattern.test(content)) {
        violations.push({path: relativePath, rule: rule.id});
      }
    }
  }
  return violations;
}

export function collectWorkspaceFiles(root) {
  const files = [];
  function visit(relativeDirectory) {
    const absoluteDirectory = path.join(root, relativeDirectory);
    for (const entry of fs.readdirSync(absoluteDirectory, {withFileTypes: true})) {
      const relativePath = normalize(path.join(relativeDirectory, entry.name));
      if (isExcluded(relativePath)) {
        continue;
      }
      if (entry.isDirectory()) {
        visit(relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }
  visit("");
  return files.sort();
}

export function runBoundaryMode(mode, root) {
  if (mode === "tracked") {
    const paths = execFileSync("git", ["ls-files", "-z"], {cwd: root})
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    return scanPaths(root, paths);
  }
  if (mode === "workspace") {
    return scanPaths(root, collectWorkspaceFiles(root));
  }
  if (mode === "release") {
    const paths = collectWorkspaceFiles(root);
    return scanPaths(root, paths, {excludeBaselineFixtures: false});
  }
  throw new Error(`Unknown boundary mode: ${mode}`);
}

function parseArguments(argv) {
  const modeIndex = argv.indexOf("--mode");
  const rootIndex = argv.indexOf("--root");
  if (modeIndex < 0 || !argv[modeIndex + 1]) {
    throw new Error("Usage: check-public-boundary.mjs --mode tracked|workspace|release [--root PATH]");
  }
  return {
    mode: argv[modeIndex + 1],
    root: path.resolve(rootIndex >= 0 && argv[rootIndex + 1] ? argv[rootIndex + 1] : process.cwd()),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {mode, root} = parseArguments(process.argv.slice(2));
    const violations = runBoundaryMode(mode, root);
    if (violations.length > 0) {
      for (const violation of violations) {
        console.error(`${violation.rule}: ${violation.path}`);
      }
      process.exitCode = 1;
    } else {
      console.log(`Public boundary ${mode} check passed (${root})`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
