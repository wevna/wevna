import type { CapturedEvent, Envelope } from "@wevna/protocol";

// The analyzer's own input contract: the narrow shape analysis actually
// consumes, kept separate from the full RequestModel this package now also
// owns (see request-model.ts). RequestModel satisfies this structurally —
// it has every field here plus more no analyzer needs — so passing one
// straight through just works, with no adapter.
//
// Why keep both now that they live in the same package: an analyzer that
// only declares `{ durationMs, timeline }` cannot quietly start depending
// on a request's method, route, or status code, so the moment one genuinely
// needs that it shows up as a signature change in review rather than as a
// silent coupling. It also keeps analyzers usable on anything timeline-
// shaped — a future queue job or background task — that is not, and should
// not have to pretend to be, an HTTP request.
export interface AnalyzableTimelineEntry {
  kind: string;
  relativeOffsetMs: number;
  // Undefined for instantaneous events (console.log, exception.captured —
  // neither represents a measured operation with a start and end).
  durationMs: number | undefined;
  event: Envelope<CapturedEvent>;
}

export interface AnalyzableRequest {
  // Undefined for a still-pending request (no http.request event yet) —
  // analysis degrades gracefully rather than guessing a duration.
  durationMs: number | undefined;
  timeline: readonly AnalyzableTimelineEntry[];
}
