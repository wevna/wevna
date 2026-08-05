import type { RequestModel } from "@wevna/intelligence";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it } from "vitest";
import { computeSessionTimelineLayout, isErrorRequest } from "./session-timeline-layout.ts";

function makeEvent(kind: string, sequence = 1): Envelope<CapturedEvent> {
  return {
    version: 1,
    sessionId: "session-1",
    sequence,
    payload: { id: `event-${sequence}`, kind, occurredAt: 0, attributes: {} },
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
    endedAt: 42,
    durationMs: 42,
    status: "complete",
    events: [],
    timeline: [],
    ...overrides,
  };
}

describe("computeSessionTimelineLayout", () => {
  it("returns an empty layout for no requests", () => {
    const layout = computeSessionTimelineLayout([]);

    expect(layout.totalDurationMs).toBe(0);
    expect(layout.rows).toHaveLength(0);
  });

  it("positions a single request starting at the session start", () => {
    const layout = computeSessionTimelineLayout([makeRequest({ startedAt: 100, durationMs: 50 })]);

    expect(layout.totalDurationMs).toBe(50);
    expect(layout.rows[0]?.leftPercent).toBe(0);
    expect(layout.rows[0]?.widthPercent).toBe(100);
  });

  it("positions later requests proportionally to the session's full span", () => {
    const layout = computeSessionTimelineLayout([
      makeRequest({ id: "a", correlationId: "a", startedAt: 0, durationMs: 100 }),
      makeRequest({ id: "b", correlationId: "b", startedAt: 300, durationMs: 100 }),
    ]);

    // Session spans 0 -> 400 (b starts at 300 and runs 100ms further).
    expect(layout.totalDurationMs).toBe(400);
    expect(layout.rows[0]?.leftPercent).toBe(0);
    expect(layout.rows[0]?.widthPercent).toBe(25);
    expect(layout.rows[1]?.leftPercent).toBe(75);
    expect(layout.rows[1]?.widthPercent).toBe(25);
  });

  it("renders a still-pending request (no durationMs) as an instantaneous marker", () => {
    const layout = computeSessionTimelineLayout([
      makeRequest({ id: "a", correlationId: "a", startedAt: 0, durationMs: 100 }),
      makeRequest({
        id: "b",
        correlationId: "b",
        startedAt: 50,
        durationMs: undefined,
        status: "pending",
      }),
    ]);

    expect(layout.rows[1]?.isInstantaneous).toBe(true);
    expect(layout.rows[1]?.widthPercent).toBe(0);
  });

  it("degrades every row to a zero-width marker when the session has no measurable span", () => {
    const layout = computeSessionTimelineLayout([
      makeRequest({ startedAt: 0, durationMs: undefined, status: "pending" }),
    ]);

    expect(layout.totalDurationMs).toBe(0);
    expect(layout.rows[0]?.isInstantaneous).toBe(true);
  });

  it("never lets a bar extend past the end of the session track", () => {
    const layout = computeSessionTimelineLayout([
      makeRequest({ id: "a", correlationId: "a", startedAt: 0, durationMs: 400 }),
      // Reports a duration longer than the remaining space left after it starts.
      makeRequest({ id: "b", correlationId: "b", startedAt: 380, durationMs: 100 }),
    ]);

    const b = layout.rows[1];
    expect(b).toBeDefined();
    expect((b?.leftPercent ?? 0) + (b?.widthPercent ?? 0)).toBeLessThanOrEqual(100);
  });
});

describe("isErrorRequest", () => {
  it("is false for a plain successful request", () => {
    expect(isErrorRequest(makeRequest({ statusCode: 200 }))).toBe(false);
  });

  it("is true for a 4xx/5xx status code", () => {
    expect(isErrorRequest(makeRequest({ statusCode: 404 }))).toBe(true);
    expect(isErrorRequest(makeRequest({ statusCode: 500 }))).toBe(true);
  });

  it("is true when the request captured an exception, even with a 2xx status", () => {
    expect(
      isErrorRequest(makeRequest({ statusCode: 200, events: [makeEvent("exception.captured")] })),
    ).toBe(true);
  });

  it("is false for a pending request with no status code yet", () => {
    expect(isErrorRequest(makeRequest({ statusCode: undefined, status: "pending" }))).toBe(false);
  });
});
