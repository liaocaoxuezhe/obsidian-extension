export interface HeaderSection {
  header: string;
  content: string;
}

export function cleanMarkdown(content: string): string {
  return (
    content
      // Phase 1 — structural blocks
      .replace(/^---\n[\s\S]*?\n---\n?/, "")
      .replace(/^(`{3,}|~{3,}).*\n[\s\S]*?\n\1\s*$/gm, "")
      .replace(/%%[\s\S]*?%%/g, "")
      .replace(/\$\$[\s\S]*?\$\$/g, "")

      // Phase 2 — links & embeds
      .replace(/!\[\[.*?\]\]/g, "")
      .replace(/\[\[(?:[^\]|]*?\|)?([^\]]*?)\]\]/g, "$1")
      .replace(/!\[.*?\]\(.*?\)/gs, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\[\^[^\]]+\]/g, "")

      // Phase 3 — block-level markers (keep # headers intact)
      .replace(/^\|[-:\s|]+\|$/gm, "")
      .replace(/^\|(.+)\|$/gm, (_, inner: string) =>
        inner.replace(/\|/g, " ").trim(),
      )
      .replace(/^(\s*>)+\s?/gm, "")
      .replace(/\[![\w-]+\]/g, "")
      .replace(/^[-*_]{3,}\s*$/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      .replace(/^\[\^[^\]]+\]:\s*/gm, "")

      // Phase 4 — inline formatting
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\$[^$\n]+\$/g, "")
      .replace(/<\/?[^>]+(>|$)/g, "")
      .replace(/[*_~]{1,3}/g, "")
      .replace(/==/g, "")
      .replace(/https?:\/\/[^\s)>\]]+/g, "")

      // Phase 5 — cleanup
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

export function splitByHeaders(
  cleaned: string,
): HeaderSection[] {
  const lines = cleaned.split("\n");
  const sections: HeaderSection[] = [];
  const headerStack: { level: number; text: string }[] = [];
  let currentLines: string[] = [];

  function flush() {
    const body = currentLines.join("\n").trim();
    if (body || headerStack.length > 0) {
      sections.push({
        header: headerStack.map((h) => h.text).join(" > "),
        content: body,
      });
    }
    currentLines = [];
  }

  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.*)/);
    if (m) {
      flush();
      const level = m[1].length;
      const text = m[2].trim();
      while (
        headerStack.length > 0 &&
        headerStack[headerStack.length - 1].level >= level
      ) {
        headerStack.pop();
      }
      headerStack.push({ level, text });
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return sections.filter((s) => s.content.length > 0);
}
