import vinext from "vinext";
import { defineConfig } from "vite";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

// In development the Node backend (server/index.ts) runs separately on 8817;
// Vite proxies API and WebSocket traffic to it so the browser sees one origin.
const backend = `http://127.0.0.1:${process.env.BACKEND_PORT ?? 8817}`;

export default defineConfig({
  server: {
    watch: isCodexSeatbeltSandbox ? { useFsEvents: false, usePolling: true } : undefined,
    proxy: {
      "/api": {
        target: backend,
        ws: true,
        changeOrigin: false,
      },
    },
  },
  plugins: [vinext()],
});
