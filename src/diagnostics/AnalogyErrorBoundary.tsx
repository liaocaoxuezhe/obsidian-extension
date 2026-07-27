import React, { Component, type ErrorInfo, type ReactNode } from "react";
import type { DiagnosticRecorder } from "./diagnostic-recorder";

interface Props {
  children: ReactNode;
  recorder: DiagnosticRecorder;
  viewName?: string;
  onCopyReport?: () => void;
  onReload?: () => void;
  onOpenSettings?: () => void;
  onSendReport?: () => void;
}

interface State {
  hasError: boolean;
  errorId: string | null;
}

export class AnalogyErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, errorId: null };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true, errorId: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const errorId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    this.props.recorder.captureException(
      "react.render",
      `react.error.${this.props.viewName || "view"}`,
      error,
      {
        viewName: this.props.viewName || "unknown",
        componentStack: info.componentStack || "",
      }
    );
    this.setState({ errorId });
  }

  private handleReload = (): void => {
    this.setState({ hasError: false, errorId: null });
    this.props.onReload?.();
  };

  private handleCopyReport = (): void => {
    this.props.onCopyReport?.();
  };

  private handleOpenSettings = (): void => {
    this.props.onOpenSettings?.();
  };

  private handleSendReport = (): void => {
    this.props.onSendReport?.();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="analogy-error-boundary p-4 text-sm" role="alert" aria-live="assertive">
          <div className="rounded-md border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950">
            <h3 className="mb-2 font-semibold text-red-800 dark:text-red-200">
              Analogy 界面出现错误 / Analogy UI Error
            </h3>
            <p className="mb-3 text-red-700 dark:text-red-300">
              子组件渲染失败，插件其他功能仍可继续使用。诊断信息已记录，您可以选择发送或复制。
              <br />
              A child component failed to render. Other plugin features may still work.
            </p>
            {this.state.errorId && (
              <p className="mb-3 text-xs text-red-600 dark:text-red-400">
                Error ID: {this.state.errorId}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded border border-red-300 bg-white px-3 py-1.5 text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-transparent dark:text-red-200"
                onClick={this.handleCopyReport}
              >
                复制诊断 / Copy Report
              </button>
              <button
                type="button"
                className="rounded bg-red-600 px-3 py-1.5 text-white hover:bg-red-700"
                onClick={this.handleReload}
              >
                重新加载 / Reload
              </button>
              <button
                type="button"
                className="rounded border border-red-300 bg-white px-3 py-1.5 text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-transparent dark:text-red-200"
                onClick={this.handleOpenSettings}
              >
                打开设置 / Settings
              </button>
              <button
                type="button"
                className="rounded border border-red-300 bg-white px-3 py-1.5 text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-transparent dark:text-red-200"
                onClick={this.handleSendReport}
              >
                发送报告 / Send Report
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
