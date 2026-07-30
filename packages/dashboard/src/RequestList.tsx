import type { RequestModel } from "./request-store.ts";

export interface RequestListProps {
  requests: readonly RequestModel[];
}

function formatDuration(durationMs: number | undefined): string {
  return durationMs === undefined ? "…" : `${durationMs.toFixed(1)}ms`;
}

// Minimal, developer-oriented validation view: proves requests assemble
// correctly from raw events. Not an inspector — no expansion, no per-event
// detail, no timeline. That's future work built on top of RequestStore.
export function RequestList({ requests }: RequestListProps) {
  if (requests.length === 0) {
    return <p className="request-list__empty">No requests yet.</p>;
  }

  return (
    <ul className="request-list">
      {requests.map((request) => (
        <li key={request.id} className="request-row">
          <span className="request-row__status" data-status={request.status}>
            {request.status}
          </span>
          <span className="request-row__method">{request.method ?? "—"}</span>
          <span className="request-row__route">{request.route ?? "—"}</span>
          <span className="request-row__status-code">{request.statusCode ?? "—"}</span>
          <span className="request-row__duration">{formatDuration(request.durationMs)}</span>
          <span className="request-row__count">
            {request.events.length} event{request.events.length === 1 ? "" : "s"}
          </span>
        </li>
      ))}
    </ul>
  );
}
