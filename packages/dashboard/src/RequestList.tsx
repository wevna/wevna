import { memo } from "react";
import type { RequestModel } from "./request-store.ts";
import { WaterfallTimeline } from "./WaterfallTimeline.tsx";

export interface RequestListProps {
  requests: readonly RequestModel[];
}

function formatDuration(durationMs: number | undefined): string {
  return durationMs === undefined ? "…" : `${durationMs.toFixed(1)}ms`;
}

// Memoized so a request whose model object hasn't changed (every request
// except the one an incoming event just touched — see request-store.ts)
// skips re-rendering, including recomputing its waterfall layout, even
// though RequestList itself re-renders on every event.
const RequestRow = memo(function RequestRow({ request }: { request: RequestModel }) {
  return (
    <li className="request-row">
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
      <WaterfallTimeline request={request} />
    </li>
  );
});

// Minimal, developer-oriented validation view: proves requests assemble
// correctly from raw events, and that each renders as an intuitive
// waterfall. Not a full inspector — no expansion/collapse, no per-event
// detail panel. That's future work built on top of RequestStore/
// timeline.ts/timeline-layout.ts.
export function RequestList({ requests }: RequestListProps) {
  if (requests.length === 0) {
    return <p className="request-list__empty">No requests yet.</p>;
  }

  return (
    <ul className="request-list">
      {requests.map((request) => (
        <RequestRow key={request.id} request={request} />
      ))}
    </ul>
  );
}
