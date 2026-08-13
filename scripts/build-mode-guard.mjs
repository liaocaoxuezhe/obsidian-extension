import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUILD_MODES = Object.freeze(["local", "ci", "release"]);

export function assertBuildMode(requestedMode, environment = process.env) {
  if (!BUILD_MODES.includes(requestedMode)) {
    throw new Error("BUILD_MODE_REQUIRED: use npm run build:local, npm run build:ci, or the internal npm run build:release");
  }
  const markers = BUILD_MODES.filter((mode) => environment[`ANALOGY_BUILD_MODE_${mode.toUpperCase()}`] === "1");
  if (markers.length > 1) {
    throw new Error(`BUILD_MODE_CONFLICT: mutually exclusive mode markers are set (${markers.join(", ")})`);
  }
  if (markers.length === 1 && markers[0] !== requestedMode) {
    throw new Error(`BUILD_MODE_CONFLICT: ${requestedMode} does not match ${markers[0]} marker`);
  }
  const declared = (environment.ANALOGY_BUILD_MODE || "").trim();
  if (declared && declared !== requestedMode) {
    throw new Error(`BUILD_MODE_CONFLICT: ${requestedMode} does not match ANALOGY_BUILD_MODE=${declared}`);
  }
  return requestedMode;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const mode = assertBuildMode(process.argv[2]);
    console.log(`[build-mode] ${mode}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
