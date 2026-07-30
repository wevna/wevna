import { useMemo } from "react";
import { computeTimelineAxisTicks } from "./timeline-layout.ts";

export interface TimelineAxisProps {
  totalDurationMs: number;
}

// Anchors each label to its tick rather than centering all of them, so the
// first and last ticks stay inside the track instead of clipping past its
// edges.
function tickTransform(leftPercent: number): string {
  if (leftPercent <= 0) {
    return "translateX(0)";
  }
  if (leftPercent >= 100) {
    return "translateX(-100%)";
  }
  return "translateX(-50%)";
}

// Purely a scale reference — the accessible timing info already lives on
// each waterfall row (aria-label/title carry the exact offset and
// duration), so this is aria-hidden rather than duplicating it. Structured
// as a spacer/track/spacer row matching .waterfall-row's own layout (via
// the shared --wf-label-width/--wf-timing-width custom properties) so its
// ticks land directly above the track they describe.
export function TimelineAxis({ totalDurationMs }: TimelineAxisProps) {
  const ticks = useMemo(() => computeTimelineAxisTicks(totalDurationMs), [totalDurationMs]);

  return (
    <div className="timeline-axis" aria-hidden="true">
      <span className="timeline-axis__spacer" />
      <span className="timeline-axis__track">
        {ticks.map((tick) => (
          <span
            key={tick.leftPercent}
            className="timeline-axis__tick"
            style={{ left: `${tick.leftPercent}%`, transform: tickTransform(tick.leftPercent) }}
          >
            {tick.label}
          </span>
        ))}
      </span>
      <span className="timeline-axis__spacer timeline-axis__spacer--timing" />
    </div>
  );
}
