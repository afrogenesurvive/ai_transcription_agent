/**
 * GuideErrorBoundary — catches rendering errors from DocViewer markdown
 * rendering and shows a fallback UI instead of letting React unmount
 * the entire component tree.
 */

import React from "react";

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
}

export default class GuideErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  handleRetry = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="dev-panel-empty"
          style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <p style={{ fontWeight: 600, marginBottom: 4 }}>Failed to render this document.</p>
          <p style={{ fontSize: "var(--fs-11)", color: "var(--text-muted)", marginBottom: 12 }}>
            Check the console (<kbd>Cmd+Option+I</kbd>) for error details.
          </p>
          <button
            onClick={this.handleRetry}
            style={{
              padding: "6px 16px",
              borderRadius: "var(--radius)",
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              cursor: "pointer",
              fontSize: "var(--fs-12)",
              fontFamily: "var(--font)",
            }}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
