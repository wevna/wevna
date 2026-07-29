import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library's auto-cleanup only registers itself when it detects a
// global `afterEach` (i.e. vitest's `test.globals: true`); this project
// keeps globals off and imports test functions explicitly instead, so
// cleanup has to be wired up by hand here.
afterEach(() => {
  cleanup();
});
