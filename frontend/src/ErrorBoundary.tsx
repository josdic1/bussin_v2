import { Component, type ErrorInfo, type ReactNode } from "react";

const RELOAD_KEY = "bussin-chunk-reload";

/**
 * True when one automatic reload is allowed now. Needs working storage to
 * remember the last reload: without it, never auto-reload (that could loop
 * forever); the Reload button is shown instead.
 */
export function claimAutoReload(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    return sessionStorage.getItem(RELOAD_KEY) !== null;
  } catch {
    return false;
  }
}

/** A tab opened before a deploy asks for code files the new build no longer has. */
function isStaleBuild(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|Importing a module script failed|error loading dynamically|Failed to fetch dynamically|ChunkLoadError|Unable to preload CSS/i.test(message);
}

/**
 * Last line of defense: a render error must never leave anyone staring at a
 * blank white screen. A stale build after a deploy reloads itself once;
 * anything else shows the error and a one-tap reload.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Bussin screen crashed", error, info.componentStack);
    if (isStaleBuild(error) && claimAutoReload()) location.reload();
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main style={{ minHeight: "100vh", background: "#f5f5ef", padding: "48px 24px", fontFamily: "system-ui, sans-serif", color: "#1b2e26" }}>
        <h1 style={{ fontSize: 28, margin: "0 0 12px" }}>Bussin hit a snag</h1>
        <p style={{ fontSize: 17, lineHeight: 1.5, margin: "0 0 24px" }}>
          Your trip is safe on the server. Tap Reload to pick up where you left off.
        </p>
        <button type="button" onClick={() => location.reload()}
          style={{ width: "100%", maxWidth: 480, padding: "18px", fontSize: 20, fontWeight: 700, borderRadius: 16, border: "2px solid #1b2e26", background: "#1b2e26", color: "#fff" }}>
          Reload
        </button>
        <p style={{ fontSize: 13, color: "#5b6b63", marginTop: 24, wordBreak: "break-word" }}>
          Details: {this.state.error.message}
        </p>
      </main>
    );
  }
}
