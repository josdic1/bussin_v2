import { useEffect, useState } from "react";
import "./update-banner.css";

// Shows a bar when Bussin was updated while this tab was open.
// Checks the server's build every 2 minutes, whenever the tab comes back into view,
// and right away when a screen gets data it doesn't recognize (see ops/api.ts).
// Old pages talking to a new server is the one way the app can look broken after a
// deploy, so this asks for a reload instead of showing a confusing error.

const EVERY_MS = 2 * 60 * 1000;
export const CHECK_EVENT = "bussin:check-version";

async function serverBuild(): Promise<string | null> {
  try {
    const response = await fetch("/api/version", { cache: "no-store" });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return body && typeof body === "object" && "build" in body && typeof body.build === "string" ? body.build : null;
  } catch {
    return null; // offline: say nothing
  }
}

export function UpdateBanner() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!import.meta.env.PROD) return;
    let alive = true;
    const check = async () => {
      const build = await serverBuild();
      if (alive && build && build !== __BUILD_ID__) setStale(true);
    };
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    const timer = window.setInterval(() => void check(), EVERY_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(CHECK_EVENT, check);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(CHECK_EVENT, check);
    };
  }, []);

  if (!stale) return null;
  return <div className="update-bar" role="alert">
    <span>Bussin was just updated. Reload to get the latest version.</span>
    <button type="button" onClick={() => location.reload()}>Reload</button>
  </div>;
}
