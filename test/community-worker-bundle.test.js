const assert = require("assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const mainPath = path.join(root, "main.js");
const mainMapPath = path.join(root, "main.js.map");
const originalMain = fs.readFileSync(mainPath);
const originalMainMap = fs.existsSync(mainMapPath) ? fs.readFileSync(mainMapPath) : null;
const version = require(path.join(root, "package.json")).version;
const buildId = `${version}+test.community-worker.${process.pid}`;
const artifactDir = path.join(root, "artifacts", buildId);

try {
  execFileSync(process.execPath, ["esbuild.config.mjs", "ci"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ANALOGY_BUILD_ID: buildId },
  });

  const mainBundle = fs.readFileSync(mainPath, "utf8");
  assert.ok(
    mainBundle.includes("[AnalogyWorker]"),
    "main.js must contain the embedded worker implementation",
  );
  assert.ok(
    !fs.existsSync(path.join(root, "embedding-worker.js")),
    "production builds must not require a standalone embedding-worker.js",
  );
  assert.ok(
    !fs.existsSync(path.join(root, "embedding-worker.js.map")),
    "production builds must not leave a standalone worker source map",
  );
} finally {
  fs.writeFileSync(mainPath, originalMain);
  if (originalMainMap) fs.writeFileSync(mainMapPath, originalMainMap);
  else fs.rmSync(mainMapPath, { force: true });
  fs.rmSync(artifactDir, { recursive: true, force: true });
}

console.log("Community worker bundle test passed");
