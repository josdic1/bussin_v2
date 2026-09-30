import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
