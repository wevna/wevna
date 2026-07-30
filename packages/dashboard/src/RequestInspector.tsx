import { EventList } from "./EventList.tsx";
import { formatEventCount, formatRequestDuration } from "./request-format.ts";
import type { RequestModel } from "./request-store.ts";
import { WaterfallTimeline } from "./WaterfallTimeline.tsx";

export interface RequestInspectorProps {
  request: RequestModel | undefined;
  selectedEventId: string | undefined;
  onSelectEvent: (id: string) => void;
}

// The workspace half of the request list/inspector split (RequestList is
// the navigation half — see its own comment). Renders straight off the
// selected RequestModel: no copying, no separate fetch, and no timeline or
// event-rendering logic of its own — WaterfallTimeline and EventList are
// reused exactly as they're used elsewhere in the dashboard, so a request's
// events and timeline are never rendered two different ways.
export function RequestInspector({
  request,
  selectedEventId,
  onSelectEvent,
}: RequestInspectorProps) {
  if (!request) {
    return <p className="request-inspector__empty">Select a request to inspect it.</p>;
  }

  return (
    <div className="request-inspector">
      <dl className="request-inspector__summary">
        <dt>Method</dt>
        <dd>{request.method ?? "—"}</dd>
        <dt>Route</dt>
        <dd>{request.route ?? "—"}</dd>
        <dt>Status</dt>
        <dd data-status={request.status}>{request.status}</dd>
        <dt>Status Code</dt>
        <dd>{request.statusCode ?? "—"}</dd>
        <dt>Duration</dt>
        <dd>{formatRequestDuration(request.durationMs)}</dd>
        <dt>Correlation ID</dt>
        <dd>{request.correlationId}</dd>
        <dt>Started At</dt>
        <dd>{new Date(request.startedAt).toLocaleString()}</dd>
        <dt>Event Count</dt>
        <dd>{formatEventCount(request.events.length)}</dd>
      </dl>

      <h3 className="request-inspector__section-heading">Timeline</h3>
      <WaterfallTimeline request={request} />

      <h3 className="request-inspector__section-heading">Events</h3>
      <EventList events={request.events} selectedId={selectedEventId} onSelect={onSelectEvent} />
    </div>
  );
}
