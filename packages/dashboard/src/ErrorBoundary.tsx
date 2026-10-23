import { Component, type ErrorInfo, type ReactNode } from "react";

export interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | undefined;
}

// `kind` is an open string and plugin attributes are Record<string, unknown>
// by design, so a third-party plugin can emit a shape the UI never
// anticipated. Without a boundary, one bad event unmounts the whole
// dashboard — a blank page that gives no hint the problem is a single event.
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: undefined };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Wevna dashboard crashed while rendering", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <div className="error-boundary" role="alert">
        <h1 className="error-boundary__title">The dashboard hit an error</h1>
        <p>
          Something in the event stream rendered unexpectedly — often an event from a plugin with an
          unusual shape. Your app is unaffected.
        </p>
        <pre className="error-boundary__message">{error.message}</pre>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => window.location.reload()}
        >
          Reload dashboard
        </button>
      </div>
    );
  }
}
