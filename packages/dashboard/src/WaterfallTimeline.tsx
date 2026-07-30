import { useMemo } from "react";
import { getEventKindCategory } from "./event-kind-category.ts";
import type { RequestModel } from "./request-store.ts";
import { TimelineAxis } from "./TimelineAxis.tsx";
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
    <>
      <TimelineAxis totalDurationMs={layout.totalDurationMs} />
      <ul
        className="waterfall"
        aria-label={`Timeline for ${[request.method, request.route].filter(Boolean).join(" ") || "request"}`}
      >
        {layout.entries.map(({ entry, leftPercent, widthPercent, isInstantaneous }) => {
          const offsetLabel = `+${formatMs(entry.relativeOffsetMs)}`;
          const durationLabel =
            entry.durationMs !== undefined ? ` for ${formatMs(entry.durationMs)}` : "";
          // Shape (bar vs. marker) plus this data attribute (colour) plus
          // the label text below are three independent ways to tell kinds
          // apart — colour is never the only signal. Exceptions get a
          // fourth: a diamond marker (CSS-only, see App.css) instead of
          // the neutral dot every other instantaneous kind uses.
          const category = getEventKindCategory(entry.kind);
          const exceptionMessage =
            category === "exception" && typeof entry.event.payload.attributes.message === "string"
              ? entry.event.payload.attributes.message
              : undefined;

          return (
            <li key={entry.event.payload.id} className="waterfall-row">
              {/* Always-visible text label: bars must remain understandable
                  without relying on colour or position alone. */}
              <span className="waterfall-row__label">{entry.kind}</span>
              <span className="waterfall-row__track">
                {isInstantaneous ? (
                  <span
                    className="waterfall-row__marker"
                    data-kind-category={category}
                    style={{ left: `${leftPercent}%` }}
                    role="img"
                    aria-label={
                      exceptionMessage
                        ? `${entry.kind}: ${exceptionMessage} at ${offsetLabel}`
                        : `${entry.kind} at ${offsetLabel}`
                    }
                    title={
                      exceptionMessage
                        ? `${entry.kind} · ${exceptionMessage}`
                        : `${entry.kind} · ${offsetLabel}`
                    }
                  />
                ) : (
                  <span
                    className="waterfall-row__bar"
                    data-kind-category={category}
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
    </>
  );
}
