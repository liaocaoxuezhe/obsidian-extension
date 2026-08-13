const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const facade = fs.readFileSync(path.join(root, "src/local-vector/chroma-process.ts"), "utf8");
const embedding = fs.readFileSync(path.join(root, "src/local-vector/embedding.ts"), "utf8");
const manager = fs.readFileSync(path.join(root, "src/runtime/chroma-runtime-manager.ts"), "utf8");

for (const [label, source] of [["Chroma facade", facade], ["embedding loader", embedding]]) {
  assert.doesNotMatch(source, /\/bin\/zsh|pip install|npm install --omit=dev|shell:\s*true/i, `${label} must not bootstrap through a user shell`);
}
assert.match(facade, /ChromaRuntimeManager/, "the compatibility facade must use the managed process owner");
assert.match(manager, /\{ shell: false \}/, "the managed process owner must disable shell execution");
assert.match(embedding, /automatic npm installation is disabled/, "the embedding loader must direct installation to onboarding");

console.log("Local managed-runtime review passed");
