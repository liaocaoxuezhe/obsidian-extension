import { requestUrl } from "obsidian";
import type { DiagnosticReport, DiagnosticReportResponse } from "./diagnostic-types";

export interface SendReportOptions {
  endpoint: string;
  timeoutMs?: number;
  serializedReport?: string;
}

export async function sendDiagnosticReport(
  report: DiagnosticReport,
  options: SendReportOptions
): Promise<DiagnosticReportResponse> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const response = await requestUrl({
    url: options.endpoint,
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Accept": "application/json",
    },
    body: options.serializedReport ?? JSON.stringify(report),
    throw: false,
    timeout: timeoutMs,
  });

  if (response.status >= 400) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = typeof response.json === "function" ? response.json : JSON.parse(response.text);
      if (body?.message || body?.detail) {
        detail = `${detail}: ${body.message || body.detail}`;
      }
    } catch {
      // ignore body parse
    }
    throw new Error(detail);
  }

  const body = typeof response.json === "object" ? response.json : JSON.parse(response.text);
  return body as DiagnosticReportResponse;
}

export function generateReportFileName(pluginVersion: string): string {
  const now = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  return `analogy-diagnostic-${pluginVersion}-${now}.json`;
}

export function formatReportAsMarkdown(report: DiagnosticReport): string {
  const lines: string[] = [];
  lines.push(`# Analogy Diagnostic Report`);
  lines.push("");
  lines.push(`- **Report ID**: ${report.report_id}`);
  lines.push(`- **Plugin Version**: ${report.plugin.version}`);
  lines.push(`- **Build ID**: ${report.plugin.build_id}`);
  lines.push(`- **Obsidian Version**: ${report.host.obsidian_version}`);
  lines.push(`- **Platform**: ${report.host.platform} (${report.host.arch})`);
  lines.push(`- **Locale**: ${report.host.locale}`);
  lines.push(`- **Model**: ${report.runtime.model}`);
  lines.push(`- **Suspected Unclean Exit**: ${report.session.suspected_unclean_exit ? "Yes" : "No"}`);
  lines.push(`- **Last Stage**: ${report.session.last_stage}`);
  lines.push(`- **Safe Mode**: ${report.session.safe_mode ? "Yes" : "No"}`);
  lines.push("");
  lines.push("## Recent Events");
  lines.push("");
  for (const event of report.events.slice(-20)) {
    lines.push(`### ${event.timestamp} [${event.level.toUpperCase()}] ${event.stage} — ${event.code}`);
    lines.push(event.message);
    if (event.error) {
      lines.push("");
      lines.push("```");
      lines.push(`${event.error.name}: ${event.error.message}`);
      if (event.error.stack) lines.push(event.error.stack);
      lines.push("```");
    }
    lines.push("");
  }
  return lines.join("\n");
}
