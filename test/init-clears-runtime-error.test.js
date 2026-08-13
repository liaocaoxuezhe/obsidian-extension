const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.ts"), "utf8");

assert.match(
  mainSource,
  /updateServiceState\(\{\s*status: "initializing",[\s\S]*?lastError: "",[\s\S]*?activeModel: modelConfig\.shortName,/,
  "initLocalServices should clear stale errors before each initialization attempt"
);

assert.match(
  mainSource,
  /status: "ready",[\s\S]*?embeddingStatus: "ready",[\s\S]*?lastError: "",/,
  "successful local service initialization should clear stale runtime errors"
);

console.log("init clears stale runtime error test passed");
