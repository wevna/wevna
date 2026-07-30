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

  it("returns an empty string for kinds other than console.log or exception.captured", () => {
    const event: CapturedEvent = {
      id: "event-1",
      kind: "http.request",
      occurredAt: Date.now(),
      attributes: { message: "should be ignored" },
    };

    expect(summarizeEvent(event)).toBe("");
  });

  it("returns 'name: message' for exception.captured events", () => {
    const event: CapturedEvent = {
      id: "event-1",
      kind: "exception.captured",
      occurredAt: Date.now(),
      attributes: { name: "TypeError", message: "cannot read property of undefined" },
    };

    expect(summarizeEvent(event)).toBe("TypeError: cannot read property of undefined");
  });

  it("defaults to 'Error' when an exception.captured event has no name attribute", () => {
    const event: CapturedEvent = {
      id: "event-1",
      kind: "exception.captured",
      occurredAt: Date.now(),
      attributes: { message: "boom" },
    };

    expect(summarizeEvent(event)).toBe("Error: boom");
  });

  it("returns an empty string when exception.captured has no message attribute", () => {
    const event: CapturedEvent = {
      id: "event-1",
      kind: "exception.captured",
      occurredAt: Date.now(),
      attributes: {},
    };

    expect(summarizeEvent(event)).toBe("");
  });
});
