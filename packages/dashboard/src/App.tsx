import "./App.css";
import { EventList } from "./EventList.tsx";
import { useLiveEvents } from "./use-live-events.ts";

// TODO: Replace with the real dashboard (session list, timeline, event
// inspector) once event details, filtering, and replay exist. For now this
// only proves live events reach the UI.
function App() {
  const events = useLiveEvents();

  return (
    <main className="app">
      <h1 className="app__title">Wevna</h1>
      <p className="app__description">Runtime understanding for modern backends.</p>

      <EventList events={events} />
    </main>
  );
}

export default App;
