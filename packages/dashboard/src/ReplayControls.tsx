import type { ReplayControls as ReplayControlsApi } from "./replay-event-source.ts";

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

export interface ReplayControlsProps {
  position: number;
  totalEvents: number;
  state: "playing" | "paused";
  speed: number;
  controls: ReplayControlsApi;
}

// Only rendered while viewing a recording (see App.tsx) — live mode has
// no fixed end to play/seek toward, so these never appear there. Renders
// straight off the numbers use-event-source.ts already derived from
// ReplayEventSource; every interaction here is a direct call into
// `controls`, which is the only thing that ever changes replay state.
export function ReplayControls({
  position,
  totalEvents,
  state,
  speed,
  controls,
}: ReplayControlsProps) {
  const atStart = position <= 0;
  const atEnd = position >= totalEvents;

  return (
    <div className="replay-controls">
      <button type="button" onClick={controls.restart} disabled={totalEvents === 0}>
        Restart
      </button>
      <button type="button" onClick={controls.stepBackward} disabled={atStart}>
        Step Back
      </button>
      <button
        type="button"
        onClick={state === "playing" ? controls.pause : controls.play}
        disabled={state !== "playing" && atEnd}
      >
        {state === "playing" ? "Pause" : "Play"}
      </button>
      <button type="button" onClick={controls.stepForward} disabled={atEnd}>
        Step Forward
      </button>
      <input
        type="range"
        className="replay-controls__seek"
        aria-label="Seek"
        min={0}
        max={totalEvents}
        value={position}
        onChange={(event) => controls.seek(Number(event.target.value))}
      />
      <span className="replay-controls__position">
        {position} / {totalEvents} events
      </span>
      <label className="replay-controls__speed">
        Speed
        <select
          aria-label="Playback speed"
          value={speed}
          onChange={(event) => controls.setSpeed(Number(event.target.value))}
        >
          {SPEEDS.map((speedOption) => (
            <option key={speedOption} value={speedOption}>
              {speedOption}x
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
