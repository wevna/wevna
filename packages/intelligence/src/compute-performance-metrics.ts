import type { AnalyzableRequest } from "./analyzable-request.js";
import { categorizeEvent, type EventCategory } from "./event-category.js";

export interface SlowestOperation {
  kind: string;
  durationMs: number;
  relativeOffsetMs: number;
  eventId: string;
}

export interface CategoryBreakdown {
  category: EventCategory;
  eventCount: number;
  totalDurationMs: number;
  // Of the request's total duration, not of this category's own total —
  // categories overlap in wall-clock time (a SQL query runs *within* the
  // request's own span, not after it), so these are not expected to sum to
  // 100 across categories. Each one only answers "how much of the whole
  // request's time did this category's events span."
  percentOfRequestDuration: number;
  slowestDurationMs: number | undefined;
}

export interface RequestPerformanceMetrics {
  totalDurationMs: number | undefined;
  eventCount: number;
  sqlQueryCount: number;
  cumulativeSqlTimeMs: number;
  redisCommandCount: number;
  cumulativeRedisTimeMs: number;
  consoleEventCount: number;
  exceptionCount: number;
  // The single slowest *operation* — excludes http.request (see
  // CONTAINER_KIND below) — undefined when nothing in the timeline has a
  // measured duration (e.g. only console.log/exception.captured so far).
  slowestOperation: SlowestOperation | undefined;
  // Sorted by totalDurationMs descending (ties broken alphabetically by
  // category) so the most time-consuming category is always first —
  // a presentation-friendly ordering, not a fact about the data itself.
  categoryBreakdown: readonly CategoryBreakdown[];
}

// http.request's own duration spans the entire request — it isn't an
// "operation" performed during the request, it's the request itself (see
// the dashboard's timeline-layout.ts for the same fact driving the
// waterfall's own layout math). Comparing it against sql.query/
// redis.command durations for "slowest operation" would trivially always
// pick it and say nothing about why the request was actually slow.
const CONTAINER_KIND = "http.request";

function percentOf(part: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return (part / total) * 100;
}

interface CategoryAccumulator {
  eventCount: number;
  totalDurationMs: number;
  slowestDurationMs: number | undefined;
}

// Pure: the same request always produces the same metrics, so callers can
// memoize on the request's own identity (see the dashboard's
// PerformanceSection, which does exactly that).
export function computeRequestPerformanceMetrics(
  request: AnalyzableRequest,
): RequestPerformanceMetrics {
  const totalDurationMs = request.durationMs;
  const byCategory = new Map<EventCategory, CategoryAccumulator>();
  let sqlQueryCount = 0;
  let cumulativeSqlTimeMs = 0;
  let redisCommandCount = 0;
  let cumulativeRedisTimeMs = 0;
  let consoleEventCount = 0;
  let exceptionCount = 0;
  let slowestOperation: SlowestOperation | undefined;

  for (const entry of request.timeline) {
    const category = categorizeEvent(entry.kind);
    const durationMs = entry.durationMs ?? 0;

    const bucket = byCategory.get(category) ?? {
      eventCount: 0,
      totalDurationMs: 0,
      slowestDurationMs: undefined,
    };
    bucket.eventCount += 1;
    bucket.totalDurationMs += durationMs;
    if (
      entry.durationMs !== undefined &&
      (bucket.slowestDurationMs === undefined || entry.durationMs > bucket.slowestDurationMs)
    ) {
      bucket.slowestDurationMs = entry.durationMs;
    }
    byCategory.set(category, bucket);

    switch (category) {
      case "sql":
        sqlQueryCount += 1;
        cumulativeSqlTimeMs += durationMs;
        break;
      case "redis":
        redisCommandCount += 1;
        cumulativeRedisTimeMs += durationMs;
        break;
      case "console":
        consoleEventCount += 1;
        break;
      case "exception":
        exceptionCount += 1;
        break;
      default:
        break;
    }

    if (
      entry.kind !== CONTAINER_KIND &&
      entry.durationMs !== undefined &&
      entry.durationMs > 0 &&
      (slowestOperation === undefined || entry.durationMs > slowestOperation.durationMs)
    ) {
      slowestOperation = {
        kind: entry.kind,
        durationMs: entry.durationMs,
        relativeOffsetMs: entry.relativeOffsetMs,
        eventId: entry.event.payload.id,
      };
    }
  }

  const categoryBreakdown: CategoryBreakdown[] = Array.from(byCategory.entries())
    .map(([category, bucket]) => ({
      category,
      eventCount: bucket.eventCount,
      totalDurationMs: bucket.totalDurationMs,
      percentOfRequestDuration: percentOf(bucket.totalDurationMs, totalDurationMs ?? 0),
      slowestDurationMs: bucket.slowestDurationMs,
    }))
    .sort((a, b) => b.totalDurationMs - a.totalDurationMs || a.category.localeCompare(b.category));

  return {
    totalDurationMs,
    eventCount: request.timeline.length,
    sqlQueryCount,
    cumulativeSqlTimeMs,
    redisCommandCount,
    cumulativeRedisTimeMs,
    consoleEventCount,
    exceptionCount,
    slowestOperation,
    categoryBreakdown,
  };
}
