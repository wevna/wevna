import type { TimeAttribution } from "./attribute-time.js";
import type { RequestPerformanceMetrics } from "./compute-performance-metrics.js";
import type { RepeatedOperation } from "./detect-repetition.js";
import { DEFAULT_PERFORMANCE_THRESHOLDS, type PerformanceThresholds } from "./thresholds.js";

export type PerformanceInsightType =
  | "slow-request"
  | "long-sql-execution"
  | "multiple-database-calls"
  | "multiple-redis-operations"
  | "repeated-operation"
  | "dominant-category"
  | "exception-occurred";

// Analysis that needs the request's own events rather than aggregate
// metrics. Optional so the existing metrics-only call sites keep working and
// simply produce no insight of these kinds — a caller that has not computed
// repetition should get silence, not a wrong answer.
export interface InsightContext {
  repeatedOperations?: readonly RepeatedOperation[];
  timeAttribution?: readonly TimeAttribution[];
}

// Human-readable names for the categories a dominant-category insight can
// name. Kept here rather than on EventCategory itself: the category is a
// classification, and how it is worded to a developer is presentation.
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  sql: "PostgreSQL",
  redis: "Redis",
  httpClient: "outgoing HTTP calls",
  http: "HTTP",
  console: "console output",
  exception: "exception handling",
  other: "uncategorized operations",
};

function labelFor(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

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
  context: InsightContext = {},
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

  // Ordered after the raw counts and before exceptions: a repeated query
  // explains a high query count, so it reads as the reason for the insight
  // above it.
  for (const repeated of context.repeatedOperations ?? []) {
    if (repeated.count < thresholds.repeatedOperationCount) {
      continue;
    }
    const what = repeated.kind === "sql.query" ? "query" : "command";
    insights.push({
      type: "repeated-operation",
      title: repeated.kind === "sql.query" ? "Repeated Query" : "Repeated Redis Command",
      // States the shape and the count, and stops there — a repeated query is
      // often an N+1 and sometimes entirely correct. The developer looking at
      // their own code is better placed to tell which.
      message: `The same ${what} ran ${repeated.count} times, taking ${round(repeated.totalDurationMs)}ms in total: ${repeated.signature}`,
    });
  }

  const dominant = context.timeAttribution?.[0];
  if (dominant !== undefined && dominant.sharePercent > thresholds.dominantCategorySharePercent) {
    insights.push({
      type: "dominant-category",
      title: "Where The Time Went",
      message: `${dominant.sharePercent}% of this request (${round(dominant.totalDurationMs)}ms) was spent on ${labelFor(dominant.category)}.`,
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
