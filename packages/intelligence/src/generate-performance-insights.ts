import type { RequestPerformanceMetrics } from "./compute-performance-metrics.js";
import { DEFAULT_PERFORMANCE_THRESHOLDS, type PerformanceThresholds } from "./thresholds.js";

export type PerformanceInsightType =
  | "slow-request"
  | "long-sql-execution"
  | "multiple-database-calls"
  | "multiple-redis-operations"
  | "exception-occurred";

export interface PerformanceInsight {
  type: PerformanceInsightType;
  title: string;
  // Always states the actual numbers involved and the threshold they
  // crossed — an insight explains why it fired, not just that it did.
  message: string;
}

function round(ms: number): number {
  return Math.round(ms);
}

// Pure and deterministic: the same metrics and thresholds always produce
// the same insights, in the same order (the fixed order they're checked
// in below) — no invented heuristics, only direct threshold comparisons
// against numbers already present in the metrics.
export function generatePerformanceInsights(
  metrics: RequestPerformanceMetrics,
  thresholds: PerformanceThresholds = DEFAULT_PERFORMANCE_THRESHOLDS,
): readonly PerformanceInsight[] {
  const insights: PerformanceInsight[] = [];

  if (metrics.totalDurationMs !== undefined && metrics.totalDurationMs > thresholds.slowRequestMs) {
    insights.push({
      type: "slow-request",
      title: "Slow Request",
      message: `This request took ${round(metrics.totalDurationMs)}ms, exceeding the ${thresholds.slowRequestMs}ms threshold.`,
    });
  }

  const slowestSqlMs = metrics.categoryBreakdown.find(
    (breakdown) => breakdown.category === "sql",
  )?.slowestDurationMs;
  if (slowestSqlMs !== undefined && slowestSqlMs > thresholds.longSqlQueryMs) {
    insights.push({
      type: "long-sql-execution",
      title: "Long SQL Execution",
      message: `The slowest SQL query took ${round(slowestSqlMs)}ms, exceeding the ${thresholds.longSqlQueryMs}ms threshold.`,
    });
  }

  if (metrics.sqlQueryCount > thresholds.multipleDatabaseCallsCount) {
    insights.push({
      type: "multiple-database-calls",
      title: "Multiple Database Calls",
      message: `${metrics.sqlQueryCount} SQL queries were executed, exceeding the threshold of ${thresholds.multipleDatabaseCallsCount}.`,
    });
  }

  if (metrics.redisCommandCount > thresholds.multipleRedisOperationsCount) {
    insights.push({
      type: "multiple-redis-operations",
      title: "Multiple Redis Operations",
      message: `${metrics.redisCommandCount} Redis operations were executed, exceeding the threshold of ${thresholds.multipleRedisOperationsCount}.`,
    });
  }

  if (metrics.exceptionCount > 0) {
    insights.push({
      type: "exception-occurred",
      title: "Exception Occurred",
      message:
        metrics.exceptionCount === 1
          ? "An exception occurred during this request."
          : `${metrics.exceptionCount} exceptions occurred during this request.`,
    });
  }

  return insights;
}
