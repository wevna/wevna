import "./design-system.css";
import "./App.css";
import { DashboardHeader } from "./DashboardHeader.tsx";
import { EndpointStatsSection } from "./EndpointStatsSection.tsx";
import { EventDetails } from "./EventDetails.tsx";
import { EventList } from "./EventList.tsx";
import { findTimelineEntry } from "./find-timeline-entry.ts";
import { ReplayControls } from "./ReplayControls.tsx";
import { RequestInspector } from "./RequestInspector.tsx";
import { RequestList } from "./RequestList.tsx";
import { formatEventCount } from "./request-format.ts";
import { SessionTimeline } from "./SessionTimeline.tsx";
import { useEventFilter } from "./use-event-filter.ts";
import { useEventSource } from "./use-event-source.ts";
import { useRequestSelection } from "./use-request-selection.ts";
import { useSelection } from "./use-selection.ts";
import { useTheme } from "./use-theme.ts";
import { useTimeline } from "./use-timeline.ts";

function App() {
  const { events, requests, clearRequests, sessionMode, replay } = useEventSource();
  const { selectedId, select } = useSelection();
  // Selection resolves against the full live list, not the
  // paused/cleared/filtered view, so it survives all three — the details
  // panel never loses what's selected just because the row scrolled out of
  // view or got filtered out.
  const selectedEvent = events.find((event) => event.payload.id === selectedId);
  const { visibleEvents, paused, liveCount, pause, resume, clear } = useTimeline(events);
  const { query, kind, availableKinds, filteredEvents, setQuery, setKind } =
    useEventFilter(visibleEvents);
  const { selectedRequestId, selectRequest, clearRequestSelection } = useRequestSelection();
  // Resolves against the current requests list every render, same as
  // selectedEvent above — a request whose model object hasn't changed
  // (see request-store.ts) is the same reference, so this doesn't defeat
  // RequestList's/RequestInspector's memoization, and a still-executing
  // (or, during replay, still-advancing) selected request's inspector view
  // updates automatically as its model object changes. If replay seeks to
  // a position before the selected request existed, it simply disappears
  // from `requests` and this resolves to undefined — RequestInspector
  // already renders its placeholder for that case, so a stale selection
  // clears itself with no extra code, and reappears the same way if
  // replay moves forward past it again.
  const selectedRequest = requests.find((request) => request.id === selectedRequestId);
  // Looked up across every request, not just selectedRequest — an event
  // can be selected (from the raw list, or a different request's own
  // event list) without its owning request being the one currently open
  // in the inspector.
  const selectedTimelineEntry = findTimelineEntry(requests, selectedId);
  const { theme, toggleTheme } = useTheme();

  // Only meaningful in live mode — see use-event-source.ts. Clearing the
  // request list removes whatever was selected too — leaving a stale id
  // selected here would be harmless (selectedRequest would just resolve
  // to undefined) but pointless to keep around.
  function handleClearRequests(): void {
    clearRequests?.();
    clearRequestSelection();
  }

  return (
    <main className="app">
      <DashboardHeader
        sessionMode={sessionMode}
        search={{ query, kind, availableKinds, onQueryChange: setQuery, onKindChange: setKind }}
        timeline={{ paused, liveCount, onPause: pause, onResume: resume, onClear: clear }}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      {/* Purely informational — no replay controls here, just exposing
          which recording is being viewed and when it was made. */}
      {sessionMode.mode === "recording" && sessionMode.metadata ? (
        <p className="app__recording-banner">
          Viewing a recorded session · started{" "}
          {new Date(sessionMode.metadata.recordingStartedAt).toLocaleString()}
          {sessionMode.metadata.eventCount !== undefined
            ? ` · ${sessionMode.metadata.eventCount} events`
            : ""}
        </p>
      ) : null}

      {/* Only present once the recording's events have loaded (see
          use-event-source.ts) — never in live mode, which has no fixed
          end to play toward or seek within. */}
      {replay ? (
        <ReplayControls
          position={replay.position}
          totalEvents={replay.totalEvents}
          state={replay.state}
          speed={replay.speed}
          controls={replay.controls}
        />
      ) : null}

      <SessionTimeline
        requests={requests}
        selectedRequestId={selectedRequestId}
        onSelectRequest={selectRequest}
        variant="ribbon"
      />

      <section className="dashboard-grid">
        <div className="dashboard-pane dashboard-pane--events">
          <div className="dashboard-pane__heading">
            <h2>Events</h2>
            <span className="dashboard-pane__count">{formatEventCount(requests.length)}</span>
            {clearRequests ? (
              <button type="button" className="btn btn-ghost" onClick={handleClearRequests}>
                Clear requests
              </button>
            ) : null}
          </div>
          <RequestList
            requests={requests}
            selectedRequestId={selectedRequestId}
            onSelectRequest={selectRequest}
          />
        </div>

        <div className="dashboard-pane dashboard-pane--timeline">
          <SessionTimeline
            requests={requests}
            selectedRequestId={selectedRequestId}
            onSelectRequest={selectRequest}
            variant="expanded"
          />
        </div>

        <div className="dashboard-pane dashboard-pane--inspector">
          <RequestInspector
            request={selectedRequest}
            selectedEventId={selectedId}
            onSelectEvent={select}
          />
        </div>
      </section>

      <EndpointStatsSection requests={requests} />

      <section className="all-events-section">
        <h2 className="all-events-section__title">All Events</h2>
        <div className="app__layout">
          <EventList events={filteredEvents} selectedId={selectedId} onSelect={select} />
          <EventDetails
            event={selectedEvent}
            relativeOffsetMs={selectedTimelineEntry?.relativeOffsetMs}
          />
        </div>
      </section>
    </main>
  );
}

export default App;
