import type { DiagnosticRecorder } from "./diagnostic-recorder";

let globalRecorder: DiagnosticRecorder | null = null;

export function setDiagnosticRecorder(recorder: DiagnosticRecorder | null): void {
  globalRecorder = recorder;
}

export function getDiagnosticRecorder(): DiagnosticRecorder | null {
  return globalRecorder;
}

export function withRecorder<T>(fn: (recorder: DiagnosticRecorder) => T): T | undefined {
  if (globalRecorder) {
    return fn(globalRecorder);
  }
  return undefined;
}
