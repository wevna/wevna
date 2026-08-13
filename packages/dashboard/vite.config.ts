import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // The dashboard talks to its server over same-origin relative URLs
    // (see live-events.ts, use-session-mode.ts) — production works
    // because @wevna/server serves both the API/WS and the built
    // dashboard from one origin. `vite dev` doesn't have that server, so
    // proxy to a Wevna instance already running elsewhere (e.g. a demo
    // app started with `wevna.start()`) for live data during UI work.
    proxy: {
      "/api": "http://localhost:4123",
      "/ws": { target: "ws://localhost:4123", ws: true },
    },
  },
});
