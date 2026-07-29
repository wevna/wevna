import type { CapturedEvent } from "@wevna/protocol";
import { describe, expect, it } from "vitest";
import { summarizeEvent } from "./summarize-event.ts";

describe("summarizeEvent", () => {
  it("returns the message attribute for console.log events", () => {
    const event: CapturedEvent = {
      id: "event-1",
      kind: "console.log",
      occurredAt: Date.now(),
      attributes: { message: "hello world" },
    };

    expect(summarizeEvent(event)).toBe("hello world");
  });

  it("returns an empty string when console.log has no message attribute", () => {
    const event: CapturedEvent = {
      id: "event-1",
      kind: "console.log",
      occurredAt: Date.now(),
      attributes: {},
    };

    expect(summarizeEvent(event)).toBe("");
  });

  it("returns an empty string for kinds other than console.log", () => {
    const event: CapturedEvent = {
      id: "event-1",
      kind: "http.request",
      occurredAt: Date.now(),
      attributes: { message: "should be ignored" },
    };

    expect(summarizeEvent(event)).toBe("");
  });
});
