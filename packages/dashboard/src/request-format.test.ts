import { describe, expect, it } from "vitest";
import { formatEventCount, formatRequestDuration } from "./request-format.ts";

describe("formatRequestDuration", () => {
  it("shows a placeholder for an unknown duration", () => {
    expect(formatRequestDuration(undefined)).toBe("…");
  });

  it("formats a known duration to one decimal place", () => {
    expect(formatRequestDuration(42)).toBe("42.0ms");
  });
});

describe("formatEventCount", () => {
  it("uses the singular form for exactly one event", () => {
    expect(formatEventCount(1)).toBe("1 event");
  });

  it("uses the plural form for zero events", () => {
    expect(formatEventCount(0)).toBe("0 events");
  });

  it("uses the plural form for more than one event", () => {
    expect(formatEventCount(3)).toBe("3 events");
  });
});
