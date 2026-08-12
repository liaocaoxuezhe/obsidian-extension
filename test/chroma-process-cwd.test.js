const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "runtime", "chroma-runtime-manager.ts"),
  "utf8",
);

assert.match(source, /"run",\s*"--path",\s*options\.dataPath/, "managed Chroma must receive the vault data path as an argument");
assert.match(source, /\{ shell: false \}/, "managed Chroma must be launched without a shell");
assert.doesNotMatch(source, /cwd:\s*options\.dataPath/, "the vector database path must not be used as executable cwd");

console.log("Managed Chroma launch isolation test passed");
