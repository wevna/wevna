import type { RequestModel } from "@wevna/intelligence";
import { useState } from "react";
import { EventDetails } from "./EventDetails.tsx";
import { EventList } from "./EventList.tsx";
import { ExecutionGraphSection } from "./ExecutionGraphSection.tsx";
import { PerformanceSection } from "./PerformanceSection.tsx";
import { formatEventCount, formatRequestDuration } from "./request-format.ts";
import { WaterfallTimeline } from "./WaterfallTimeline.tsx";

export interface RequestInspectorProps {
  request: RequestModel | undefined;
  selectedEventId: string | undefined;
  onSelectEvent: (id: string) => void;
}

type InspectorTab = "overview" | "attributes" | "performance";

const TABS: readonly { value: InspectorTab; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "attributes", label: "Attributes" },
  { value: "performance", label: "Performance" },
];

// The workspace half of the request list/inspector split (RequestList is
// the navigation half — see its own comment). Renders straight off the
// selected RequestModel: no copying, no separate fetch, and no timeline or
// event-rendering logic of its own — WaterfallTimeline, EventList and
// EventDetails are reused exactly as they're used elsewhere in the
// dashboard, so a request's events, timeline and attributes are never
// rendered two different ways.
//
// Every tab panel stays mounted at all times — only a CSS
// [data-active="false"] rule (see App.css) hides the inactive ones — so
// switching tabs never unmounts WaterfallTimeline/PerformanceSection/
// ExecutionGraphSection and re-triggers their work, and so every panel
// stays reachable via plain DOM queries regardless of which tab is
// visible (existing tests rely on exactly this, from before tabs
// existed).
export function RequestInspector({
  request,
  selectedEventId,
  onSelectEvent,
}: RequestInspectorProps) {
  const [activeTab, setActiveTab] = useState<InspectorTab>("overview");

  if (!request) {
    return <p className="request-inspector__empty">Select a request to inspect it.</p>;
  }

  const primaryEvent =
    request.events.find((event) => event.payload.id === selectedEventId) ??
    request.events.find((event) => event.payload.kind === "http.request") ??
    request.events[0];
  const primaryEntry = request.timeline.find(
    (entry) => entry.event.payload.id === primaryEvent?.payload.id,
  );

  return (
    <div className="request-inspector">
      <div className="request-inspector__tabs seg" role="tablist" aria-label="Request details">
        {TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            className="seg-opt"
            data-active={activeTab === tab.value}
            aria-selected={activeTab === tab.value}
            onClick={() => setActiveTab(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="request-inspector__panel" data-active={activeTab === "overview"}>
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

        <h3 className="request-inspector__section-heading">Events</h3>
        <EventList events={request.events} selectedId={selectedEventId} onSelect={onSelectEvent} />
      </div>

      <div className="request-inspector__panel" data-active={activeTab === "attributes"}>
        <EventDetails event={primaryEvent} relativeOffsetMs={primaryEntry?.relativeOffsetMs} />
      </div>

      <div className="request-inspector__panel" data-active={activeTab === "performance"}>
        <h3 className="request-inspector__section-heading">Timeline</h3>
        <WaterfallTimeline request={request} />

        <PerformanceSection request={request} />

        <h3 className="request-inspector__section-heading">Execution Graph</h3>
        <ExecutionGraphSection request={request} />
      </div>
    </div>
  );
}
