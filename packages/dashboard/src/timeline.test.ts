import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it } from "vitest";
import { buildTimeline, getRelativeOffset } from "./timeline.ts";

function makeEvent(overrides: {
  kind?: string;
  occurredAt?: number;
  sequence?: number;
  attributes?: Record<string, unknown>;
}): Envelope<CapturedEvent> {
  return {
    version: 1,
    sessionId: "session-1",
    sequence: overrides.sequence ?? 1,
    payload: {
      id: `event-${overrides.sequence ?? 1}`,
      kind: overrides.kind ?? "console.log",
      occurredAt: overrides.occurredAt ?? 0,
      attributes: overrides.attributes ?? {},
    },
  };
}

describe("getRelativeOffset", () => {
  it("returns the difference between a timestamp and the request start", () => {
    expect(getRelativeOffset(100, 122)).toBe(22);
  });

  it("returns 0 for the start event itself", () => {
    expect(getRelativeOffset(100, 100)).toBe(0);
  });

  it("can return a negative offset for a timestamp before the recorded start", () => {
    expect(getRelativeOffset(100, 90)).toBe(-10);
  });
});

describe("buildTimeline", () => {
  it("returns an empty timeline for no events", () => {
    expect(buildTimeline([], 0)).toEqual([]);
  });

  it("computes relative offsets for each event against the request start", () => {
    const events = [
      makeEvent({ kind: "http.request", occurredAt: 100, sequence: 1 }),
      makeEvent({ kind: "console.log", occurredAt: 103, sequence: 2 }),
      makeEvent({ kind: "sql.query", occurredAt: 111, sequence: 3 }),
    ];

    const timeline = buildTimeline(events, 100);

    expect(timeline.map((entry) => entry.relativeOffsetMs)).toEqual([0, 3, 11]);
  });

  it("preserves the given event order (assumed already chronological)", () => {
    const events = [
      makeEvent({ kind: "first", occurredAt: 1, sequence: 1 }),
      makeEvent({ kind: "second", occurredAt: 2, sequence: 2 }),
      makeEvent({ kind: "third", occurredAt: 3, sequence: 3 }),
    ];

    const timeline = buildTimeline(events, 1);

    expect(timeline.map((entry) => entry.kind)).toEqual(["first", "second", "third"]);
  });

  it("copies kind, sequence, and timestamp onto each entry", () => {
    const event = makeEvent({ kind: "redis.command", occurredAt: 42, sequence: 7 });

    const [entry] = buildTimeline([event], 0);

    expect(entry?.kind).toBe("redis.command");
    expect(entry?.sequence).toBe(7);
    expect(entry?.timestamp).toBe(42);
  });

  it("extracts durationMs from the event's own attributes when present", () => {
    const event = makeEvent({ kind: "sql.query", occurredAt: 10, attributes: { durationMs: 4.5 } });

    const [entry] = buildTimeline([event], 0);

    expect(entry?.durationMs).toBe(4.5);
  });

  it("leaves durationMs undefined when the event has none", () => {
    const event = makeEvent({ kind: "console.log", occurredAt: 10, attributes: { message: "hi" } });

    const [entry] = buildTimeline([event], 0);

    expect(entry?.durationMs).toBeUndefined();
  });

  it("references the exact same event object, never a copy", () => {
    const event = makeEvent({});

    const [entry] = buildTimeline([event], 0);

    expect(entry?.event).toBe(event);
  });

  it("does not mutate the input events", () => {
    const event = makeEvent({ occurredAt: 5 });
    const before = JSON.stringify(event);

    buildTimeline([event], 0);

    expect(JSON.stringify(event)).toBe(before);
  });

  it("produces one entry per event, in order, for equal timestamps", () => {
    const events = [
      makeEvent({ kind: "a", occurredAt: 10, sequence: 1 }),
      makeEvent({ kind: "b", occurredAt: 10, sequence: 2 }),
    ];

    const timeline = buildTimeline(events, 10);

    expect(timeline.map((entry) => entry.relativeOffsetMs)).toEqual([0, 0]);
    expect(timeline.map((entry) => entry.kind)).toEqual(["a", "b"]);
  });
});
