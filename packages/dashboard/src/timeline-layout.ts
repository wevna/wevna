import type { TimelineEntry } from "./timeline.ts";

export interface TimelineLayoutEntry {
  // Reference to the underlying entry (and, through it, the event) — never
  // copied.
  entry: TimelineEntry;
  // Position and width as percentages of the layout's totalDurationMs,
  // both always within [0, 100]. Dimensionless on purpose: no pixels, no
  // DOM units — a consuming component decides how those percentages
  // become CSS.
  leftPercent: number;
  widthPercent: number;
  // True when this entry has no renderable width (no measurable duration,
  // or a duration of 0) and should be presented as a marker rather than a
  // bar.
  isInstantaneous: boolean;
}

export interface TimelineLayout {
  // The time span this layout represents. 0 when it couldn't be
  // determined (e.g. a single instantaneous event with no known request
  // duration) — every entry then degrades to a zero-width marker at the
  // start rather than producing NaN/Infinity positions.
  totalDurationMs: number;
  entries: readonly TimelineLayoutEntry[];
}

function clampPercent(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

// Prefers the request's own accurately-measured duration when known.
// Falls back to the latest timestamp any entry has reached — every timed
// producer (HttpInstrumentation, PgInstrumentation, RedisInstrumentation)
// publishes once its operation *finishes*, so relativeOffsetMs is already
// an end time, not a start time (see the comment on TimelineLayoutEntry
// below) — so a still-in-progress request (no http.request event yet)
// still gets a sensible, non-empty layout instead of collapsing to zero
// the moment the first event arrives.
function computeTotalDurationMs(
  entries: readonly TimelineEntry[],
  requestDurationMs: number | undefined,
): number {
  if (requestDurationMs !== undefined && requestDurationMs > 0) {
    return requestDurationMs;
  }

  let max = 0;
  for (const entry of entries) {
    if (entry.relativeOffsetMs > max) {
      max = entry.relativeOffsetMs;
    }
  }
  return max;
}

// Converts a request's timeline (milliseconds, from timeline.ts) into
// dimensionless, proportional layout data — no DOM, no pixels, no React.
// A pure function of its inputs: the same timeline and request duration
// always produce the same layout, so a consumer can safely memoize on
// them (see WaterfallTimeline.tsx) and skip recomputing for requests that
// haven't changed.
//
// Every timed event kind (http.request, sql.query, redis.command) is
// published *after* its operation resolves — its occurredAt, and so its
// relativeOffsetMs, marks when the operation finished, not when it
// started (see http-instrumentation.ts / pg-instrumentation.ts /
// redis-instrumentation.ts, all of which call Date.now() inside a
// completion callback). A bar therefore has to *end* at relativeOffsetMs
// and extend backward by durationMs, not forward from it — otherwise a
// query that ran from +1ms to +10ms would incorrectly render as if it ran
// from +10ms to +19ms. This also makes the http.request bar (whose
// durationMs is the whole request's duration, ending at the very last
// moment) correctly span the entire track from 0%, rather than degrading
// to a zero-width marker pinned at the right edge with no room left to
// grow into.
export function computeTimelineLayout(
  entries: readonly TimelineEntry[],
  requestDurationMs: number | undefined,
): TimelineLayout {
  const totalDurationMs = computeTotalDurationMs(entries, requestDurationMs);

  if (totalDurationMs <= 0) {
    return {
      totalDurationMs: 0,
      entries: entries.map((entry) => ({
        entry,
        leftPercent: 0,
        widthPercent: 0,
        isInstantaneous: true,
      })),
    };
  }

  return {
    totalDurationMs,
    entries: entries.map((entry) => {
      const durationMs = entry.durationMs && entry.durationMs > 0 ? entry.durationMs : 0;
      const startMs = entry.relativeOffsetMs - durationMs;
      const leftPercent = clampPercent((startMs / totalDurationMs) * 100);
      const rawWidthPercent = (durationMs / totalDurationMs) * 100;
      // Clamped against the remaining space so a bar can never extend
      // past the end of the track, even if an individual event's own
      // reported duration pushes it beyond the layout's total.
      const widthPercent = clampPercent(Math.min(rawWidthPercent, 100 - leftPercent));

      return {
        entry,
        leftPercent,
        widthPercent,
        isInstantaneous: widthPercent <= 0,
      };
    }),
  };
}
