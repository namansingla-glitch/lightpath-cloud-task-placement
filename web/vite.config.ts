import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" so the built site also works from any folder or static host.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8000" } },
  build: { chunkSizeWarningLimit: 1200 },
});
