import { describe, expect, it } from "vitest";
import type {
  CategoryBreakdown,
  RequestPerformanceMetrics,
} from "./compute-performance-metrics.js";
import { generatePerformanceInsights } from "./generate-performance-insights.js";
import { DEFAULT_PERFORMANCE_THRESHOLDS, type PerformanceThresholds } from "./thresholds.js";

function makeBreakdown(overrides: Partial<CategoryBreakdown> = {}): CategoryBreakdown {
  return {
    category: "sql",
    eventCount: 0,
    totalDurationMs: 0,
    percentOfRequestDuration: 0,
    slowestDurationMs: undefined,
    ...overrides,
  };
}

function makeMetrics(
  overrides: Partial<RequestPerformanceMetrics> = {},
): RequestPerformanceMetrics {
  return {
    totalDurationMs: 10,
    eventCount: 0,
    sqlQueryCount: 0,
    cumulativeSqlTimeMs: 0,
    redisCommandCount: 0,
    cumulativeRedisTimeMs: 0,
    consoleEventCount: 0,
    exceptionCount: 0,
    slowestOperation: undefined,
    categoryBreakdown: [],
    ...overrides,
  };
}

describe("generatePerformanceInsights", () => {
  describe("Slow Request", () => {
    it("fires when total duration exceeds the threshold", () => {
      const insights = generatePerformanceInsights(makeMetrics({ totalDurationMs: 1500 }));

      expect(insights.map((i) => i.type)).toContain("slow-request");
      expect(insights.find((i) => i.type === "slow-request")?.message).toBe(
        "This request took 1500ms, exceeding the 1000ms threshold.",
      );
    });

    it("does not fire when duration is exactly at the threshold", () => {
      const insights = generatePerformanceInsights(makeMetrics({ totalDurationMs: 1000 }));

      expect(insights.map((i) => i.type)).not.toContain("slow-request");
    });

    it("does not fire when duration is unknown (pending request)", () => {
      const insights = generatePerformanceInsights(makeMetrics({ totalDurationMs: undefined }));

      expect(insights.map((i) => i.type)).not.toContain("slow-request");
    });
  });

  describe("Long SQL Execution", () => {
    it("fires when the slowest SQL query exceeds the threshold", () => {
      const insights = generatePerformanceInsights(
        makeMetrics({
          categoryBreakdown: [makeBreakdown({ category: "sql", slowestDurationMs: 150 })],
        }),
      );

      const insight = insights.find((i) => i.type === "long-sql-execution");
      expect(insight).toBeDefined();
      expect(insight?.message).toBe(
        "The slowest SQL query took 150ms, exceeding the 100ms threshold.",
      );
    });

    it("does not fire when no sql category is present", () => {
      const insights = generatePerformanceInsights(makeMetrics({ categoryBreakdown: [] }));

      expect(insights.map((i) => i.type)).not.toContain("long-sql-execution");
    });

    it("does not fire when the slowest query is under the threshold", () => {
      const insights = generatePerformanceInsights(
        makeMetrics({
          categoryBreakdown: [makeBreakdown({ category: "sql", slowestDurationMs: 50 })],
        }),
      );

      expect(insights.map((i) => i.type)).not.toContain("long-sql-execution");
    });
  });

  describe("Multiple Database Calls", () => {
    it("fires when SQL query count exceeds the threshold", () => {
      const insights = generatePerformanceInsights(makeMetrics({ sqlQueryCount: 6 }));

      const insight = insights.find((i) => i.type === "multiple-database-calls");
      expect(insight?.message).toBe("6 SQL queries were executed, exceeding the threshold of 5.");
    });

    it("does not fire at exactly the threshold", () => {
      const insights = generatePerformanceInsights(makeMetrics({ sqlQueryCount: 5 }));

      expect(insights.map((i) => i.type)).not.toContain("multiple-database-calls");
    });
  });

  describe("Multiple Redis Operations", () => {
    it("fires when Redis command count exceeds the threshold", () => {
      const insights = generatePerformanceInsights(makeMetrics({ redisCommandCount: 8 }));

      const insight = insights.find((i) => i.type === "multiple-redis-operations");
      expect(insight?.message).toBe(
        "8 Redis operations were executed, exceeding the threshold of 5.",
      );
    });

    it("does not fire at exactly the threshold", () => {
      const insights = generatePerformanceInsights(makeMetrics({ redisCommandCount: 5 }));

      expect(insights.map((i) => i.type)).not.toContain("multiple-redis-operations");
    });
  });

  describe("Exception Occurred", () => {
    it("fires with singular phrasing for exactly one exception", () => {
      const insights = generatePerformanceInsights(makeMetrics({ exceptionCount: 1 }));

      expect(insights.find((i) => i.type === "exception-occurred")?.message).toBe(
        "An exception occurred during this request.",
      );
    });

    it("fires with plural phrasing and a count for multiple exceptions", () => {
      const insights = generatePerformanceInsights(makeMetrics({ exceptionCount: 3 }));

      expect(insights.find((i) => i.type === "exception-occurred")?.message).toBe(
        "3 exceptions occurred during this request.",
      );
    });

    it("does not fire when there are no exceptions", () => {
      const insights = generatePerformanceInsights(makeMetrics({ exceptionCount: 0 }));

      expect(insights.map((i) => i.type)).not.toContain("exception-occurred");
    });
  });

  describe("configurable thresholds", () => {
    it("uses DEFAULT_PERFORMANCE_THRESHOLDS when none is given", () => {
      const insights = generatePerformanceInsights(makeMetrics({ totalDurationMs: 1001 }));

      expect(insights.map((i) => i.type)).toContain("slow-request");
    });

    it("respects a custom, stricter threshold", () => {
      const strict: PerformanceThresholds = {
        ...DEFAULT_PERFORMANCE_THRESHOLDS,
        slowRequestMs: 10,
      };

      const insights = generatePerformanceInsights(makeMetrics({ totalDurationMs: 20 }), strict);

      expect(insights.map((i) => i.type)).toContain("slow-request");
      expect(insights.find((i) => i.type === "slow-request")?.message).toContain("10ms threshold");
    });

    it("respects a custom, looser threshold that suppresses an insight the default would fire", () => {
      const loose: PerformanceThresholds = {
        ...DEFAULT_PERFORMANCE_THRESHOLDS,
        slowRequestMs: 5000,
      };

      const insights = generatePerformanceInsights(makeMetrics({ totalDurationMs: 2000 }), loose);

      expect(insights.map((i) => i.type)).not.toContain("slow-request");
    });
  });

  describe("multiple insights and determinism", () => {
    it("produces every applicable insight for a request with several problems at once", () => {
      const insights = generatePerformanceInsights(
        makeMetrics({
          totalDurationMs: 2000,
          sqlQueryCount: 10,
          redisCommandCount: 10,
          exceptionCount: 1,
          categoryBreakdown: [makeBreakdown({ category: "sql", slowestDurationMs: 500 })],
        }),
      );

      expect(insights.map((i) => i.type)).toEqual([
        "slow-request",
        "long-sql-execution",
        "multiple-database-calls",
        "multiple-redis-operations",
        "exception-occurred",
      ]);
    });

    it("returns an empty array for a healthy request", () => {
      const insights = generatePerformanceInsights(makeMetrics({ totalDurationMs: 20 }));

      expect(insights).toEqual([]);
    });

    it("is deterministic for the same input", () => {
      const metrics = makeMetrics({ totalDurationMs: 2000, sqlQueryCount: 10 });

      expect(generatePerformanceInsights(metrics)).toEqual(generatePerformanceInsights(metrics));
    });

    it("every insight includes a title and a non-empty message", () => {
      const insights = generatePerformanceInsights(
        makeMetrics({ totalDurationMs: 2000, exceptionCount: 2 }),
      );

      for (const insight of insights) {
        expect(insight.title.length).toBeGreaterThan(0);
        expect(insight.message.length).toBeGreaterThan(0);
      }
    });
  });
});
