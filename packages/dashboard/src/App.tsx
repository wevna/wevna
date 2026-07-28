import "./App.css";

// TODO: Replace with the real dashboard (session list, timeline, event
// inspector) once the capture pipeline and a live connection exist. The
// connection indicator below is a static placeholder — it does not reflect
// any real connection yet.
function App() {
  return (
    <main className="app">
      <h1 className="app__title">Wevna</h1>
      <p className="app__description">Runtime understanding for modern backends.</p>

      <div className="app__status">
        <span aria-hidden="true">🟢</span>
        <span>Connected</span>
      </div>

      <section className="app__placeholder">Waiting for runtime...</section>
    </main>
  );
}

export default App;
