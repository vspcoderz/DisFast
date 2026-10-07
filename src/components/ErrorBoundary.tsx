import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Shown instead of the children when a render throws. */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * Catches render errors so one broken component shows a readable message
 * instead of unmounting the whole app to a blank screen. Reloading is the
 * honest remedy — we don't try to guess a safe partial render.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("UI error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-boundary">
        <h2>{this.props.label ?? "Something went wrong"}</h2>
        <p className="error-boundary-message">{error.message}</p>
        <button className="settings-save" onClick={() => window.location.reload()}>
          Reload DisFast
        </button>
      </div>
    );
  }
}