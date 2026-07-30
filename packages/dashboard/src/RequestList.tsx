import type { RequestModel } from "./request-store.ts";
import type { TimelineEntry } from "./timeline.ts";

export interface RequestListProps {
  requests: readonly RequestModel[];
}

function formatDuration(durationMs: number | undefined): string {
  return durationMs === undefined ? "…" : `${durationMs.toFixed(1)}ms`;
}

function formatOffset(relativeOffsetMs: number): string {
  return `${Math.round(relativeOffsetMs)}ms`;
}

// Plain text only, on purpose — no bars, no canvas/SVG, no animation. Just
// enough to see that the timeline exists and is ordered correctly; a real
// visualization is future work built on top of RequestModel.timeline.
function RequestTimeline({ entries }: { entries: readonly TimelineEntry[] }) {
  if (entries.length === 0) {
    return null;
  }

  return (
    <ul className="request-row__timeline">
      {entries.map((entry) => (
        <li key={entry.event.payload.id} className="request-row__timeline-entry">
          <span className="request-row__timeline-offset">
            {formatOffset(entry.relativeOffsetMs)}
          </span>
          <span className="request-row__timeline-kind">{entry.kind}</span>
        </li>
      ))}
    </ul>
  );
}

// Minimal, developer-oriented validation view: proves requests assemble
// correctly from raw events, and that each has a correctly-ordered,
// relative-time timeline. Not an inspector — no expansion/collapse, no
// per-event detail beyond kind + offset. That's future work built on top
// of RequestStore/timeline.ts.
export function RequestList({ requests }: RequestListProps) {
  if (requests.length === 0) {
    return <p className="request-list__empty">No requests yet.</p>;
  }

  return (
    <ul className="request-list">
      {requests.map((request) => (
        <li key={request.id} className="request-row">
          <div className="request-row__summary">
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
          </div>
          <RequestTimeline entries={request.timeline} />
        </li>
      ))}
    </ul>
  );
}
