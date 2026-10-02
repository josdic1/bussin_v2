import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Last line of defense: a render error must never leave a driver staring at a
 * blank white screen. Shows what happened and a one-tap reload.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Bussin screen crashed", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main style={{ minHeight: "100vh", background: "#f5f5ef", padding: "48px 24px", fontFamily: "system-ui, sans-serif", color: "#1b2e26" }}>
        <h1 style={{ fontSize: 28, margin: "0 0 12px" }}>Bussin hit a snag</h1>
        <p style={{ fontSize: 17, lineHeight: 1.5, margin: "0 0 24px" }}>
          Your trip is safe on the server. Tap Reload to pick up where you left off.
        </p>
        <button type="button" onClick={() => location.reload()}
          style={{ width: "100%", padding: "18px", fontSize: 20, fontWeight: 700, borderRadius: 16, border: "2px solid #1b2e26", background: "#1b2e26", color: "#fff" }}>
          Reload
        </button>
      </main>
    );
  }
}
