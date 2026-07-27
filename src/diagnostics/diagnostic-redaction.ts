import * as crypto from "crypto";
import type { DiagnosticEvent, DiagnosticReport } from "./diagnostic-types";

export interface RedactionOptions {
  vaultPath?: string;
  salt?: string;
}

const LICENSE_RE = /ANALOGY-[A-Z0-9_-]{8,}/gi;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const BEARER_RE = /Bearer\s+[a-zA-Z0-9_\-./=]{8,}/gi;
const TOKEN_QUERY_RE = /([?&])(token|api_key|apikey|key|auth|secret|license)=([^&\s]*)/gi;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ABS_PATH_RE = /([A-Za-z]:\\[^\s"<>|:*?]+|\/[^\s"<>|:*?]+)/g;
const ANONYMOUS_FILE_RE = /<file:([a-f0-9]{8,64})>/gi;

export function generateReportSalt(): string {
  return crypto.randomBytes(8).toString("hex");
}

export function createRedactor(options: RedactionOptions = {}) {
  const vaultPath = options.vaultPath ? normalizePath(options.vaultPath) : "";
  const salt = options.salt || generateReportSalt();

  function fileHash(pathValue: string): string {
    return crypto
      .createHash("sha256")
      .update(salt)
      .update(pathValue)
      .digest("hex")
      .slice(0, 8);
  }

  function redactPath(value: string): string {
    let result = value;
    if (vaultPath) {
      // Replace vault paths with anonymous root.
      const escaped = vaultPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const vaultRe = new RegExp(escaped + "([^\\s\"'<>|:*?]*)", "g");
      result = result.replace(vaultRe, (_, rest: string) => {
        if (!rest) return "<vault-path>";
        return `<vault-path>/<file:${fileHash(rest)}>`;
      });
    }

    // User home directories.
    result = result.replace(/C:\\Users\\[^\\\s]+/gi, "<user-home>");
    result = result.replace(/\/Users\/[^\/\s]+/g, "<user-home>");
    result = result.replace(/\/home\/[^\/\s]+/g, "<user-home>");

    // Remaining absolute paths are generic.
    result = result.replace(ABS_PATH_RE, "<path>");
    return result;
  }

  function redactString(value: string): string {
    if (!value) return value;
    let result = value;
    result = redactPath(result);
    result = result.replace(LICENSE_RE, "<license-key>");
    result = result.replace(EMAIL_RE, "<email>");
    result = result.replace(BEARER_RE, "Bearer <token>");
    result = result.replace(TOKEN_QUERY_RE, "$1$2=<token>");
    result = result.replace(UUID_RE, "<uuid>");
    result = result.replace(ANONYMOUS_FILE_RE, (_, localId: string) => {
      return `<file:${fileHash(localId)}>`;
    });
    // Truncate very long lines to avoid accidental content inclusion.
    return result.slice(0, 16384);
  }

  function redactContext(
    context: Record<string, string | number | boolean | null> | undefined
  ): Record<string, string | number | boolean | null> | undefined {
    if (!context) return context;
    const out: Record<string, string | number | boolean | null> = {};
    for (const key of Object.keys(context)) {
      const val = context[key];
      if (typeof val === "string") {
        out[key] = redactString(val);
      } else {
        out[key] = val;
      }
    }
    return out;
  }

  function redactError(error: { name?: string; message?: string; stack?: string; causeCode?: string } | undefined) {
    if (!error) return undefined;
    return {
      name: redactString(error.name || "Error"),
      message: redactString(error.message || ""),
      stack: error.stack ? redactString(error.stack) : undefined,
      causeCode: error.causeCode ? redactString(error.causeCode) : undefined,
    };
  }

  return {
    salt,
    redactString,
    redactContext,
    redactError,
    fileHash,
  };
}

export function redactDiagnosticReport(
  report: DiagnosticReport,
  options: RedactionOptions = {}
): DiagnosticReport {
  const redactor = createRedactor(options);
  const events: DiagnosticEvent[] = report.events.map((event) => ({
    ...event,
    message: redactor.redactString(event.message).slice(0, 2048),
    context: redactor.redactContext(event.context),
    error: redactor.redactError(event.error),
  }));
  return {
    ...report,
    events,
    user_note: redactor.redactString(report.user_note).slice(0, 4000),
  };
}

function normalizePath(p: string): string {
  // Remove trailing slash for consistent prefix replacement.
  return p.replace(/[\\/]+$/, "");
}

export function isSensitiveField(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes("license") ||
    lower.includes("token") ||
    lower.includes("secret") ||
    lower.includes("password") ||
    lower.includes("apikey") ||
    lower.includes("api_key") ||
    lower.includes("email") ||
    lower.includes("vaultpath") ||
    lower.includes("basepath") ||
    lower.includes("path")
  );
}
