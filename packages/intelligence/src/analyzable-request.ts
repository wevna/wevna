import type { CapturedEvent, Envelope } from "@wevna/protocol";

// The analyzer's own input contract — deliberately not imported from
// @wevna/dashboard's RequestModel/TimelineEntry (this package must have no
// dependency on dashboard components; see the package README/PR). A
// dashboard RequestModel already satisfies this structurally (it has every
// field here, plus more this analyzer doesn't need), so passing one
// straight through just works — no adapter, no duplication of the request
// model itself, only of the narrow shape actually consumed.
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
