import type { RequestModel } from "@wevna/intelligence";
import { memo } from "react";
import { formatEventCount, formatRequestDuration } from "./request-format.ts";
import { isErrorRequest } from "./session-timeline-layout.ts";

export interface RequestListProps {
  requests: readonly RequestModel[];
  selectedRequestId: string | undefined;
  onSelectRequest: (id: string) => void;
}

interface RequestRowProps {
  request: RequestModel;
  selected: boolean;
  onSelect: () => void;
}

// Memoized so a request whose model object hasn't changed (every request
// except the one an incoming event just touched — see request-store.ts)
// skips re-rendering, even though RequestList itself re-renders on every
// event. `selected` is a plain boolean, so React.memo's default shallow
// comparison already limits a selection change to re-rendering just the
// previously- and newly-selected rows.
const RequestRow = memo(function RequestRow({ request, selected, onSelect }: RequestRowProps) {
  const className = selected ? "request-row request-row--selected" : "request-row";

  return (
    <li className={className} data-error={isErrorRequest(request)}>
      <button type="button" className="request-row__button" onClick={onSelect}>
        <span className="request-row__status" data-status={request.status}>
          {request.status}
        </span>
        <span className="request-row__method">{request.method ?? "—"}</span>
        <span className="request-row__route">{request.route ?? "—"}</span>
        <span className="request-row__status-code">{request.statusCode ?? "—"}</span>
        <span className="request-row__duration">{formatRequestDuration(request.durationMs)}</span>
        <span className="request-row__count">{formatEventCount(request.events.length)}</span>
      </button>
    </li>
  );
});

// Pure navigation, in the spirit of Chrome DevTools' Network panel: a
// request row identifies the request and lets you select it, nothing
// more. Its full detail (summary, timeline, events) lives in
// RequestInspector — see RequestInspector.tsx — which is the one place
// that renders a request's WaterfallTimeline and event list, so neither
// gets duplicated between the two components.
export function RequestList({ requests, selectedRequestId, onSelectRequest }: RequestListProps) {
  if (requests.length === 0) {
    return <p className="request-list__empty">No requests yet.</p>;
  }

  return (
    <ul className="request-list">
      {requests.map((request) => (
        <RequestRow
          key={request.id}
          request={request}
          selected={request.id === selectedRequestId}
          onSelect={() => onSelectRequest(request.id)}
        />
      ))}
    </ul>
  );
}
