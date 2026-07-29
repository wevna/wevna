import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it } from "vitest";
import { filterEvents } from "./filter-events.ts";

function makeEnvelope(
  overrides: Partial<CapturedEvent>,
  sequence: number,
): Envelope<CapturedEvent> {
  return {
    version: 1,
    sessionId: "session-1",
    sequence,
    payload: {
      id: `event-${sequence}`,
      kind: "console.log",
      occurredAt: Date.now(),
      attributes: {},
      ...overrides,
    },
  };
}

describe("filterEvents", () => {
  it("returns every event when the filter is empty", () => {
    const events = [makeEnvelope({}, 1), makeEnvelope({ kind: "http.request" }, 2)];

    expect(filterEvents(events, { kind: "", query: "" })).toBe(events);
  });

  it("filters by exact kind", () => {
    const events = [
      makeEnvelope({ kind: "console.log" }, 1),
      makeEnvelope({ kind: "http.request" }, 2),
      makeEnvelope({ kind: "http.request" }, 3),
    ];

    const result = filterEvents(events, { kind: "http.request", query: "" });

    expect(result.map((event) => event.sequence)).toEqual([2, 3]);
  });

  it("matches free text against kind", () => {
    const events = [
      makeEnvelope({ kind: "http.request" }, 1),
      makeEnvelope({ kind: "console.log" }, 2),
    ];

    const result = filterEvents(events, { kind: "", query: "http" });

    expect(result.map((event) => event.sequence)).toEqual([1]);
  });

  it("matches free text against the summary", () => {
    const events = [
      makeEnvelope({ kind: "console.log", attributes: { message: "connecting to database" } }, 1),
      makeEnvelope({ kind: "console.log", attributes: { message: "request finished" } }, 2),
    ];

    const result = filterEvents(events, { kind: "", query: "database" });

    expect(result.map((event) => event.sequence)).toEqual([1]);
  });

  it("matches free text against JSON-stringified attributes", () => {
    const events = [
      makeEnvelope({ kind: "http.request", attributes: { method: "POST", url: "/widgets" } }, 1),
      makeEnvelope({ kind: "http.request", attributes: { method: "GET", url: "/users" } }, 2),
    ];

    const result = filterEvents(events, { kind: "", query: "widgets" });

    expect(result.map((event) => event.sequence)).toEqual([1]);
  });

  it("matches case-insensitively", () => {
    const events = [
      makeEnvelope({ kind: "console.log", attributes: { message: "Hello World" } }, 1),
    ];

    expect(filterEvents(events, { kind: "", query: "HELLO" })).toHaveLength(1);
  });

  it("combines kind and free-text filters with AND semantics", () => {
    const events = [
      makeEnvelope({ kind: "http.request", attributes: { url: "/widgets" } }, 1),
      makeEnvelope({ kind: "console.log", attributes: { message: "/widgets" } }, 2),
    ];

    const result = filterEvents(events, { kind: "http.request", query: "widgets" });

    expect(result.map((event) => event.sequence)).toEqual([1]);
  });

  it("returns an empty array when nothing matches", () => {
    const events = [makeEnvelope({ kind: "console.log" }, 1)];

    expect(filterEvents(events, { kind: "", query: "nonexistent" })).toEqual([]);
  });

  it("never mutates the input array", () => {
    const events = [
      makeEnvelope({ kind: "console.log" }, 1),
      makeEnvelope({ kind: "http.request" }, 2),
    ];
    const copy = [...events];

    filterEvents(events, { kind: "http.request", query: "" });

    expect(events).toEqual(copy);
  });
});
