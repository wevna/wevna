import { aggregateEndpointStats, type RequestModel } from "@wevna/intelligence";
import { useMemo } from "react";
import { formatRequestDuration } from "./request-format.ts";

export interface EndpointStatsSectionProps {
  requests: readonly RequestModel[];
}

// The session's one cross-request view: every other pane in the dashboard
// answers "what happened in this request" — this answers "which endpoint
// should I actually look at," ranked slowest-average first. Memoized on
// `requests` the same way PerformanceSection memoizes on a single request:
// aggregateEndpointStats is a pure function of exactly this input.
export function EndpointStatsSection({ requests }: EndpointStatsSectionProps) {
  const stats = useMemo(() => aggregateEndpointStats(requests), [requests]);

  return (
    <section className="endpoint-stats-section">
      <h2 className="endpoint-stats-section__title">Endpoints</h2>

      {stats.length === 0 ? (
        <p className="endpoint-stats-section__empty">No completed requests yet.</p>
      ) : (
        <div className="endpoint-stats-table__scroll">
          <table className="endpoint-stats-table">
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Requests</th>
                <th>Errors</th>
                <th>Avg</th>
                <th>p95</th>
                <th>Slowest</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((stat) => (
                <tr key={`${stat.method} ${stat.route}`}>
                  <td className="endpoint-stats-table__endpoint">
                    <span className="endpoint-stats-table__method">{stat.method}</span>
                    <span className="endpoint-stats-table__route">{stat.route}</span>
                  </td>
                  <td>{stat.requestCount}</td>
                  <td data-has-errors={stat.errorCount > 0}>{stat.errorCount}</td>
                  <td>{formatRequestDuration(stat.averageDurationMs)}</td>
                  <td>{formatRequestDuration(stat.p95DurationMs)}</td>
                  <td>{formatRequestDuration(stat.slowestDurationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
