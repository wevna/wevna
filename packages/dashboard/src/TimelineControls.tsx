export interface TimelineControlsProps {
  paused: boolean;
  liveCount: number;
  onPause: () => void;
  onResume: () => void;
  onClear: () => void;
}

export function TimelineControls({
  paused,
  liveCount,
  onPause,
  onResume,
  onClear,
}: TimelineControlsProps) {
  return (
    <div className="timeline-controls">
      <span className="timeline-controls__count">
        {liveCount} event{liveCount === 1 ? "" : "s"}
      </span>
      <button type="button" onClick={paused ? onResume : onPause}>
        {paused ? "Resume" : "Pause"}
      </button>
      <button type="button" onClick={onClear}>
        Clear
      </button>
    </div>
  );
}
