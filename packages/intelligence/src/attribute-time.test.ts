import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it } from "vitest";
import type { AnalyzableRequest, AnalyzableTimelineEntry } from "./analyzable-request.js";
import { attributeRequestTime } from "./attribute-time.js";

let sequence = 0;

function makeEntry(kind: string, durationMs?: number): AnalyzableTimelineEntry {
  sequence += 1;
  const event: Envelope<CapturedEvent> = {
    version: 1,
    sessionId: "session-1",
    sequence,
    payload: { id: `event-${sequence}`, kind, occurredAt: sequence, attributes: {} },
  };
  return { kind, relativeOffsetMs: sequence, durationMs, event };
}

function requestOf(
  timeline: readonly AnalyzableTimelineEntry[],
  durationMs: number | undefined = 100,
): AnalyzableRequest {
  return { durationMs, timeline };
}

describe("attributeRequestTime", () => {
  it("reports nothing for a request with no timed operations", () => {
    expect(attributeRequestTime(requestOf([makeEntry("console.log")]))).toEqual([]);
  });

  it("excludes http.request, since its duration is the request itself", () => {
    const attribution = attributeRequestTime(
      requestOf([makeEntry("http.request", 100), makeEntry("sql.query", 60)]),
    );

    // Including the container would attribute 100% to "http" and say nothing.
    expect(attribution.map((a) => a.category)).toEqual(["sql"]);
  });

  it("computes each category's share of the request's own duration", () => {
    const attribution = attributeRequestTime(
      requestOf([makeEntry("sql.query", 60), makeEntry("redis.command", 10)], 100),
    );

    expect(attribution).toEqual([
      { category: "sql", totalDurationMs: 60, sharePercent: 60 },
      { category: "redis", totalDurationMs: 10, sharePercent: 10 },
    ]);
  });

  it("sums several operations in the same category", () => {
    const attribution = attributeRequestTime(
      requestOf([makeEntry("sql.query", 30), makeEntry("sql.query", 25)], 100),
    );

    expect(attribution[0]).toMatchObject({ category: "sql", totalDurationMs: 55 });
  });

  it("keeps outgoing HTTP separate from the incoming request's category", () => {
    const attribution = attributeRequestTime(
      requestOf([makeEntry("http.request", 100), makeEntry("http.client", 70)], 100),
    );

    expect(attribution).toEqual([
      { category: "httpClient", totalDurationMs: 70, sharePercent: 70 },
    ]);
  });

  it("orders by descending total duration", () => {
    const attribution = attributeRequestTime(
      requestOf([makeEntry("redis.command", 5), makeEntry("sql.query", 40)], 100),
    );

    expect(attribution.map((a) => a.category)).toEqual(["sql", "redis"]);
  });

  it("rounds a share to one decimal place", () => {
    const attribution = attributeRequestTime(requestOf([makeEntry("sql.query", 1)], 3));

    expect(attribution[0]?.sharePercent).toBe(33.3);
  });

  it("reports totals with a zero share when the request duration is unknown", () => {
    // A pending request still has real per-category totals; only the share is
    // unanswerable, and guessing one would be worse than reporting zero.
    // Built inline, not via requestOf: JS treats an explicitly-passed
    // undefined as an omitted argument, so the helper's default would apply.
    const attribution = attributeRequestTime({
      durationMs: undefined,
      timeline: [makeEntry("sql.query", 40)],
    });

    expect(attribution[0]).toMatchObject({ totalDurationMs: 40, sharePercent: 0 });
  });

  it("lets shares exceed 100% for genuinely concurrent work", () => {
    // Two overlapping queries both count in full. That is honest — the
    // alternative is inventing a serialization the runtime never had.
    const attribution = attributeRequestTime(
      requestOf([makeEntry("sql.query", 80), makeEntry("redis.command", 80)], 100),
    );

    const total = attribution.reduce((sum, a) => sum + a.sharePercent, 0);
    expect(total).toBeGreaterThan(100);
  });

  it("ignores operations with no measured duration", () => {
    const attribution = attributeRequestTime(
      requestOf([makeEntry("sql.query", 40), makeEntry("sql.query", undefined)], 100),
    );

    expect(attribution[0]?.totalDurationMs).toBe(40);
  });

  it("is deterministic for the same input", () => {
    const build = () =>
      attributeRequestTime(
        requestOf([makeEntry("sql.query", 10), makeEntry("redis.command", 10)], 100),
      );
    expect(build()).toEqual(build());
  });
});
