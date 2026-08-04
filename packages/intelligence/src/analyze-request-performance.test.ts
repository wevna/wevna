import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it } from "vitest";
import type { AnalyzableRequest, AnalyzableTimelineEntry } from "./analyzable-request.js";
import { analyzeRequestPerformance } from "./analyze-request-performance.js";
import type { PerformanceThresholds } from "./thresholds.js";

function makeEntry(overrides: {
  kind: string;
  relativeOffsetMs: number;
  durationMs?: number;
  sequence?: number;
}): AnalyzableTimelineEntry {
  const sequence = overrides.sequence ?? 1;
  const event: Envelope<CapturedEvent> = {
    version: 1,
    sessionId: "session-1",
    sequence,
    payload: {
      id: `event-${sequence}`,
      kind: overrides.kind,
      occurredAt: overrides.relativeOffsetMs,
      attributes: {},
    },
  };
  return {
    kind: overrides.kind,
    relativeOffsetMs: overrides.relativeOffsetMs,
    durationMs: overrides.durationMs,
    event,
  };
}

describe("analyzeRequestPerformance", () => {
  it("returns both metrics and insights derived from the same request", () => {
    const request: AnalyzableRequest = {
      durationMs: 1500,
      timeline: [
        makeEntry({ kind: "sql.query", relativeOffsetMs: 50, durationMs: 40, sequence: 1 }),
        makeEntry({ kind: "http.request", relativeOffsetMs: 1500, durationMs: 1500, sequence: 2 }),
      ],
    };

    const analysis = analyzeRequestPerformance(request);

    expect(analysis.metrics.totalDurationMs).toBe(1500);
    expect(analysis.metrics.sqlQueryCount).toBe(1);
    expect(analysis.insights.map((i) => i.type)).toContain("slow-request");
  });

  it("accepts a custom thresholds override and applies it to the generated insights", () => {
    const request: AnalyzableRequest = {
      durationMs: 200,
      timeline: [makeEntry({ kind: "http.request", relativeOffsetMs: 200, durationMs: 200 })],
    };
    const strict: PerformanceThresholds = {
      slowRequestMs: 100,
      longSqlQueryMs: 100,
      multipleDatabaseCallsCount: 5,
      multipleRedisOperationsCount: 5,
      repeatedOperationCount: 3,
      dominantCategorySharePercent: 60,
    };

    const analysis = analyzeRequestPerformance(request, strict);

    expect(analysis.insights.map((i) => i.type)).toContain("slow-request");
  });

  it("returns no insights for a fast, simple request under default thresholds", () => {
    const request: AnalyzableRequest = {
      durationMs: 15,
      timeline: [makeEntry({ kind: "http.request", relativeOffsetMs: 15, durationMs: 15 })],
    };

    const analysis = analyzeRequestPerformance(request);

    expect(analysis.insights).toEqual([]);
  });

  it("handles a still-pending request (no known duration) without throwing", () => {
    const request: AnalyzableRequest = {
      durationMs: undefined,
      timeline: [makeEntry({ kind: "console.log", relativeOffsetMs: 5 })],
    };

    expect(() => analyzeRequestPerformance(request)).not.toThrow();
    const analysis = analyzeRequestPerformance(request);
    expect(analysis.metrics.totalDurationMs).toBeUndefined();
    expect(analysis.insights).toEqual([]);
  });

  it("is deterministic for the same request and thresholds", () => {
    const request: AnalyzableRequest = {
      durationMs: 1200,
      timeline: [makeEntry({ kind: "http.request", relativeOffsetMs: 1200, durationMs: 1200 })],
    };

    expect(analyzeRequestPerformance(request)).toEqual(analyzeRequestPerformance(request));
  });
});
