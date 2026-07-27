import type { DiagnosticReport } from "./diagnostic-types";

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

export class DiagnosticReportSnapshot {
  private report: DiagnosticReport | null = null;

  replace(report: DiagnosticReport): DiagnosticReport {
    const cloned = JSON.parse(JSON.stringify(report)) as DiagnosticReport;
    this.report = deepFreeze(cloned);
    return this.report;
  }

  invalidate(): void {
    this.report = null;
  }

  get(): DiagnosticReport | null {
    return this.report;
  }

  serialize(): string | null {
    return this.report ? JSON.stringify(this.report, null, 2) : null;
  }
}
