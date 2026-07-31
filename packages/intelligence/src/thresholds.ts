// Every number that decides whether an insight fires lives here, and only
// here — insight generation reads from a PerformanceThresholds value
// rather than embedding literals of its own, so tuning a threshold (or a
// consumer overriding one, e.g. a stricter budget for a latency-sensitive
// service) never means hunting through the analyzer's logic.
export interface PerformanceThresholds {
  // A request whose total duration exceeds this is flagged "Slow Request".
  // 1000ms: a widely-used, unsurprising default for "a human waiting on
  // this would notice."
  slowRequestMs: number;
  // A single SQL query whose own duration exceeds this is flagged "Long
  // SQL Execution". 100ms: in line with common database slow-query-log
  // defaults (e.g. Postgres deployments commonly set log_min_duration_statement
  // in the 100–250ms range).
  longSqlQueryMs: number;
  // More SQL queries than this in one request is flagged "Multiple
  // Database Calls" — a request making more than a handful of individual
  // queries is a common N+1 symptom, whether or not any single one is
  // individually slow.
  multipleDatabaseCallsCount: number;
  // Same idea as multipleDatabaseCallsCount, for Redis commands.
  multipleRedisOperationsCount: number;
}

export const DEFAULT_PERFORMANCE_THRESHOLDS: PerformanceThresholds = {
  slowRequestMs: 1000,
  longSqlQueryMs: 100,
  multipleDatabaseCallsCount: 5,
  multipleRedisOperationsCount: 5,
};
