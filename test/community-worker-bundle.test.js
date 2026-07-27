const assert = require("assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

execFileSync(process.execPath, ["esbuild.config.mjs", "production"], {
  cwd: root,
  stdio: "inherit",
});

const mainBundle = fs.readFileSync(path.join(root, "main.js"), "utf8");
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

console.log("Community worker bundle test passed");
