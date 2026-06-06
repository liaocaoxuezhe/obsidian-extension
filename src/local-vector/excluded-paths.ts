export function normalizeExcludedIndexPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const rawPath of paths) {
    const path = rawPath.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!path || seen.has(path)) continue;
    seen.add(path);
    normalized.push(path);
  }

  return normalized;
}

export function isPathExcludedFromIndex(filePath: string, excludedPaths: string[]): boolean {
  const normalizedPath = filePath.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");

  return excludedPaths.some((excludedPath) => {
    return normalizedPath === excludedPath || normalizedPath.startsWith(`${excludedPath}/`);
  });
}
