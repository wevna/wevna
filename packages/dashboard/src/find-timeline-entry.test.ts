import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it } from "vitest";
import { findTimelineEntry } from "./find-timeline-entry.ts";
import type { RequestModel } from "./request-store.ts";
import type { TimelineEntry } from "./timeline.ts";

function makeTimelineEntry(eventId: string, relativeOffsetMs: number): TimelineEntry {
  const event: Envelope<CapturedEvent> = {
    version: 1,
    sessionId: "session-1",
    sequence: 1,
    payload: { id: eventId, kind: "console.log", occurredAt: 0, attributes: {} },
  };
  return {
    event,
    kind: "console.log",
    sequence: 1,
    timestamp: 0,
    relativeOffsetMs,
    durationMs: undefined,
  };
}

function makeRequest(overrides: Partial<RequestModel> = {}): RequestModel {
  return {
    id: "corr-1",
    correlationId: "corr-1",
    method: "GET",
    route: "/widgets",
    statusCode: 200,
    startedAt: 0,
    endedAt: 10,
    durationMs: 10,
    status: "complete",
    events: [],
    timeline: [],
    ...overrides,
  };
}

describe("findTimelineEntry", () => {
  it("returns undefined when no event id is given", () => {
    expect(findTimelineEntry([makeRequest()], undefined)).toBeUndefined();
  });

  it("returns undefined when no request has a matching entry", () => {
    const requests = [makeRequest({ timeline: [makeTimelineEntry("event-1", 5)] })];

    expect(findTimelineEntry(requests, "event-missing")).toBeUndefined();
  });

  it("finds the entry within the selected request's own timeline", () => {
    const entry = makeTimelineEntry("event-1", 12);
    const requests = [makeRequest({ timeline: [entry] })];

    expect(findTimelineEntry(requests, "event-1")).toBe(entry);
  });

  it("finds the entry even when it belongs to a request other than the first", () => {
    const entry = makeTimelineEntry("event-2", 7);
    const requests = [
      makeRequest({ id: "a", correlationId: "a", timeline: [makeTimelineEntry("event-1", 3)] }),
      makeRequest({ id: "b", correlationId: "b", timeline: [entry] }),
    ];

    expect(findTimelineEntry(requests, "event-2")).toBe(entry);
  });

  it("returns undefined for an empty requests list", () => {
    expect(findTimelineEntry([], "event-1")).toBeUndefined();
  });
});
