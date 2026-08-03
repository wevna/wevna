import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

// Testing Library's auto-cleanup only registers itself when it detects a
// global `afterEach` (i.e. vitest's `test.globals: true`); this project
// keeps globals off and imports test functions explicitly instead, so
// cleanup has to be wired up by hand here.
afterEach(() => {
  cleanup();
});

// use-session-mode.ts fetches GET /api/session on every mount. Without a
// mock, jsdom's Node-backed global fetch would attempt a real network
// request to a server that isn't running in tests — slow, and dependent on
// real network/DNS timing rather than deterministic. Defaults every test
// to "live" mode (the vast majority of tests care about live behaviour,
// not recordings) with zero events; a test that specifically needs
// "recording" mode overrides this itself (see App.test.tsx's "Offline
// session viewing" tests).
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/session/events")) {
        return new Response(JSON.stringify({ events: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ mode: "live" }), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});
