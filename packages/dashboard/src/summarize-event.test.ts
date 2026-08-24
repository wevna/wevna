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

  // log.record is the Python SDK's logging capture. Same idea as console.log,
  // kept as its own kind because it carries a level and a logger name that
  // console.log has no equivalent for.
  it("returns the message for a log.record at an unremarkable level", () => {
    const event: CapturedEvent = {
      id: "event-1",
      kind: "log.record",
      occurredAt: Date.now(),
      attributes: { message: "fetching order 42", level: "INFO", logger: "app.orders" },
    };

    expect(summarizeEvent(event)).toBe("fetching order 42");
  });

  it.each(["WARNING", "ERROR", "CRITICAL"])(
    "prefixes a log.record at %s with its level",
    (level) => {
      const event: CapturedEvent = {
        id: "event-1",
        kind: "log.record",
        occurredAt: Date.now(),
        attributes: { message: "could not price the order", level },
      };

      expect(summarizeEvent(event)).toBe(`${level}: could not price the order`);
    },
  );

  it("matches the level case-insensitively", () => {
    const event: CapturedEvent = {
      id: "event-1",
      kind: "log.record",
      occurredAt: Date.now(),
      attributes: { message: "careful", level: "warning" },
    };

    expect(summarizeEvent(event)).toBe("warning: careful");
  });

  it("returns just the message when a log.record has no level", () => {
    const event: CapturedEvent = {
      id: "event-1",
      kind: "log.record",
      occurredAt: Date.now(),
      attributes: { message: "no level here" },
    };

    expect(summarizeEvent(event)).toBe("no level here");
  });

  it("returns an empty string when a log.record has no message", () => {
    const event: CapturedEvent = {
      id: "event-1",
      kind: "log.record",
      occurredAt: Date.now(),
      attributes: { level: "INFO" },
    };

    expect(summarizeEvent(event)).toBe("");
  });
});
