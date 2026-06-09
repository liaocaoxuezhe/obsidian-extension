export interface SummaryResult {
  text: string;
  usedSummary: boolean;
  error?: string;
}

export interface SummaryClient {
  generate(input: { model: string; prompt: string; options?: Record<string, unknown> }): Promise<string>;
}

export interface DocumentSummarizerOptions {
  enabled: boolean;
  model: string;
  maxInputChars: number;
  fallbackToOriginal: boolean;
  promptTemplate?: string;
  client: SummaryClient;
}

export const SUMMARY_PROMPT_CONTENT_PLACEHOLDER = "{page_content}";

export const DEFAULT_SUMMARY_PROMPT = [
  "Summarize the following article into a 200-word abstract.",
  "Requirements:",
  "1. Retain the core arguments and key conclusions",
  "2. Do not add any content not present in the original text",
  "3. Directly output the summary, without any prefatory explanations",
  "4. Do not output reasoning, thinking process, analysis, or hidden chain-of-thought",
  "Output language: Keep the same as the content's language.",
  "content:",
  "[原文]",
  "```",
  SUMMARY_PROMPT_CONTENT_PLACEHOLDER,
  "```",
].join("\n");

export class DocumentSummarizer {
  constructor(private options: DocumentSummarizerOptions) {}

  async summarize(text: string, _path: string): Promise<SummaryResult> {
    const original = text.trim();
    if (!this.options.enabled || original.length === 0) {
      return { text: original, usedSummary: false };
    }

    try {
      const input = original.slice(0, this.options.maxInputChars);
      const summary = this.stripOuterFence(await this.options.client.generate({
        model: this.options.model,
        prompt: this.buildPrompt(input),
        options: { temperature: 0.2 },
      }));

      if (!summary) {
        return { text: original, usedSummary: false, error: "empty summary" };
      }
      return { text: summary, usedSummary: true };
    } catch (err) {
      if (!this.options.fallbackToOriginal) throw err;
      return {
        text: original,
        usedSummary: false,
        error: (err as Error)?.message || String(err),
      };
    }
  }

  private buildPrompt(content: string): string {
    const template = (this.options.promptTemplate || DEFAULT_SUMMARY_PROMPT).trim() || DEFAULT_SUMMARY_PROMPT;
    if (template.includes(SUMMARY_PROMPT_CONTENT_PLACEHOLDER)) {
      return template.split(SUMMARY_PROMPT_CONTENT_PLACEHOLDER).join(content);
    }
    return [template, "", "content:", "```", content, "```"].join("\n");
  }

  private stripOuterFence(value: string): string {
    const trimmed = value.trim();
    if (!trimmed.startsWith("```") || !trimmed.endsWith("```")) {
      return trimmed;
    }

    let inner = trimmed.slice(3, -3).trim();
    const firstLineBreak = inner.search(/\r?\n/);
    if (firstLineBreak >= 0) {
      const firstLine = inner.slice(0, firstLineBreak).trim();
      if (/^[A-Za-z0-9_-]+$/.test(firstLine)) {
        inner = inner.slice(firstLineBreak).trim();
      }
    }
    return inner.trim();
  }
}
