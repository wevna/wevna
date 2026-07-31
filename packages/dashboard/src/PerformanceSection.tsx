import { analyzeRequestPerformance } from "@wevna/intelligence";
import { useMemo } from "react";
import { formatRequestDuration } from "./request-format.ts";
import type { RequestModel } from "./request-store.ts";

export interface PerformanceSectionProps {
  request: RequestModel;
}

function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

// Mirrors WaterfallTimeline's own pattern: memoized on the request itself
// (via useMemo — analyzeRequestPerformance is a pure function of exactly
// this input, see @wevna/intelligence), so a request whose events haven't
// changed never recomputes its analysis just because a sibling request
// updated. This component only ever turns analyzeRequestPerformance's
// output into markup — it never derives a metric or evaluates a threshold
// itself; all of that lives in @wevna/intelligence.
export function PerformanceSection({ request }: PerformanceSectionProps) {
  const { metrics, insights } = useMemo(() => analyzeRequestPerformance(request), [request]);

  return (
    <div className="performance-section">
      <dl className="performance-section__summary">
        <dt>Request Duration</dt>
        <dd>{formatRequestDuration(metrics.totalDurationMs)}</dd>
        <dt>Longest Operation</dt>
        <dd>
          {metrics.slowestOperation
            ? `${metrics.slowestOperation.kind} · ${formatMs(metrics.slowestOperation.durationMs)}`
            : "—"}
        </dd>
        <dt>SQL Queries</dt>
        <dd>
          {metrics.sqlQueryCount} · {formatMs(metrics.cumulativeSqlTimeMs)} total
        </dd>
        <dt>Redis Operations</dt>
        <dd>
          {metrics.redisCommandCount} · {formatMs(metrics.cumulativeRedisTimeMs)} total
        </dd>
        <dt>Console Events</dt>
        <dd>{metrics.consoleEventCount}</dd>
        <dt>Exceptions</dt>
        <dd>{metrics.exceptionCount}</dd>
      </dl>

      {insights.length > 0 ? (
        <ul className="performance-section__insights">
          {insights.map((insight) => (
            <li key={insight.type} className="performance-insight">
              <span className="performance-insight__title">{insight.title}</span>
              <span className="performance-insight__message">{insight.message}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="performance-section__no-insights">No performance issues detected.</p>
      )}
    </div>
  );
}
