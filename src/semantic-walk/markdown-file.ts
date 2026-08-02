export function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path);
}
