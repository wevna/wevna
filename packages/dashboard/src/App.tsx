import "./App.css";
import { EventDetails } from "./EventDetails.tsx";
import { EventList } from "./EventList.tsx";
import { useLiveEvents } from "./use-live-events.ts";
import { useSelection } from "./use-selection.ts";

// TODO: Replace with the real dashboard (session list, timeline, filtering,
// replay) once those exist. For now this proves live events reach the UI
// and can be inspected one at a time.
function App() {
  const events = useLiveEvents();
  const { selectedId, select } = useSelection();
  const selectedEvent = events.find((event) => event.payload.id === selectedId);

  return (
    <main className="app">
      <h1 className="app__title">Wevna</h1>
      <p className="app__description">Runtime understanding for modern backends.</p>

      <div className="app__layout">
        <EventList events={events} selectedId={selectedId} onSelect={select} />
        <EventDetails event={selectedEvent} />
      </div>
    </main>
  );
}

export default App;
