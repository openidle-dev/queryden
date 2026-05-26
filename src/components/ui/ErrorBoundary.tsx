import { Component, ErrorInfo, ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#0f0f0f] flex items-center justify-center p-6 font-sans">
          <div className="max-w-md w-full bg-[var(--surface-elevated)] border border-red-500/20 rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in duration-300">
            <div className="p-6 border-b border-[var(--neutral-6)] bg-gradient-to-br from-red-500/10 to-transparent flex items-center gap-4">
              <div className="p-3 bg-red-500/20 rounded-xl">
                <AlertTriangle className="w-8 h-8 text-red-500" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-white">Application Oops</h1>
                <p className="text-xs text-red-400 font-mono">CRITICAL_SMOKE_ERROR</p>
              </div>
            </div>
            <div className="p-6 space-y-4">
              <div className="p-4 bg-[var(--surface-base)] rounded-lg border border-[var(--neutral-6)] font-mono text-[11px] text-[var(--neutral-11)] break-all max-h-40 overflow-auto">
                <span className="text-red-400 font-bold">Error:</span> {this.state.error?.message}
                <br /><br />
                <span className="opacity-50">Stack Trace:</span> {this.state.error?.stack}
              </div>
              <p className="text-xs text-[var(--neutral-11)] text-center px-4">
                Something went wrong in the UI rendering. This is likely a bug in the component tree.
              </p>
              <button
                onClick={() => window.location.reload()}
                className="w-full py-3 bg-[var(--accent-9)] text-white rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-[var(--accent-10)] transition-all shadow-lg shadow-[var(--accent-9)]/20"
              >
                <RefreshCw className="w-4 h-4" />
                Reload Application
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
