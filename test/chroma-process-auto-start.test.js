const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "local-vector", "chroma-process.ts"),
  "utf8",
);

assert.match(source, /new ChromaRuntimeManager\(hooks\)/, "Chroma facade must delegate to the managed runtime");
assert.match(source, /executablePath:\s*this\.executablePath/, "the verified executable must be supplied explicitly");
assert.doesNotMatch(source, /python|pip install|\/bin\/zsh|chroma-venv/i, "startup must not bootstrap a system Python runtime");

console.log("Managed Chroma process startup contract test passed");
