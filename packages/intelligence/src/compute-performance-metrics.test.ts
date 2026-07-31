import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it } from "vitest";
import type { AnalyzableRequest, AnalyzableTimelineEntry } from "./analyzable-request.js";
import { computeRequestPerformanceMetrics } from "./compute-performance-metrics.js";

function makeEntry(overrides: {
  kind: string;
  relativeOffsetMs: number;
  durationMs?: number;
  sequence?: number;
  attributes?: Record<string, unknown>;
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
      attributes: overrides.attributes ?? {},
    },
  };
  return {
    kind: overrides.kind,
    relativeOffsetMs: overrides.relativeOffsetMs,
    durationMs: overrides.durationMs,
    event,
  };
}

function makeRequest(overrides: {
  durationMs?: number;
  timeline: readonly AnalyzableTimelineEntry[];
}): AnalyzableRequest {
  return { durationMs: overrides.durationMs, timeline: overrides.timeline };
}

describe("computeRequestPerformanceMetrics", () => {
  describe("requests with no database activity", () => {
    it("reports zero counts and durations when only http.request and console.log are present", () => {
      const metrics = computeRequestPerformanceMetrics(
        makeRequest({
          durationMs: 20,
          timeline: [
            makeEntry({ kind: "console.log", relativeOffsetMs: 2, sequence: 1 }),
            makeEntry({ kind: "http.request", relativeOffsetMs: 20, durationMs: 20, sequence: 2 }),
          ],
        }),
      );

      expect(metrics.sqlQueryCount).toBe(0);
      expect(metrics.cumulativeSqlTimeMs).toBe(0);
      expect(metrics.redisCommandCount).toBe(0);
      expect(metrics.cumulativeRedisTimeMs).toBe(0);
      expect(metrics.consoleEventCount).toBe(1);
      expect(metrics.exceptionCount).toBe(0);
      expect(metrics.eventCount).toBe(2);
    });

    it("has no slowest operation when nothing but the container event has a duration", () => {
      const metrics = computeRequestPerformanceMetrics(
        makeRequest({
          durationMs: 10,
          timeline: [
            makeEntry({ kind: "console.log", relativeOffsetMs: 1, sequence: 1 }),
            makeEntry({ kind: "http.request", relativeOffsetMs: 10, durationMs: 10, sequence: 2 }),
          ],
        }),
      );

      expect(metrics.slowestOperation).toBeUndefined();
    });
  });

  describe("SQL-heavy requests", () => {
    it("counts SQL queries and sums their durations", () => {
      const metrics = computeRequestPerformanceMetrics(
        makeRequest({
          durationMs: 100,
          timeline: [
            makeEntry({ kind: "sql.query", relativeOffsetMs: 20, durationMs: 10, sequence: 1 }),
            makeEntry({ kind: "sql.query", relativeOffsetMs: 50, durationMs: 25, sequence: 2 }),
            makeEntry({ kind: "sql.query", relativeOffsetMs: 80, durationMs: 15, sequence: 3 }),
            makeEntry({
              kind: "http.request",
              relativeOffsetMs: 100,
              durationMs: 100,
              sequence: 4,
            }),
          ],
        }),
      );

      expect(metrics.sqlQueryCount).toBe(3);
      expect(metrics.cumulativeSqlTimeMs).toBe(50);
    });

    it("reports the slowest SQL query's duration on the sql category breakdown", () => {
      const metrics = computeRequestPerformanceMetrics(
        makeRequest({
          durationMs: 100,
          timeline: [
            makeEntry({ kind: "sql.query", relativeOffsetMs: 20, durationMs: 10, sequence: 1 }),
            makeEntry({ kind: "sql.query", relativeOffsetMs: 50, durationMs: 25, sequence: 2 }),
          ],
        }),
      );

      const sql = metrics.categoryBreakdown.find((b) => b.category === "sql");
      expect(sql?.slowestDurationMs).toBe(25);
    });
  });

  describe("Redis-heavy requests", () => {
    it("counts Redis commands and sums their durations", () => {
      const metrics = computeRequestPerformanceMetrics(
        makeRequest({
          durationMs: 50,
          timeline: [
            makeEntry({ kind: "redis.command", relativeOffsetMs: 10, durationMs: 3, sequence: 1 }),
            makeEntry({ kind: "redis.command", relativeOffsetMs: 20, durationMs: 4, sequence: 2 }),
            makeEntry({ kind: "http.request", relativeOffsetMs: 50, durationMs: 50, sequence: 3 }),
          ],
        }),
      );

      expect(metrics.redisCommandCount).toBe(2);
      expect(metrics.cumulativeRedisTimeMs).toBe(7);
    });
  });

  describe("mixed workloads", () => {
    it("tracks every category independently in the same request", () => {
      const metrics = computeRequestPerformanceMetrics(
        makeRequest({
          durationMs: 40,
          timeline: [
            makeEntry({ kind: "console.log", relativeOffsetMs: 1, sequence: 1 }),
            makeEntry({ kind: "sql.query", relativeOffsetMs: 15, durationMs: 10, sequence: 2 }),
            makeEntry({ kind: "redis.command", relativeOffsetMs: 20, durationMs: 3, sequence: 3 }),
            makeEntry({
              kind: "exception.captured",
              relativeOffsetMs: 25,
              sequence: 4,
              attributes: { name: "Error", message: "boom" },
            }),
            makeEntry({ kind: "http.request", relativeOffsetMs: 40, durationMs: 40, sequence: 5 }),
          ],
        }),
      );

      expect(metrics.consoleEventCount).toBe(1);
      expect(metrics.sqlQueryCount).toBe(1);
      expect(metrics.redisCommandCount).toBe(1);
      expect(metrics.exceptionCount).toBe(1);
      expect(metrics.eventCount).toBe(5);
    });
  });

  describe("exception scenarios", () => {
    it("counts multiple exceptions", () => {
      const metrics = computeRequestPerformanceMetrics(
        makeRequest({
          durationMs: 10,
          timeline: [
            makeEntry({ kind: "exception.captured", relativeOffsetMs: 3, sequence: 1 }),
            makeEntry({ kind: "exception.captured", relativeOffsetMs: 6, sequence: 2 }),
          ],
        }),
      );

      expect(metrics.exceptionCount).toBe(2);
    });

    it("never counts an exception as an operation with a duration", () => {
      const metrics = computeRequestPerformanceMetrics(
        makeRequest({
          durationMs: 10,
          timeline: [makeEntry({ kind: "exception.captured", relativeOffsetMs: 3, sequence: 1 })],
        }),
      );

      expect(metrics.slowestOperation).toBeUndefined();
    });
  });

  describe("longest operation detection", () => {
    it("picks the operation with the greatest duration across categories", () => {
      const metrics = computeRequestPerformanceMetrics(
        makeRequest({
          durationMs: 100,
          timeline: [
            makeEntry({ kind: "sql.query", relativeOffsetMs: 30, durationMs: 20, sequence: 1 }),
            makeEntry({ kind: "redis.command", relativeOffsetMs: 60, durationMs: 45, sequence: 2 }),
            makeEntry({
              kind: "http.request",
              relativeOffsetMs: 100,
              durationMs: 100,
              sequence: 3,
            }),
          ],
        }),
      );

      expect(metrics.slowestOperation).toEqual({
        kind: "redis.command",
        durationMs: 45,
        relativeOffsetMs: 60,
        eventId: "event-2",
      });
    });

    it("excludes http.request even though its own duration is the largest", () => {
      const metrics = computeRequestPerformanceMetrics(
        makeRequest({
          durationMs: 100,
          timeline: [
            makeEntry({ kind: "sql.query", relativeOffsetMs: 30, durationMs: 20, sequence: 1 }),
            makeEntry({
              kind: "http.request",
              relativeOffsetMs: 100,
              durationMs: 100,
              sequence: 2,
            }),
          ],
        }),
      );

      expect(metrics.slowestOperation?.kind).toBe("sql.query");
    });

    it("ignores zero-duration entries when picking the slowest operation", () => {
      const metrics = computeRequestPerformanceMetrics(
        makeRequest({
          durationMs: 30,
          timeline: [
            makeEntry({ kind: "sql.query", relativeOffsetMs: 10, durationMs: 0, sequence: 1 }),
            makeEntry({ kind: "sql.query", relativeOffsetMs: 20, durationMs: 12, sequence: 2 }),
          ],
        }),
      );

      expect(metrics.slowestOperation?.eventId).toBe("event-2");
    });
  });

  describe("percentage calculations", () => {
    it("computes each category's percentage of the total request duration", () => {
      const metrics = computeRequestPerformanceMetrics(
        makeRequest({
          durationMs: 100,
          timeline: [
            makeEntry({ kind: "sql.query", relativeOffsetMs: 25, durationMs: 25, sequence: 1 }),
            makeEntry({
              kind: "http.request",
              relativeOffsetMs: 100,
              durationMs: 100,
              sequence: 2,
            }),
          ],
        }),
      );

      const sql = metrics.categoryBreakdown.find((b) => b.category === "sql");
      const http = metrics.categoryBreakdown.find((b) => b.category === "http");
      expect(sql?.percentOfRequestDuration).toBe(25);
      expect(http?.percentOfRequestDuration).toBe(100);
    });

    it("reports 0% for every category when the total duration is unknown", () => {
      const metrics = computeRequestPerformanceMetrics(
        makeRequest({
          durationMs: undefined,
          timeline: [
            makeEntry({ kind: "sql.query", relativeOffsetMs: 10, durationMs: 10, sequence: 1 }),
          ],
        }),
      );

      expect(metrics.categoryBreakdown[0]?.percentOfRequestDuration).toBe(0);
    });

    it("never divides by zero when the total duration is zero", () => {
      const metrics = computeRequestPerformanceMetrics(
        makeRequest({
          durationMs: 0,
          timeline: [makeEntry({ kind: "console.log", relativeOffsetMs: 0, sequence: 1 })],
        }),
      );

      expect(Number.isFinite(metrics.categoryBreakdown[0]?.percentOfRequestDuration)).toBe(true);
    });
  });

  describe("category breakdown ordering", () => {
    it("sorts categories by total duration, most time-consuming first", () => {
      const metrics = computeRequestPerformanceMetrics(
        makeRequest({
          durationMs: 100,
          timeline: [
            makeEntry({ kind: "redis.command", relativeOffsetMs: 10, durationMs: 5, sequence: 1 }),
            makeEntry({ kind: "sql.query", relativeOffsetMs: 40, durationMs: 30, sequence: 2 }),
            makeEntry({
              kind: "http.request",
              relativeOffsetMs: 100,
              durationMs: 100,
              sequence: 3,
            }),
          ],
        }),
      );

      expect(metrics.categoryBreakdown.map((b) => b.category)).toEqual(["http", "sql", "redis"]);
    });

    it("breaks ties alphabetically for deterministic ordering", () => {
      const metrics = computeRequestPerformanceMetrics(
        makeRequest({
          durationMs: 20,
          timeline: [
            makeEntry({ kind: "redis.command", relativeOffsetMs: 10, durationMs: 5, sequence: 1 }),
            makeEntry({ kind: "sql.query", relativeOffsetMs: 15, durationMs: 5, sequence: 2 }),
          ],
        }),
      );

      expect(metrics.categoryBreakdown.map((b) => b.category)).toEqual(["redis", "sql"]);
    });
  });

  describe("determinism and edge cases", () => {
    it("returns the same result for the same input", () => {
      const request = makeRequest({
        durationMs: 50,
        timeline: [
          makeEntry({ kind: "sql.query", relativeOffsetMs: 10, durationMs: 10, sequence: 1 }),
        ],
      });

      expect(computeRequestPerformanceMetrics(request)).toEqual(
        computeRequestPerformanceMetrics(request),
      );
    });

    it("handles an empty timeline without throwing", () => {
      expect(() =>
        computeRequestPerformanceMetrics(makeRequest({ durationMs: undefined, timeline: [] })),
      ).not.toThrow();
    });

    it("returns zeroed-out metrics for an empty timeline", () => {
      const metrics = computeRequestPerformanceMetrics(
        makeRequest({ durationMs: undefined, timeline: [] }),
      );

      expect(metrics.eventCount).toBe(0);
      expect(metrics.categoryBreakdown).toEqual([]);
      expect(metrics.slowestOperation).toBeUndefined();
    });
  });
});
