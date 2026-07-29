import "./App.css";
import { EventDetails } from "./EventDetails.tsx";
import { EventList } from "./EventList.tsx";
import { TimelineControls } from "./TimelineControls.tsx";
import { useLiveEvents } from "./use-live-events.ts";
import { useSelection } from "./use-selection.ts";
import { useTimeline } from "./use-timeline.ts";

// TODO: Replace with the real dashboard (session list, filtering, replay)
// once those exist. For now this proves live events reach the UI and can
// be inspected one at a time.
function App() {
  const events = useLiveEvents();
  const { selectedId, select } = useSelection();
  // Selection resolves against the full live list, not the paused/cleared
  // view, so it survives both — the details panel never loses what's
  // selected just because it scrolled out of the visible window.
  const selectedEvent = events.find((event) => event.payload.id === selectedId);
  const { visibleEvents, paused, liveCount, pause, resume, clear } = useTimeline(events);

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

      <div className="app__layout">
        <EventList events={visibleEvents} selectedId={selectedId} onSelect={select} />
        <EventDetails event={selectedEvent} />
      </div>
    </main>
  );
}

export default App;
