import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Every build gets an ID. The app knows its own ID; the server reports the ID of
// the build it's serving (from dist/version.json). When they differ, the app was
// updated while this tab was open, and the page offers a reload.
const BUILD_ID = Date.now().toString(36);

function buildId(): Plugin {
  return {
    name: "bussin-build-id",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build: BUILD_ID }) });
    }
  };
}

export default defineConfig({
  plugins: [react(), buildId()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  // MapLibre is one large lazy chunk loaded only by the map screens.
  build: { chunkSizeWarningLimit: 1200 },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: false
      }
    }
  }
});
