import { useMemo } from "react";
import type { RequestModel } from "./request-store.ts";
import { computeTimelineLayout } from "./timeline-layout.ts";

export interface WaterfallTimelineProps {
  request: RequestModel;
}

function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

// Plain HTML/CSS bars positioned with percentage left/width — no canvas,
// no SVG, no chart library. computeTimelineLayout (timeline-layout.ts)
// does all the actual math; this component only ever turns its output
// into markup. Memoized on request.timeline/request.durationMs (via
// useMemo — computeTimelineLayout is a pure function of exactly those
// inputs) so a request whose events haven't changed never recomputes its
// layout just because a sibling request updated.
export function WaterfallTimeline({ request }: WaterfallTimelineProps) {
  const layout = useMemo(
    () => computeTimelineLayout(request.timeline, request.durationMs),
    [request.timeline, request.durationMs],
  );

  if (layout.entries.length === 0) {
    return null;
  }

  return (
    <ul
      className="waterfall"
      aria-label={`Timeline for ${[request.method, request.route].filter(Boolean).join(" ") || "request"}`}
    >
      {layout.entries.map(({ entry, leftPercent, widthPercent, isInstantaneous }) => {
        const offsetLabel = `+${formatMs(entry.relativeOffsetMs)}`;
        const durationLabel =
          entry.durationMs !== undefined ? ` for ${formatMs(entry.durationMs)}` : "";

        return (
          <li key={entry.event.payload.id} className="waterfall-row">
            {/* Always-visible text label: bars must remain understandable
                without relying on colour or position alone. */}
            <span className="waterfall-row__label">{entry.kind}</span>
            <span className="waterfall-row__track">
              {isInstantaneous ? (
                <span
                  className="waterfall-row__marker"
                  style={{ left: `${leftPercent}%` }}
                  role="img"
                  aria-label={`${entry.kind} at ${offsetLabel}`}
                  title={`${entry.kind} · ${offsetLabel}`}
                />
              ) : (
                <span
                  className="waterfall-row__bar"
                  style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
                  role="img"
                  aria-label={`${entry.kind} starting ${offsetLabel}${durationLabel}`}
                  title={`${entry.kind} · ${offsetLabel}${durationLabel}`}
                />
              )}
            </span>
            <span className="waterfall-row__timing">
              {offsetLabel}
              {entry.durationMs !== undefined ? ` · ${formatMs(entry.durationMs)}` : ""}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
