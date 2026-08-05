import { Pause, Play, Trash2 } from "lucide-react";

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
      <button type="button" className="btn btn-secondary" onClick={paused ? onResume : onPause}>
        {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
        {paused ? "Resume" : "Pause"}
      </button>
      <button type="button" className="btn btn-secondary" onClick={onClear}>
        <Trash2 aria-hidden="true" />
        Clear
      </button>
    </div>
  );
}
