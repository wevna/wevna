import "./App.css";
import { EventDetails } from "./EventDetails.tsx";
import { EventList } from "./EventList.tsx";
import { findTimelineEntry } from "./find-timeline-entry.ts";
import { RequestInspector } from "./RequestInspector.tsx";
import { RequestList } from "./RequestList.tsx";
import { SearchControls } from "./SearchControls.tsx";
import { TimelineControls } from "./TimelineControls.tsx";
import { useEventFilter } from "./use-event-filter.ts";
import { useLiveEvents } from "./use-live-events.ts";
import { useRequestSelection } from "./use-request-selection.ts";
import { useRequests } from "./use-requests.ts";
import { useSelection } from "./use-selection.ts";
import { useTimeline } from "./use-timeline.ts";

// TODO: Replace with the real dashboard (session list, replay) once those
// exist. For now this proves live events reach the UI and can be
// inspected, paused, and searched.
function App() {
  const events = useLiveEvents();
  const { selectedId, select } = useSelection();
  // Selection resolves against the full live list, not the
  // paused/cleared/filtered view, so it survives all three — the details
  // panel never loses what's selected just because the row scrolled out of
  // view or got filtered out.
  const selectedEvent = events.find((event) => event.payload.id === selectedId);
  const { visibleEvents, paused, liveCount, pause, resume, clear } = useTimeline(events);
  const { query, kind, availableKinds, filteredEvents, setQuery, setKind } =
    useEventFilter(visibleEvents);
  // Requests are assembled from the full, raw event list — independent of
  // pause/filter/search, exactly like EventStore itself. Those are
  // presentation concerns layered on top of the raw pipeline, not part of
  // what a request "is".
  const { requests, clear: clearRequestsStore } = useRequests(events);
  const { selectedRequestId, selectRequest, clearRequestSelection } = useRequestSelection();
  // Resolves against the live requests list every render, same as
  // selectedEvent above — a request whose model object hasn't changed
  // (see request-store.ts) is the same reference, so this doesn't defeat
  // RequestList's/RequestInspector's memoization, and a still-executing
  // selected request's inspector view updates automatically as its model
  // object changes.
  const selectedRequest = requests.find((request) => request.id === selectedRequestId);
  // Looked up across every request, not just selectedRequest — an event
  // can be selected (from the raw list, or a different request's own
  // event list) without its owning request being the one currently open
  // in the inspector.
  const selectedTimelineEntry = findTimelineEntry(requests, selectedId);

  // Clearing the request list removes whatever was selected too — leaving
  // a stale id selected here would be harmless (selectedRequest would just
  // resolve to undefined) but pointless to keep around.
  function clearRequests(): void {
    clearRequestsStore();
    clearRequestSelection();
  }

  return (
    <main className="app">
      <h1 className="app__title">Wevna</h1>
      <p className="app__description">Runtime understanding for modern backends.</p>

      <TimelineControls
        paused={paused}
        liveCount={liveCount}
        onPause={pause}
        onResume={resume}
        onClear={clear}
      />
      <SearchControls
        query={query}
        kind={kind}
        availableKinds={availableKinds}
        onQueryChange={setQuery}
        onKindChange={setKind}
      />

      <div className="app__layout">
        <EventList events={filteredEvents} selectedId={selectedId} onSelect={select} />
        <EventDetails
          event={selectedEvent}
          relativeOffsetMs={selectedTimelineEntry?.relativeOffsetMs}
        />
      </div>

      <section className="requests-section">
        <div className="requests-section__header">
          <h2 className="requests-section__title">Requests</h2>
          <button type="button" onClick={clearRequests}>
            Clear requests
          </button>
        </div>
        <div className="requests-section__layout">
          <RequestList
            requests={requests}
            selectedRequestId={selectedRequestId}
            onSelectRequest={selectRequest}
          />
          <RequestInspector
            request={selectedRequest}
            selectedEventId={selectedId}
            onSelectEvent={select}
          />
        </div>
      </section>
    </main>
  );
}

export default App;
