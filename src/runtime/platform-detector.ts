import { SupportedPlatformKey } from "./runtime-types";

const PLATFORM_MAP: Record<string, SupportedPlatformKey> = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "win32-x64": "win32-x64",
};

export function detectSupportedPlatform(
  platform: string = process.platform,
  architecture: string = process.arch,
): SupportedPlatformKey {
  const supportedPlatform = PLATFORM_MAP[`${platform}-${architecture}`];
  if (!supportedPlatform) {
    throw new Error(`UNSUPPORTED_PLATFORM: ${platform}-${architecture}`);
  }
  return supportedPlatform;
}
