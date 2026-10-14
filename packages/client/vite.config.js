import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const serverPort = process.env.PORT || 4001;

export default defineConfig({
  plugins: [react()],
  // The client-side PoC loads libav.js from its package entry and resolves the WASM binary from
  // /libav/, so keep it out of the pre-bundler to preserve its runtime asset resolution.
  optimizeDeps: {
    exclude: ["libav.js"]
  },
  server: {
    proxy: {
      "/api": `http://localhost:${serverPort}`
    }
  }
});
