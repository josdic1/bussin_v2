import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { ErrorBoundary, claimAutoReload } from "./ErrorBoundary";
import "./styles.css";
import "./ops/ops.css";

const root = document.getElementById("root");

if (!root) throw new Error("Missing root element");

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>
);

// Vite reports a missing code file from an older build here; reload once to get the new build.
window.addEventListener("vite:preloadError", (event) => {
  if (!claimAutoReload()) return; // the error screen with a Reload button takes over
  event.preventDefault();
  location.reload();
});

// Cache the app shell so a server blip never leaves a white screen on launch.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
